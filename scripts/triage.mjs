// Triage: check proposals against what Claude already knows (memories, profile,
// CLAUDE.md, .claude/rules, skill bodies) and against each other, before anything is
// written or queued. One isolated model call per batch decides, for every proposal:
// keep (normalized), drop (covered / one-off / stale / derivable / low value),
// merge into another proposal, or patch an existing memory/skill instead.
import fs from 'node:fs';
import path from 'node:path';
import { options } from './config.mjs';
import { buildIndex } from './knowledge.mjs';
import { normalize } from './paths.mjs';
import { runModel } from './review-worker.mjs';

const BATCH = 12;
const EXCERPTS_PER_PROPOSAL = 3;
const EXCERPT_CHARS = 900;

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
          verdict: { type: 'string', enum: ['keep', 'drop', 'merge', 'patch'] },
          reason: { type: 'string' },
          drop_kind: { type: 'string', enum: ['covered', 'one_off', 'stale', 'derivable', 'low_value', 'conflict_resolved'] },
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
          patch: {
            type: 'object',
            additionalProperties: false,
            required: ['file', 'old', 'new'],
            properties: { file: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } },
          },
        },
      },
    },
  },
};

export function languageRule(lang) {
  return lang === 'auto'
    ? 'Write every rewrite in the language the user writes in.'
    : `Write every rewrite in ${lang === 'pt-BR' ? 'Brazilian Portuguese' : 'English'}, whatever language the proposal is in.`;
}

function describe(p) {
  return [
    `kind=${p.kind}${p.memory_type ? `/${p.memory_type}` : ''}${p.block ? `/${p.block}` : ''}${p.scope ? ` scope=${p.scope}` : ''}${p.op === 'patch' ? ` op=patch target=${p.target}` : ''}`,
    `title: ${p.title || ''}`,
    p.description ? `description: ${p.description}` : '',
    p.text ? `text: ${p.text}` : '',
    p.body ? `body: ${String(p.body).slice(0, 1500)}` : '',
    p.old !== undefined ? `old: ${p.old}\nnew: ${p.new}` : '',
    p.evidence ? `evidence: ${p.evidence}` : '',
    p.when ? `session date: ${p.when}` : '',
  ].filter(Boolean).join('\n');
}

export function triagePrompt({ batch, others, excerpts, lang }) {
  return `You curate what an AI coding assistant remembers between sessions. Below are PROPOSALS for new memories, profile facts or skills, and EXCERPTS of what is already written in its memories, profile, CLAUDE.md files, rules and skills. Decide for every proposal:

- "drop" when it should not be saved. Set drop_kind:
  - covered: the excerpts already say it (set covered_by to the file path). Partially covered with no meaningful new detail counts as covered.
  - one_off: an instruction for one task, a status update or a to-do (those belong in a task tracker), not a standing rule or reusable fact.
  - stale: superseded by newer knowledge, or about something finished (a completed rename, a closed decision).
  - derivable: a business rule already implemented in code and tests, unless the reason behind it is non-obvious and written nowhere.
  - low_value: vague, generic advice any assistant already follows, or too narrow to matter again.
- "merge" when another proposal says the same thing (in any language or kind): set merge_into to the id that should absorb it. The absorbing proposal must be "keep" and its rewrite must combine the details of both.
- "patch" when the topic is owned by an excerpt marked [patchable] (a skill, memory or profile file) and the proposal adds a real detail it lacks: set patch.file to that path, patch.old to an exact fragment copied verbatim from the excerpt (a whole line or sentence, unique in the file), and patch.new to the replacement that keeps the old content and adds the detail, written in the style and language of that file. Also give rewrite.title: a short title for the addition. Prefer patching the skill that owns a procedure over saving a separate memory.
- "keep" when it is worth saving as new. Always give a rewrite that:
  - picks the right kind: "profile" for a short fact valid on every project (block "user" for who the user is and how they like to work, "environment" for OS/shell/tool facts — "text" holds one sentence); "memory" for a fact about one project (memory_type feedback/project/reference; "description" one line; "body" with the fact plus "**Why:**" and "**How to apply:**" lines); "skill" only for a reusable multi-step procedure (description ≤ 250 chars saying when to use it; body with steps);
  - uses a short human-readable title (never a slug like "feedback-x-y");
  - removes details that will soon be stale (PR numbers, counts, dates) unless they are the point.
- If a kept proposal contradicts an excerpt, keep it and set conflict_with to the file and what differs, so the owner decides.

${languageRule(lang)}
Answer for every proposal id in this batch, once.

OTHER PROPOSALS (for duplicates across batches; decide only the ones in THIS BATCH):
${others.map((o) => `#${o.id} ${o.kind}: ${o.title}`).join('\n') || '(none)'}

EXCERPTS:
${excerpts.map((e) => `<excerpt file="${e.file}"${e.patchable ? ' patchable' : ''}${e.heading ? ` heading="${e.heading}"` : ''}>\n${e.text.slice(0, EXCERPT_CHARS)}\n</excerpt>`).join('\n') || '(none found)'}

THIS BATCH:
${batch.map((p) => `<proposal id="${p.id}">\n${describe(p)}\n</proposal>`).join('\n')}`;
}

/**
 * Triage proposals ({id, kind, title, description, text, body, ...}) for one project dir.
 * Returns { verdicts: Map(id -> verdict), cost }.
 */
export async function triage(proposals, { cwd, lang = options().learningLanguage, model = options().reviewerModel } = {}) {
  const index = buildIndex(cwd);
  const verdicts = new Map();
  let cost = 0;
  const calls = [];
  for (let i = 0; i < proposals.length; i += BATCH) {
    const batch = proposals.slice(i, i + BATCH);
    const seen = new Set();
    const excerpts = [];
    for (const p of batch) {
      for (const hit of index.search([p.title, p.description, p.text, p.body, p.target].filter(Boolean).join(' '), EXCERPTS_PER_PROPOSAL)) {
        const key = `${hit.file}#${hit.heading}#${hit.text.slice(0, 40)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        excerpts.push(hit);
      }
    }
    const others = proposals.filter((p) => !batch.includes(p));
    const result = await runModel({ prompt: triagePrompt({ batch, others, excerpts, lang }), schema: TRIAGE_SCHEMA, model });
    cost += Number(result.total_cost_usd) || 0;
    calls.push(result);
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
  return { verdicts, cost, calls: calls.length };
}

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

export function dedupePrompt({ items, lang }) {
  return `These notes are about to be saved for an AI coding assistant. Find groups that state the same rule or fact (in any language, kind or wording) and should be ONE note. Do not group notes that merely share a topic but say different things.

For each group: "keep" is the id to keep, "merge" the ids folded into it, and give the combined "title", "description" and "body" (memories) or "text" (profile facts) with every detail of the group. Return an empty list if there are no duplicates. ${languageRule(lang)}

${items.map((i) => [`#${i.id} [${i.kind}] ${i.title}`, i.description, i.text, i.body && String(i.body).slice(0, 600)].filter(Boolean).join('\n')).join('\n\n')}`;
}

/** Turn a "patch" verdict into a curator patch item, if the fragment is really there. */
export function patchItemFromVerdict(v) {
  const file = v.patch?.file;
  if (!file || !v.patch.old) return null;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const count = text.split(v.patch.old).length - 1;
  if (count !== 1) return null;
  const kind = /[\\/]skills[\\/]/i.test(file) ? 'skill' : normalize(file).endsWith('/user.md') ? 'profile' : 'memory';
  return { op: 'patch', kind, target: path.resolve(file), old: v.patch.old, new: v.patch.new };
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

function noteFor(v) {
  if (v.verdict === 'drop') return `${(v.drop_kind || 'dropped').replace('_', ' ')}: ${v.reason}${v.covered_by ? ` (${v.covered_by})` : ''}`;
  if (v.verdict === 'merge') return `merged into #${v.merge_into}: ${v.reason}`;
  if (v.verdict === 'patch') return `update to existing ${path.basename(path.dirname(v.patch.file)) === 'memory' ? 'memory' : 'file'} ${v.patch.file}: ${v.reason}`;
  return v.conflict_with ? `⚠ conflicts with ${v.conflict_with}` : null;
}

/**
 * Triage the approval queue: drop what is covered, merge duplicates, turn additions to
 * existing skills/memories into patches, normalize the rest. Only untriaged items unless
 * `force`. Records the cost as a maintenance review.
 */
export async function tidyQueue(db, { force = false } = {}) {
  const rows = db.prepare(`
    SELECT c.*, s.started_at session_started_at FROM candidates c LEFT JOIN sessions s ON s.id = c.session_id
    WHERE c.outcome = 'queued' ${force ? '' : 'AND c.triaged_at IS NULL'}
    ORDER BY COALESCE(s.started_at, c.ts), c.id`).all();
  const report = { total: rows.length, kept: 0, dropped: 0, merged: 0, patched: 0, conflicts: 0, cost: 0 };
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
    const { verdicts, cost } = await triage(proposals, { cwd });
    report.cost += cost;
    for (const { row, payload } of items) {
      const v = verdicts.get(row.id);
      if (!v) continue;
      if (v.verdict === 'drop' || v.verdict === 'merge') {
        db.prepare('UPDATE candidates SET outcome = ?, note = ?, decided_at = ?, triaged_at = ? WHERE id = ?')
          .run(DROP_OUTCOME[v.verdict], noteFor(v), now, now, row.id);
        report[v.verdict === 'drop' ? 'dropped' : 'merged']++;
        continue;
      }
      let item = payload.item;
      let note = noteFor(v);
      if (v.verdict === 'patch') {
        const patch = patchItemFromVerdict(v);
        if (patch) {
          item = { ...patch, title: v.rewrite?.title || item.title, confidence: item.confidence, evidence: item.evidence };
          report.patched++;
        } else {
          item = rewriteItem(item, v);
          note = `kept as new (the suggested update did not match ${v.patch?.file || 'its target'})`;
          report.kept++;
        }
      } else {
        item = rewriteItem(item, v);
        report.kept++;
        if (v.conflict_with) report.conflicts++;
      }
      db.prepare(`
        UPDATE candidates SET kind = ?, scope = ?, memory_type = ?, title = ?, summary = ?, payload = ?, note = ?, triaged_at = ?
        WHERE id = ?`).run(
        item.kind, item.kind === 'profile' ? 'global' : item.scope || 'project', item.memory_type ?? null,
        String(item.title || item.text || '').slice(0, 200),
        String(item.op === 'patch' ? item.new : item.text || item.body || item.description || '').slice(0, 1500),
        JSON.stringify({ ...payload, item }), note, now, row.id);
    }
  }
  db.prepare("INSERT INTO reviews (session_id, mode, trigger, model, status, detail, cost_usd, ts) VALUES ('maintenance', 'maintenance', 'triage', ?, 'ok', ?, ?, ?)")
    .run(options().reviewerModel, JSON.stringify(report), report.cost, Date.now());
  return report;
}
