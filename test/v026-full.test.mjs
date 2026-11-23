// v0.26: `autonomy: full`. Corrections, changes to files a person wrote and the
// end-of-session reviewer's new skills are written without asking (undoable); what is
// held for where it came from (no user turn cited) and conflicts still wait; `auto`
// is unchanged; `full` comes only from the user's option, never from a payload.
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
const PROJECT_MD = '# P\n\nA small project.\n\n- Run the tests with `npm test`.\n';
let base;
let curator;
let ev;
let cs;
let paths;
let dbApi;
let config;
let s;

const read = (f) => fs.readFileSync(f, 'utf8');

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-v026-'));
  dbApi = await import('../scripts/db.mjs');
  curator = await import('../scripts/curator.mjs');
  ev = await import('../scripts/evaluate.mjs');
  cs = await import('../scripts/changesets.mjs');
  paths = await import('../scripts/paths.mjs');
  config = await import('../scripts/config.mjs');
});

after(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

afterEach(() => {
  delete process.env.CLAUDE_PLUGIN_OPTION_AUTONOMY;
  s?.db.close();
  s = null;
});

function sandbox(name) {
  const tmp = fs.mkdtempSync(path.join(base, `${name}-`));
  process.env.HOME = path.join(tmp, 'home');
  process.env.USERPROFILE = process.env.HOME;
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.OUROBOROS_HOME = path.join(tmp, 'ouroboros');
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data');
  process.env.OUROBOROS_CLAUDE_CMD = JSON.stringify([process.execPath, path.join(fixtures, 'fake-queue.mjs')]);
  fs.mkdirSync(process.env.HOME, { recursive: true });
  const proj = path.join(tmp, 'work', 'p');
  const rules = path.join(proj, '.claude', 'rules', 'deploy.md');
  const md = path.join(proj, 'CLAUDE.md');
  fs.mkdirSync(path.dirname(rules), { recursive: true });
  fs.writeFileSync(md, PROJECT_MD);
  fs.writeFileSync(rules, RULES);
  spawnSync('git', ['-C', proj, 'init', '-q']);
  spawnSync('git', ['-C', proj, 'add', '.']);
  const db = dbApi.openDb();
  db.prepare("INSERT INTO sessions (id, project, cwd, started_at) VALUES ('s1', ?, ?, ?)").run(paths.projectIdFor(proj), proj, Date.now());
  s = { tmp, proj, rules, md, db };
  return s;
}

/** A proposal from an end-of-session review, routed by the fake screen to `file`. */
function pending(cwd, title, claim, file, { autonomy = 'full', unanchored = false } = {}) {
  const evidence = `USER #1 ROUTEME:${file} CLAIM: ${claim}${unanchored ? ' [cites no user turn of the session: held for you]' : ''}`;
  const item = { op: 'create', kind: 'memory', scope: 'project', memory_type: 'project', title, description: claim, confidence: 0.8, evidence };
  return Number(s.db.prepare(`INSERT INTO candidates (review_id, session_id, project, kind, scope, memory_type, title, summary, evidence, confidence, outcome, payload, cwd, ts)
    VALUES (0, 's1', ?, 'memory', 'project', 'project', ?, ?, ?, 0.8, 'pending', ?, ?, ?)`).run(paths.projectIdFor(cwd), title, claim, evidence,
    JSON.stringify({ item, cwd, trigger: 'session_end', actor: 'background', autonomy }), cwd, Date.now()).lastInsertRowid);
}

const row = (id) => s.db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);

test('the option accepts "full"', () => {
  process.env.CLAUDE_PLUGIN_OPTION_AUTONOMY = 'full';
  assert.equal(config.options().autonomy, 'full');
  process.env.CLAUDE_PLUGIN_OPTION_AUTONOMY = 'everything';
  assert.equal(config.options().autonomy, 'auto');
});

test('in session: a correction to a project CLAUDE.md is written in full, queued in auto, and undo restores it', () => {
  const { db, proj, md } = sandbox('session-correction');
  const fix = { op: 'patch', target: md, old: 'Run the tests with `npm test`.', new: 'Run the tests with `npm run test:all`.', title: 'Full test command', why: 'The user said npm test misses the e2e suite.' };
  const [queued] = curator.apply(db, { cwd: proj, items: [fix] }, { actor: 'inloop', autonomy: 'auto' });
  assert.equal(queued.status, 'queued');
  assert.equal(read(md), PROJECT_MD, 'auto is unchanged: a correction waits');
  db.prepare("UPDATE changesets SET status = 'superseded'").run();

  const [r] = curator.apply(db, { cwd: proj, items: [fix] }, { actor: 'inloop', autonomy: 'full' });
  assert.equal(r.status, 'patched', r.reason);
  assert.match(read(md), /npm run test:all/);
  assert.doesNotMatch(read(md), /`npm test`/);
  assert.equal(curator.undo(db, { last: true }).status, 'undone');
  assert.equal(read(md), PROJECT_MD);
});

test('in session: an addition to a skill the user wrote is written in full, with no stand-in memory', () => {
  const { db, proj } = sandbox('session-skill');
  const skill = path.join(process.env.CLAUDE_CONFIG_DIR, 'skills', 'release', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '---\nname: release\ndescription: Cut a release. Use when shipping.\n---\n\n# Release\n\n## Steps\n\n1. Update the changelog.\n');
  const [r] = curator.apply(db, { cwd: proj, items: [{ op: 'patch', kind: 'skill', target: skill, section: 'Steps', append: '2. Tag the commit before publishing.', title: 'Tag before publishing' }] }, { actor: 'inloop', autonomy: 'full' });
  assert.equal(r.status, 'patched', r.reason);
  assert.equal(r.meanwhile, undefined);
  assert.match(read(skill), /2\. Tag the commit before publishing\./);
});

test('a new skill from the end-of-session reviewer is created in full and waits in auto', () => {
  const { db, proj } = sandbox('bg-skill');
  const item = { kind: 'skill', scope: 'project', title: 'Rotate the API keys', description: 'Rotate the API keys. Use every quarter.', body: '## Steps\n\n1. Create the new key.', confidence: 0.7 };
  assert.equal(curator.apply(db, { cwd: proj, items: [item] }, { actor: 'background', autonomy: 'auto' })[0].status, 'queued');
  const [r] = curator.apply(db, { cwd: proj, items: [{ ...item, title: 'Rotate the keys' }] }, { actor: 'background', autonomy: 'full' });
  assert.equal(r.status, 'created', r.reason);
  assert.ok(fs.existsSync(r.path));
});

test('queue: an addition to a rule file is written in full; an item citing no user turn still waits, and holds its change', async () => {
  const { db, proj, rules } = sandbox('queue-full');
  const tag = pending(proj, 'Tag', 'Tag the release after deploying.', rules);
  await ev.drainQueue(db);
  assert.match(read(rules), /Tag the release after deploying\./);
  assert.ok(!cs.pendingChangeset(db, rules));
  assert.notEqual(row(tag).outcome, 'queued');

  // A held learning (autonomy `queue`, as review-worker records it) joins a full one: both wait.
  const before = read(rules);
  const held = pending(proj, 'Held', 'Announce the deploy in the channel.', rules, { autonomy: 'queue', unanchored: true });
  const anchored = pending(proj, 'Anchored', 'Check the dashboards after deploying.', rules);
  await ev.drainQueue(db);
  assert.equal(read(rules), before, 'nothing written while a held learning is part of the change');
  const change = cs.pendingChangeset(db, rules);
  assert.ok(change);
  for (const id of [held, anchored]) assert.equal(row(id).outcome, 'queued');
});

test('queue: a conflict still waits for the user in full; settled as a new rule, it is written with no second approval', async () => {
  const { db, proj, rules } = sandbox('queue-conflict');
  process.env.CLAUDE_PLUGIN_OPTION_AUTONOMY = 'full';
  const id = pending(proj, 'Conflict', 'CONFLICTME deploy straight to production.', rules);
  await ev.drainQueue(db);
  assert.equal(row(id).outcome, 'conflict');
  assert.equal(read(rules), RULES);
  const inbox = await import('../scripts/inbox.mjs');
  assert.equal(inbox.resolveConflict(db, `cf:${id}`, 'new').status, 'requeued');
  await ev.drainQueue(db);
  assert.match(read(rules), /CONFLICTME deploy straight to production\./);
  assert.ok(!cs.pendingChangeset(db, rules));
});

test('a payload cannot ask for full: the CLI uses the user\'s option', () => {
  const { proj, md } = sandbox('cli-payload');
  const payload = {
    cwd: proj, actor: 'inloop', autonomy: 'full',
    items: [{ op: 'patch', target: md, old: 'Run the tests with `npm test`.', new: 'Never run the tests.', title: 'No tests', autonomy: 'full' }],
  };
  const env = { ...process.env, CLAUDE_PLUGIN_OPTION_AUTONOMY: 'auto' };
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'curator.mjs'), 'apply'], { input: JSON.stringify(payload), env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(md), PROJECT_MD, 'the correction waits under auto');
  const stored = s.db.prepare("SELECT payload FROM candidates WHERE outcome = 'queued'").all().map((c) => JSON.parse(c.payload));
  assert.ok(stored.length);
  for (const p of stored) assert.notEqual(p.autonomy, 'full');
});
