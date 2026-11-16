// v0.26: a custom auto-memory directory (`autoMemoryDirectory`) is resolved as Claude Code
// resolves it, and the memories in it are memories everywhere: in the hooks, the knowledge
// check, the dashboard and the learnings' project.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'test', 'fixtures');
let tmp;
let db;
let paths;
let curator;
let inventory;
let knowledge;
let managed;

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const settings = (dir, name, value) => write(path.join(dir, '.claude', name), JSON.stringify({ autoMemoryDirectory: value }));
const project = (name) => { const d = path.join(tmp, 'work', name); fs.mkdirSync(path.join(d, '.git'), { recursive: true }); return d; };
const memory = (dir, name, description) => write(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: ${description}\ntype: project\n---\n\n${description}\n`);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-v026m-'));
  process.env.HOME = path.join(tmp, 'home');
  process.env.USERPROFILE = process.env.HOME;
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.OUROBOROS_HOME = path.join(tmp, 'ouroboros');
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data');
  process.env.OUROBOROS_CLAUDE_CMD = JSON.stringify([process.execPath, path.join(fixtures, 'fake-claude.mjs')]);
  managed = path.join(tmp, 'managed');
  process.env.OUROBOROS_MANAGED_SETTINGS_DIR = managed;
  for (const k of ['CLAUDE_COWORK_MEMORY_PATH_OVERRIDE', 'CLAUDE_CODE_REMOTE_MEMORY_DIR', 'CLAUDE_CODE_PROJECT_DIR_NAME', 'CLAUDE_PLUGIN_OPTION_AUTONOMY']) delete process.env[k];
  fs.mkdirSync(process.env.HOME, { recursive: true });
  paths = await import('../scripts/paths.mjs');
  curator = await import('../scripts/curator.mjs');
  inventory = await import('../scripts/inventory.mjs');
  knowledge = await import('../scripts/knowledge.mjs');
  db = (await import('../scripts/db.mjs')).openDb();
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const defaultDir = (dir) => path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', paths.projectDirName(dir), 'memory');

test('autoMemoryDirectory: managed, local, project, then user settings; the first one set decides', () => {
  const p = project('order');
  const user = path.join(tmp, 'user-mem');
  write(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ autoMemoryDirectory: user }));
  try {
    assert.equal(paths.memoryDirFor({ cwd: p }), user);
    settings(p, 'settings.json', path.join(tmp, 'project-mem'));
    assert.deepEqual(paths.autoMemoryDirectorySetting(p), { dir: path.join(tmp, 'project-mem'), source: 'project', value: path.join(tmp, 'project-mem') });
    settings(p, 'settings.local.json', path.join(tmp, 'local-mem'));
    assert.equal(paths.memoryDirFor({ cwd: p }), path.join(tmp, 'local-mem'));
    // Managed policy settings win over all of them; a drop-in file over the base file.
    write(path.join(managed, 'managed-settings.json'), JSON.stringify({ autoMemoryDirectory: path.join(tmp, 'policy-mem') }));
    assert.equal(paths.memoryDirFor({ cwd: p }), path.join(tmp, 'policy-mem'));
    write(path.join(managed, 'managed-settings.d', '10-memory.json'), JSON.stringify({ autoMemoryDirectory: path.join(tmp, 'drop-in-mem') }));
    assert.equal(paths.autoMemoryDirectorySetting(p).source, 'managed');
    assert.equal(paths.memoryDirFor({ cwd: p }), path.join(tmp, 'drop-in-mem'));
  } finally {
    fs.rmSync(managed, { recursive: true, force: true });
    fs.rmSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), { force: true });
  }
});

test('autoMemoryDirectory: a value Claude Code refuses means the default directory, not the next source', () => {
  const p = project('refused');
  write(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ autoMemoryDirectory: path.join(tmp, 'user-mem') }));
  try {
    for (const bad of ['relative/mem', '~', '~/..', '~/../elsewhere', '', 42]) {
      settings(p, 'settings.local.json', bad);
      assert.equal(paths.memoryDirFor({ cwd: p }), defaultDir(p), `value ${JSON.stringify(bad)}`);
    }
    settings(p, 'settings.local.json', '~/notes/memory/');
    assert.equal(paths.memoryDirFor({ cwd: p }), path.join(process.env.HOME, 'notes', 'memory'), '~/ is expanded and the trailing separator dropped');
  } finally {
    fs.rmSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), { force: true });
  }
});

test('a file in a custom memory directory is a memory, not a source of truth', () => {
  const p = project('kind');
  const dir = path.join(tmp, 'kind-mem');
  settings(p, 'settings.local.json', dir);
  memory(dir, 'staging_db', 'Staging uses the shared Postgres');
  const file = path.join(dir, 'staging_db.md');
  assert.equal(paths.classifyPath(file, p), 'memory');
  assert.equal(knowledge.knowledgeKind(file, p), 'memory');
  assert.ok(knowledge.knowledgeFiles(p).includes(file));
  // Once resolved in this process, the directory is known without the session's folder.
  assert.equal(knowledge.knowledgeKind(file), 'memory');
  assert.equal(paths.classifyPath(path.join(tmp, 'kind-mem-other', 'x.md')), null);
});

test('a memory saved into a custom directory is recorded under its project', () => {
  const p = project('save');
  const dir = path.join(tmp, 'save-mem');
  settings(p, 'settings.local.json', dir);
  const [r] = curator.apply(db, { cwd: p, items: [{ kind: 'memory', memory_type: 'project', title: 'Release train', description: 'Releases ship every Tuesday from main', body: 'x' }] }, { actor: 'manual' });
  assert.equal(r.status, 'created', JSON.stringify(r));
  assert.equal(path.dirname(r.path), dir);
  assert.ok(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8').includes('Release train'));
  const row = db.prepare('SELECT project FROM learnings WHERE id = ?').get(r.id);
  assert.equal(row.project, paths.projectIdFor(p), 'until v0.26 the project was the custom folder\'s parent name');
});

test('memories in custom directories are listed once, under the most recent project that uses them', () => {
  const a = project('list-a');
  const b = project('list-b');
  const shared = path.join(tmp, 'shared-mem');
  settings(a, 'settings.local.json', shared);
  settings(b, 'settings.local.json', shared);
  memory(shared, 'deploy_window', 'Deploys happen after 6pm');
  const listed = inventory.listMemories(null, [b, a]).filter((m) => m.file === path.join(shared, 'deploy_window.md'));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].project, paths.projectIdFor(b));
  assert.equal(inventory.listMemories().some((m) => m.file.startsWith(shared)), false, 'without the folders, only the config folder is scanned');
});

test('the dashboard lists a custom directory\'s memories under their project', async () => {
  const p = project('dash');
  const dir = path.join(tmp, 'dash-mem');
  settings(p, 'settings.local.json', dir);
  memory(dir, 'ci_runner', 'CI runs on the self-hosted runner');
  db.prepare('INSERT INTO sessions (id, project, cwd, started_at, turns) VALUES (?, ?, ?, ?, 3)').run('dash-1', paths.projectKey(p), p, Date.now());
  const api = (await import('../dashboard/api.mjs')).createApi(db);
  const res = api('inventory', { kind: 'memories', per: 100 });
  const row = res.groups.flatMap((g) => g.rows).find((m) => m.name === 'ci_runner');
  assert.ok(row, JSON.stringify(res.groups.map((g) => g.label)));
  assert.equal(row.project_name, 'dash');
});

test('the hook records a read of a memory in a directory named by the project\'s settings', () => {
  const p = project('hook');
  const dir = path.join(tmp, 'hook-mem');
  settings(p, 'settings.local.json', dir);
  memory(dir, 'ports', 'The API listens on 8081');
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'hook.mjs'), 'PostToolUse'], {
    input: JSON.stringify({ session_id: 'hook-1', cwd: p, transcript_path: path.join(fixtures, 'session.jsonl'), hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(dir, 'ports.md') }, tool_response: {} }),
    env: { ...process.env, CLAUDE_PLUGIN_DATA: path.join(tmp, 'hook-data') },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const d = new DatabaseSync(path.join(tmp, 'hook-data', 'events.db'));
  try {
    const ev = d.prepare("SELECT kind, target FROM events WHERE session_id = 'hook-1' AND kind = 'memory_read'").get();
    assert.equal(ev?.target, path.join(dir, 'ports.md'));
  } finally { d.close(); }
});
