// Daily upkeep, run by the worker (`--maintain`), started from SessionStart at most
// once a day: archive learnings nobody uses, and consolidate any area whose budget is
// past `consolidateAt`. Everything goes through the curator, so it is undoable.
import path from 'node:path';
import { options } from './config.mjs';
import { forget, indexEntriesIn, rewriteProfileBlock } from './curator.mjs';
import { getMeta, logError, monthSpend, setMeta } from './db.mjs';
import { BLOCKS, blockChars, parseProfile, readProfileText } from './profile.mjs';
import { runModel } from './review-worker.mjs';
import { loadSettings } from './settings.mjs';

const DAY = 86_400_000;
const MIN_INTERVAL = 20 * 60 * 60 * 1000;
const KEEP_CONFIDENCE = 0.7; // unused learnings at or above this are kept
const TARGET_RATIO = 0.7; // consolidate down to 70% of a budget

export const CONSOLIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['bullets'],
  properties: {
    bullets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'sources'],
        properties: {
          text: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

export function consolidatePrompt({ title, bullets, targetChars }) {
  return `These are the "${title}" facts an AI coding assistant keeps about its user. The list is too long. Rewrite it in at most ${targetChars} characters in total:

- merge bullets that say the same thing or belong together;
- shorten wordy bullets, keeping every concrete detail that matters (names, commands, paths);
- drop only what another bullet already covers — never invent anything;
- keep the language each bullet is written in;
- for every output bullet, list in "sources" the ids of the input bullets it comes from (every input id must appear in some output bullet, unless it was fully redundant).

Input bullets:
${bullets.map((b) => `- [${b.id}] ${b.text}`).join('\n')}`;
}

/** Score for "keep this": confidence weighted by how often it was used. */
function score(l) {
  return (l.confidence ?? 0.5) * (1 + Math.log2(1 + (l.uses || 0)));
}

export function decay(db, settings, now = Date.now()) {
  const cutoff = now - (settings.archiveAfterDaysUnused || 60) * DAY;
  const stale = db.prepare(`
    SELECT * FROM learnings
    WHERE status = 'active' AND origin_session IS NOT 'native' AND kind IN ('memory', 'skill') AND pinned = 0
      AND COALESCE(confidence, 0.5) < ? AND created_at < ? AND COALESCE(last_used_at, 0) < ?
    ORDER BY confidence, uses`).all(KEEP_CONFIDENCE, cutoff, cutoff);
  const archived = [];
  for (const l of stale) {
    const r = forget(db, { match: l.id });
    if (r.status === 'archived') archived.push(l.title);
  }
  return archived;
}

/** Archive the weakest learnings of a set until it fits `target` items. */
function trimToTarget(db, rows, target) {
  const archived = [];
  const sorted = [...rows].sort((a, b) => score(a) - score(b));
  let count = rows.length;
  for (const l of sorted) {
    if (count <= target) break;
    const r = forget(db, { match: l.id });
    if (r.status === 'archived') { archived.push(l.title); count--; }
  }
  return archived;
}

export async function consolidate(db, settings, opts) {
  const report = { profile: [], archived: [], cost: 0 };
  const limits = settings.limits;

  // Profile blocks: rewritten by the isolated model (merge + shorten).
  const blocks = parseProfile(readProfileText() ?? '');
  for (const key of Object.keys(BLOCKS)) {
    const limit = key === 'user' ? limits.userBlockChars : limits.environmentBlockChars;
    const used = blockChars(blocks[key]);
    if (used < limit * limits.consolidateAt || blocks[key].length < 2) continue;
    if (opts.monthlyBudgetUsd <= 0 || monthSpend(db) >= opts.monthlyBudgetUsd) break;
    try {
      const result = await runModel({
        prompt: consolidatePrompt({ title: BLOCKS[key], bullets: blocks[key], targetChars: Math.floor(limit * TARGET_RATIO) }),
        schema: CONSOLIDATE_SCHEMA,
        model: opts.judgeModel,
      });
      report.cost += Number(result.total_cost_usd) || 0;
      db.prepare("INSERT INTO reviews (session_id, mode, trigger, model, status, cost_usd, output_tokens, input_tokens, ts) VALUES ('maintenance', 'maintenance', ?, ?, 'ok', ?, ?, ?, ?)")
        .run(`consolidate:${key}`, opts.judgeModel, Number(result.total_cost_usd) || 0, result.usage?.output_tokens || 0,
          (result.usage?.input_tokens || 0) + (result.usage?.cache_creation_input_tokens || 0), Date.now());
      const r = rewriteProfileBlock(db, key, result.structured_output.bullets);
      report.profile.push({ block: key, ...r });
    } catch (err) {
      logError(db, 'maintenance:consolidate', err);
    }
  }

  // Project memories: per directory, archive the weakest Ouroboros memories.
  const memories = db.prepare("SELECT * FROM learnings WHERE status = 'active' AND kind = 'memory' AND origin_session IS NOT 'native' AND pinned = 0").all();
  const byDir = new Map();
  for (const m of memories) {
    const dir = path.dirname(m.path);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(m);
  }
  for (const [dir, rows] of byDir) {
    const entries = indexEntriesIn(dir);
    if (entries < limits.memoryIndexLines * limits.consolidateAt) continue;
    const excess = entries - Math.floor(limits.memoryIndexLines * TARGET_RATIO);
    report.archived.push(...trimToTarget(db, rows, Math.max(0, rows.length - excess)));
  }

  // Learned skills.
  const skills = db.prepare("SELECT * FROM learnings WHERE status = 'active' AND kind = 'skill' AND origin_session IS NOT 'native'").all();
  if (skills.length >= limits.learnedSkills * limits.consolidateAt) {
    // Kept skills count against the budget but are never the ones trimmed.
    const kept = skills.filter((s) => s.pinned).length;
    report.archived.push(...trimToTarget(db, skills.filter((s) => !s.pinned), Math.max(0, Math.floor(limits.learnedSkills * TARGET_RATIO) - kept)));
  }
  return report;
}

export async function maintain(db, { force = false, now = Date.now() } = {}) {
  const last = Number(getMeta(db, 'maintenance_at')) || 0;
  if (!force && now - last < MIN_INTERVAL) return { status: 'skipped', reason: 'ran recently' };
  setMeta(db, 'maintenance_at', now);
  const settings = loadSettings();
  const opts = options();
  const decayed = decay(db, settings, now);
  let tidied = null;
  const waiting = db.prepare("SELECT COUNT(*) n FROM candidates WHERE outcome IN ('pending', 'queued') AND triaged_at IS NULL AND changeset_id IS NULL").get().n
    + db.prepare("SELECT COUNT(*) n FROM changesets WHERE status = 'stale'").get().n;
  if (waiting && opts.monthlyBudgetUsd > monthSpend(db)) {
    try {
      const { drainQueue } = await import('./evaluate.mjs');
      tidied = await drainQueue(db);
    } catch (err) {
      logError(db, 'maintenance:triage', err);
    }
  }
  const cons = await consolidate(db, settings, opts);
  const archived = [...decayed, ...cons.archived];
  const merged = cons.profile.filter((p) => p.status === 'consolidated');
  db.prepare('INSERT INTO maintenance (ts, kind, detail, archived, merged, cost_usd) VALUES (?, ?, ?, ?, ?, ?)')
    .run(now, 'daily', JSON.stringify({ decayed, consolidated: cons.profile, trimmed: cons.archived }), archived.length,
      merged.reduce((n, p) => n + (p.merged || 0), 0), cons.cost);
  const lines = [
    ...(decayed.length ? [`🧹 archived ${decayed.length} unused: ${decayed.slice(0, 5).join('; ')}${decayed.length > 5 ? '…' : ''}`] : []),
    ...merged.map((p) => `🧹 consolidated the profile ${BLOCKS[p.block]} block (${p.before} → ${p.after} facts)`),
    ...(cons.archived.length ? [`🧹 archived ${cons.archived.length} to stay within budget: ${cons.archived.slice(0, 5).join('; ')}`] : []),
  ];
  if (lines.length) db.prepare('INSERT INTO notices (ts, session_id, text) VALUES (?, ?, ?)').run(now, 'maintenance', lines.join('\n'));
  return { status: 'ok', decayed, consolidated: cons.profile, trimmed: cons.archived, tidied, cost: cons.cost + (tidied?.cost || 0) };
}
