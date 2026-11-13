// The dashboard server: malformed requests, framing, bulk decisions and server recognition.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let tmp;
let env;
let child;
let port;
let db;
let projectKey;
let runAction;
let api;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

/** Raw request line, so targets like "//" and "/\" reach the server unchanged. */
const raw = (target, headers = {}) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: target, headers: { Host: `127.0.0.1:${port}`, ...headers }, timeout: 5000 }, (res) => {
    res.resume();
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
  });
  req.on('error', (err) => resolve({ error: err.code || String(err) }));
  req.end();
});

const getJson = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => {
    let b = '';
    res.on('data', (d) => (b += d));
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-v025-'));
  env = {
    ...process.env, HOME: path.join(tmp, 'home'), USERPROFILE: path.join(tmp, 'home'),
    CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'), OUROBOROS_HOME: path.join(tmp, 'ouroboros'), CLAUDE_PLUGIN_DATA: path.join(tmp, 'data'),
  };
  for (const d of [env.HOME, env.CLAUDE_CONFIG_DIR, env.OUROBOROS_HOME, env.CLAUDE_PLUGIN_DATA]) fs.mkdirSync(d, { recursive: true });
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, OUROBOROS_HOME: env.OUROBOROS_HOME, CLAUDE_PLUGIN_DATA: env.CLAUDE_PLUGIN_DATA });
  projectKey = (await import('../scripts/paths.mjs')).projectKey;
  db = (await import('../scripts/db.mjs')).openDb();
  ({ runAction } = await import('../dashboard/actions.mjs'));
  api = (await import('../dashboard/api.mjs')).createApi(db);
  port = await freePort();
  child = spawn(process.execPath, ['--no-warnings', path.join(root, 'dashboard', 'server.mjs'), '--serve', '--data', env.CLAUDE_PLUGIN_DATA, '--port', String(port)], { env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    if ((await raw('/api/ping')).status === 200) break;
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(() => {
  child?.kill();
  db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('M20: malformed targets and directories never stop the server', async () => {
  for (const target of ['//', '/\\', '///', '//?a=1', '/ok/../..//', '/ok/..//']) {
    const r = await raw(target);
    assert.ok([400, 404].includes(r.status), `${target} -> ${JSON.stringify(r)}`);
  }
  assert.equal((await raw('//')).status, 404);
  assert.equal(child.exitCode, null, 'the server is still running');
  assert.equal((await raw('/api/ping')).status, 200);
  assert.equal((await raw('/')).status, 200);
});

test('M19: every response forbids framing', async () => {
  for (const target of ['/', '/app.js', '/api/ping', '/nope', '//']) {
    const r = await raw(target);
    assert.equal(r.headers['x-frame-options'], 'DENY', target);
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/, target);
    assert.match(r.headers['content-security-policy'], /base-uri 'none'/, target);
  }
});

test('Low: a bulk decision needs the confirmed count and a readable filter', async () => {
  const cwd = path.join(tmp, 'work', 'app');
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  for (const n of [1, 2]) {
    db.prepare(`INSERT INTO candidates (review_id, session_id, project, kind, title, summary, confidence, ts, outcome, payload, cwd, triaged_at)
      VALUES (1, 's1', ?, 'memory', ?, 'x', 0.6, ?, 'queued', ?, ?, ?)`).run(projectKey(cwd), `Entry ${n}`, Date.now(),
      JSON.stringify({ item: { op: 'create', kind: 'memory', title: `Entry ${n}`, description: 'd' } }), cwd, Date.now());
  }
  const open = () => db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE outcome = 'queued'").get().n;
  const before = open();
  assert.equal(before, 2);
  const longGroup = `${projectKey(cwd)}|file:${'/deep/path'.repeat(60)}`;
  assert.ok(longGroup.length > 400);
  for (const f of [{ group: longGroup }, { group: 'no-such-group' }, { project: 7, expect: 2 }, { group: 'x'.repeat(5000), expect: 2 }, {}]) {
    const r = await runAction(db, 'reject_many', f, api);
    assert.equal(r.status, 'invalid', JSON.stringify([f.group?.length, r]));
  }
  assert.equal(open(), before, 'nothing was decided');
  // A long, readable group id is honoured: with its real count (none) it decides nothing else.
  const r = await runAction(db, 'reject_many', { group: longGroup, expect: 0 }, api);
  assert.equal(r.status, 'done');
  assert.equal(open(), before);
});

test('Launcher: the ping names the data directory and pid the server serves', async () => {
  const ping = await getJson('/api/ping');
  assert.equal(ping.app, 'ouroboros');
  assert.equal(path.resolve(ping.data), path.resolve(env.CLAUDE_PLUGIN_DATA));
  assert.equal(ping.pid, child.pid);
});
