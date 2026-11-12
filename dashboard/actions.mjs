// Write actions available from the dashboard (POST /api/action). Every write goes through
// the curator or inbox.mjs, so it lands in the ledger and is undoable.
import { confirm, forget, pin, undo } from '../scripts/curator.mjs';
import * as inbox from '../scripts/inbox.mjs';

/** Bulk decisions apply to at most this many entries per request. */
const MAX_BULK = 2000;

/** Approve or reject one queue entry: "cs:<id>" is a change to a file, "it:<id>" or a number one proposal. */
function decide(db, key, approve) {
  return approve ? inbox.approve(db, key) : inbox.reject(db, key);
}

/** Totals of a queue drain (several rounds) for the dashboard's message. */
function summed(r) {
  const out = { cost: r.cost };
  for (const rep of r.reports || []) {
    for (const [k, v] of Object.entries(rep)) if (typeof v === 'number' && k !== 'cost') out[k] = (out[k] || 0) + v;
  }
  return out;
}

/**
 * Run one action. `api` is the dashboard API (createApi): bulk decisions take a filter,
 * `{ project, group, expect }`, and the server resolves it to entries; `expect` is the count
 * the user confirmed, and nothing is decided when the inbox no longer matches it.
 */
export async function runAction(db, action, id, api) {
  switch (action) {
    case 'triage_queue': {
      const { drainQueue } = await import('../scripts/evaluate.mjs');
      const r = await drainQueue(db, { force: !!id });
      return r.status === 'done' ? { status: 'done', ...summed(r) } : r;
    }
    case 'restore': {
      const r = db.prepare(`
        UPDATE candidates SET outcome = 'queued', decided_at = NULL, triaged_at = NULL, changeset_id = NULL, note = COALESCE(note, '') || ' (restored by you)'
        WHERE id = ? AND outcome IN ('dropped', 'merged', 'suggested', 'duplicate')`).run(Number(id));
      return r.changes ? { status: 'restored' } : { status: 'not_found' };
    }
    case 'resolve_conflict': {
      // The user settles a conflict: "new" = it is a new rule (the editor writes it,
      // replacing what contradicts it); "keep" = the current rule stands.
      const [cid, choice] = String(id).split(':');
      const r = inbox.resolveConflict(db, `cf:${Number(cid)}`, choice === 'new' ? 'new' : 'keep');
      if (r.status !== 'requeued') return r;
      const { drainQueue } = await import('../scripts/evaluate.mjs');
      const d = await drainQueue(db);
      if (d.status !== 'done') return { status: 'waiting', reason: d.reason, title: r.title };
      const after = db.prepare('SELECT outcome FROM candidates WHERE id = ?').get(Number(cid));
      return { status: after.outcome === 'queued' ? 'composed' : after.outcome, title: r.title };
    }
    case 'dismiss': return inbox.dismiss(db, `sg:${Number(id)}`);
    case 'undo': return undo(db, { id });
    case 'undo_batch': return /^[0-9a-f]{6,32}$/.test(String(id)) ? undo(db, { batch: String(id) }) : { status: 'not_found' };
    case 'pin': {
      const [lid, on] = String(id).split(':');
      return pin(db, lid, on !== 'off');
    }
    case 'undo_change': {
      const cs = db.prepare("SELECT batch FROM changesets WHERE id = ? AND status = 'applied'").get(Number(id));
      return cs?.batch ? undo(db, { batch: cs.batch }) : { status: 'not_found', reason: 'no applied change with that id' };
    }
    case 'forget': return forget(db, { match: id });
    case 'confirm': return confirm(db, id);
    case 'approve': return decide(db, id, true);
    case 'reject': {
      const r = decide(db, id, false);
      // Removing one learning from a change to a file: compose the rest again now.
      if (r.recompose) {
        const { drainQueue } = await import('../scripts/evaluate.mjs');
        await drainQueue(db);
      }
      return r;
    }
    case 'approve_many':
    case 'reject_many': {
      const f = id && typeof id === 'object' && !Array.isArray(id) ? id : null;
      if (!f || !api?.inboxKeys) return { status: 'invalid', reason: 'a bulk decision takes a filter: { project, group }' };
      // A filter that cannot be read must never widen to "the whole inbox", and the count the user
      // confirmed is required: a bulk decision without it decides nothing. (A group id is a project
      // key plus a file path, so it may be long.)
      const readable = (x) => x === undefined || x === null || (typeof x === 'string' && x.length <= 4000);
      if (!Number.isInteger(f.expect) || !readable(f.project) || !readable(f.group)) {
        return { status: 'invalid', reason: 'a bulk decision needs the count you confirmed (expect) and a readable filter' };
      }
      const keys = api.inboxKeys({ project: f.project ?? null, group: f.group ?? null }, action === 'approve_many' ? 'approve' : 'reject');
      if (f.expect !== keys.length) return { status: 'changed', total: keys.length, expected: f.expect };
      const results = keys.slice(0, MAX_BULK).map((x) => decide(db, x, action === 'approve_many'));
      const count = (st) => results.filter((r) => r.status === st).length;
      const saved = count('created') + count('patched');
      const rejected = count('rejected_by_user');
      return { status: 'done', total: results.length, saved, rejected, other: results.length - saved - rejected };
    }
    default: return null;
  }
}
