// The inbox reviewed in the conversation: list, show, preview, and decisions that let the
// user edit an entry before approving it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

let tmp;
let db;
let curator;
let inbox;
let hook;
let cwd;
let skill;
let rules;

const SKILL = '---\nname: local-dev\ndescription: Run the app locally\n---\n\n# Local dev\n\n## Pitfalls\n\n- Port 3000 must be free.\n';
const RULES = '# Rules\n\n- Ask all owner decisions at once, then agree on waves.\n- Never push without approval.\n';

function queuePatch(append, title) {
  const [r] = curator.apply(db, {
    cwd, session_id: 'sess-1', items: [{ op: 'patch', kind: 'skill', target: skill, section: 'Pitfalls', append, title, confidence: 0.6 }],
  }, { actor: 'background', autonomy: 'queue' });
  assert.equal(r.status, 'queued', r.reason);
  return r;
}

function conflict(title, claim) {
  const r = db.prepare(`INSERT INTO candidates (review_id, session_id, project, kind, title, claim, summary, confidence, outcome, target, cwd, note, ts)
    VALUES (0, 'sess-1', ?, 'memory', ?, ?, ?, 0.7, 'conflict', ?, ?, 'conflict: contradicts the written rule', ?)`)
    .run(hook.projectKeyOf(cwd), title, claim, claim, rules, cwd, Date.now());
  return Number(r.lastInsertRowid);
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-inbox-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.OUROBOROS_HOME = path.join(tmp, 'ouroboros');
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data');
  cwd = path.join(tmp, 'work', 'app');
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  skill = path.join(tmp, 'claude', 'skills', 'local-dev', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, SKILL);
  rules = path.join(cwd, 'CLAUDE.md');
  fs.writeFileSync(rules, RULES);
  curator = await import('../scripts/curator.mjs');
  inbox = await import('../scripts/inbox.mjs');
  const paths = await import('../scripts/paths.mjs');
  hook = { ...(await import('../scripts/hook.mjs')), projectKeyOf: paths.projectKey };
  const dbApi = await import('../scripts/db.mjs');
  db = dbApi.openDb();
  db.prepare("INSERT INTO sessions (id, project, cwd, started_at) VALUES ('sess-1', ?, ?, ?)").run(paths.projectKey(cwd), cwd, Date.now());
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('list and show: a queued change to a file comes with its learnings and the diff', () => {
  const q = queuePatch('- Run the seed before the API.', 'Seed before the API');
  const entries = inbox.inboxEntries(db, { project: cwd });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].key, `cs:${q.changesetId}`);
  assert.match(inbox.listText(entries), /1 waiting: 1 change to a file/);
  const s = inbox.showEntry(db, entries[0].key);
  assert.equal(s.status, 'ok');
  assert.match(s.text, /Seed before the API/);
  assert.match(s.text, /\+ - Run the seed before the API\./);
  assert.match(s.text, / {2}- Port 3000 must be free\./, 'context lines around the change');
  assert.equal(inbox.inboxEntries(db, { project: path.join(tmp, 'elsewhere') }).length, 0, 'another project does not see it');
  assert.equal(hook.inboxCount(db, hook.projectKeyOf(cwd)), 1);
});

test('edit: the user rewrites the change before approving; preview writes nothing', () => {
  const [e] = inbox.inboxEntries(db);
  const claim = inbox.showEntry(db, e.key).claims[0];
  const edits = [{ append: '- Run `pnpm seed` before starting the API (it needs the base tenant).', section: 'Pitfalls', claims: [claim] }];
  const p = inbox.previewEdit(db, e.key, { edits });
  assert.equal(p.status, 'ok');
  assert.match(p.text, /\+ - Run `pnpm seed`/);
  assert.equal(fs.readFileSync(skill, 'utf8'), SKILL, 'preview does not write');
  const bad = inbox.editAndApprove(db, e.key, { edits: [{ old: 'not in the file', new: 'x' }] });
  assert.equal(bad.status, 'invalid');
  const r = inbox.editAndApprove(db, e.key, { edits, reason: 'name the command' });
  assert.equal(r.status, 'patched', r.reason);
  assert.equal(r.edited, true);
  const text = fs.readFileSync(skill, 'utf8');
  assert.match(text, /Run `pnpm seed` before starting the API/);
  assert.doesNotMatch(text, /Run the seed before the API\./);
  const c = db.prepare('SELECT outcome, note FROM candidates WHERE id = ?').get(claim);
  assert.equal(c.outcome, 'patched');
  assert.match(c.note, /name the command/);
  assert.equal(inbox.inboxEntries(db).length, 0);
  assert.equal(curator.undo(db, { last: true }).status, 'undone', 'an edited approval is undoable like any write');
  assert.equal(fs.readFileSync(skill, 'utf8'), SKILL);
});

test('edit can drop one learning of a change and keep the others', () => {
  queuePatch('- Kill node before reinstalling.', 'Kill node before reinstalling');
  const q = queuePatch('- Use port 3001 when 3000 is taken.', 'Port fallback');
  const s = inbox.showEntry(db, `cs:${q.changesetId}`);
  assert.equal(s.claims.length, 2);
  const [keep, drop] = s.claims;
  const r = inbox.editAndApprove(db, `cs:${q.changesetId}`, { edits: [{ append: '- Kill node before reinstalling.', section: 'Pitfalls', claims: [keep] }], drop: [drop] });
  assert.equal(r.status, 'patched', r.reason);
  assert.equal(db.prepare('SELECT outcome FROM candidates WHERE id = ?').get(drop).outcome, 'rejected_by_user');
  assert.equal(db.prepare('SELECT outcome FROM candidates WHERE id = ?').get(keep).outcome, 'patched');
  assert.doesNotMatch(fs.readFileSync(skill, 'utf8'), /3001/);
  curator.undo(db, { last: true });
});

test('a new item: edited fields replace the proposed ones before it is saved', () => {
  const [q] = curator.apply(db, {
    cwd, session_id: 'sess-1', items: [{ op: 'create', kind: 'memory', scope: 'project', memory_type: 'feedback', title: 'No sample data', description: 'Never seed sample rows', body: 'Do not seed.\n\n**Why:** x\n**How to apply:** y', confidence: 0.5 }],
  }, { actor: 'background', autonomy: 'queue' });
  assert.equal(q.status, 'queued', q.reason);
  const key = `it:${q.candidateId}`;
  assert.match(inbox.showEntry(db, key).text, /What it would save:[\s\S]*Do not seed\./);
  const r = inbox.editAndApprove(db, key, { item: { title: 'Agenda starts empty', description: 'Never insert sample agenda rows; the agenda starts empty' } });
  assert.equal(r.status, 'created', r.reason);
  const l = db.prepare('SELECT title, path FROM learnings WHERE id = ?').get(r.id);
  assert.equal(l.title, 'Agenda starts empty');
  assert.match(fs.readFileSync(l.path, 'utf8'), /Never insert sample agenda rows/);
});

test('a conflict settled as a new rule with the correction composed in the conversation', () => {
  const id = conflict('Ask decisions one at a time', 'Ask owner decisions one at a time, waiting for each answer.');
  const key = `cf:${id}`;
  assert.match(inbox.showEntry(db, key).text, /Conflict with a written rule[\s\S]*Decide: keep the current rule/);
  assert.equal(inbox.approve(db, key).status, 'invalid', 'a conflict is resolved, not approved');
  const edits = [{ old: '- Ask all owner decisions at once, then agree on waves.', new: '- Ask owner decisions one at a time, waiting for each answer.', corrects: true }];
  assert.match(inbox.previewEdit(db, key, { edits }).text, /rewrites existing text/);
  const r = inbox.resolveConflict(db, key, 'new', { edits });
  assert.equal(r.status, 'patched', r.reason);
  const text = fs.readFileSync(rules, 'utf8');
  assert.match(text, /one at a time/);
  assert.doesNotMatch(text, /all owner decisions at once/, 'the old rule is replaced, not contradicted');
  assert.equal(db.prepare('SELECT outcome FROM candidates WHERE id = ?').get(id).outcome, 'patched');
  const w = db.prepare('SELECT why, actor FROM writes ORDER BY id DESC LIMIT 1').get();
  assert.equal(w.actor, 'manual');
  assert.match(w.why, /You settled a conflict/);
  curator.undo(db, { last: true });
  assert.equal(fs.readFileSync(rules, 'utf8'), RULES);
});

test('a conflict kept, one sent back to the editor, and suggested fixes done or dismissed', () => {
  const kept = conflict('Push freely', 'Push without asking.');
  assert.equal(inbox.reject(db, `cf:${kept}`, { reason: 'still want approval' }).status, 'rejected_by_user');
  assert.match(db.prepare('SELECT note FROM candidates WHERE id = ?').get(kept).note, /still want approval/);
  const later = conflict('Waves are fine', 'Agree on waves.');
  assert.equal(inbox.resolveConflict(db, `cf:${later}`, 'new').status, 'requeued');
  assert.equal(db.prepare('SELECT outcome FROM candidates WHERE id = ?').get(later).outcome, 'queued');
  const sg = (title) => Number(db.prepare(`INSERT INTO candidates (review_id, session_id, project, kind, title, summary, outcome, cwd, ts)
    VALUES (0, 'sess-1', ?, 'memory', ?, 'x', 'suggested', ?, ?)`).run(hook.projectKeyOf(cwd), title, cwd, Date.now()).lastInsertRowid);
  const a = sg('Ignore the generated file');
  const b = sg('Fix the broken script');
  assert.equal(inbox.dismiss(db, `sg:${a}`, { done: true }).status, 'fixed');
  assert.equal(inbox.reject(db, `sg:${b}`).status, 'dismissed');
  assert.equal(inbox.dismiss(db, `sg:${b}`).status, 'not_found');
});

test('a stale change is not approved blindly: it says to edit it against the current file', () => {
  const q = queuePatch('- Clear the cache after upgrading.', 'Clear the cache');
  db.prepare("UPDATE changesets SET status = 'stale' WHERE id = ?").run(q.changesetId);
  const r = inbox.approve(db, `cs:${q.changesetId}`);
  assert.equal(r.status, 'stale');
  const claim = inbox.showEntry(db, `cs:${q.changesetId}`).claims[0];
  const e = inbox.editAndApprove(db, `cs:${q.changesetId}`, { edits: [{ append: '- Clear the cache after upgrading.', section: 'Pitfalls', claims: [claim] }] });
  assert.equal(e.status, 'patched', e.reason);
});

test('the card says what the file is and quotes what the user said in that session', async () => {
  const { buildDigest, citedTurns, quotesFor, userTurnsOfReview } = await import('../scripts/transcript.mjs');
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  const turn = (i, text) => ({ type: 'user', timestamp: new Date(t0 + i * 60_000).toISOString(), message: { role: 'user', content: text } });
  const entries = [turn(0, 'start the api'), turn(1, 'why is my agenda already filled? it should be empty'), turn(2, 'yes, production too'), turn(3, 'later question')];
  assert.deepEqual(citedTurns('USER #2, #3 (agenda)'), [2, 3]);
  assert.deepEqual(citedTurns('the session events'), []);
  // At review time: the digest numbers user turns from the review cursor.
  const digest = buildDigest(entries, { fromLine: 1 });
  assert.deepEqual(quotesFor('USER #1, #2', digest.userTurns).map((q) => q.text), ['why is my agenda already filled? it should be empty', 'yes, production too']);
  // Later, for an entry stored before quotes existed: the review covered the last 2 turns up to its time.
  const later = userTurnsOfReview(entries, { reviewedAt: t0 + 2.5 * 60_000, turnsReviewed: 2 });
  assert.deepEqual(quotesFor('USER #1', later).map((q) => q.text), ['why is my agenda already filled? it should be empty']);
  assert.equal(userTurnsOfReview(entries, { reviewedAt: t0 + 10 * 60_000, turnsReviewed: 0, fromStart: true })[0].text, 'start the api');

  // A stored entry with no quotes yet finds them in its session's transcript (and keeps them).
  const transcript = path.join(tmp, 'sess-2.jsonl');
  fs.writeFileSync(transcript, entries.map((e) => JSON.stringify(e)).join('\n'));
  db.prepare("INSERT INTO sessions (id, project, cwd, started_at, transcript_path) VALUES ('sess-2', ?, ?, ?, ?)").run(hook.projectKeyOf(cwd), cwd, t0, transcript);
  const review = Number(db.prepare("INSERT INTO reviews (session_id, mode, trigger, status, turns_reviewed, ts) VALUES ('sess-2', 'background', 'session_end', 'ok', 2, ?)").run(t0 + 2.5 * 60_000).lastInsertRowid);
  const id = Number(db.prepare(`INSERT INTO candidates (review_id, session_id, project, kind, title, claim, evidence, confidence, outcome, target, cwd, note, ts)
    VALUES (?, 'sess-2', ?, 'memory', 'Agenda starts empty', 'The agenda starts empty.', 'USER #1, #2', 0.7, 'conflict', ?, ?, ?, ?)`)
    .run(review, hook.projectKeyOf(cwd), rules, cwd, `conflict: ${rules}: it contradicts the rules`, t0).lastInsertRowid);
  const card = inbox.showEntry(db, `cf:${id}`).text;
  assert.match(card, /You said \(turn 1\): "why is my agenda already filled\? it should be empty"/);
  assert.match(card, /You said \(turn 2\): "yes, production too"/);
  assert.doesNotMatch(card, /USER #/);
  assert.match(card, /Why it was held: it contradicts the rules/, 'the file path before the reason is not shown (drive letters included)');
  assert.match(card, /^\[\d+\/\d+\] cf:/, 'the card starts with its position in the inbox');
  assert.ok(db.prepare('SELECT quotes FROM candidates WHERE id = ?').get(id).quotes, 'the quotes are kept');
  inbox.resolveConflict(db, `cf:${id}`, 'keep');
});

test('describeFile names what a knowledge file is', () => {
  const home = os.homedir();
  assert.equal(inbox.describeFile(path.join(home, '.claude', 'skills', 'nisus', 'reference', 'windows-gotchas.md')), 'A reference file of the global skill "nisus"');
  assert.equal(inbox.describeFile(path.join(home, '.claude', 'skills', 'nisus-local', 'SKILL.md')), 'The global skill "nisus-local"');
  assert.match(inbox.describeFile(path.join(home, 'src', 'api', '.claude', 'rules', 'testing.md')), /rule file of project api/);
  assert.match(inbox.describeFile(path.join(home, 'src', 'api', 'CLAUDE.md')), /instructions of api/);
  assert.match(inbox.describeFile(path.join(home, '.ouroboros', 'user.md')), /global profile/);
  assert.equal(inbox.shortPath(path.join(home, 'a', 'b.md')), '~/a/b.md');
});
