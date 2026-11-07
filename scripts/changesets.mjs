// Changesets: the unit Ouroboros writes and the user approves. A changeset holds every
// pending change to ONE knowledge file, composed together (by the editor, or from a
// patch Claude wrote in session), so two learnings can never make conflicting edits
// to the same file. Edits are exact fragments the model chose; this module decides
// whether they are safe to apply, and applies them through the curator's ledger.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appendToSection, containsSecret, needsApproval, writeText } from './curator.mjs';
import { knowledgeKind } from './knowledge.mjs';
import { projectKey } from './paths.mjs';

/** A changeset may grow a file by at most this many characters. */
export const MAX_GROWTH_CHARS = 6000;
/** A correcting edit may remove at most this much text; other edits only add. */
export const MAX_REMOVED_CHARS = 800;
/** Words an adding edit may change (punctuation moved around an insertion). */
const ADD_SLACK_WORDS = 1;
const MIN_OLD_CHARS = 8;

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
 * Rules: the fragment exists exactly once; only an edit marked `corrects` may remove
 * text (and not much); the frontmatter, headings and secrets are protected; the file
 * grows by a bounded amount. Returns { after, applied, rejected: [{ edit, reason }] }.
 */
export function applyEdits(text, edits) {
  const original = String(text);
  let cur = original;
  const applied = [];
  const rejected = [];
  for (const e of edits || []) {
    const reject = (reason) => rejected.push({ edit: e, reason });
    let next;
    if (e.append !== undefined) {
      if (!String(e.append || '').trim()) { reject('empty addition'); continue; }
      next = appendToSection(cur, e.section, e.append);
    } else {
      const old = String(e.old ?? '');
      const repl = String(e.new ?? '');
      if (old.trim().length < MIN_OLD_CHARS) { reject('the fragment to replace is too short to be unique'); continue; }
      const count = cur.split(old).length - 1;
      if (count !== 1) { reject(count ? `the fragment appears ${count} times` : 'the fragment is not in the file'); continue; }
      if (old === repl) { reject('changes nothing'); continue; }
      const removed = removedWords(old, repl);
      if (e.corrects) {
        if (removed.join(' ').length > MAX_REMOVED_CHARS) { reject(`removes too much text (${removed.join(' ').length} chars)`); continue; }
      } else if (removed.length > ADD_SLACK_WORDS) {
        reject('removes existing text, but none of its learnings corrects that text');
        continue;
      }
      next = cur.replace(old, () => repl);
    }
    if (frontmatter(next) !== frontmatter(cur)) { reject('changes the frontmatter'); continue; }
    if (headingCount(next) < headingCount(cur)) { reject('removes a heading'); continue; }
    if (containsSecret(next) && !containsSecret(cur)) { reject('adds something that looks like a secret'); continue; }
    cur = next;
    applied.push(e);
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
    target, knowledgeKind(target), cwd || null, cwd ? projectKey(cwd) : null, hashText(base), JSON.stringify(edits),
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
  return needsApproval({ op: 'patch', target: cs.file, kind: kind === 'skill' ? 'skill' : kind === 'profile' ? 'profile' : 'memory', corrects: !!cs.corrects, confidence }, actor, autonomy);
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
    file: cs.file, after, actor,
    title: claims.length === 1 ? claims[0].title : `${path.basename(cs.file)}: ${claims.length} updates`,
    confidence: claims.length ? Math.max(...claims.map((c) => c.confidence ?? 0.6)) : 0.6,
  });
  if (r.status !== 'patched') return r;
  const now = Date.now();
  const rebased = hashText(current) !== cs.base_hash;
  db.prepare("UPDATE changesets SET status = 'applied', decided_at = ?, learning_id = ?, note = COALESCE(?, note) WHERE id = ?")
    .run(now, r.id, rebased ? 'applied on top of a newer version of the file' : null, id);
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
    payload.session_id || actor, projectKey(item.projectDir || payload.cwd || ''), item.kind, item.scope || 'project', item.memory_type ?? null,
    String(item.title || path.basename(file)).slice(0, 200), String(item.append ?? item.new ?? '').slice(0, 1500), String(item.evidence || '').slice(0, 800),
    item.confidence, JSON.stringify({ item: { ...item, projectDir: undefined, project_dir: item.projectDir }, cwd: payload.cwd, trigger: payload.trigger, actor }),
    payload.cwd || null, String(item.append ?? item.new ?? '').slice(0, 1500), file, now, now);
  const cid = Number(r.lastInsertRowid);
  edit.claims = [cid];
  const pending = pendingChangeset(db, file);
  let edits = [edit];
  let claimIds = [cid];
  let replaces = null;
  let note = null;
  if (pending) {
    const combined = [...JSON.parse(pending.edits), edit];
    if (!applyEdits(base, combined).rejected.length) {
      edits = combined;
      claimIds = [...claimsOf(db, pending.id).map((c) => c.id), cid];
      replaces = pending.id;
    } else {
      note = `does not fit together with pending change #${pending.id} to the same file`;
    }
  }
  const changesetId = saveChangeset(db, { file, cwd: payload.cwd, base, edits, claimIds, replaces, note });
  return { id: cid, changesetId, replaced: !!replaces };
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
