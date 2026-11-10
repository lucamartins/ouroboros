// Daily upkeep, run by the worker (`--maintain`), started from SessionStart at most
// once a day: archive learnings nobody uses, and trim any area whose budget is past
// `consolidateAt`. Everything goes through the curator, so it is undoable.
import path from 'node:path';
import { options } from './config.mjs';
import { forget, indexEntriesIn } from './curator.mjs';
import { getMeta, logError, monthSpend, setMeta } from './db.mjs';
import { loadSettings } from './settings.mjs';

const DAY = 86_400_000;
const MIN_INTERVAL = 20 * 60 * 60 * 1000;
const KEEP_CONFIDENCE = 0.7; // unused learnings at or above this are kept
const TARGET_RATIO = 0.7; // consolidate down to 70% of a budget

/**
 * Whether a learning does its work without ever being read: a `feedback` or `user`
 * memory states a rule, and its line in MEMORY.md (loaded in every session of the
 * project) already says it. Claude follows it without opening the file, so "never read"
 * says nothing about whether it is used. A `project` or `reference` memory is a fact or a
 * pointer looked up on demand; for those, and for skills, a read or a use is the signal.
 */
export function actsThroughIndex(l) {
  return l.kind === 'memory' && ['feedback', 'user'].includes(l.memory_type);
}

/** Score for "keep this": confidence weighted by how often it was used. */
function score(l) {
  // A rule that acts through the index counts as used: its reads are not a measure.
  const uses = actsThroughIndex(l) ? Math.max(1, l.uses || 0) : l.uses || 0;
  return (l.confidence ?? 0.5) * (1 + Math.log2(1 + uses));
}

export function decay(db, settings, now = Date.now()) {
  const cutoff = now - (settings.archiveAfterDaysUnused || 60) * DAY;
  const stale = db.prepare(`
    SELECT * FROM learnings
    WHERE status = 'active' AND origin_session IS NOT 'native' AND kind IN ('memory', 'skill') AND pinned = 0
      AND COALESCE(confidence, 0.5) < ? AND created_at < ? AND COALESCE(last_used_at, 0) < ?
    ORDER BY confidence, uses`).all(KEEP_CONFIDENCE, cutoff, cutoff).filter((l) => !actsThroughIndex(l));
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

/** Capture events are kept this long (longer than any range the dashboard shows). */
const EVENT_RETENTION_DAYS = 400;
/** Never pruned: the all-time use counts of skills and memories are read from them. */
const KEPT_EVENT_KINDS = ['skill_used', 'memory_read'];

/** Delete old capture events (turns, failures, recoveries, writes observed), which otherwise grow forever. */
export function pruneEvents(db, now = Date.now(), days = EVENT_RETENTION_DAYS) {
  return db.prepare(`DELETE FROM events WHERE ts < ? AND kind NOT IN (${KEPT_EVENT_KINDS.map(() => '?').join(',')})`)
    .run(now - days * DAY, ...KEPT_EVENT_KINDS).changes;
}

export async function consolidate(db, settings, opts) {
  const report = { archived: [], cost: 0 };
  const limits = settings.limits;

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
  const pruned = pruneEvents(db, now);
  const archived = [...decayed, ...cons.archived];
  db.prepare('INSERT INTO maintenance (ts, kind, detail, archived, merged, cost_usd) VALUES (?, ?, ?, ?, ?, ?)')
    .run(now, 'daily', JSON.stringify({ decayed, trimmed: cons.archived }), archived.length, 0, cons.cost);
  const lines = [
    ...(decayed.length ? [`🧹 archived ${decayed.length} unused: ${decayed.slice(0, 5).join('; ')}${decayed.length > 5 ? '…' : ''}`] : []),
    ...(cons.archived.length ? [`🧹 archived ${cons.archived.length} to stay within budget: ${cons.archived.slice(0, 5).join('; ')}`] : []),
  ];
  if (lines.length) db.prepare('INSERT INTO notices (ts, session_id, text) VALUES (?, ?, ?)').run(now, 'maintenance', lines.join('\n'));
  return { status: 'ok', decayed, trimmed: cons.archived, pruned, tidied, cost: cons.cost + (tidied?.cost || 0) };
}
