// The learning state of one session: what its earlier reviews already saved, queued or
// dropped, and what they noticed but could not settle yet (open observations). Every
// review of the session reads it, so a later one can refine an earlier learning instead
// of proposing it again, and can close what an earlier one left open. Each transcript
// segment is still reviewed once; this is what carries over between segments.
import path from 'node:path';

const MAX_ENTRIES = 20;
const MAX_OBSERVATIONS = 10;

function oneLine(s, max) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * What the session's reviews did so far, oldest first:
 * { ref, status: saved | waiting | conflict | dropped | suggested, title, file, text }.
 * `ref` names the entry in a later proposal's "refines" (a learning id, or "c<candidate id>").
 */
export function sessionLearnings(db, sessionId) {
  if (!sessionId) return [];
  const saved = db.prepare(`
    SELECT w.batch, MIN(w.id) first, MAX(w.title) title, MAX(w.why) why, MAX(w.learning_id) learning_id, MAX(w.op) op
    FROM writes w WHERE w.session_id = ? AND w.reverted_at IS NULL AND w.op IN ('create', 'patch')
    GROUP BY w.batch ORDER BY first`).all(sessionId).map((b) => {
    const l = b.learning_id ? db.prepare('SELECT title, path FROM learnings WHERE id = ?').get(b.learning_id) : null;
    return { ref: b.learning_id, status: 'saved', op: b.op, title: b.title || l?.title || '', file: l?.path || null, text: b.why || '', at: b.first };
  });
  const STATUS = { queued: 'waiting', pending: 'waiting', conflict: 'conflict', dropped: 'dropped', suggested: 'suggested', rejected_by_user: 'rejected' };
  const others = db.prepare(`
    SELECT id, title, summary, claim, target, outcome, note FROM candidates
    WHERE session_id = ? AND outcome IN ('queued', 'pending', 'conflict', 'dropped', 'suggested', 'rejected_by_user') ORDER BY id`).all(sessionId)
    .map((c) => ({ ref: `c${c.id}`, status: STATUS[c.outcome], title: c.title, file: c.target || null, text: c.claim || c.summary || '', note: c.note || '' }));
  return [...saved, ...others].slice(-MAX_ENTRIES);
}

/** Observations earlier reviews of the session left open. */
export function openObservations(db, sessionId) {
  if (!sessionId) return [];
  return db.prepare('SELECT id, text, ts FROM observations WHERE session_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT ?').all(sessionId, MAX_OBSERVATIONS).reverse();
}

/** Record observations (strings, or { text }) a review could not settle yet. */
export function addObservations(db, sessionId, list, now = Date.now()) {
  if (!sessionId || !Array.isArray(list)) return 0;
  const open = openObservations(db, sessionId).map((o) => o.text.toLowerCase());
  let n = 0;
  for (const raw of list.slice(0, MAX_OBSERVATIONS)) {
    const text = oneLine(typeof raw === 'string' ? raw : raw?.text, 400);
    if (text.length < 8 || open.includes(text.toLowerCase())) continue;
    db.prepare('INSERT INTO observations (session_id, text, ts) VALUES (?, ?, ?)').run(sessionId, text, now);
    open.push(text.toLowerCase());
    n++;
  }
  return n;
}

/** Close observations: the given ids ("o12" or 12), or every open one of the session. */
export function closeObservations(db, sessionId, ids = null, now = Date.now()) {
  if (!sessionId) return 0;
  if (ids === null) return db.prepare('UPDATE observations SET closed_at = ? WHERE session_id = ? AND closed_at IS NULL').run(now, sessionId).changes;
  let n = 0;
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = Number(String(raw).replace(/^o/i, ''));
    if (Number.isInteger(id)) n += db.prepare('UPDATE observations SET closed_at = ? WHERE id = ? AND session_id = ? AND closed_at IS NULL').run(now, id, sessionId).changes;
  }
  return n;
}

/** The file a "refines" ref points to (a saved learning, or a waiting change to a file), or null. */
export function refFile(db, sessionId, ref) {
  const r = String(ref || '').trim();
  if (!r) return null;
  if (/^lrn_/.test(r)) {
    return db.prepare("SELECT path FROM learnings WHERE id = ? AND status = 'active'").get(r)?.path || null;
  }
  const m = /^c(\d+)$/i.exec(r);
  if (m) return db.prepare('SELECT target FROM candidates WHERE id = ? AND session_id = ?').get(Number(m[1]), sessionId)?.target || null;
  return null;
}

/**
 * The state as text for a review prompt, or '' when the session has none.
 * `audience`: 'reviewer' (the end-of-session model, which answers with "refines") or
 * 'claude' (the in-session review, which patches the file itself).
 */
export function sessionStateText(db, sessionId, { audience = 'reviewer' } = {}) {
  const learned = sessionLearnings(db, sessionId);
  const open = openObservations(db, sessionId);
  if (!learned.length && !open.length) return '';
  const LABEL = { saved: 'saved', waiting: 'waiting for approval', conflict: 'conflict, waiting for the user', dropped: 'not saved', suggested: 'suggested as a fix in the project', rejected: 'rejected by the user' };
  const out = [];
  if (learned.length) {
    out.push('Already handled by earlier reviews of this session:');
    for (const l of learned) {
      const where = l.file ? ` → ${path.basename(path.dirname(l.file))}/${path.basename(l.file)}` : '';
      const why = l.status === 'dropped' && l.note ? ` (${oneLine(l.note, 120)})` : '';
      out.push(`- [${l.ref}] ${LABEL[l.status]}${where}: ${oneLine(l.title, 120)}${l.text ? ` — ${oneLine(l.text, 220)}` : ''}${why}`);
    }
    out.push(audience === 'reviewer'
      ? 'Do not propose these again. If this part refines, extends or contradicts one of them, propose ONE item that states the whole updated fact and set "refines" to its [ref]; an item rejected or not saved is proposed again only if this part adds what it lacked.'
      : 'Do not save these again. If this stretch refines, extends or contradicts one of them, patch that file (or the waiting change) instead of creating a new item.');
  }
  if (open.length) {
    out.push('', 'Left open by earlier reviews (noticed, not settled yet):');
    for (const o of open) out.push(`- [o${o.id}] ${o.text}`);
    out.push(audience === 'reviewer'
      ? 'If this part settles one of them (it worked, the user confirmed or repeated it), propose it as an item with the earlier context in mind; if it shows it was wrong or a one-off, leave it out.'
      : 'If this stretch settles one of them, save it now and list its id in "resolve"; if it shows it was wrong or a one-off, list it in "resolve" without saving.');
  }
  return out.join('\n');
}
