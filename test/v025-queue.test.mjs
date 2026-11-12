// The evaluation queue (review III): a learning held for the user stays held whatever
// arrives next for its file; failures are retried a bounded number of times and never
// hold back the rest; what changed while a model call ran is respected; a lost lease
// stops the evaluation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'test', 'fixtures');
const RULES = '# Deploy\n\n- Deploy with `npm run deploy`.\n- Staging first.\n';
let base;
let curator;
let ev;
let cs;
let inbox;
let paths;
let dbApi;
let s;

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-v025q-'));
  dbApi = await import('../scripts/db.mjs');
  curator = await import('../scripts/curator.mjs');
  ev = await import('../scripts/evaluate.mjs');
  cs = await import('../scripts/changesets.mjs');
  inbox = await import('../scripts/inbox.mjs');
  paths = await import('../scripts/paths.mjs');
});

after(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

afterEach(() => {
  delete process.env.FAKE_QUEUE_RACE;
  s?.db.close();
  s = null;
});

/** A fresh sandbox per test: its own home, config, data and project (a git repo with a rule file). */
function sandbox(name) {
  const tmp = fs.mkdtempSync(path.join(base, `${name}-`));
  process.env.HOME = path.join(tmp, 'home');
  process.env.USERPROFILE = process.env.HOME;
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.OUROBOROS_HOME = path.join(tmp, 'ouroboros');
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data');
  process.env.OUROBOROS_CLAUDE_CMD = JSON.stringify([process.execPath, path.join(fixtures, 'fake-queue.mjs')]);
  process.env.FAKE_QUEUE_LOG = path.join(tmp, 'calls.log');
  fs.mkdirSync(process.env.HOME, { recursive: true });
  const proj = path.join(tmp, 'work', 'p');
  const rules = path.join(proj, '.claude', 'rules', 'deploy.md');
  fs.mkdirSync(path.dirname(rules), { recursive: true });
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# P\n\nA small project.\n');
  fs.writeFileSync(rules, RULES);
  spawnSync('git', ['-C', proj, 'init', '-q']);
  spawnSync('git', ['-C', proj, 'add', '.']);
  const db = dbApi.openDb();
  db.prepare("INSERT INTO sessions (id, project, cwd, started_at) VALUES ('s1', ?, ?, ?)").run(paths.projectIdFor(proj), proj, Date.now());
  s = { tmp, proj, rules, db };
  return s;
}

/** A proposal from an end-of-session review, waiting for the evaluation, routed by the fake screen to `file`. */
function pending(cwd, title, claim, file, { autonomy = 'queue', notify = false } = {}) {
  const evidence = file ? `USER #1 ROUTEME:${file} CLAIM: ${claim}` : 'USER #1';
  const item = { op: 'create', kind: 'memory', scope: 'project', memory_type: 'project', title, description: claim, confidence: 0.8, evidence };
  return Number(s.db.prepare(`INSERT INTO candidates (review_id, session_id, project, kind, scope, memory_type, title, summary, evidence, confidence, outcome, payload, cwd, ts)
    VALUES (0, 's1', ?, 'memory', 'project', 'project', ?, ?, ?, 0.8, 'pending', ?, ?, ?)`).run(paths.projectIdFor(cwd), title, claim, evidence,
    JSON.stringify({ item, cwd, trigger: 'session_end', actor: 'background', autonomy, notify }), cwd, Date.now()).lastInsertRowid);
}

const row = (id) => s.db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
const calls = () => { try { return fs.readFileSync(process.env.FAKE_QUEUE_LOG, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const race = (plan) => { process.env.FAKE_QUEUE_RACE = JSON.stringify({ ...plan, once: path.join(s.tmp, `race-${Math.random().toString(36).slice(2)}`) }); return JSON.parse(process.env.FAKE_QUEUE_RACE).once; };

test('A3: a learning held for the user is not written when an anchored one for the same memory arrives, and the notice says so', async () => {
  const { db, proj } = sandbox('a3-memory');
  const [m] = curator.apply(db, { cwd: proj, items: [{ kind: 'memory', memory_type: 'project', title: 'Deploy notes', description: 'How we deploy', body: '- Deploy from main.' }] }, { actor: 'manual' });
  const before = fs.readFileSync(m.path, 'utf8');
  // One review, two items for the same memory: one cites no user turn (held), one does.
  const held = pending(proj, 'Held item', 'Skip the staging step when the pipeline is red.', m.path, { autonomy: 'queue', notify: true });
  const anchored = pending(proj, 'Anchored item', 'Tag every release.', m.path, { autonomy: 'auto', notify: true });
  await ev.drainQueue(db);
  assert.equal(fs.readFileSync(m.path, 'utf8'), before, 'nothing written without the user');
  const change = cs.pendingChangeset(db, m.path);
  assert.ok(change);
  for (const id of [held, anchored]) assert.deepEqual([row(id).outcome, row(id).changeset_id], ['queued', change.id]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM writes WHERE op = 'patch' AND actor = 'background'").get().n, 0);
  const notice = db.prepare('SELECT text FROM notices').all().map((n) => n.text).join('\n');
  assert.doesNotMatch(notice, /updated/);
  assert.match(notice, /waiting for approval: Anchored item/);
});

test('A3: a held learning for a project CLAUDE.md gets no stand-in memory when an anchored one joins its change', async () => {
  const { db, proj } = sandbox('a3-claudemd');
  const md = path.join(proj, 'CLAUDE.md');
  const held = pending(proj, 'Held item', 'Skip the staging step when the pipeline is red.', md, { autonomy: 'queue' });
  await ev.drainQueue(db);
  const anchored = pending(proj, 'Anchored item', 'Tag every release.', md, { autonomy: 'auto' });
  await ev.drainQueue(db);
  assert.equal(curator.interimOf(db, held), null, 'the held learning is not active anywhere');
  assert.ok(curator.interimOf(db, anchored), 'the anchored one is known meanwhile, as before');
  assert.equal(row(held).outcome, 'queued');
});

test('M9: a learning the editor never answers for waits for the user after two tries, and its sibling\'s change keeps its id', async () => {
  const { db, proj, rules } = sandbox('m9-omit');
  const tag = pending(proj, 'Tag', 'Tag the release after deploying.', rules);
  const skipped = pending(proj, 'Skipped', 'SKIPCLAIM announce the deploy.', rules);
  const first = await ev.drainQueue(db);
  assert.equal(first.rounds, 2);
  assert.equal(calls().filter((k) => k === 'editor').length, 2);
  const r = row(skipped);
  assert.deepEqual([r.outcome, r.changeset_id], ['queued', null]);
  assert.ok(r.triaged_at, 'out of the queue');
  assert.match(r.note, /gave no verdict for it; nothing was written, you decide/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM changesets').get().n, 1, 'the unchanged change was not replaced');
  assert.equal(row(tag).changeset_id, cs.pendingChangeset(db, rules).id);
  assert.equal((await ev.drainQueue(db)).rounds, 0);
  assert.equal(ev.queueHasWork(db), false);
});

test('M9: an editor call that keeps failing is retried once per drain, then the learning waits for the user', async () => {
  const { db, proj, rules } = sandbox('m9-fail');
  const id = pending(proj, 'Fails', 'EDITORFAIL tag the release.', rules);
  assert.equal((await ev.drainQueue(db)).rounds, 1);
  assert.equal(calls().filter((k) => k === 'editor').length, 1, 'not again in the same drain');
  assert.equal(row(id).triaged_at, null, 'still waiting for the next drain');
  assert.equal((await ev.drainQueue(db)).rounds, 1);
  assert.equal(calls().filter((k) => k === 'editor').length, 2);
  assert.equal(row(id).outcome, 'queued');
  assert.ok(row(id).triaged_at);
  assert.match(row(id).note, /could not be composed \(2 attempts failed\)/);
  assert.equal(ev.queueHasWork(db), false);
});

test('M9: a screen that fails for one project does not hold back another project, and is bounded too', async () => {
  const { db, proj, tmp } = sandbox('m9-screen');
  const other = path.join(tmp, 'work', 'q');
  fs.mkdirSync(other, { recursive: true });
  const bad = pending(proj, 'Bad', 'SCREENFAIL something the model will not answer for.', null, { autonomy: 'auto' });
  const good = pending(other, 'Use pnpm', 'Use pnpm in project q.', null, { autonomy: 'auto' });
  const r = await ev.drainQueue(db);
  assert.equal(r.status, 'done');
  assert.equal(row(good).outcome, 'created');
  assert.equal(row(bad).outcome, 'pending');
  assert.equal(calls().filter((k) => k === 'screen').length, 2, 'the failed screen is not repeated in the same drain');
  await ev.drainQueue(db);
  assert.equal(row(bad).outcome, 'queued');
  assert.match(row(bad).note, /the knowledge check failed for it; nothing was written, you decide/);
  assert.equal(ev.queueHasWork(db), false);
});

test('M9: a stale change no learning waits in any more is closed', async () => {
  const { db, proj, rules } = sandbox('m9-empty');
  const id = pending(proj, 'Tag', 'Tag the release.', rules);
  const csId = cs.saveChangeset(db, { file: rules, cwd: proj, base: RULES, edits: [], claimIds: [id] });
  db.prepare("UPDATE changesets SET status = 'stale' WHERE id = ?").run(csId);
  db.prepare("UPDATE candidates SET outcome = 'rejected_by_user', triaged_at = ? WHERE id = ?").run(Date.now(), id);
  assert.equal(ev.queueHasWork(db), true);
  await ev.drainQueue(db);
  assert.equal(cs.getChangeset(db, csId).status, 'superseded');
  assert.equal(ev.queueHasWork(db), false);
  assert.deepEqual(calls(), [], 'no model call for it');
});

test('M10: a live session\'s patch queued while the editor runs ends in the file\'s one pending change', async () => {
  const { db, proj, rules } = sandbox('m10-new');
  const tag = pending(proj, 'Tag', 'Tag the release after deploying.', rules);
  race({ during: 'editor', do: 'inloop-patch', cwd: proj, item: { op: 'patch', kind: 'memory', target: rules, title: 'Announce deploys', append: '- Announce deploys in the channel.', confidence: 0.8 } });
  await ev.drainQueue(db);
  const open = db.prepare("SELECT id FROM changesets WHERE status IN ('pending', 'stale') AND file = ?").all(path.resolve(rules));
  assert.equal(open.length, 1, 'one pending change per file');
  const live = db.prepare("SELECT * FROM candidates WHERE title = 'Announce deploys'").get();
  for (const c of [row(tag), live]) assert.deepEqual([c.outcome, c.changeset_id], ['queued', open[0].id]);
});

test('M10: a live session\'s patch attached to the pending change during a recomposition is not lost', async () => {
  const { db, proj, rules } = sandbox('m10-attach');
  const fix = pending(proj, 'Fix', 'FIX:- Deploy with `npm run deploy`.=>- Deploy with `make deploy`.', rules);
  await ev.drainQueue(db);
  assert.ok(row(fix).changeset_id);
  const tag = pending(proj, 'Tag', 'Tag the release after deploying.', rules);
  // It rewrites the line the pending correction rewrites: it does not fit, so it is
  // attached to the pending change, which goes stale, while the editor recomposes it.
  race({ during: 'editor', do: 'inloop-patch', cwd: proj, item: { op: 'patch', kind: 'memory', target: rules, title: 'Announce deploys', old: '- Deploy with `npm run deploy`.', new: '- Announce deploys in the channel.\n- Deploy with `npm run deploy`.', confidence: 0.8 } });
  await ev.drainQueue(db);
  const open = db.prepare("SELECT id FROM changesets WHERE status IN ('pending', 'stale') AND file = ?").all(path.resolve(rules));
  assert.equal(open.length, 1);
  const live = db.prepare("SELECT * FROM candidates WHERE title = 'Announce deploys'").get();
  for (const c of [row(fix), row(tag), live]) assert.deepEqual([c.outcome, c.changeset_id], ['queued', open[0].id]);
  assert.equal(cs.getChangeset(db, open[0].id).status, 'pending');
});

test('M10: an entry the user rejects while it is being screened stays rejected', async () => {
  const { db, proj } = sandbox('m10-reject');
  const [q] = curator.apply(db, { cwd: proj, session_id: 'live', items: [{ kind: 'memory', memory_type: 'feedback', title: 'Use tabs', description: 'Indent with tabs here', body: 'Indent with tabs.', confidence: 0.8 }] }, { actor: 'inloop', autonomy: 'queue' });
  race({ during: 'screen', do: 'reject', key: `it:${q.candidateId}` });
  await ev.drainQueue(db);
  assert.equal(row(q.candidateId).outcome, 'rejected_by_user');
  assert.deepEqual(inbox.inboxEntries(db).map((e) => e.key), []);
});

test('a drain whose lease another process took stops and leaves the rows to it', async () => {
  const { db, proj, rules } = sandbox('lease');
  const id = pending(proj, 'Tag', 'Tag the release after deploying.', rules);
  const once = race({ during: 'screen', do: 'steal-lease' });
  const r = await ev.drainQueue(db);
  assert.equal(r.status, 'busy');
  assert.deepEqual(calls(), ['screen'], 'no editor call after the lease was lost');
  assert.deepEqual([row(id).outcome, row(id).triaged_at, row(id).changeset_id], ['pending', null, null]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM changesets').get().n, 0);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'lease:evaluate'").get()?.value, fs.readFileSync(`${once}.token`, 'utf8'), 'the new holder keeps it');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reviews WHERE trigger = 'triage'").get().n, 1, 'the call made is still recorded');
});

test('M10: an entry the user rejects while a failing editor call runs stays rejected and is not counted', async () => {
  const { db, proj, rules } = sandbox('m10-fail');
  const id = pending(proj, 'Fails', 'EDITORFAIL tag the release.', rules);
  race({ during: 'editor', do: 'sql', sql: `UPDATE candidates SET outcome = 'rejected_by_user', decided_at = 1, triaged_at = 1 WHERE id = ${id}` });
  await ev.drainQueue(db);
  const r = row(id);
  assert.deepEqual([r.outcome, r.triaged_at], ['rejected_by_user', 1], 'left as the user left it');
  assert.equal(JSON.parse(r.payload).editor_misses, undefined, 'no failed attempt counted for it');
  assert.equal(ev.queueHasWork(db), false);
});

test('one failing group does not block the others in the drain', async () => {
  const { db, proj, tmp } = sandbox('group');
  const other = path.join(tmp, 'work', 'q');
  fs.mkdirSync(other, { recursive: true });
  const bad = pending(proj, 'Bad', 'DROPME something already documented.', null, { autonomy: 'auto' });
  const good = pending(other, 'Use pnpm', 'Use pnpm in project q.', null, { autonomy: 'auto' });
  // Writing the first group's verdict fails (a database error outside any model call).
  db.exec(`CREATE TRIGGER boom BEFORE UPDATE ON candidates WHEN NEW.id = ${bad} BEGIN SELECT RAISE(ABORT, 'boom'); END`);
  const r = await ev.drainQueue(db);
  assert.equal(r.status, 'done', 'the drain itself does not fail');
  assert.equal(row(good).outcome, 'created', 'the other project was evaluated');
  assert.equal(row(bad).outcome, 'pending', 'the failing one waits for the next drain');
  assert.equal(calls().filter((k) => k === 'screen').length, 2, 'one screen per group, no retry in the same drain');
  assert.match(db.prepare("SELECT message FROM errors WHERE source = 'evaluate:queue'").get().message, /boom/);
});

test('a carried learning the user rejects while the editor runs is not put back in the change', async () => {
  const { db, proj, rules } = sandbox('post-row');
  const a = pending(proj, 'Tag', 'Tag the release after deploying.', rules);
  await ev.drainQueue(db);
  assert.equal(row(a).changeset_id, cs.pendingChangeset(db, rules).id);
  const b = pending(proj, 'Announce', 'Announce the deploy in the channel.', rules);
  race({ during: 'editor', do: 'sql', sql: `UPDATE candidates SET outcome = 'rejected_by_user', decided_at = 1 WHERE id = ${a}` });
  await ev.drainQueue(db);
  assert.equal(row(a).outcome, 'rejected_by_user');
  const open = cs.pendingChangeset(db, rules);
  assert.deepEqual(cs.claimsOf(db, open.id, { all: true }).map((c) => c.id), [b], 'the change holds only what is still waiting');
  assert.doesNotMatch(open.edits, /Tag the release/);
  assert.equal(calls().filter((k) => k === 'editor').length, 3, 'composed again without it');
});

test('a change whose status moved while the editor ran is not composed on top of', async () => {
  const { db, proj, rules } = sandbox('post-status');
  const a = pending(proj, 'Tag', 'Tag the release after deploying.', rules);
  await ev.drainQueue(db);
  const first = cs.pendingChangeset(db, rules);
  const b = pending(proj, 'Announce', 'Announce the deploy in the channel.', rules);
  race({ during: 'editor', do: 'sql', sql: `UPDATE changesets SET status = 'superseded' WHERE id = ${first.id}` });
  await ev.drainQueue(db);
  assert.equal(cs.getChangeset(db, first.id).status, 'superseded');
  const open = cs.pendingChangeset(db, rules);
  assert.deepEqual(cs.claimsOf(db, open.id, { all: true }).map((c) => c.id), [b], 'the first learning is not pulled into a new change');
  assert.equal(row(a).changeset_id, first.id);
});

test('a file that changed while the editor ran is composed again on its new text', async () => {
  const { db, proj, rules } = sandbox('post-file');
  const a = pending(proj, 'Tag', 'Tag the release after deploying.', rules);
  race({ during: 'editor', do: 'write', file: rules, text: '- Never deploy on Fridays.\n' });
  await ev.drainQueue(db);
  const open = cs.pendingChangeset(db, rules);
  assert.equal(open.base_hash, cs.hashText(fs.readFileSync(rules, 'utf8')), 'composed against what the file says now');
  assert.equal(calls().filter((k) => k === 'editor').length, 2);
  assert.equal(row(a).changeset_id, open.id);
});

test('a lease lost while the editor ran stops the drain before anything is saved', async () => {
  const { db, proj, rules } = sandbox('lease-editor');
  const id = pending(proj, 'Tag', 'Tag the release after deploying.', rules);
  const once = race({ during: 'editor', do: 'steal-lease' });
  const r = await ev.drainQueue(db);
  assert.equal(r.status, 'busy');
  assert.deepEqual(calls(), ['screen', 'editor']);
  assert.deepEqual([row(id).outcome, row(id).triaged_at, row(id).changeset_id], ['pending', null, null], 'left to the new holder');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM changesets').get().n, 0);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'lease:evaluate'").get()?.value, fs.readFileSync(`${once}.token`, 'utf8'));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM reviews WHERE trigger = 'editor'").get().n, 1, 'the call made is still recorded');
});
