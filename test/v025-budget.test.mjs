// v0.25.2: a monthly budget raised in `/plugin` showed the old value on the dashboard until
// the next session started, and the sessions the old budget held back were reviewed three
// per session start (or never, when an older version had skipped them).
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
let config;
let worker;
let api;
let proj;
let settingsFile;
let optionsFile;
let transcript;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-budget-'));
  const home = path.join(tmp, 'home');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.OUROBOROS_HOME = path.join(tmp, 'ouroboros');
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data');
  process.env.OUROBOROS_CLAUDE_CMD = JSON.stringify([process.execPath, path.join(root, 'test', 'fixtures', 'fake-claude.mjs')]);
  for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE_PLUGIN_OPTION_')) delete process.env[k];
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  proj = path.join(home, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  spawnSync('git', ['-C', proj, 'init', '-q']);
  settingsFile = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  optionsFile = path.join(process.env.CLAUDE_PLUGIN_DATA, 'options.json');
  dbApi = await import('../scripts/db.mjs');
  config = await import('../scripts/config.mjs');
  worker = await import('../scripts/review-worker.mjs');
  api = await import('../dashboard/api.mjs');
  db = dbApi.openDb();
  transcript = path.join(tmp, 't.jsonl');
  const line = (type, text) => JSON.stringify({ type, cwd: proj, timestamp: new Date().toISOString(), message: { role: type, content: text } });
  const lines = [];
  for (let i = 1; i <= 4; i++) lines.push(line('user', `turn ${i}: please fix the build`), line('assistant', `done ${i}`));
  fs.writeFileSync(transcript, `${lines.join('\n')}\n`);
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const overview = () => api.createApi(db)('overview', new URLSearchParams({ days: '30' }));
const touch = (file, ms) => fs.utimesSync(file, ms / 1000, ms / 1000);

test('the dashboard shows a budget changed in /plugin before the next session start', () => {
  fs.writeFileSync(optionsFile, JSON.stringify({ monthlyBudgetUsd: 5, autoMemory: { on: true }, updatedAt: Date.now() - 60_000 }));
  assert.equal(overview().cost.budget, 5, 'only the snapshot: its value');
  // What `/plugin` writes: the options under the plugin's id, in the user settings.
  fs.writeFileSync(settingsFile, JSON.stringify({ pluginConfigs: { 'ouroboros@ouroboros': { options: { monthly_budget_usd: 30 } } } }));
  assert.equal(overview().cost.budget, 30, 'settings edited after the snapshot win');
  assert.equal(overview().options.autoMemory.on, true, 'what the hook recorded beside the options stays');
  // A snapshot taken after the settings changed (the next session start) is the newer word.
  touch(settingsFile, Date.now() - 120_000);
  assert.equal(overview().cost.budget, 5);
  // A worker started by hand (no CLAUDE_PLUGIN_OPTION_*) sees the same.
  touch(settingsFile, Date.now());
  assert.equal(config.options().monthlyBudgetUsd, 30);
  // An option removed from the settings is back to its default, as in the next hook.
  fs.writeFileSync(settingsFile, JSON.stringify({ pluginConfigs: { 'ouroboros@ouroboros': { options: {} } } }));
  assert.equal(overview().cost.budget, 5);
  fs.rmSync(settingsFile);
  fs.rmSync(optionsFile);
});

function addSession(id, state, startedAt) {
  db.prepare(`INSERT INTO sessions (id, project, cwd, transcript_path, started_at, ended_at, turns, queue_state, reviewed_at, last_event_at)
    VALUES (?, 'p', ?, ?, ?, ?, 4, ?, ?, ?)`).run(id, proj, transcript, startedAt, startedAt + 1000, state, Date.now(), Date.now());
  db.prepare(`INSERT INTO reviews (session_id, mode, trigger, model, status, detail, turns_reviewed, corrections, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, ts) VALUES (?, 'background', 'session_end', 'haiku', 'skipped', 'monthly budget reached', 0, 0, 0, 0, 0, 0, 0, 0, ?)`)
    .run(id, Date.now());
}

test('a raised budget finishes every session the old one held back, newest first, until it runs out', async () => {
  const now = Date.now();
  // Six sessions held back this month by a spent budget (the sweep took three per start);
  // one skipped by an older version, when a budget skip was final.
  for (let i = 0; i < 6; i++) addSession(`w${i}`, 'waiting', now - (i + 1) * 3_600_000);
  addSession('old-skip', 'skipped', now - 10 * 3_600_000);
  // One that failed a moment ago waits its 30 minutes; a backfill skip is not taken.
  db.prepare("INSERT INTO sessions (id, project, cwd, transcript_path, started_at, turns, queue_state, reviewed_at, last_event_at) VALUES ('just-failed', 'p', ?, ?, ?, 4, 'waiting', ?, ?)")
    .run(proj, transcript, now, now, now);
  db.prepare(`INSERT INTO reviews (session_id, mode, trigger, model, status, detail, turns_reviewed, corrections, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, ts) VALUES ('just-failed', 'background', 'session_end', 'haiku', 'failed', 'boom', 0, 0, 0, 0, 0, 0, 0, 0, ?)`).run(now);

  assert.deepEqual(dbApi.resumableSessions(db, now), ['w0', 'w1', 'w2', 'w3', 'w4', 'w5']);
  assert.equal(dbApi.requeueBudgetSkips(db, now), 1);
  assert.equal(db.prepare("SELECT queue_state FROM sessions WHERE id = 'old-skip'").get().queue_state, 'waiting');

  // The budget is still spent: nothing is taken.
  process.env.CLAUDE_PLUGIN_OPTION_MONTHLY_BUDGET_USD = '0.002';
  db.prepare(`INSERT INTO reviews (session_id, mode, trigger, model, status, turns_reviewed, corrections, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, ts) VALUES ('spent', 'background', 'session_end', 'haiku', 'ok', 0, 0, 0, 0, 0, 0, 0.002, 0, ?)`).run(now);
  try {
    assert.deepEqual(await worker.resumeWaiting(db), { reviewed: 0, statuses: [] });
    // Raised: all seven in one run, not three per session start.
    process.env.CLAUDE_PLUGIN_OPTION_MONTHLY_BUDGET_USD = '30';
    const r = await worker.resumeWaiting(db);
    assert.equal(r.reviewed, 7);
    assert.ok(r.statuses.every((s) => s === 'ok'), r.statuses.join());
    const states = Object.fromEntries(db.prepare('SELECT id, queue_state FROM sessions').all().map((s) => [s.id, s.queue_state]));
    for (const id of ['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'old-skip']) assert.equal(states[id], 'done', id);
    assert.equal(states['just-failed'], 'waiting', 'a failure is retried after 30 minutes, not at once');
  } finally {
    delete process.env.CLAUDE_PLUGIN_OPTION_MONTHLY_BUDGET_USD;
  }
});
