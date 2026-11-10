// v0.8 mechanisms: reverting one change among later edits, surgical profile writes, one
// memory directory per repository (worktrees included), ancestor CLAUDE.md files, long
// sessions reviewed in parts, the single-consumer evaluation queue, the budget guard,
// merges that must land somewhere, rewrites as corrections, notices per project.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let tmp;
let db;
let dbApi;
let curator;
let cs;
let ev;
let migrate;
let paths;
let proj;

const read = (f) => fs.readFileSync(f, 'utf8');

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-v08-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.OUROBOROS_HOME = path.join(tmp, 'ouroboros');
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data');
  process.env.OUROBOROS_CLAUDE_CMD = JSON.stringify([process.execPath, path.join(root, 'test', 'fixtures', 'fake-claude.mjs')]);
  proj = path.join(tmp, 'work', 'p');
  fs.mkdirSync(proj, { recursive: true });
  spawnSync('git', ['-C', proj, 'init', '-q']);
  dbApi = await import('../scripts/db.mjs');
  curator = await import('../scripts/curator.mjs');
  cs = await import('../scripts/changesets.mjs');
  ev = await import('../scripts/evaluate.mjs');
  migrate = await import('../scripts/migrate.mjs');
  paths = await import('../scripts/paths.mjs');
  db = dbApi.openDb();
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('revertChange undoes one write and keeps later edits elsewhere in the file', async () => {
  const { revertChange, lineDiff } = await import('../scripts/textdiff.mjs');
  const before = '# T\n\n- a\n- b\n- c\n';
  const after = '# T\n\n- a\n- b\n- added\n- c\n';
  assert.deepEqual(lineDiff(before, after), [{ at: 4, before: [], after: ['- added'] }]);
  const later = `${after}- user line\n`;
  assert.equal(revertChange(later, before, after), `${before}- user line\n`);
  // The changed line itself was edited: no safe revert.
  assert.equal(revertChange(later.replace('- added', '- edited'), before, after), null);
  // A replaced line goes back; repeated lines elsewhere do not confuse it.
  const b2 = 'x\nsame\nold\nsame\n';
  const a2 = 'x\nsame\nnew\nsame\n';
  assert.equal(revertChange(`top\n${a2}`, b2, a2), `top\n${b2}`);
});

test('the retired profile (user.md) becomes proposals for the global CLAUDE.md and moves to the archive', async () => {
  const file = path.join(process.env.OUROBOROS_HOME, 'user.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    '# Ouroboros profile', '', '## User', '', '- Prefers short answers <!-- lrn_p1 -->', '  with examples when useful', '',
    'A paragraph the user wrote.', '', '## Environment & lessons', '', '- Git Bash is the hook shell <!-- lrn_p2 -->', '',
  ].join('\n'));
  db.prepare("INSERT INTO learnings (id, kind, scope, block, name, title, path, confidence, status, created_at, updated_at) VALUES ('lrn_p1', 'profile', 'global', 'user', 'x', 'Prefers short answers', ?, 0.6, 'active', 0, 0)").run(file);
  assert.deepEqual(migrate.profileBullets(fs.readFileSync(file, 'utf8')), ['Prefers short answers with examples when useful', 'Git Bash is the hook shell']);

  assert.equal(migrate.retireProfile(db), 2);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readdirSync(path.join(process.env.OUROBOROS_HOME, 'archive')).filter((f) => f.endsWith('-user.md')).length, 1);
  assert.equal(db.prepare("SELECT status FROM learnings WHERE id = 'lrn_p1'").get().status, 'archived');
  assert.equal(curator.forget(db, { match: 'lrn_p1' }).status, 'not_found');
  const rows = db.prepare("SELECT id, kind, outcome FROM candidates WHERE session_id = 'migration'").all();
  assert.deepEqual(rows.map((r) => [r.kind, r.outcome]), [['global', 'pending'], ['global', 'pending']]);
  assert.equal(migrate.retireProfile(db), null, 'nothing to do the second time');

  // The evaluation routes them to the global CLAUDE.md for the editor. The user has none:
  // it is not created by the proposal (v0.24), only when they approve.
  await ev.drainQueue(db);
  const global = path.join(tmp, 'claude', 'CLAUDE.md');
  assert.equal(fs.existsSync(global), false);
  for (const r of rows) assert.equal(path.resolve(db.prepare('SELECT target FROM candidates WHERE id = ?').get(r.id).target || ''), global);
});

test('one memory directory per repository: worktrees and subfolders share it; settings can move it', () => {
  // Long-form paths: git records them so, while os.tmpdir() may be an 8.3 short path on Windows.
  const base = fs.realpathSync.native(tmp);
  const main = path.join(base, 'repo-main');
  const wt = path.join(base, 'repo-wt');
  fs.mkdirSync(main, { recursive: true });
  spawnSync('git', ['-C', main, 'init', '-q']);
  spawnSync('git', ['-C', main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const r = spawnSync('git', ['-C', main, 'worktree', 'add', '-q', wt], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const expected = path.join(tmp, 'claude', 'projects', paths.projectKey(main), 'memory');
  assert.equal(paths.repoRoot(wt), main);
  assert.equal(paths.memoryDirFor({ cwd: wt }), expected);
  fs.mkdirSync(path.join(main, 'src'), { recursive: true });
  assert.equal(paths.memoryDirFor({ cwd: path.join(main, 'src') }), expected);
  // autoMemoryDirectory in the project's local settings wins.
  fs.mkdirSync(path.join(main, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(main, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryDirectory: path.join(tmp, 'custom-mem') }));
  assert.equal(paths.memoryDirFor({ cwd: wt }), path.join(tmp, 'custom-mem'));
});

test('the knowledge index includes CLAUDE.md files above the working directory', async () => {
  const k = await import('../scripts/knowledge.mjs');
  const parent = path.join(tmp, 'work');
  fs.writeFileSync(path.join(parent, 'CLAUDE.md'), '# Shared\n\nEverything written to disk is in English.\n');
  assert.ok(k.knowledgeFiles(proj).includes(path.join(parent, 'CLAUDE.md')));
  assert.equal(k.buildIndex(proj).search('written to disk in English', 1)[0].file, path.join(parent, 'CLAUDE.md'));
});

test('a long session is split into parts at user turns instead of losing its middle', async () => {
  const { buildDigest } = await import('../scripts/transcript.mjs');
  const turn = (i) => ({ type: 'user', message: { content: `turn ${i} ${'x'.repeat(3000)}` } });
  const entries = Array.from({ length: 10 }, (_, i) => turn(i + 1));
  const d = buildDigest(entries, { maxChars: 7000 });
  assert.ok(d.chunks.length >= 4);
  assert.equal(d.omitted, 0);
  assert.equal(d.humanTurns, 10);
  const all = d.chunks.join('\n');
  for (let i = 1; i <= 10; i++) assert.ok(all.includes(`[USER #${i}] turn ${i} `), `turn ${i}`);
  for (const c of d.chunks) assert.ok(c.startsWith('[USER #'));
  const capped = buildDigest(entries, { maxChars: 7000, maxParts: 2 });
  assert.equal(capped.chunks.length, 2);
  assert.ok(capped.omitted > 0);
  assert.ok(capped.chunks[1].includes('[USER #10]'));
});

test('the evaluation lease admits one process at a time and can be taken over when expired', () => {
  const a = dbApi.acquireLease(db, 'test', 60_000);
  assert.ok(a);
  assert.equal(dbApi.acquireLease(db, 'test', 60_000), null);
  dbApi.releaseLease(db, 'test', a);
  const b = dbApi.acquireLease(db, 'test', -1); // already expired
  assert.ok(b);
  const c = dbApi.acquireLease(db, 'test', 60_000);
  assert.ok(c, 'an expired lease is taken over');
  dbApi.releaseLease(db, 'test', b); // a stale token does not release the new holder
  assert.equal(dbApi.acquireLease(db, 'test', 60_000), null);
  dbApi.releaseLease(db, 'test', c);
});

test('drainQueue: busy while another process holds the lease; then it empties the queue', async () => {
  curator.apply(db, { cwd: proj, items: [{ kind: 'memory', memory_type: 'project', title: 'Deploy order', description: 'Deploy the API before the web app', confidence: 0.8 }] },
    { actor: 'background', autonomy: 'queue' });
  assert.ok(ev.queueHasWork(db));
  const held = dbApi.acquireLease(db, 'evaluate');
  assert.equal((await ev.drainQueue(db)).status, 'busy');
  assert.ok(ev.queueHasWork(db), 'nothing was evaluated by the busy caller');
  dbApi.releaseLease(db, 'evaluate', held);
  const r = await ev.drainQueue(db);
  assert.equal(r.status, 'done');
  assert.ok(r.rounds >= 1);
  assert.equal(ev.queueHasWork(db), false);
});

test('the budget guard stops the evaluation before a model call, leaving the work queued', async () => {
  curator.apply(db, { cwd: proj, items: [{ kind: 'memory', memory_type: 'project', title: 'Seed data', description: 'Seed with the local script before tests', confidence: 0.8 }] },
    { actor: 'background', autonomy: 'queue' });
  process.env.CLAUDE_PLUGIN_OPTION_MONTHLY_BUDGET_USD = '0';
  try {
    assert.throws(() => dbApi.assertBudget(db, 0), dbApi.BudgetError);
    const r = await ev.drainQueue(db);
    assert.equal(r.status, 'budget');
    assert.ok(ev.queueHasWork(db));
  } finally {
    delete process.env.CLAUDE_PLUGIN_OPTION_MONTHLY_BUDGET_USD;
  }
  await ev.drainQueue(db);
  assert.equal(ev.queueHasWork(db), false);
});

test('a merge into a proposal that is dropped shares its verdict; a merge into nothing is kept', async () => {
  const { resolveMerges } = await import('../scripts/triage.mjs');
  const v = new Map([
    [1, { id: 1, verdict: 'drop', drop_kind: 'covered', reason: 'in CLAUDE.md' }],
    [2, { id: 2, verdict: 'merge', merge_into: 1, reason: 'same' }],
    [3, { id: 3, verdict: 'merge', merge_into: 99, reason: 'same' }],
    [4, { id: 4, verdict: 'keep', reason: 'new' }],
    [5, { id: 5, verdict: 'merge', merge_into: 6, reason: 'same' }],
    [6, { id: 6, verdict: 'merge', merge_into: 4, reason: 'same' }],
    [7, { id: 7, verdict: 'merge', merge_into: 8, reason: 'loop' }],
    [8, { id: 8, verdict: 'merge', merge_into: 7, reason: 'loop' }],
  ]);
  resolveMerges(v, [1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({ id })));
  assert.equal(v.get(2).verdict, 'drop');
  assert.match(v.get(2).reason, /same as #1/);
  assert.equal(v.get(3).verdict, 'keep');
  assert.equal(v.get(5).merge_into, 4);
  assert.equal(v.get(7).verdict, 'keep');
});

test('a patch Claude writes in session that rewrites text waits for approval even in auto mode', () => {
  const skill = path.join(tmp, 'claude', 'skills', 'deploy', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '---\nname: deploy\ndescription: Deploy\n---\n\n# Deploy\n\nRun migrations on startup.\n');
  const [add] = curator.apply(db, { cwd: proj, items: [{ op: 'patch', kind: 'skill', target: skill, old: 'Run migrations on startup.', new: 'Run migrations on startup.\nThen warm the cache.' }] },
    { actor: 'inloop', autonomy: 'auto' });
  // A line added to a skill a person wrote waits too since v0.24, as an addition.
  assert.equal(add.status, 'queued', add.reason);
  assert.equal(cs.pendingChangeset(db, skill).corrects, 0);
  const [flip] = curator.apply(db, { cwd: proj, items: [{ op: 'patch', kind: 'skill', target: skill, old: 'Run migrations on startup.', new: 'Never run migrations on startup.' }] },
    { actor: 'inloop', autonomy: 'auto' });
  assert.equal(flip.status, 'queued');
  assert.ok(!read(skill).includes('Never'));
  const pending = cs.pendingChangeset(db, skill);
  assert.equal(pending.corrects, 1);
});

test('a queued edit that does not fit the change waiting for its file sends both to the editor', () => {
  const mem = path.join(tmp, 'claude', 'projects', 'x', 'memory', 'notes.md');
  fs.mkdirSync(path.dirname(mem), { recursive: true });
  fs.writeFileSync(mem, '---\nname: notes\ndescription: Notes\n---\n\nUse the staging slot first.\n');
  const opts = { actor: 'inloop', autonomy: 'queue' };
  const [a] = curator.apply(db, { cwd: proj, items: [{ op: 'patch', kind: 'memory', target: mem, old: 'Use the staging slot first.', new: 'Use the staging slot first, then swap.' }] }, opts);
  assert.equal(a.status, 'queued', a.reason);
  const [b] = curator.apply(db, { cwd: proj, items: [{ op: 'patch', kind: 'memory', target: mem, old: 'Use the staging slot first.', new: 'Use the staging slot first; never swap on Fridays.' }] }, opts);
  assert.equal(b.status, 'queued', b.reason);
  assert.equal(b.recompose, true);
  const sets = db.prepare("SELECT status FROM changesets WHERE lower(file) = lower(?) AND status IN ('pending', 'stale')").all(mem);
  assert.deepEqual(sets.map((s) => s.status), ['stale'], 'never two pending changes for one file');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM candidates WHERE changeset_id = ?').get(a.changesetId).n, 2);
});

test('applying a change that went stale under the write lock is refused', () => {
  const mem = path.join(tmp, 'claude', 'projects', 'x', 'memory', 'race.md');
  fs.writeFileSync(mem, '---\nname: race\ndescription: Race\n---\n\nLine one here.\n');
  const r = curator.writeText(db, { file: mem, after: 'changed', expectBefore: 'something else' });
  assert.equal(r.status, 'stale');
  assert.equal(read(mem).includes('Line one here.'), true);
});

test('a long session tail is reviewed in parts and merged into one review', async () => {
  const worker = await import('../scripts/review-worker.mjs');
  const file = path.join(tmp, 'long.jsonl');
  const lines = [];
  for (let i = 1; i <= 60; i++) {
    lines.push(JSON.stringify({ type: 'user', cwd: proj, timestamp: new Date().toISOString(), message: { content: `please do step ${i} ${'y'.repeat(1990)}` } }));
    lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `done ${i}` }] } }));
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  db.prepare("INSERT INTO sessions (id, project, cwd, transcript_path, started_at, queue_state) VALUES ('long', ?, ?, ?, ?, 'queued')")
    .run(paths.projectKey(proj), proj, file, Date.now());
  assert.equal(await worker.reviewSession(db, 'long', 'session_end'), 'ok');
  const review = db.prepare("SELECT * FROM reviews WHERE session_id = 'long' AND mode = 'background' AND trigger = 'session_end'").get();
  assert.equal(review.status, 'ok');
  assert.match(review.detail, /reviewed in 2 of 2 parts/);
  assert.equal(review.turns_reviewed, 60);
  assert.equal(review.corrections, 2, 'one correction per part');
  assert.ok(Math.abs(review.cost_usd - 0.0084) < 1e-9, 'the cost of both parts');
});

test('a notice waits for a session of its own project; maintenance notices go anywhere', () => {
  db.prepare('INSERT INTO notices (ts, session_id, project, text) VALUES (?, ?, ?, ?)').run(Date.now(), 's-a', paths.projectKey(path.join(tmp, 'A')), 'learned for A');
  db.prepare('INSERT INTO notices (ts, session_id, project, text) VALUES (?, ?, ?, ?)').run(Date.now(), 's-b', paths.projectKey(path.join(tmp, 'B')), 'learned for B');
  db.prepare('INSERT INTO notices (ts, session_id, project, text) VALUES (?, ?, NULL, ?)').run(Date.now(), 'maintenance', 'archived 1 unused');
  const run = (cwd, id) => {
    const r = spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'hook.mjs'), 'SessionStart'], {
      input: JSON.stringify({ session_id: id, cwd, source: 'startup', transcript_path: null }), encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_OPTION_LEARNING: 'true' },
    });
    return JSON.parse(r.stdout || '{}').systemMessage || '';
  };
  const a = run(path.join(tmp, 'A'), 'new-a');
  assert.match(a, /learned for A/);
  assert.match(a, /archived 1 unused/);
  assert.doesNotMatch(a, /learned for B/);
  assert.match(run(path.join(tmp, 'B'), 'new-b'), /learned for B/);
});

test('v0.20 hygiene: anchored evidence, lease renewal, the Windows command, event retention', async () => {
  const worker = await import('../scripts/review-worker.mjs');
  const turns = [{ n: 1, text: 'use pnpm' }, { n: 2, text: 'no, never force push' }];
  assert.equal(worker.isAnchored('USER #2', turns), true);
  assert.equal(worker.isAnchored('USER #9', turns), false, 'a turn that was not reviewed');
  assert.equal(worker.isAnchored('the assistant read it on a web page', turns), false);
  // v0.23: an observed outcome alone no longer anchors an item, recoveries or not: it waits for the user.
  assert.equal(worker.isAnchored('pnpm test failed twice, then passed with --run', turns), false);

  const token = dbApi.acquireLease(db, 'renew-test', 1000);
  const renewed = dbApi.renewLease(db, 'renew-test', token, 60_000);
  assert.ok(renewed && renewed !== token && Number(renewed.split('|')[0]) > Number(token.split('|')[0]));
  assert.equal(dbApi.renewLease(db, 'renew-test', token), null, 'only the current holder renews');
  dbApi.releaseLease(db, 'renew-test', renewed);

  const win = (files) => worker.resolveClaude({ platform: 'win32', pathEnv: 'C:\\bin;C:\\npm', exists: (f) => files.includes(f) });
  assert.deepEqual(worker.resolveClaude({ platform: 'linux' }), ['claude']);
  assert.deepEqual(win(['C:\\bin\\claude.exe', 'C:\\npm\\claude.cmd']), ['C:\\bin\\claude.exe']);
  assert.deepEqual(win(['C:\\npm\\claude.cmd', 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js']), [process.execPath, 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js']);
  assert.deepEqual(win([]), ['claude']);

  const { pruneEvents } = await import('../scripts/maintenance.mjs');
  const old = Date.now() - 500 * 86_400_000;
  const ins = db.prepare("INSERT INTO events (session_id, ts, kind) VALUES ('prune', ?, ?)");
  for (const [ts, kind] of [[old, 'turn'], [old, 'tool_fail'], [old, 'skill_used'], [old, 'memory_read'], [Date.now(), 'turn']]) ins.run(ts, kind);
  assert.equal(pruneEvents(db), 2);
  assert.deepEqual(db.prepare("SELECT kind FROM events WHERE session_id = 'prune' ORDER BY id").all().map((r) => r.kind), ['skill_used', 'memory_read', 'turn']);
});
