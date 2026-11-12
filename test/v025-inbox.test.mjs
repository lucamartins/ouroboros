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
