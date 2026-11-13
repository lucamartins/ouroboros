// v0.25 (review III: inbox): a refused call changes nothing, approving one learning does
// not approve the whole change, an unrecognised conflict choice is refused, and the inbox
// skill is not opened by the model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let tmp;
let db;
let curator;
let cs;
let inbox;
let cwd;
let rules;

const RULES = '# Rules\n\n## Deploy\n\n- Deploy with `npm run deploy`.\n';
const read = (f) => fs.readFileSync(f, 'utf8');

function queue(append, title) {
  const [r] = curator.apply(db, {
    cwd, session_id: 'sess-1', items: [{ op: 'patch', kind: 'rules', target: rules, section: 'Deploy', append, title, confidence: 0.6 }],
  }, { actor: 'background', autonomy: 'queue' });
  assert.equal(r.status, 'queued', r.reason);
  return r;
}

const outcomes = (csId) => cs.claimsOf(db, csId, { all: true }).map((c) => c.outcome);
const writes = () => db.prepare('SELECT COUNT(*) n FROM writes').get().n;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-v025-inbox-'));
  process.env.HOME = path.join(tmp, 'home');
  process.env.USERPROFILE = process.env.HOME;
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.OUROBOROS_HOME = path.join(tmp, 'ouroboros');
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data');
  cwd = path.join(tmp, 'work', 'app');
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  rules = path.join(cwd, 'CLAUDE.md');
  curator = await import('../scripts/curator.mjs');
  cs = await import('../scripts/changesets.mjs');
  inbox = await import('../scripts/inbox.mjs');
  const paths = await import('../scripts/paths.mjs');
  db = (await import('../scripts/db.mjs')).openDb();
  db.prepare("INSERT INTO sessions (id, project, cwd, started_at) VALUES ('sess-1', ?, ?, ?)").run(paths.projectKey(cwd), cwd, Date.now());
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('M11: edit with drop listing every learning refuses and changes nothing', () => {
  fs.writeFileSync(rules, RULES);
  queue('- Tag the release.', 'Tag the release');
  const q = queue('- Announce deploys.', 'Announce deploys');
  const id = q.changesetId;
  const ids = cs.claimsOf(db, id).map((c) => c.id);
  assert.equal(ids.length, 2);
  const r = inbox.editAndApprove(db, `cs:${id}`, { edits: JSON.parse(cs.getChangeset(db, id).edits), drop: ids });
  assert.equal(r.status, 'invalid');
  assert.deepEqual(outcomes(id), ['queued', 'queued'], 'no learning was rejected');
  assert.equal(cs.getChangeset(db, id).status, 'pending');
  assert.equal(read(rules), RULES);
  assert.equal(writes(), 0);
  inbox.reject(db, `cs:${id}`);
});

test('M11: approving a change with no waiting learning left refuses, closes it and writes nothing', () => {
  fs.writeFileSync(rules, RULES);
  const q = queue('- Rotate the key.', 'Rotate the key');
  db.prepare("UPDATE candidates SET outcome = 'rejected_by_user' WHERE changeset_id = ?").run(q.changesetId);
  const r = inbox.approve(db, `cs:${q.changesetId}`);
  assert.equal(r.status, 'invalid');
  assert.equal(read(rules), RULES);
  assert.equal(cs.getChangeset(db, q.changesetId).status, 'rejected');
  assert.equal(writes(), 0);
});

test('M12: approving it:<id> of a learning that sits in a change writes nothing and names the change', () => {
  fs.writeFileSync(rules, RULES);
  const a = queue('- Never deploy on Fridays.', 'No Friday deploys');
  const b = queue('- Ping the on-call first.', 'Ping on-call');
  const r = inbox.approve(db, `it:${a.candidateId}`);
  assert.equal(r.status, 'changed');
  assert.equal(r.key, `cs:${b.changesetId}`);
  assert.equal(read(rules), RULES, 'nothing written');
  assert.deepEqual(outcomes(b.changesetId), ['queued', 'queued']);
  // Rejecting that key keeps its meaning: the learning leaves the change.
  assert.equal(inbox.reject(db, `it:${a.candidateId}`).status, 'rejected_by_user');
  assert.deepEqual(outcomes(b.changesetId).sort(), ['queued', 'rejected_by_user']);
});

test('M13: resolve accepts any letter case and refuses an unrecognised choice without deciding', () => {
  const mk = (title) => Number(db.prepare(`INSERT INTO candidates (review_id, session_id, project, kind, title, claim, summary, confidence, outcome, target, cwd, note, ts)
    VALUES (0, 'sess-1', 'p', 'memory', ?, 'x', 'x', 0.7, 'conflict', ?, ?, 'conflict', ?)`).run(title, rules, cwd, Date.now()).lastInsertRowid);
  const id = mk('Conflicting rule');
  for (const bad of ['maybe', '', undefined, null]) {
    assert.equal(inbox.resolveConflict(db, `cf:${id}`, bad).status, 'invalid');
    assert.equal(db.prepare('SELECT outcome FROM candidates WHERE id = ?').get(id).outcome, 'conflict');
  }
  assert.equal(inbox.resolveConflict(db, `cf:${id}`, 'New').status, 'requeued');
  const id2 = mk('Another');
  assert.equal(inbox.resolveConflict(db, `cf:${id2}`, ' KEEP ').status, 'rejected_by_user');
});

test('the inbox skill is not opened by the model', () => {
  const head = read(path.join(root, 'skills', 'inbox', 'SKILL.md')).split(/^---$/m)[1];
  assert.match(head, /^disable-model-invocation: true$/m);
});

// ---- review III follow-up ----

function queuedItem(note, payload = {}) {
  const item = { kind: 'memory', memory_type: 'feedback', title: 'Follow-up item', body: 'Body.', description: 'd', project_dir: cwd };
  return Number(db.prepare(`INSERT INTO candidates (review_id, session_id, project, kind, title, claim, summary, confidence, outcome, cwd, note, payload, ts)
    VALUES (0, 'sess-1', 'p', 'memory', 'Follow-up item', 'x', 'x', 0.8, 'queued', ?, ?, ?, ?)`).run(cwd, note, JSON.stringify({ item, autonomy: 'auto', ...payload }), Date.now()).lastInsertRowid);
}

test('approve it:<id> of a learning whose change is closed does not point at a card that does not exist', () => {
  for (const status of ['rejected', 'superseded', 'applied']) {
    fs.writeFileSync(rules, RULES);
    const q = queue('- Closed change.', `Closed ${status}`);
    const id = cs.claimsOf(db, q.changesetId)[0].id;
    db.prepare('UPDATE changesets SET status = ? WHERE id = ?').run(status, q.changesetId);
    const r = inbox.approve(db, `it:${id}`);
    assert.equal(r.status, 'not_found', status);
    assert.equal(r.key, undefined);
    assert.equal(read(rules), RULES);
    assert.equal(inbox.reject(db, `it:${id}`).status, 'rejected_by_user', 'the user can still clear it');
  }
});

test('edit with a drop that is not a list is invalid and changes nothing', () => {
  fs.writeFileSync(rules, RULES);
  const q = queue('- Drop shape.', 'Drop shape');
  const before = writes();
  for (const bad of ['5', 5, { a: 1 }, null]) {
    const r = inbox.editAndApprove(db, `cs:${q.changesetId}`, { edits: JSON.parse(cs.getChangeset(db, q.changesetId).edits), drop: bad });
    assert.equal(r.status, 'invalid');
  }
  assert.deepEqual(outcomes(q.changesetId), ['queued']);
  assert.equal(cs.getChangeset(db, q.changesetId).status, 'pending');
  assert.equal(read(rules), RULES);
  assert.equal(writes(), before);
  inbox.reject(db, `cs:${q.changesetId}`);
});

test('the card of a queued item names its stand-in project memories and what approving or rejecting does', () => {
  const mem = (title) => {
    const [r] = curator.apply(db, { cwd, session_id: 'sess-1', items: [{ kind: 'memory', memory_type: 'feedback', title, description: 'd', body: 'Body.', project_dir: cwd }] }, { actor: 'background', autonomy: 'auto' });
    assert.equal(r.status, 'created', r.reason);
    return r;
  };
  const a = mem('Stand-in one');
  const b = mem('Stand-in two');
  const one = queuedItem(null, { interim: a.id });
  const t1 = inbox.showEntry(db, `it:${one}`).text;
  assert.match(t1, /Meanwhile: already active as a project memory \(/);
  assert.match(t1, /Approving writes the line here and retires it; rejecting keeps the memory/);
  const two = queuedItem(null, { interim: a.id, interims: [b.id] });
  const t2 = inbox.showEntry(db, `it:${two}`).text;
  assert.match(t2, /retires them; rejecting keeps them/);
  assert.equal(t2.match(/Meanwhile:[^(]*\(([^)]*)\)/)[1].split(',').length, 2, 'both paths named');
  assert.doesNotMatch(inbox.showEntry(db, `it:${queuedItem(null)}`).text, /Meanwhile/);
});

test('the card says why a learning the editor or the knowledge check could not handle waited', () => {
  const cases = [
    ['the editor of CLAUDE.md gave no verdict for it; nothing was written, you decide', /the editor of its file gave no verdict/],
    ['the change to CLAUDE.md could not be composed (3 attempts failed); nothing was written, you decide', /could not be composed/],
    ['the knowledge check failed for it; nothing was written, you decide', /knowledge check could not be completed/],
  ];
  for (const [note, re] of cases) {
    const line = inbox.showEntry(db, `it:${queuedItem(note, { autonomy: 'queue' })}`).text.match(/Waited because: [^\n]*/)[0];
    assert.match(line, re);
    assert.doesNotMatch(line, /autonomy/);
  }
  assert.match(inbox.showEntry(db, `it:${queuedItem(null, { autonomy: 'queue' })}`).text, /Waited because: your autonomy setting is "queue"/);
});

test('the card of a route whose owner could not be picked names it and says approving saves a separate item', () => {
  const notes = [
    'the knowledge check sent it to nowhere/RULES.md, no knowledge file of this project or yours is named nowhere/RULES.md; nothing was created, you decide',
    'the knowledge check sent it to notes.md, notes.md matches 2 files and no rule picks one; nothing was created, you decide',
    'the knowledge check sent it to /etc/CLAUDE.md, which is not a file Ouroboros may change (CLAUDE.md); nothing was created, you decide',
  ];
  for (const n of notes) {
    const line = inbox.showEntry(db, `it:${queuedItem(n)}`).text.match(/Waited because: [^\n]*/)[0];
    assert.doesNotMatch(line, /autonomy/, 'until v0.25 it said "your autonomy setting (auto)"');
    assert.match(line, /its topic has an owner Ouroboros could not pick \(the knowledge check named [^)]+\)/);
    assert.match(line, /approving saves it as a separate memory/);
  }
  const restored = inbox.showEntry(db, `it:${queuedItem('you restored it, but the editor found it already covered (it says so); nothing was written, you decide')}`).text;
  assert.match(restored, /Waited because: you restored it, but the editor found it already covered/);
});
