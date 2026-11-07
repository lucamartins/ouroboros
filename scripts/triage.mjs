// Knowledge check (triage): judge proposals with the learning rubric against what
// Claude already knows, the project's sources of truth, the map of which skill or rule
// owns each topic, and what the user rejected before. One isolated model call per
// batch decides, for every proposal:
//   keep     save as new (normalized rewrite)
//   drop     fails the rubric (covered, one-off, derivable, default behavior, ...)
//   merge    same as another proposal
//   patch    add to the skill / rule / memory that owns the topic
//   correct  existing knowledge is wrong: fix it (always waits for the user)
import fs from 'node:fs';
import path from 'node:path';
import { options } from './config.mjs';
import { buildIndex, knowledgeKind, ownersMap, PATCHABLE } from './knowledge.mjs';
import { runModel } from './review-worker.mjs';
import { languageRule, rubricText } from './rubric.mjs';

const BATCH = 12;
const EXCERPTS_PER_PROPOSAL = 4;
const EXCERPT_CHARS = 900;
const REJECTIONS_DAYS = 180;

export const DROP_KINDS = ['covered', 'one_off', 'derivable', 'default_behavior', 'unverified', 'stale', 'low_value', 'rejected_before'];

const PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'mode'],
  properties: {
    file: { type: 'string' },
    mode: { type: 'string', enum: ['append', 'replace'] },
    section: { type: 'string' },
    text: { type: 'string' },
    old: { type: 'string' },
    new: { type: 'string' },
  },
};

export const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'verdict', 'reason'],
        properties: {
          id: { type: 'integer' },
          verdict: { type: 'string', enum: ['keep', 'drop', 'merge', 'patch', 'correct'] },
          reason: { type: 'string' },
          rule: { type: 'string' },
          drop_kind: { type: 'string', enum: DROP_KINDS },
          covered_by: { type: 'string' },
          merge_into: { type: 'integer' },
          conflict_with: { type: 'string' },
          rewrite: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', enum: ['profile', 'memory', 'skill'] },
              block: { type: 'string', enum: ['user', 'environment'] },
              memory_type: { type: 'string', enum: ['feedback', 'project', 'reference'] },
              scope: { type: 'string', enum: ['global', 'project'] },
              title: { type: 'string' },
              description: { type: 'string' },
              text: { type: 'string' },
              body: { type: 'string' },
            },
          },
          patch: PATCH_SCHEMA,
        },
      },
    },
  },
};

export const DEDUPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['groups'],
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['keep', 'merge', 'reason'],
        properties: {
          keep: { type: 'integer' },
          merge: { type: 'array', items: { type: 'integer' } },
          reason: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          text: { type: 'string' },
          body: { type: 'string' },
        },
      },
    },
  },
};

export { languageRule };

function describe(p) {
  return [
    `kind=${p.kind}${p.memory_type ? `/${p.memory_type}` : ''}${p.block ? `/${p.block}` : ''}${p.scope ? ` scope=${p.scope}` : ''}${p.op === 'patch' ? ` op=patch target=${p.target}` : ''}`,
    `title: ${p.title || ''}`,
    p.description ? `description: ${p.description}` : '',
    p.text ? `text: ${p.text}` : '',
    p.body ? `body: ${String(p.body).slice(0, 1500)}` : '',
    p.old !== undefined ? `old: ${p.old}\nnew: ${p.new}` : '',
    p.append !== undefined ? `append to section "${p.section || ''}": ${p.append}` : '',
    p.evidence ? `evidence: ${p.evidence}` : '',
    p.when ? `session date: ${p.when}` : '',
  ].filter(Boolean).join('\n');
}

const KIND_LABEL = {
  skill: 'skill (patchable)', rules: 'rule file (patchable, needs approval)', instructions: 'CLAUDE.md (patchable, needs approval)',
  memory: 'memory (patchable)', profile: 'global profile (patchable)', source: 'SOURCE OF TRUTH (read-only)', rejected: 'REJECTED BEFORE by the user',
};

export function triagePrompt({ batch, others, excerpts, owners, lang }) {
  return `You curate what an AI coding assistant remembers between sessions. Judge each PROPOSAL with the rubric, using the EXCERPTS (what is already written, sources of truth, and proposals the user rejected before) and the OWNERS map (which skill or rule file owns which topic).

RUBRIC — a proposal is saved only if it passes every rule:
${rubricText()}

VERDICTS (set "rule" to the id of the rubric rule that decided it):
- "drop" with drop_kind: covered (an excerpt already says it; set covered_by to the file), one_off, derivable, default_behavior, unverified (a source of truth contradicts it), stale, low_value, rejected_before (the user already rejected the same thing).
- "merge" with merge_into: another proposal says the same thing in any language or kind. The absorbing proposal must be "keep" and its rewrite must combine both.
- "patch": the topic has an owner (a skill, rule file, memory or profile in OWNERS or EXCERPTS) and the proposal adds a real detail it lacks. Prefer this over a new memory whenever an owner exists, even if no excerpt shares its words. Set patch.file to the owner's path and either:
    mode "append": patch.section = the heading or bold topic to add under (from OWNERS or the excerpt), patch.text = the addition, written in the owner's style and language;
    mode "replace": patch.old = an exact, unique fragment copied verbatim from an excerpt of that file, patch.new = its replacement keeping the old content.
  Also give rewrite.title: a short title for the addition.
- "correct": the proposal is verified (by the user or a source of truth) and shows that an existing skill, rule or memory is WRONG or outdated. Give a patch that fixes the wrong text (usually mode "replace") and set conflict_with to what was wrong. Never just keep a proposal that contradicts existing knowledge: either correct the knowledge or drop the proposal.
- Stale owners: whatever the verdict for a proposal, if its excerpts show a skill, rule or memory that a SOURCE OF TRUTH contradicts on the same topic, answer "correct" with a patch that fixes that text (this is how outdated documentation gets repaired).
- "keep": worth saving as new and no owner fits. Give a rewrite that picks the right kind ("profile" = one sentence valid on every project in "text", block user/environment; "memory" = one project's fact with "description" and a "body" holding the fact plus "**Why:**" and "**How to apply:**"; "skill" = a reusable multi-step procedure with description ≤ 250 chars saying when to use it), uses a short human-readable title (never a slug), and removes details that will go stale.

${languageRule(lang)} Keep code identifiers, commands and file names as they are.
Answer once for every proposal id in THIS BATCH.

OWNERS (skills and rule files: name — description — sections):
${owners.map((o) => `- [${o.kind}] ${o.name} (${o.file}) — ${o.description}${o.headings.length ? ` — sections: ${o.headings.join(' | ')}` : ''}`).join('\n') || '(none)'}

OTHER PROPOSALS (for duplicates across batches; decide only THIS BATCH):
${others.map((o) => `#${o.id} ${o.kind}: ${o.title}`).join('\n') || '(none)'}

EXCERPTS:
${excerpts.map((e) => `<excerpt file="${e.file}" kind="${KIND_LABEL[e.kind] || e.kind}"${e.heading ? ` heading="${e.heading}"` : ''}>\n${e.text.slice(0, EXCERPT_CHARS)}\n</excerpt>`).join('\n') || '(none found)'}

THIS BATCH:
${batch.map((p) => `<proposal id="${p.id}">\n${describe(p)}\n</proposal>`).join('\n')}`;
}

export function dedupePrompt({ items, lang }) {
  return `These notes are about to be saved for an AI coding assistant. Find groups that state the same rule or fact (in any language, kind or wording) and should be ONE note. Do not group notes that merely share a topic but say different things.

For each group: "keep" is the id to keep, "merge" the ids folded into it, and give the combined "title", "description" and "body" (memories) or "text" (profile facts) with every detail of the group. Return an empty list if there are no duplicates. ${languageRule(lang)}

${items.map((i) => [`#${i.id} [${i.kind}] ${i.title}`, i.description, i.text, i.body && String(i.body).slice(0, 600)].filter(Boolean).join('\n')).join('\n\n')}`;
}

/** Proposals the user rejected or undid recently, as extra documents for the index. */
export function rejectionDocs(db) {
  if (!db) return [];
  const since = Date.now() - REJECTIONS_DAYS * 86_400_000;
  const rejected = db.prepare("SELECT title, summary, note FROM candidates WHERE outcome = 'rejected_by_user' AND COALESCE(decided_at, ts) >= ?").all(since)
    .map((r) => ({ file: '(rejected proposal)', kind: 'rejected', heading: r.title, text: `${r.title}\n${r.summary || ''}` }));
  const undone = db.prepare("SELECT title, path FROM learnings WHERE status = 'reverted' AND updated_at >= ?").all(since)
    .map((r) => ({ file: '(undone learning)', kind: 'rejected', heading: r.title, text: `${r.title} (was saved to ${r.path} and undone by the user)` }));
  return [...rejected, ...undone];
}

/**
 * Triage proposals ({id, kind, title, description, text, body, ...}) for one project dir.
 * Returns { verdicts: Map(id -> verdict), cost, calls }.
 */
export async function triage(proposals, { cwd, db = null, lang = options().learningLanguage, model = options().reviewerModel } = {}) {
  const index = buildIndex(cwd, { extra: rejectionDocs(db) });
  const owners = ownersMap(cwd);
  const verdicts = new Map();
  let cost = 0;
  let calls = 0;
  for (let i = 0; i < proposals.length; i += BATCH) {
    const batch = proposals.slice(i, i + BATCH);
    const seen = new Set();
    const excerpts = [];
    const take = (hit) => {
      const key = `${hit.file}#${hit.heading}#${hit.text.slice(0, 40)}`;
      if (seen.has(key)) return;
      seen.add(key);
      excerpts.push(hit);
    };
    for (const p of batch) {
      const query = [p.title, p.description, p.text, p.body, p.target, p.append].filter(Boolean).join(' ');
      for (const hit of index.search(query, EXCERPTS_PER_PROPOSAL)) take(hit);
      // Always look at the best source of truth and past rejection, even if they rank lower.
      for (const hit of index.search(query, 1, { kinds: ['source'] })) take(hit);
      for (const hit of index.search(query, 1, { kinds: ['rejected'] })) if (hit.score > 4) take(hit);
    }
    const others = proposals.filter((p) => !batch.includes(p));
    const result = await runModel({ prompt: triagePrompt({ batch, others, excerpts, owners, lang }), schema: TRIAGE_SCHEMA, model });
    cost += Number(result.total_cost_usd) || 0;
    calls++;
    for (const v of result.structured_output.verdicts || []) {
      if (batch.some((p) => p.id === v.id)) verdicts.set(v.id, v);
    }
  }

  // Batches only see each other's titles: one more pass over everything kept catches
  // duplicates that landed in different batches.
  if (proposals.length > BATCH) {
    const kept = proposals.filter((p) => verdicts.get(p.id)?.verdict === 'keep').map((p) => ({ id: p.id, ...rewriteItem(p, verdicts.get(p.id)) }));
    if (kept.length > 1) {
      const result = await runModel({ prompt: dedupePrompt({ items: kept, lang }), schema: DEDUPE_SCHEMA, model });
      cost += Number(result.total_cost_usd) || 0;
      calls++;
      const keptIds = new Set(kept.map((k) => k.id));
      for (const g of result.structured_output.groups || []) {
        const merge = (g.merge || []).filter((id) => id !== g.keep && keptIds.has(id));
        if (!keptIds.has(g.keep) || !merge.length) continue;
        const v = verdicts.get(g.keep);
        v.rewrite = { ...(v.rewrite || {}), ...Object.fromEntries(['title', 'description', 'text', 'body'].filter((k) => g[k]).map((k) => [k, g[k]])) };
        for (const id of merge) verdicts.set(id, { id, verdict: 'merge', merge_into: g.keep, reason: g.reason });
      }
    }
  }
  return { verdicts, cost, calls };
}

/**
 * Turn a "patch" or "correct" verdict into a curator patch item, after checking the
 * target is a patchable file and, for replacements, that the fragment is really there.
 */
export function patchItemFromVerdict(v) {
  const p = v.patch;
  if (!p?.file) return null;
  const file = path.resolve(p.file);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const kind = knowledgeKind(file);
  if (!PATCHABLE.has(kind)) return null;
  const base = { op: 'patch', kind: ['skill', 'profile'].includes(kind) ? kind : 'memory', target: file, targetKind: kind, corrects: v.verdict === 'correct' || undefined };
  if (p.mode === 'append' || (p.old === undefined && p.text)) {
    if (!String(p.text || '').trim()) return null;
    // Adding to the profile is adding a fact to one of its blocks.
    if (kind === 'profile') return { op: 'create', kind: 'profile', block: /user/i.test(p.section || '') ? 'user' : 'environment', text: p.text };
    return { ...base, section: p.section || '', append: p.text };
  }
  if (!p.old || text.split(p.old).length - 1 !== 1) return null;
  return { ...base, old: p.old, new: p.new ?? '' };
}

/** Apply a "keep" verdict's rewrite on top of the original proposal. */
export function rewriteItem(item, v) {
  const r = v.rewrite || {};
  const next = { ...item };
  for (const k of ['kind', 'block', 'memory_type', 'scope', 'title', 'description', 'text', 'body']) {
    if (r[k] !== undefined && r[k] !== '') next[k] = r[k];
  }
  if (next.kind === 'profile') {
    next.scope = 'global';
    delete next.memory_type;
    // A profile fact is its text; keep the title in step with it.
    if (r.text) next.title = r.text.length > 90 ? `${r.text.slice(0, 87)}…` : r.text;
  }
  if (next.kind !== 'profile') delete next.block;
  return next;
}

const DROP_OUTCOME = { drop: 'dropped', merge: 'merged' };

export function noteFor(v) {
  const rule = v.rule ? ` [${v.rule}]` : '';
  if (v.verdict === 'drop') return `${(v.drop_kind || 'dropped').replace(/_/g, ' ')}${rule}: ${v.reason}${v.covered_by ? ` (${v.covered_by})` : ''}`;
  if (v.verdict === 'merge') return `merged into #${v.merge_into}: ${v.reason}`;
  if (v.verdict === 'correct') return `✎ corrects ${v.patch?.file}: ${v.conflict_with || v.reason}`;
  if (v.verdict === 'patch') return `adds to ${v.patch?.file}${v.patch?.section ? ` › ${v.patch.section}` : ''}: ${v.reason}`;
  return v.conflict_with ? `⚠ conflicts with ${v.conflict_with}` : null;
}

/** Resolve one verdict into: { outcome, item, note } for the caller to record or apply. */
export function resolveVerdict(item, v) {
  if (!v) return { outcome: 'keep', item, note: null };
  if (v.verdict === 'drop' || v.verdict === 'merge') return { outcome: DROP_OUTCOME[v.verdict], item, note: noteFor(v) };
  if (v.verdict === 'patch' || v.verdict === 'correct') {
    const patch = patchItemFromVerdict(v);
    if (patch) {
      return {
        outcome: v.verdict,
        item: { ...patch, title: v.rewrite?.title || item.title, confidence: item.confidence, evidence: item.evidence },
        note: noteFor(v),
      };
    }
    // The owner could not be updated safely: keep as new, flagged.
    return { outcome: 'keep', item: rewriteItem(item, v), note: `kept as new (could not update ${v.patch?.file || 'its owner'} safely)` };
  }
  return { outcome: 'keep', item: rewriteItem(item, v), note: noteFor(v) };
}

/**
 * Triage the approval queue. Only untriaged items unless `force`.
 * Records the cost as a maintenance review.
 */
export async function tidyQueue(db, { force = false } = {}) {
  const rows = db.prepare(`
    SELECT c.*, s.started_at session_started_at FROM candidates c LEFT JOIN sessions s ON s.id = c.session_id
    WHERE c.outcome = 'queued' ${force ? '' : 'AND c.triaged_at IS NULL'}
    ORDER BY COALESCE(s.started_at, c.ts), c.id`).all();
  const report = { total: rows.length, kept: 0, dropped: 0, merged: 0, patched: 0, corrections: 0, cost: 0, byRule: {} };
  if (!rows.length) return report;

  // Retrieval depends on the project, so triage one project directory at a time.
  const groups = new Map();
  for (const r of rows) {
    let payload = {};
    try { payload = JSON.parse(r.payload || '{}'); } catch { /* ignore */ }
    const key = payload.cwd || r.cwd || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row: r, payload });
  }

  const now = Date.now();
  for (const [cwd, items] of groups) {
    const proposals = items.map(({ row, payload }) => ({
      id: row.id, ...payload.item, evidence: row.evidence,
      when: row.session_started_at ? new Date(row.session_started_at).toISOString().slice(0, 10) : undefined,
    }));
    const { verdicts, cost } = await triage(proposals, { cwd, db });
    report.cost += cost;
    for (const { row, payload } of items) {
      const v = verdicts.get(row.id);
      if (!v) continue;
      if (v.rule) report.byRule[v.rule] = (report.byRule[v.rule] || 0) + 1;
      const { outcome, item, note } = resolveVerdict(payload.item, v);
      if (outcome === 'dropped' || outcome === 'merged') {
        db.prepare('UPDATE candidates SET outcome = ?, note = ?, decided_at = ?, triaged_at = ? WHERE id = ?').run(outcome, note, now, now, row.id);
        report[outcome]++;
        continue;
      }
      report[outcome === 'patch' ? 'patched' : outcome === 'correct' ? 'corrections' : 'kept']++;
      db.prepare(`
        UPDATE candidates SET kind = ?, scope = ?, memory_type = ?, title = ?, summary = ?, payload = ?, note = ?, triaged_at = ?
        WHERE id = ?`).run(
        item.kind, item.kind === 'profile' ? 'global' : item.scope || 'project', item.memory_type ?? null,
        String(item.title || item.text || '').slice(0, 200),
        String(item.op === 'patch' ? (item.append ?? item.new) : item.text || item.body || item.description || '').slice(0, 1500),
        JSON.stringify({ ...payload, item }), note, now, row.id);
    }
  }
  db.prepare("INSERT INTO reviews (session_id, mode, trigger, model, status, detail, cost_usd, ts) VALUES ('maintenance', 'maintenance', 'triage', ?, 'ok', ?, ?, ?)")
    .run(options().reviewerModel, JSON.stringify(report), report.cost, Date.now());
  return report;
}
