// Learning evaluation: what happens to every proposed learning before anything is
// written or queued. Four stages:
//   1. screen   (triage.mjs) the rubric, against excerpts of what is known: drop, merge,
//               keep as new, route to the file that owns the topic, or suggest a fix
//   2. ground   what the project's tracked code and config say about the identifiers
//               the learnings name (no model)
//   3. edit     ONE model call per owner file: it reads the whole file with every
//               learning pending for it (new and already queued) and the grounding,
//               judges each (covered / contradicted / adds / corrects / conflict) and
//               writes one coherent set of exact-fragment edits
//   4. validate (changesets.mjs) edits are applied by code, never by the model, and
//               only when safe; the result is one changeset per file
// A learning is written only when the screen and the editor both say so.
import fs from 'node:fs';
import path from 'node:path';
import { options } from './config.mjs';
import { apply as curatorApply } from './curator.mjs';
import { applyChangeset, applyEdits, changesetNeedsApproval, claimsOf, getChangeset, pendingChangeset, saveChangeset } from './changesets.mjs';
import { logError } from './db.mjs';
import { groundIdentifiers, identifiersIn, knowledgeKind, PATCHABLE, resolveOwner, tokenize } from './knowledge.mjs';
import { insertReview, runModel, usageOf } from './review-worker.mjs';
import { describe, noteFor, rewriteItem, triage } from './triage.mjs';

const FULL_FILE_CHARS = 40_000;
const VIEW_BUDGET_CHARS = 24_000;

export const EDITOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['claims', 'edits'],
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'reason'],
        properties: {
          id: { type: 'integer' },
          status: { type: 'string', enum: ['adds', 'corrects', 'covered', 'contradicted', 'conflict'] },
          reason: { type: 'string' },
          conflicts_with: { type: 'integer' },
        },
      },
    },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['old', 'new', 'claims'],
        properties: {
          old: { type: 'string' },
          new: { type: 'string' },
          claims: { type: 'array', items: { type: 'integer' } },
          why: { type: 'string' },
        },
      },
    },
  },
};

const KIND_DESC = {
  skill: 'a skill (a procedure the assistant loads when the task matches) or one of its reference files',
  rules: 'a project rule file (loaded when the assistant works on matching files)',
  instructions: 'a CLAUDE.md (instructions loaded in every session of the project)',
  memory: 'a project memory note',
};

/**
 * What the editor sees of a file: all of it, or for a very large file an outline plus
 * the blocks most related to the claims, verbatim (edits must copy from them).
 */
export function fileView(text, claimsText) {
  if (text.length <= FULL_FILE_CHARS) return { text, partial: false };
  const want = new Set(tokenize(claimsText));
  const blocks = [];
  let start = 0;
  for (const m of text.matchAll(/\n\s*\n/g)) {
    blocks.push({ at: start, text: text.slice(start, m.index) });
    start = m.index + m[0].length;
  }
  blocks.push({ at: start, text: text.slice(start) });
  const scored = blocks.map((b, i) => ({ i, b, score: tokenize(b.text).filter((t) => want.has(t)).length + (/^#{1,6}\s/.test(b.text) ? 0.5 : 0) }));
  const pick = new Set();
  let used = 0;
  for (const s of [...scored].sort((a, b) => b.score - a.score)) {
    if (s.score <= 0) break;
    if (used && used + s.b.text.length > VIEW_BUDGET_CHARS) continue;
    pick.add(s.i);
    used += s.b.text.length;
  }
  const outline = (text.match(/^#{1,6}\s+.+$/gm) || []).join('\n');
  const parts = [];
  let last = -1;
  for (const i of [...pick].sort((a, b) => a - b)) {
    if (i !== last + 1) parts.push('[…]');
    parts.push(blocks[i].text);
    last = i;
  }
  if (last !== blocks.length - 1) parts.push('[…]');
  return { text: `OUTLINE:\n${outline}\n\nEXCERPTS (verbatim):\n${parts.join('\n\n')}`, partial: true };
}

export function editorPrompt({ file, kind, view, claims, grounding }) {
  return `You maintain one file that an AI coding assistant reads as knowledge: ${KIND_DESC[kind] || 'a knowledge file'}. Learnings (CLAIMS) were proposed for it. Decide what each one means for this file and write the edits.

STATUS of each claim:
- "covered": the file already says it, in any words. No edit.
- "contradicted": the PROJECT EVIDENCE (tracked code, scripts, config) shows the claim is false or outdated, or it names things that do not exist. No edit.
- "adds": true, lasting, and missing from the file. Add it where it belongs.
- "corrects": the file states something that the claim shows is wrong or outdated, and the claim is backed by the project evidence or by the user. Replace the wrong text.
- "conflict": it contradicts another claim or the file, and neither the project evidence nor recency settles it (set conflicts_with when it is another claim). No edit.
When two claims disagree, prefer the one the project evidence confirms, then the one from the more recent session.
Read the whole file for each claim: text elsewhere in the file that says the opposite must be corrected by the same edits, or the file would contradict itself.

EDITS:
- "old" is an exact fragment copied character for character from the FILE below (a whole line or sentence, long enough to be unique); "new" replaces it.
- To add, pick the line after which the addition belongs (the end of the right section or list): old = that line, new = that same line, a newline, then the addition. Match the surrounding format (bullet, table row, numbered step).
- Write as the file does: same language, tone and density, as short as its other entries. No dates, PR or issue numbers, session details or people's names unless the file already does that.
- Only "corrects" edits may remove text, and only the wrong part. Never touch the frontmatter (the --- block at the top).
- One edit may serve several claims: list their ids in "claims". Never write two edits that touch the same text.
- No edit for covered, contradicted or conflict claims. Answer once for every claim id.
${view.partial ? '- The file is large: you see its outline and the parts related to the claims. Copy "old" only from what you see.\n' : ''}
FILE ${file}:
<file>
${view.text}
</file>

CLAIMS:
${claims.map((c) => `<claim id="${c.id}"${c.when ? ` session="${c.when}"` : ''}${c.confidence ? ` confidence="${c.confidence}"` : ''}${c.corrects ? ' reported_stale="yes"' : ''}>\n${c.claim}${c.evidence ? `\nevidence: ${c.evidence}` : ''}\n</claim>`).join('\n')}

PROJECT EVIDENCE (where the project's tracked code and config mention what the claims name; "not found" means no tracked file mentions it):
${grounding.length ? grounding.map((g) => (g.hits.length
    ? `- \`${g.id}\`:\n${g.hits.map((h) => `    ${h.file}:${h.line}: ${h.text}`).join('\n')}`
    : `- \`${g.id}\`: ${g.exists ? 'exists' : 'not found'}`)).join('\n') : '(nothing to look up)'}`;
}

/**
 * Stage 3+4 for one file: the editor judges every claim and writes edits; code keeps
 * the safe ones. Returns { status: Map(id -> {status, reason}), applied, rejected, base, cost }.
 */
export async function composeFile({ file, claims, cwd, model }) {
  const base = fs.readFileSync(file, 'utf8');
  const kind = knowledgeKind(file);
  const all = claims.map((c) => c.claim).join('\n');
  const grounding = groundIdentifiers(identifiersIn(all), cwd);
  const view = fileView(base, all);
  const result = await runModel({ prompt: editorPrompt({ file, kind, view, claims, grounding }), schema: EDITOR_SCHEMA, model });
  const out = result.structured_output;
  const status = new Map();
  for (const s of out.claims || []) if (claims.some((c) => c.id === s.id)) status.set(s.id, s);
  const writes = (id) => ['adds', 'corrects'].includes(status.get(id)?.status);
  const edits = (out.edits || []).map((e) => ({
    old: e.old, new: e.new, why: e.why || '',
    claims: (e.claims || []).filter((id) => claims.some((c) => c.id === id)),
    corrects: (e.claims || []).some((id) => status.get(id)?.status === 'corrects'),
  }));
  const justified = edits.filter((e) => e.claims.some(writes));
  const unjustified = edits.filter((e) => !e.claims.some(writes)).map((edit) => ({ edit, reason: 'no learning justifies it' }));
  const { applied, rejected } = applyEdits(base, justified);
  return { status, applied, rejected: [...unjustified, ...rejected], base, usage: usageOf(result) };
}

// ---------- outcomes ----------

function setOutcome(db, id, outcome, note, extra = {}) {
  const now = Date.now();
  const fields = { outcome, note: note ?? null, triaged_at: now, decided_at: outcome === 'queued' ? null : now, ...extra };
  const keys = Object.keys(fields);
  db.prepare(`UPDATE candidates SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
}

function when(row) {
  return row.session_started_at ? new Date(row.session_started_at).toISOString().slice(0, 10) : undefined;
}

/** A claim the editor can judge, from a candidate row. */
function claimFrom(row, overrides = {}) {
  let item = {};
  try { item = JSON.parse(row.payload || '{}').item || {}; } catch { /* ignore */ }
  const text = row.claim || item.append || item.new || [item.description, item.text, item.body].filter(Boolean).join('\n') || row.summary || row.title;
  return { id: row.id, title: row.title, claim: String(text).slice(0, 2000), evidence: row.evidence, when: when(row), confidence: row.confidence, ...overrides };
}

/**
 * Compose the changes for each owner file. `routes`: Map(file -> [claim]). Claims
 * already pending for a file are judged again together with the new ones, and the
 * file's previous pending changeset is replaced.
 */
export async function composeRoutes(db, routes, ctx) {
  const report = { changesets: 0, applied: 0, queued: 0, covered: 0, contradicted: 0, conflicts: 0, unwritten: 0, cost: 0, calls: 0, results: [] };
  for (const [file, fresh] of routes) {
    const pending = pendingChangeset(db, file);
    const stale = db.prepare("SELECT id FROM changesets WHERE status = 'stale' AND lower(file) = lower(?)").all(file).map((r) => r.id);
    const previous = [pending?.id, ...stale].filter(Boolean);
    const carried = previous.flatMap((id) => claimsOf(db, id)).filter((c) => !fresh.some((f) => f.id === c.id)).map((c) => claimFrom(c));
    const claims = [...carried, ...fresh];
    if (!claims.length) continue;
    let composed;
    try {
      composed = await composeFile({ file, claims, cwd: ctx.cwd, model: ctx.model });
    } catch (err) {
      logError(db, 'evaluate:editor', err);
      // Leave them waiting: the next queue check tries again.
      for (const c of fresh) setOutcome(db, c.id, 'queued', `could not compose the change to ${file} yet`, { triaged_at: null, target: file });
      continue;
    }
    report.calls++;
    report.cost += composed.usage.cost;
    insertReview(db, { sessionId: ctx.sessionId || 'maintenance', mode: ctx.sessionId ? 'background' : 'maintenance', trigger: 'editor', model: ctx.model, status: 'ok', usage: composed.usage, sessionStartedAt: ctx.sessionStartedAt });

    const appliedFor = (id) => composed.applied.some((e) => e.claims.includes(id));
    const rejectedFor = (id) => composed.rejected.filter((r) => r.edit.claims?.includes(id)).map((r) => r.reason);
    const inChangeset = [];
    for (const c of claims) {
      const s = composed.status.get(c.id);
      const where = path.basename(file);
      if (!s) { setOutcome(db, c.id, 'queued', null, { triaged_at: null, target: file, changeset_id: null }); continue; }
      if (s.status === 'covered') {
        report.covered++;
        setOutcome(db, c.id, c.duplicateOf ? 'duplicate' : 'dropped', `covered [editor]: ${s.reason} (${file})`, { target: file, changeset_id: null });
      } else if (s.status === 'contradicted') {
        report.contradicted++;
        setOutcome(db, c.id, 'dropped', `unverified [editor]: ${s.reason}`, { target: file, changeset_id: null });
      } else if (s.status === 'conflict') {
        report.conflicts++;
        setOutcome(db, c.id, 'dropped', `conflict [editor]${s.conflicts_with ? ` with #${s.conflicts_with}` : ''}: ${s.reason}`, { target: file, changeset_id: null });
      } else if (!appliedFor(c.id)) {
        report.unwritten++;
        setOutcome(db, c.id, 'dropped', `not written to ${where}: ${rejectedFor(c.id).join('; ') || 'no edit was given'}`, { target: file, changeset_id: null });
      } else {
        inChangeset.push(c.id);
        db.prepare('UPDATE candidates SET note = ?, claim = ?, target = ?, triaged_at = ? WHERE id = ?')
          .run(`${s.status === 'corrects' ? `✎ corrects ${file}` : `adds to ${file}`}: ${s.reason}`, c.claim, file, Date.now(), c.id);
      }
    }
    for (const id of previous) db.prepare("UPDATE changesets SET status = 'superseded', decided_at = ? WHERE id = ? AND status IN ('pending', 'stale')").run(Date.now(), id);
    if (!inChangeset.length) continue;
    const note = composed.rejected.length ? `left out: ${composed.rejected.map((r) => r.reason).join('; ')}` : null;
    const csId = saveChangeset(db, { file, cwd: ctx.cwd, base: composed.base, edits: composed.applied, claimIds: inChangeset, note, cost: composed.usage.cost });
    report.changesets++;
    const cs = getChangeset(db, csId);
    if (!changesetNeedsApproval(db, cs, ctx.actor, ctx.autonomy)) {
      const r = applyChangeset(db, csId, { actor: ctx.actor });
      if (r.status === 'patched') {
        report.applied++;
        report.results.push({ status: 'patched', title: path.basename(file), claims: inChangeset.length, changesetId: csId });
        continue;
      }
    }
    report.queued++;
    report.results.push({ status: 'queued', title: `${path.basename(file)} (${inChangeset.length} change${inChangeset.length > 1 ? 's' : ''})`, changesetId: csId });
  }
  return report;
}

/**
 * Evaluate candidate rows (already recorded, with their proposal in `payload`).
 * ctx: { cwd, sessionId, sessionStartedAt, actor, autonomy, lang, model, payload }.
 */
export async function evaluate(db, rows, ctx) {
  const report = { total: rows.length, kept: 0, created: 0, dropped: 0, merged: 0, routed: 0, suggested: 0, stale: 0, queued: 0, patched: 0, cost: 0, calls: 0, byRule: {}, results: [] };
  if (!rows.length) return report;
  const items = new Map(rows.map((r) => {
    let item = {};
    try { item = JSON.parse(r.payload || '{}').item || {}; } catch { /* ignore */ }
    return [r.id, item];
  }));
  const proposals = rows.map((r) => ({ id: r.id, ...items.get(r.id), claim: r.claim || undefined, target: r.target || undefined, evidence: r.evidence, when: when(r) }));
  const screen = await triage(proposals, { cwd: ctx.cwd, db, lang: ctx.lang, model: ctx.model, exclude: rows.map((r) => r.id) });
  report.cost += screen.cost;
  report.calls += screen.calls;
  insertReview(db, { sessionId: ctx.sessionId || 'maintenance', mode: ctx.sessionId ? 'background' : 'maintenance', trigger: 'triage', model: ctx.model, status: 'ok', usage: { cost: screen.cost }, sessionStartedAt: ctx.sessionStartedAt });

  const routes = new Map();
  const route = (file, claim) => {
    if (!routes.has(file)) routes.set(file, []);
    if (!routes.get(file).some((c) => c.id === claim.id)) routes.get(file).push(claim);
  };
  const creates = [];
  for (const row of rows) {
    const v = screen.verdicts.get(row.id);
    const item = items.get(row.id);
    if (v?.rule) report.byRule[v.rule] = (report.byRule[v.rule] || 0) + 1;
    if (v?.stale) {
      // The screen saw documentation a source of truth contradicts: a correction claim.
      const owner = resolveOwner(v.stale.file, ctx.cwd);
      if (owner && PATCHABLE.has(knowledgeKind(owner)) && knowledgeKind(owner) !== 'profile') {
        const r = db.prepare(`
          INSERT INTO candidates (review_id, session_id, project, kind, scope, title, summary, evidence, confidence, outcome, cwd, claim, target, payload, ts)
          VALUES (0, ?, ?, 'memory', 'project', ?, ?, ?, 0.7, 'queued', ?, ?, ?, ?, ?)`).run(
          row.session_id, row.project, `Outdated: ${path.basename(owner)}`.slice(0, 200), v.stale.claim.slice(0, 1500),
          `found while checking #${row.id}: ${v.reason}`.slice(0, 800), ctx.cwd || null, v.stale.claim, owner,
          JSON.stringify({ item: { op: 'create', kind: 'memory', title: `Outdated: ${path.basename(owner)}`, body: v.stale.claim }, cwd: ctx.cwd }), Date.now());
        route(owner, { id: Number(r.lastInsertRowid), title: `Outdated: ${path.basename(owner)}`, claim: v.stale.claim, evidence: `a source of truth contradicts ${owner}`, confidence: 0.7, corrects: true });
        report.stale++;
      }
    }
    if (!v) { creates.push({ row, item }); continue; }
    if (v.verdict === 'drop' || v.verdict === 'merge') {
      report[v.verdict === 'drop' ? 'dropped' : 'merged']++;
      setOutcome(db, row.id, v.verdict === 'drop' ? 'dropped' : 'merged', noteFor(v), { changeset_id: null });
    } else if (v.verdict === 'fix') {
      report.suggested++;
      setOutcome(db, row.id, 'suggested', noteFor(v), { changeset_id: null });
    } else if (v.verdict === 'route') {
      const owner = resolveOwner(v.owner, ctx.cwd);
      const kind = owner && knowledgeKind(owner);
      const claim = v.claim || describe(item);
      if (owner && kind === 'profile') {
        creates.push({ row, item: rewriteItem(item, { rewrite: { kind: 'profile', block: /user/i.test(v.section || '') ? 'user' : 'environment', text: claim } }) });
      } else if (owner && PATCHABLE.has(kind)) {
        report.routed++;
        db.prepare('UPDATE candidates SET claim = ?, target = ? WHERE id = ?').run(claim, owner, row.id);
        route(owner, { ...claimFrom({ ...row, claim }), title: row.title });
      } else {
        creates.push({ row, item: rewriteItem(item, v), note: `kept as new (owner not found: ${v.owner || 'none'})` });
      }
    } else {
      creates.push({ row, item: rewriteItem(item, v), note: noteFor(v) });
    }
  }

  // New items go through the curator (dedupe, budgets, approval rules).
  for (const { row, item, note } of creates) {
    if (item.op === 'patch') {
      // An unscreened change to a file: let the editor compose it.
      const owner = resolveOwner(item.target, ctx.cwd);
      if (owner) { route(owner, claimFrom(row)); continue; }
    }
    const [r] = curatorApply(db, { ...(ctx.payload || {}), cwd: ctx.cwd, session_id: row.session_id, items: [{ ...item, candidateId: row.id }] }, { actor: ctx.actor, autonomy: ctx.autonomy });
    report.kept++;
    if (r.status === 'duplicate' && r.target && fs.existsSync(String(r.target))) {
      // Seeing it again reinforces the saved one, and the editor folds in what is new.
      db.prepare("UPDATE learnings SET confidence = MIN(0.9, COALESCE(confidence, 0.5) + 0.1), updated_at = ? WHERE status = 'active' AND lower(path) = lower(?)").run(Date.now(), r.target);
      route(path.resolve(String(r.target)), claimFrom({ ...row, claim: [item.description, item.text, item.body].filter(Boolean).join('\n') || item.title }, { duplicateOf: r.target }));
      db.prepare('UPDATE candidates SET outcome = ?, note = ? WHERE id = ?').run('duplicate', `similar to ${r.target}`, row.id);
      continue;
    }
    if (r.status === 'queued') {
      report.queued++;
      db.prepare('UPDATE candidates SET note = COALESCE(?, note), triaged_at = ? WHERE id = ?').run(note || null, Date.now(), r.candidateId);
    } else {
      if (r.status === 'created') report.created++;
      db.prepare('UPDATE candidates SET outcome = ?, learning_id = ?, note = ?, triaged_at = ?, decided_at = ? WHERE id = ?')
        .run(r.status, r.id || null, r.reason ? `${note ? `${note}; ` : ''}${r.reason}` : note || null, Date.now(), Date.now(), row.id);
    }
    report.results.push({ status: r.status, title: r.title || item.title, candidateId: row.id });
  }

  const composed = await composeRoutes(db, routes, ctx);
  report.cost += composed.cost;
  report.calls += composed.calls;
  report.patched += composed.applied;
  report.queued += composed.queued;
  report.editor = { changesets: composed.changesets, covered: composed.covered, contradicted: composed.contradicted, conflicts: composed.conflicts, unwritten: composed.unwritten };
  report.results.push(...composed.results);
  return report;
}

// ---------- the approval queue ----------

/**
 * Evaluate the approval queue: untriaged proposals, and changesets that went stale
 * (the file changed, or the user removed one of their learnings). `force` evaluates
 * everything waiting again, from scratch. Records the cost as a maintenance review.
 */
export async function tidyQueue(db, { force = false, autonomy = 'queue' } = {}) {
  const opts = options();
  if (force) {
    db.prepare("UPDATE changesets SET status = 'superseded', decided_at = ? WHERE status IN ('pending', 'stale')").run(Date.now());
    db.prepare("UPDATE candidates SET changeset_id = NULL, triaged_at = NULL WHERE outcome = 'queued'").run();
  }
  const rows = db.prepare(`
    SELECT c.*, s.started_at session_started_at FROM candidates c LEFT JOIN sessions s ON s.id = c.session_id
    WHERE c.outcome = 'queued' AND c.changeset_id IS NULL AND c.triaged_at IS NULL
    ORDER BY COALESCE(s.started_at, c.ts), c.id`).all();
  const staleSets = db.prepare("SELECT * FROM changesets WHERE status = 'stale'").all();
  const report = { total: rows.length, recomposed: 0, kept: 0, created: 0, dropped: 0, merged: 0, routed: 0, suggested: 0, stale: 0, queued: 0, patched: 0, cost: 0, byRule: {} };
  if (!rows.length && !staleSets.length) return report;

  // Retrieval and grounding depend on the project, so evaluate one directory at a time.
  const groups = new Map();
  const group = (cwd) => {
    const key = cwd || '';
    if (!groups.has(key)) groups.set(key, { rows: [], stale: [] });
    return groups.get(key);
  };
  for (const r of rows) {
    let payload = {};
    try { payload = JSON.parse(r.payload || '{}'); } catch { /* ignore */ }
    group(payload.cwd || r.cwd).rows.push(r);
  }
  for (const cs of staleSets) group(cs.cwd).stale.push(cs);

  for (const [cwd, g] of groups) {
    const ctx = { cwd: cwd || undefined, actor: 'background', autonomy, lang: opts.learningLanguage, model: opts.reviewerModel, payload: { trigger: 'session_end' } };
    if (g.rows.length) {
      const r = await evaluate(db, g.rows, ctx);
      for (const k of ['kept', 'created', 'dropped', 'merged', 'routed', 'suggested', 'stale', 'queued', 'patched', 'cost']) report[k] += r[k] || 0;
      for (const [rule, n] of Object.entries(r.byRule)) report.byRule[rule] = (report.byRule[rule] || 0) + n;
    }
    if (g.stale.length) {
      const routes = new Map();
      for (const cs of g.stale) if (!routes.has(cs.file)) routes.set(cs.file, []);
      const r = await composeRoutes(db, routes, ctx);
      report.recomposed += g.stale.length;
      report.cost += r.cost;
      report.queued += r.queued;
      report.patched += r.applied;
    }
  }
  db.prepare("INSERT INTO reviews (session_id, mode, trigger, model, status, detail, cost_usd, ts) VALUES ('maintenance', 'maintenance', 'triage-summary', ?, 'ok', ?, 0, ?)")
    .run(opts.reviewerModel, JSON.stringify(report), Date.now());
  return report;
}
