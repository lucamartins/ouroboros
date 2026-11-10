// Changesets: the unit Ouroboros writes and the user approves. A changeset holds every
// pending change to ONE knowledge file, composed together (by the editor, or from a
// patch Claude wrote in session), so two learnings can never make conflicting edits
// to the same file. Edits are exact fragments the model chose; this module decides
// whether they are safe to apply, and applies them through the curator's ledger.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appendToSection, containsSecret, createdByOuroboros, needsApproval, writeText } from './curator.mjs';
import { knowledgeKind } from './knowledge.mjs';
import { projectIdFor } from './paths.mjs';
import { addedText, isInsertion } from './textdiff.mjs';

/** A changeset may grow a file by at most this many characters. */
export const MAX_GROWTH_CHARS = 6000;
/** A correcting edit may remove at most this much text; other edits only add. */
export const MAX_REMOVED_CHARS = 800;
const MIN_OLD_CHARS = 4;

/**
 * A knowledge file as people name it: a skill's SKILL.md by the skill ("acme-local"), a
 * skill's reference file as "<skill>/<file>", anything else by its file name.
 */
export function fileDisplayName(file) {
  const parts = String(file || '').split(/[\\/]/);
  const base = parts[parts.length - 1] || '';
  const i = parts.map((p) => p.toLowerCase()).lastIndexOf('skills');
  if (i >= 0 && parts.length > i + 2) {
    const skill = parts[i + 1];
    return /^skill\.md$/i.test(base) ? skill : `${skill}/${parts.slice(i + 2).join('/')}`;
  }
  return base;
}

export function hashText(text) {
  return crypto.createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 16);
}

function frontmatter(text) {
  return /^---\r?\n[\s\S]*?\r?\n---/.exec(text)?.[0] || '';
}

function headingCount(text) {
  return (String(text).match(/^#{1,6}\s+\S/gm) || []).length;
}

/** Words of `old` that `next` no longer has: what an edit removes. */
export function removedWords(old, next) {
  const count = new Map();
  for (const w of String(next).split(/\s+/).filter(Boolean)) count.set(w, (count.get(w) || 0) + 1);
  const removed = [];
  for (const w of String(old).split(/\s+/).filter(Boolean)) {
    const c = count.get(w) || 0;
    if (c > 0) count.set(w, c - 1);
    else removed.push(w);
  }
  return removed;
}

/**
 * Apply edits in order to `text`, keeping only the safe ones. An edit is either
 * { old, new } (an exact fragment found once, replaced) or { append, section }.
 * Rules: the fragment exists exactly once; an edit that is not a pure insertion (the
 * old fragment must survive intact inside the new text) rewrites existing text, so it
 * is a correction: it is marked `corrects` (which always waits for the user) and may
 * remove only a bounded amount; the frontmatter and headings are protected; the text
 * an edit adds may hold no secret; the file grows by a bounded amount.
 * Returns { after, applied, rejected: [{ edit, reason }] }; applied edits carry
 * `corrects: true` when they rewrite text (and `rewrites: true` when the caller had not
 * marked them as a correction).
 */
export function applyEdits(text, edits) {
  const original = String(text);
  let cur = original;
  const applied = [];
  const rejected = [];
  for (const e of edits || []) {
    const reject = (reason) => rejected.push({ edit: e, reason });
    let next;
    let edit = e;
    let added;
    if (e.append !== undefined) {
      if (!String(e.append || '').trim()) { reject('empty addition'); continue; }
      next = appendToSection(cur, e.section, e.append);
      added = String(e.append);
    } else {
      const old = String(e.old ?? '');
      const repl = String(e.new ?? '');
      if (old.trim().length < MIN_OLD_CHARS) { reject('the fragment to replace is too short to be unique'); continue; }
      const count = cur.split(old).length - 1;
      if (count !== 1) { reject(count ? `the fragment appears ${count} times` : 'the fragment is not in the file'); continue; }
      if (old === repl) { reject('changes nothing'); continue; }
      if (isInsertion(old, repl)) {
        added = repl.replace(old.trimEnd(), '');
      } else {
        // Rewriting text (even one word: "Run X" -> "Never run X") changes what the file
        // says: only a correction may do it, and a correction waits for the user.
        const removed = removedWords(old, repl).join(' ').length;
        if (removed > MAX_REMOVED_CHARS) { reject(`removes too much text (${removed} chars)`); continue; }
        if (!e.corrects) edit = { ...e, corrects: true, rewrites: true };
        added = addedText(old, repl) || repl;
      }
      next = cur.replace(old, () => repl);
    }
    if (frontmatter(next) !== frontmatter(cur)) { reject('changes the frontmatter'); continue; }
    if (headingCount(next) < headingCount(cur)) { reject('removes a heading'); continue; }
    if (containsSecret(added)) { reject('adds something that looks like a secret'); continue; }
    cur = next;
    applied.push(edit);
  }
  if (cur.length - original.length > MAX_GROWTH_CHARS) {
    return { after: original, applied: [], rejected: [...rejected, ...applied.map((edit) => ({ edit, reason: `the changes grow the file by ${cur.length - original.length} chars` }))] };
  }
  return { after: cur, applied, rejected };
}

// ---------- store ----------

export function getChangeset(db, id) {
  return db.prepare('SELECT * FROM changesets WHERE id = ?').get(id);
}

export function pendingChangeset(db, file) {
  return db.prepare("SELECT * FROM changesets WHERE status = 'pending' AND lower(file) = lower(?) ORDER BY id DESC").get(path.resolve(file));
}

/** The learnings a changeset implements (only those still waiting, unless `all`). */
export function claimsOf(db, changesetId, { all = false } = {}) {
  return db.prepare(`
    SELECT c.*, s.started_at session_started_at FROM candidates c LEFT JOIN sessions s ON s.id = c.session_id
    WHERE c.changeset_id = ? ${all ? '' : "AND c.outcome = 'queued'"} ORDER BY COALESCE(s.started_at, c.ts), c.id`).all(changesetId);
}

/**
 * Record a pending changeset and attach its claims (candidate ids) to it. `replaces`
 * is the pending changeset for the same file it supersedes (its claims move over).
 */
export function saveChangeset(db, { file, cwd, base, edits, note = null, cost = 0, claimIds, replaces = null }) {
  const now = Date.now();
  const target = path.resolve(file);
  if (replaces) db.prepare("UPDATE changesets SET status = 'superseded', decided_at = ? WHERE id = ? AND status = 'pending'").run(now, replaces);
  const r = db.prepare(`
    INSERT INTO changesets (file, kind, cwd, project, base_hash, edits, corrects, status, note, cost_usd, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(
    target, knowledgeKind(target), cwd || null, cwd ? projectIdFor(cwd) : null, hashText(base), JSON.stringify(edits),
    edits.some((e) => e.corrects) ? 1 : 0, note, cost, now);
  const id = Number(r.lastInsertRowid);
  const attach = db.prepare("UPDATE candidates SET changeset_id = ?, target = ?, outcome = 'queued', decided_at = NULL WHERE id = ?");
  for (const c of claimIds) attach.run(id, target, c);
  return id;
}

/** Whether a changeset must wait for the user (same rules as single items). */
export function changesetNeedsApproval(db, cs, actor, autonomy) {
  const claims = claimsOf(db, cs.id);
  const confidence = claims.length ? Math.min(...claims.map((c) => c.confidence ?? 0.6)) : 0.6;
  const kind = knowledgeKind(cs.file);
  // A learned-preferences rule file is Ouroboros's own: adding to it is not a change to a file a person wrote.
  const ownFile = kind === 'rules' && createdByOuroboros(db, cs.file);
  return needsApproval({ op: 'patch', target: cs.file, kind: kind === 'skill' ? 'skill' : 'memory', corrects: !!cs.corrects, confidence, ownFile }, actor, autonomy);
}

/**
 * Apply a pending changeset. When the file changed since it was composed, the edits
 * are re-applied to the current text; if they no longer fit, it is marked stale and
 * the next queue check composes it again.
 */
export function applyChangeset(db, id, { actor = 'manual' } = {}) {
  const cs = getChangeset(db, id);
  if (!cs || cs.status !== 'pending') return { status: 'not_found', reason: 'no pending change with that id' };
  let current;
  try { current = fs.readFileSync(cs.file, 'utf8'); } catch {
    db.prepare("UPDATE changesets SET status = 'stale', note = ? WHERE id = ?").run('the file no longer exists', id);
    return { status: 'stale', reason: 'the file no longer exists' };
  }
  const { after, applied, rejected } = applyEdits(current, JSON.parse(cs.edits));
  if (rejected.length || !applied.length) {
    const why = rejected.map((r) => r.reason).join('; ') || 'nothing to apply';
    db.prepare("UPDATE changesets SET status = 'stale', note = ? WHERE id = ?").run(`the file changed since: ${why}`, id);
    return { status: 'stale', reason: 'the file changed since this was proposed; the next check composes it again' };
  }
  const claims = claimsOf(db, id);
  const r = writeText(db, {
    file: cs.file, after, actor, expectBefore: current,
    title: claims.length === 1 ? claims[0].title : `${fileDisplayName(cs.file)}: ${claims.length} updates`,
    why: claims.map((c) => `- ${c.title}: ${String(c.claim || c.summary || '').replace(/\s+/g, ' ').slice(0, 300)}${c.evidence ? ` (${String(c.evidence).replace(/\s+/g, ' ').slice(0, 160)})` : ''}`).join('\n'),
    confidence: claims.length ? Math.max(...claims.map((c) => c.confidence ?? 0.6)) : 0.6,
  });
  if (r.status === 'stale') {
    db.prepare("UPDATE changesets SET status = 'stale', note = ? WHERE id = ?").run(r.reason, id);
    return { status: 'stale', reason: 'the file changed while this was being applied; the next check composes it again' };
  }
  if (r.status !== 'patched') return r;
  const now = Date.now();
  const rebased = hashText(current) !== cs.base_hash;
  db.prepare("UPDATE changesets SET status = 'applied', decided_at = ?, learning_id = ?, batch = ?, note = COALESCE(?, note) WHERE id = ?")
    .run(now, r.id, r.batch, rebased ? 'applied on top of a newer version of the file' : null, id);
  db.prepare("UPDATE candidates SET outcome = 'patched', learning_id = ?, decided_at = ? WHERE changeset_id = ? AND outcome = 'queued'").run(r.id, now, id);
  return { ...r, status: 'patched', title: r.title || path.basename(cs.file), claims: claims.length, rebased };
}

export function rejectChangeset(db, id) {
  const cs = getChangeset(db, id);
  if (!cs || !['pending', 'stale'].includes(cs.status)) return { status: 'not_found', reason: 'no pending change with that id' };
  const now = Date.now();
  db.prepare("UPDATE changesets SET status = 'rejected', decided_at = ? WHERE id = ?").run(now, id);
  db.prepare("UPDATE candidates SET outcome = 'rejected_by_user', decided_at = ? WHERE changeset_id = ? AND outcome = 'queued'").run(now, id);
  return { status: 'rejected_by_user', title: path.basename(cs.file) };
}

/**
 * Queue a patch Claude wrote in session (it read the file itself, so no editor runs).
 * It joins the file's pending changeset when the edits still apply together.
 */
export function queueEdit(db, item, payload, actor) {
  const file = path.resolve(String(item.target));
  const base = fs.readFileSync(file, 'utf8');
  const edit = item.append !== undefined
    ? { append: item.append, section: item.section || '', corrects: !!item.corrects }
    : { old: item.old, new: item.new ?? '', corrects: !!item.corrects };
  const now = Date.now();
  const r = db.prepare(`
    INSERT INTO candidates (review_id, session_id, project, kind, scope, memory_type, title, summary, evidence, confidence, outcome, payload, cwd, claim, target, triaged_at, ts)
    VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`).run(
    payload.session_id || actor, projectIdFor(item.projectDir || payload.cwd || ''), item.kind, item.scope || 'project', item.memory_type ?? null,
    String(item.title || path.basename(file)).slice(0, 200), String(item.append ?? item.new ?? '').slice(0, 1500), String(item.evidence || '').slice(0, 800),
    item.confidence, JSON.stringify({ item: { ...item, projectDir: undefined, project_dir: item.projectDir }, cwd: payload.cwd, trigger: payload.trigger, actor }),
    payload.cwd || null, String(item.append ?? item.new ?? '').slice(0, 1500), file, now, now);
  const cid = Number(r.lastInsertRowid);
  edit.claims = [cid];
  const pending = pendingChangeset(db, file);
  if (!pending) {
    const changesetId = saveChangeset(db, { file, cwd: payload.cwd, base, edits: applyEdits(base, [edit]).applied, claimIds: [cid] });
    return { id: cid, changesetId, replaced: false };
  }
  const combined = applyEdits(base, [...JSON.parse(pending.edits), edit]);
  if (!combined.rejected.length) {
    const claimIds = [...claimsOf(db, pending.id).map((c) => c.id), cid];
    const changesetId = saveChangeset(db, { file, cwd: payload.cwd, base, edits: combined.applied, claimIds, replaces: pending.id });
    return { id: cid, changesetId, replaced: true };
  }
  // The new edit does not fit with what is already waiting for this file. One file never
  // has two pending changes: the waiting one goes stale with the new learning attached,
  // and the editor composes them together (`--drain`, started by the caller).
  db.prepare('UPDATE candidates SET changeset_id = ?, claim = ? WHERE id = ?').run(pending.id, String(item.append ?? item.new ?? '').slice(0, 2000), cid);
  db.prepare("UPDATE changesets SET status = 'stale', note = ? WHERE id = ?").run('a new change to this file did not fit with it; composing them together', pending.id);
  return { id: cid, changesetId: pending.id, replaced: false, recompose: true };
}

/** A changeset as the dashboard shows it. */
export function changesetView(db, cs) {
  let current = null;
  try { current = fs.readFileSync(cs.file, 'utf8'); } catch { /* gone */ }
  const claims = claimsOf(db, cs.id);
  return {
    key: `cs:${cs.id}`, id: cs.id, type: 'changeset', file: cs.file, kind: cs.kind, corrects: !!cs.corrects, note: cs.note,
    status: cs.status, created_at: cs.created_at, changed: current === null || hashText(current) !== cs.base_hash,
    session_started_at: claims.reduce((m, c) => Math.min(m, c.session_started_at || c.ts), Infinity),
    edits: JSON.parse(cs.edits),
    claims: claims.map((c) => ({ id: c.id, title: c.title, claim: c.claim || c.summary, evidence: c.evidence, note: c.note, confidence: c.confidence, session_started_at: c.session_started_at })),
  };
}
