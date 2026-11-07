// Phase 4: approval queue, confirmation, promotion, consolidation, decay, exclusions.
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
let cwdA;
let cwdB;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-life-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.OUROBOROS_HOME = path.join(tmp, 'ouroboros');
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data');
  process.env.OUROBOROS_CLAUDE_CMD = JSON.stringify([process.execPath, path.join(root, 'test', 'fixtures', 'fake-claude.mjs')]);
  process.env.CLAUDE_PLUGIN_OPTION_MONTHLY_BUDGET_USD = '5';
  cwdA = path.join(tmp, 'work', 'a');
  cwdB = path.join(tmp, 'work', 'b');
  for (const d of [cwdA, cwdB]) fs.mkdirSync(path.join(d, '.git'), { recursive: true });
  fs.mkdirSync(process.env.OUROBOROS_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.OUROBOROS_HOME, 'config.json'), JSON.stringify({
    limits: { userBlockChars: 160, learnedSkills: 4, consolidateAt: 0.8 },
    archiveAfterDaysUnused: 60,
    excludeProjects: ['**/secret-*'],
  }));
  curator = await import('../scripts/curator.mjs');
  db = (await import('../scripts/db.mjs')).openDb();
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('autonomy: hybrid queues skills and tentative items; manual always writes; approve/reject', () => {
  const items = [
    { kind: 'profile', block: 'user', text: 'Prefers small PRs', confidence: 0.8 },
    { kind: 'memory', memory_type: 'project', title: 'Tentative fact', description: 'Maybe true', confidence: 0.4 },
    { kind: 'skill', scope: 'global', title: 'Bisect flaky tests', description: 'Find the commit that made a test flaky with git bisect. Use when a test started failing intermittently.', body: 'Steps', confidence: 0.9 },
  ];
  const r = curator.apply(db, { cwd: cwdA, items }, { actor: 'inloop', autonomy: 'hybrid' });
  assert.deepEqual(r.map((x) => x.status), ['created', 'queued', 'queued']);

  const manual = curator.apply(db, { cwd: cwdA, items: [{ kind: 'skill', scope: 'global', title: 'Seed local database', description: 'Recreate and seed the local SQL database. Use before running end-to-end tests.', body: 'Steps', confidence: 0.5 }] }, { actor: 'manual', autonomy: 'queue' });
  assert.equal(manual[0].status, 'created');

  const queued = db.prepare("SELECT id, title FROM candidates WHERE outcome = 'queued' ORDER BY id").all();
  assert.equal(queued.length, 2);
  const approved = curator.decideQueued(db, queued[1].id, true);
  assert.equal(approved.status, 'created', approved.reason);
  const skillDir = path.join(tmp, 'claude', 'skills', 'learned-bisect-flaky-tests');
  assert.ok(fs.existsSync(path.join(skillDir, 'SKILL.md')));
  // Archiving a skill removes its folder; undo brings it back.
  assert.equal(curator.forget(db, { match: approved.id }).status, 'archived');
  assert.equal(fs.existsSync(skillDir), false);
  assert.equal(curator.undo(db, { id: approved.id }).status, 'undone');
  assert.ok(fs.existsSync(path.join(skillDir, 'SKILL.md')));
  assert.equal(curator.decideQueued(db, queued[0].id, false).status, 'rejected_by_user');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM candidates WHERE outcome = 'queued'").get().n, 0);
});

test('confirm raises confidence up to 0.9', () => {
  const l = db.prepare("SELECT id, confidence FROM learnings WHERE kind = 'profile'").get();
  curator.confirm(db, l.id);
  curator.confirm(db, l.id);
  assert.equal(db.prepare('SELECT confidence FROM learnings WHERE id = ?').get(l.id).confidence, 0.9);
});

test('a way-of-working rule already saved in another project is promoted to the profile', () => {
  const [a] = curator.apply(db, { cwd: cwdA, items: [{ kind: 'memory', memory_type: 'feedback', title: 'English names in code', description: 'Name folders, routes and files in English, never Portuguese' }] });
  assert.equal(a.status, 'created');
  assert.equal(a.kind, 'memory');
  const [b] = curator.apply(db, { cwd: cwdB, items: [{ kind: 'memory', memory_type: 'feedback', title: 'English names', description: 'Name folders, routes and files in English, never in Portuguese' }] });
  assert.equal(b.status, 'created', b.reason);
  assert.equal(b.kind, 'profile');
  assert.match(b.note, /promoted/);
});

test('maintenance consolidates a full profile block (undoable) and archives unused learnings', async () => {
  const { maintain } = await import('../scripts/maintenance.mjs');
  curator.apply(db, { cwd: cwdA, items: [
    { kind: 'profile', block: 'user', text: 'Talks to Claude in Portuguese', confidence: 0.8 },
    { kind: 'profile', block: 'user', text: 'Wants files on disk in English', confidence: 0.8 },
  ] });
  const file = path.join(process.env.OUROBOROS_HOME, 'user.md');
  const before = fs.readFileSync(file, 'utf8');

  // An old, never used, low-confidence memory decays.
  const [old] = curator.apply(db, { cwd: cwdA, items: [{ kind: 'memory', memory_type: 'project', title: 'Old trivia', description: 'Something nobody reads', confidence: 0.4 }] });
  db.prepare('UPDATE learnings SET created_at = ? WHERE id = ?').run(Date.now() - 90 * 86_400_000, old.id);

  const report = await maintain(db, { force: true });
  assert.equal(report.status, 'ok');
  assert.deepEqual(report.decayed, ['Old trivia']);
  const user = report.consolidated.find((c) => c.block === 'user');
  assert.equal(user.status, 'consolidated', user.reason);
  assert.ok(user.after < user.before);
  assert.notEqual(fs.readFileSync(file, 'utf8'), before);
  assert.equal(db.prepare("SELECT status FROM learnings WHERE id = ?").get(old.id).status, 'archived');
  assert.match(db.prepare('SELECT text FROM notices ORDER BY id DESC').get().text, /🧹/);

  // Undo of the consolidation restores the block and reactivates merged facts.
  const consolidateWrite = db.prepare("SELECT learning_id FROM writes WHERE op = 'consolidate' ORDER BY id DESC").get();
  const u = curator.undo(db, { id: consolidateWrite.learning_id });
  assert.equal(u.status, 'undone', u.reason);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const ids = [...before.matchAll(/<!-- (lrn_[a-z0-9]+) -->/g)].map((m) => m[1]);
  for (const id of ids) assert.equal(db.prepare('SELECT status FROM learnings WHERE id = ?').get(id).status, 'active');
});

test('learned skills past the budget are trimmed, weakest first', async () => {
  const { consolidate } = await import('../scripts/maintenance.mjs');
  const { loadSettings } = await import('../scripts/settings.mjs');
  const { options } = await import('../scripts/config.mjs');
  curator.apply(db, { cwd: cwdA, items: [
    { kind: 'skill', scope: 'global', title: 'Deploy api zip', description: 'Deploy the API zip. Use when publishing.', body: 'a', confidence: 0.3 },
    { kind: 'skill', scope: 'global', title: 'Rotate keys', description: 'Rotate signing keys. Use when keys expire.', body: 'b', confidence: 0.8 },
  ] });
  const n = () => db.prepare("SELECT COUNT(*) n FROM learnings WHERE kind = 'skill' AND status = 'active' AND origin_session IS NOT 'native'").get().n;
  assert.equal(n(), 4);
  const report = await consolidate(db, loadSettings(), options());
  assert.ok(report.archived.includes('Deploy api zip'));
  assert.ok(n() <= 2);
});

test('excluded projects are ignored by every hook', () => {
  const env = { ...process.env };
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'hook.mjs'), 'SessionStart'], {
    input: JSON.stringify({ session_id: 'ex1', cwd: path.join(tmp, 'work', 'secret-repo'), source: 'startup' }),
    env, encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions WHERE id = 'ex1'").get().n, 0);
});

test('first use in a session reinforces a learning', () => {
  const l = db.prepare("SELECT id, path, confidence FROM learnings WHERE kind = 'memory' AND status = 'active'").get();
  db.prepare('UPDATE learnings SET confidence = 0.5, last_used_at = NULL WHERE id = ?').run(l.id);
  const run = (sid) => spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'hook.mjs'), 'PostToolUse'], {
    input: JSON.stringify({ session_id: sid, cwd: cwdA, tool_name: 'Read', tool_input: { file_path: l.path }, tool_response: {} }),
    env: process.env,
  });
  run('use-1');
  run('use-1');
  const row = db.prepare('SELECT confidence, uses FROM learnings WHERE id = ?').get(l.id);
  assert.equal(row.uses, 2);
  assert.equal(Math.round(row.confidence * 10) / 10, 0.6);
});
