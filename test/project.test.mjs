// v0.18 one project per repository: a session in a worktree or a subfolder shares its
// repository's notices, inbox, project skills and knowledge files.
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
let curator;
let paths;
let main;
let wt;

function start(cwd, id) {
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'hook.mjs'), 'SessionStart'], {
    input: JSON.stringify({ session_id: id, cwd, source: 'startup', transcript_path: null }), encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_OPTION_LEARNING: 'true' },
  });
  return JSON.parse(r.stdout || '{}').systemMessage || '';
}

before(async () => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-project-')));
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.OUROBOROS_HOME = path.join(tmp, 'ouroboros');
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data');
  process.env.OUROBOROS_CLAUDE_CMD = JSON.stringify([process.execPath, path.join(root, 'test', 'fixtures', 'fake-claude.mjs')]);
  main = path.join(tmp, 'repo');
  wt = path.join(tmp, 'repo-wt');
  fs.mkdirSync(path.join(main, 'src'), { recursive: true });
  fs.writeFileSync(path.join(main, 'CLAUDE.md'), '# Repo\n\nRun pnpm test.\n');
  spawnSync('git', ['-C', main, 'init', '-q']);
  spawnSync('git', ['-C', main, 'add', '.']);
  spawnSync('git', ['-C', main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  const r = spawnSync('git', ['-C', main, 'worktree', 'add', '-q', wt], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  curator = await import('../scripts/curator.mjs');
  paths = await import('../scripts/paths.mjs');
  db = (await import('../scripts/db.mjs')).openDb();
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('a worktree and a subfolder have their repository\'s key and stand in for its main checkout', () => {
  const key = paths.projectKey(main);
  assert.equal(paths.projectIdFor(wt), key);
  assert.equal(paths.projectIdFor(path.join(main, 'src')), key);
  assert.equal(paths.projectIdFor(path.join(tmp, 'elsewhere')), paths.projectKey(path.join(tmp, 'elsewhere')));
  assert.equal(paths.stableDir(path.join(wt, 'src')), path.join(main, 'src'));
  assert.equal(paths.stableDir(main), main);
});

test('a notice from a session in a worktree reaches the next session in the repository', () => {
  start(wt, 'in-worktree');
  const s = db.prepare("SELECT project FROM sessions WHERE id = 'in-worktree'").get();
  assert.equal(s.project, paths.projectKey(main));
  db.prepare('INSERT INTO notices (ts, session_id, project, text) VALUES (?, ?, ?, ?)').run(Date.now(), 'in-worktree', s.project, 'learned in the worktree');
  assert.match(start(path.join(main, 'src'), 'in-subfolder'), /learned in the worktree/);
});

test('rows keyed by folder before v0.18 are re-keyed once', async () => {
  const { rekeyProjects } = await import('../scripts/migrate.mjs');
  const old = paths.projectKey(wt);
  db.prepare("INSERT INTO sessions (id, project, cwd, started_at) VALUES ('old', ?, ?, 1)").run(old, wt);
  db.prepare("INSERT INTO candidates (review_id, session_id, project, kind, title, outcome, cwd, ts) VALUES (0, 'old', ?, 'memory', 'Old item', 'queued', ?, 1)").run(old, wt);
  db.prepare("INSERT INTO notices (ts, session_id, project, text) VALUES (1, 'old', ?, 'old notice')").run(old);
  db.prepare("DELETE FROM meta WHERE key = 'project_keys'").run();
  assert.ok(rekeyProjects(db) >= 3);
  const key = paths.projectKey(main);
  assert.equal(db.prepare("SELECT project FROM sessions WHERE id = 'old'").get().project, key);
  assert.equal(db.prepare("SELECT project FROM candidates WHERE title = 'Old item'").get().project, key);
  assert.equal(db.prepare("SELECT project FROM notices WHERE text = 'old notice'").get().project, key);
  assert.equal(rekeyProjects(db), 0, 'runs once');
  db.prepare("DELETE FROM candidates WHERE title = 'Old item'").run();
});

test('from a worktree, a project skill is written to the main checkout and its CLAUDE.md is the one that gets the change', async () => {
  const [r] = curator.apply(db, { cwd: wt, items: [{ kind: 'skill', scope: 'project', title: 'Seed the database', description: 'Recreate and seed the local database. Use before end-to-end tests.', body: '## Steps\n1. Run the seed script.', confidence: 0.8 }] }, { actor: 'inloop', autonomy: 'auto' });
  assert.equal(r.status, 'created', r.reason);
  assert.equal(path.resolve(r.path), path.join(main, '.claude', 'skills', 'seed-the-database', 'SKILL.md'));
  assert.ok(!fs.existsSync(path.join(wt, '.claude')));

  const k = await import('../scripts/knowledge.mjs');
  const files = k.knowledgeFiles(path.join(wt, 'src'));
  assert.ok(files.includes(path.join(main, 'CLAUDE.md')));
  assert.ok(!files.some((f) => f.startsWith(wt + path.sep)), 'nothing is read from the worktree copy');
  assert.ok(files.includes(r.path));
});

test('a change waiting for a file that no longer exists is closed instead of retried forever', async () => {
  const { tidyQueue, queueHasWork } = await import('../scripts/evaluate.mjs');
  const gone = path.join(main, '.claude', 'rules', 'gone.md');
  fs.mkdirSync(path.dirname(gone), { recursive: true });
  fs.writeFileSync(gone, '# Gone\n\n- A rule.\n');
  const [q] = curator.apply(db, { cwd: main, items: [{ op: 'patch', target: gone, append: 'Another rule.', title: 'Another rule' }] }, { actor: 'inloop', autonomy: 'auto' });
  assert.equal(q.status, 'queued');
  fs.rmSync(gone);
  db.prepare("UPDATE changesets SET status = 'stale' WHERE id = ?").run(q.changesetId);
  await tidyQueue(db);
  assert.equal(db.prepare('SELECT status FROM changesets WHERE id = ?').get(q.changesetId).status, 'rejected');
  const c = db.prepare('SELECT outcome, note FROM candidates WHERE id = ?').get(q.candidateId);
  assert.equal(c.outcome, 'dropped');
  assert.match(c.note, /no longer exists/);
  assert.equal(queueHasWork(db), false);
});
