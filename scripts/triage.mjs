// Screening (stage 1 of the learning evaluation, see evaluate.mjs): judge proposals with
// the learning rubric against what Claude already knows, the project's sources of
// truth, the map of which skill or rule file owns each topic, and what the user
// rejected before. One isolated model call per batch decides, for every proposal:
//   keep   save as new (normalized rewrite)
//   drop   fails the rubric (covered, one-off, derivable, default behavior, ...)
//   merge  same as another proposal
//   route  belongs to an existing owner file: the editor composes the change there
//   fix    a workaround for a fixable defect: suggested to the user, not learned
// Screening never writes text into existing files; it only sees excerpts of them.
import path from 'node:path';
import { options } from './config.mjs';
import { buildIndex, ownersMap } from './knowledge.mjs';
import { assertBudget } from './db.mjs';
import { gitRoot } from './paths.mjs';
import { runModel, usageOf } from './review-worker.mjs';
import { destinationsText } from './router.mjs';
import { languageRule, rubricText } from './rubric.mjs';

const BATCH = 12;
const EXCERPTS_PER_PROPOSAL = 4;
const EXCERPT_CHARS = 900;
const REJECTIONS_DAYS = 180;

export const DROP_KINDS = ['covered', 'one_off', 'derivable', 'default_behavior', 'unverified', 'stale', 'low_value', 'rejected_before'];

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
          verdict: { type: 'string', enum: ['keep', 'drop', 'merge', 'route', 'fix'] },
          reason: { type: 'string' },
          rule: { type: 'string' },
          drop_kind: { type: 'string', enum: DROP_KINDS },
          covered_by: { type: 'string' },
          merge_into: { type: 'integer' },
          owner: { type: 'string' },
          section: { type: 'string' },
          claim: { type: 'string' },
          fix: { type: 'string' },
          stale: {
            type: 'object',
            additionalProperties: false,
            required: ['file', 'claim', 'source'],
            properties: { file: { type: 'string' }, claim: { type: 'string' }, source: { type: 'string' } },
          },
          rewrite: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', enum: ['global', 'preference', 'memory', 'skill'] },
              topic: { type: 'string' },
              paths: { type: 'array', items: { type: 'string' } },
              memory_type: { type: 'string', enum: ['feedback', 'project', 'reference'] },
              scope: { type: 'string', enum: ['global', 'project'] },
              title: { type: 'string' },
              description: { type: 'string' },
              text: { type: 'string' },
              body: { type: 'string' },
            },
          },
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
          claim: { type: 'string' },
        },
      },
    },
  },
};

export { languageRule };

export function describe(p) {
  return [
    `kind=${p.kind}${p.memory_type ? `/${p.memory_type}` : ''}${p.block ? `/${p.block}` : ''}${p.scope ? ` scope=${p.scope}` : ''}${p.op === 'patch' ? ` op=patch target=${p.target}` : ''}`,
    `title: ${p.title || ''}`,
    p.topic ? `topic: ${p.topic}${p.paths?.length ? ` (files: ${[].concat(p.paths).join(', ')})` : ''}` : '',
    p.claim ? `claim: ${p.claim}` : '',
    p.target && p.op !== 'patch' ? `previously routed to: ${p.target}` : '',
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
  skill: 'skill (owner)', rules: 'rule file (owner, needs approval)', instructions: 'CLAUDE.md (owner, needs approval)',
  memory: 'memory (owner)', source: 'SOURCE OF TRUTH (read-only)', rejected: 'REJECTED BEFORE by the user',
};

export function triagePrompt({ batch, others, excerpts, owners, lang }) {
  return `You curate what an AI coding assistant remembers between sessions. Screen each PROPOSAL with the rubric and decide where it belongs, using the EXCERPTS (what is already written, sources of truth, and proposals the user rejected before) and the OWNERS map (which skill or rule file owns which topic). You do NOT write changes to existing files: an editor later reads the whole owner file, checks the project's code and writes the change.

RUBRIC — a proposal is saved only if it passes every rule:
${rubricText()}

DESTINATIONS — where a learning belongs (the first that fits):
${destinationsText()}

VERDICTS (set "rule" to the id of the rubric rule that decided it):
- "drop" with drop_kind: covered (an excerpt already says it; set covered_by to the file), one_off, derivable, default_behavior, unverified (a source of truth contradicts it), stale, low_value, rejected_before (the user already rejected the same thing).
- "merge" with merge_into: another proposal (in THIS BATCH or OTHER PROPOSALS) says the same thing in any language, kind or target. The one it merges into must not be dropped.
- "route": the topic has an owner — a skill or one of its reference files, a rule file, a CLAUDE.md, or a memory (from OWNERS or EXCERPTS) — and the proposal may add to it or correct it. Set owner = the owner's full path (a reference file is its skill's folder + the listed relative path), claim = the knowledge as ONE self-contained statement (what is true or what to do, and the reason when the proposal gives one), section = the heading it belongs under when obvious. Choose the owner an assistant would read when the topic comes up. Do not try to judge whether the owner already says it in parts you cannot see: the editor checks the whole file. Prefer this over "keep" whenever an owner exists.
- "fix": the proposal documents a workaround for something the project could fix once (a generated file not ignored, a broken script, a missing config line). Set fix = the change to make in the project, in one sentence. Nothing is learned.
- "keep": worth saving as new and no owner fits. Give a rewrite that picks the right kind by the DESTINATIONS order ("preference" = one sentence valid on every project that matters for one topic or kind of file, in "text", with "topic" and optional "paths"; "global" = one sentence relevant in every session whatever the task, in "text", added to the user's global CLAUDE.md; "memory" = one project's fact with "description" and a "body" holding the fact plus "**Why:**" and "**How to apply:**"; "skill" = a reusable multi-step procedure with description ≤ 250 chars saying when to use it), uses a short human-readable title (never a slug), and removes details that will go stale.
- Stale owners: whatever the verdict, if an excerpt shows a skill, rule, CLAUDE.md or memory that a SOURCE OF TRUTH contradicts on this proposal's topic, also set stale = { file: that file's path, claim: the corrected statement, source: the path of the SOURCE OF TRUTH excerpt that shows it }. Only a source-of-truth excerpt counts: a user preference, a session event or another doc is never a stale flag. This is how outdated documentation gets repaired.

${languageRule(lang)} Keep code identifiers, commands and file names as they are.
Answer once for every proposal id in THIS BATCH.

OWNERS (skills and rule files: name — description — sections — reference files):
${owners.map((o) => `- [${o.kind}] ${o.name} (${o.file}) — ${o.description}${o.headings.length ? ` — sections: ${o.headings.join(' | ')}` : ''}${o.references?.length ? ` — references: ${o.references.join(', ')}` : ''}`).join('\n') || '(none)'}

OTHER PROPOSALS (for duplicates across batches; decide only THIS BATCH):
${others.map((o) => `#${o.id} ${o.kind}: ${o.title}${o.claim ? ` — ${String(o.claim).slice(0, 160)}` : ''}`).join('\n') || '(none)'}

EXCERPTS:
${excerpts.map((e) => `<excerpt file="${e.file}" kind="${KIND_LABEL[e.kind] || e.kind}"${e.heading ? ` heading="${e.heading}"` : ''}>\n${e.text.slice(0, EXCERPT_CHARS)}\n</excerpt>`).join('\n') || '(none found)'}

THIS BATCH:
${batch.map((p) => `<proposal id="${p.id}">\n${describe(p)}\n</proposal>`).join('\n')}`;
}

export function dedupePrompt({ items, lang }) {
  return `These learnings are about to be saved for an AI coding assistant, as new notes or as changes to an existing file (→ owner). Find groups that state the same rule or fact (in any language, kind, wording or owner) and should be saved ONCE. Do not group items that merely share a topic but say different things.

For each group: "keep" is the id to keep — when they go to different owners, the one whose owner an assistant would read when the topic comes up — and "merge" the ids folded into it. Give the combined "claim" (changes to an owner) or "title", "description" and "body" (new memories) or "text" (global facts), with every detail of the group. Return an empty list if there are no duplicates. ${languageRule(lang)}

${items.map((i) => [`#${i.id} [${i.kind}${i.owner ? ` → ${i.owner}` : ''}] ${i.title}`, i.claim, i.description, i.text, i.body && String(i.body).slice(0, 600)].filter(Boolean).join('\n')).join('\n\n')}`;
}

/** Proposals the user rejected or undid recently, as extra documents for the index. */
export function rejectionDocs(db, { exclude = [] } = {}) {
  if (!db) return [];
  const since = Date.now() - REJECTIONS_DAYS * 86_400_000;
  const skip = new Set(exclude);
  const rejected = db.prepare("SELECT id, title, summary, claim FROM candidates WHERE outcome IN ('rejected_by_user', 'undone') AND COALESCE(decided_at, ts) >= ?").all(since)
    .filter((r) => !skip.has(r.id))
    .map((r) => ({ file: '(rejected proposal)', kind: 'rejected', heading: r.title, text: `${r.title}\n${r.claim || r.summary || ''}` }));
  const undone = db.prepare("SELECT title, path FROM learnings WHERE status = 'reverted' AND updated_at >= ?").all(since)
    .map((r) => ({ file: '(undone learning)', kind: 'rejected', heading: r.title, text: `${r.title} (was saved to ${r.path} and undone by the user)` }));
  // A learning whose file was deleted outside Ouroboros (by the user, or by Claude Code tidying its memory).
  // (not a file in a git working tree: there it may only be on another branch)
  const removed = db.prepare("SELECT title, path FROM learnings WHERE status = 'removed' AND origin_session IS NOT 'native' AND updated_at >= ?").all(since)
    .filter((r) => !gitRoot(path.dirname(r.path)))
    .map((r) => ({ file: '(deleted learning)', kind: 'rejected', heading: r.title, text: `${r.title} (was saved to ${r.path}; the file was deleted afterwards, outside Ouroboros)` }));
  return [...rejected, ...undone, ...removed];
}

/**
 * Screen proposals ({id, kind, title, description, text, body, claim, ...}) for one
 * project dir. Returns { verdicts: Map(id -> verdict), cost, calls }.
 */
export async function triage(proposals, { cwd, db = null, lang = options().learningLanguage, model = options().judgeModel, exclude = [], record = () => {} } = {}) {
  const call = async (args) => {
    if (db) assertBudget(db, options().monthlyBudgetUsd);
    const result = await runModel(args);
    record(usageOf(result));
    return result;
  };
  const index = buildIndex(cwd, { extra: rejectionDocs(db, { exclude }) });
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
      const query = [p.title, p.claim, p.description, p.text, p.body, p.target, p.append].filter(Boolean).join(' ');
      for (const hit of index.search(query, EXCERPTS_PER_PROPOSAL)) take(hit);
      // Always look at the best source of truth and past rejection, even if they rank lower.
      for (const hit of index.search(query, 1, { kinds: ['source'] })) take(hit);
      for (const hit of index.search(query, 1, { kinds: ['rejected'] })) if (hit.score > 4) take(hit);
    }
    const others = proposals.filter((p) => !batch.includes(p));
    const result = await call({ prompt: triagePrompt({ batch, others, excerpts, owners, lang }), schema: TRIAGE_SCHEMA, model });
    cost += Number(result.total_cost_usd) || 0;
    calls++;
    for (const v of result.structured_output.verdicts || []) {
      if (batch.some((p) => p.id === v.id)) verdicts.set(v.id, v);
    }
  }

  // Batches only see each other's titles: one more pass over everything that will be
  // saved catches duplicates across batches, including the same fact sent to two owners.
  const survivors = proposals.filter((p) => ['keep', 'route'].includes(verdicts.get(p.id)?.verdict));
  if (proposals.length > BATCH && survivors.length > 1) {
    const items = survivors.map((p) => {
      const v = verdicts.get(p.id);
      return v.verdict === 'route' ? { id: p.id, kind: p.kind, title: p.title, owner: v.owner, claim: v.claim } : { id: p.id, ...rewriteItem(p, v) };
    });
    const result = await call({ prompt: dedupePrompt({ items, lang }), schema: DEDUPE_SCHEMA, model });
    cost += Number(result.total_cost_usd) || 0;
    calls++;
    const ids = new Set(items.map((k) => k.id));
    for (const g of result.structured_output.groups || []) {
      const merge = (g.merge || []).filter((id) => id !== g.keep && ids.has(id));
      if (!ids.has(g.keep) || !merge.length) continue;
      const v = verdicts.get(g.keep);
      if (v.verdict === 'route') {
        if (g.claim) v.claim = g.claim;
      } else {
        v.rewrite = { ...(v.rewrite || {}), ...Object.fromEntries(['title', 'description', 'text', 'body'].filter((k) => g[k]).map((k) => [k, g[k]])) };
      }
      for (const id of merge) verdicts.set(id, { id, verdict: 'merge', merge_into: g.keep, reason: g.reason, stale: verdicts.get(id)?.stale });
    }
  }
  resolveMerges(verdicts, proposals);
  return { verdicts, cost, calls };
}

/**
 * A merge must land in a proposal that survives. Follow merge chains: when the target
 * is dropped or becomes a fix, the merged one shares that verdict (with its reason, so
 * it stays visible and restorable); when the target is unknown or the chain loops, the
 * merged one is kept and judged on its own.
 */
export function resolveMerges(verdicts, proposals) {
  const ids = new Set(proposals.map((p) => p.id));
  for (const [id, v] of verdicts) {
    if (v.verdict !== 'merge') continue;
    const seen = new Set([id]);
    let target = v.merge_into;
    let t = verdicts.get(target);
    while (t?.verdict === 'merge' && !seen.has(target)) {
      seen.add(target);
      target = t.merge_into;
      t = verdicts.get(target);
    }
    if (!ids.has(target) || !t || seen.has(target)) {
      verdicts.set(id, { ...v, verdict: 'keep', merge_into: undefined, reason: `kept: it was to merge into #${v.merge_into}, which is not being saved (${v.reason})` });
    } else if (t.verdict === 'drop') {
      verdicts.set(id, { ...v, verdict: 'drop', drop_kind: t.drop_kind, rule: t.rule, covered_by: t.covered_by, reason: `same as #${target}, dropped: ${t.reason}` });
    } else if (t.verdict === 'fix') {
      verdicts.set(id, { ...v, verdict: 'fix', fix: t.fix, rule: t.rule, reason: `same as #${target}: ${t.reason}` });
    } else if (target !== v.merge_into) {
      verdicts.set(id, { ...v, merge_into: target });
    }
  }
}

/** Apply a "keep" verdict's rewrite on top of the original proposal. */
export function rewriteItem(item, v) {
  const r = v?.rewrite || {};
  const next = { ...item };
  for (const k of ['kind', 'memory_type', 'scope', 'title', 'description', 'text', 'body', 'topic', 'paths']) {
    if (r[k] !== undefined && r[k] !== '') next[k] = r[k];
  }
  // A re-screened change to an owner that is now kept as new starts as a plain create.
  if (next.op === 'patch') {
    next.op = 'create';
    if (!next.body && !next.text) next.body = next.append ?? next.new ?? next.claim ?? '';
    for (const k of ['target', 'targetKind', 'append', 'section', 'old', 'new', 'corrects']) delete next[k];
  }
  if (next.kind === 'profile') next.kind = 'global';
  if (next.kind === 'global') {
    next.scope = 'global';
    delete next.memory_type;
    // A global fact is its text; keep the title in step with it.
    if (r.text) next.title = r.text.length > 90 ? `${r.text.slice(0, 87)}…` : r.text;
  }
  delete next.block;
  return next;
}

export function noteFor(v) {
  const rule = v.rule ? ` [${v.rule}]` : '';
  if (v.verdict === 'drop') return `${(v.drop_kind || 'dropped').replace(/_/g, ' ')}${rule}: ${v.reason}${v.covered_by ? ` (${v.covered_by})` : ''}`;
  if (v.verdict === 'merge') return `merged into #${v.merge_into}: ${v.reason}`;
  if (v.verdict === 'fix') return `fix in the project${rule}: ${v.fix || v.reason}`;
  if (v.verdict === 'route') return `for ${v.owner}: ${v.reason}`;
  return null;
}
