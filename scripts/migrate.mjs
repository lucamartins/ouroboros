// One-time migrations of user-level state, run from SessionStart (cheap when there is
// nothing to do).
//
// v0.12 retired ~/.ouroboros/user.md, the "global profile" Ouroboros injected into every
// session: a second global file next to ~/.claude/CLAUDE.md that repeated what it said.
// Facts valid on every project now go to the global CLAUDE.md, through the editor and
// the user's approval like any change to a CLAUDE.md. The profile's bullets become
// proposals for that file (the evaluation drops the ones it already covers) and the
// file moves to ~/.ouroboros/archive/.
import fs from 'node:fs';
import path from 'node:path';
import { ouroborosDir } from './paths.mjs';

const ID_RE = /\s*<!--\s*lrn_[A-Za-z0-9]+\s*-->\s*$/;

/** The facts of a profile file: its bullets (a bullet continues on indented lines). */
export function profileBullets(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^[-*]\s+(.*)$/.exec(lines[i]);
    if (!m) continue;
    const parts = [m[1].replace(ID_RE, '')];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^#/.test(lines[i + 1])) parts.push(lines[++i].trim());
    const fact = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (fact) out.push(fact);
  }
  return out;
}

/**
 * Move ~/.ouroboros/user.md out of the way: its facts are queued as proposals for the
 * global CLAUDE.md and its profile learnings are archived. Returns how many facts were
 * queued, or null when there was no profile.
 */
export function retireProfile(db, now = Date.now()) {
  const file = path.join(ouroborosDir(), 'user.md');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const facts = profileBullets(text);
  const insert = db.prepare(`
    INSERT INTO candidates (review_id, session_id, project, kind, scope, title, summary, evidence, confidence, outcome, payload, ts)
    VALUES (0, 'migration', NULL, 'global', 'global', ?, ?, ?, 0.7, 'pending', ?, ?)`);
  const archiveDir = path.join(ouroborosDir(), 'archive');
  const date = new Date(now).toISOString().slice(0, 10);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const fact of facts) {
      const item = { op: 'create', kind: 'global', scope: 'global', title: fact.length > 90 ? `${fact.slice(0, 87)}…` : fact, text: fact, confidence: 0.7 };
      insert.run(item.title, fact.slice(0, 1500), 'moved from ~/.ouroboros/user.md (the global profile was retired in v0.12)',
        JSON.stringify({ item, trigger: 'migration', actor: 'background' }), now);
    }
    db.prepare("UPDATE learnings SET status = 'archived', updated_at = ? WHERE kind = 'profile' AND status = 'active'").run(now);
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.renameSync(file, path.join(archiveDir, `${date}-user.md`));
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
    throw err;
  }
  return facts.length;
}
