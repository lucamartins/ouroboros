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
    limits: { learnedSkills: 4, consolidateAt: 0.8 },
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
    { kind: 'memory', memory_type: 'project', title: 'Small PRs', description: 'This project prefers small PRs', confidence: 0.8 },
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
  const l = db.prepare("SELECT id, confidence FROM learnings WHERE title = 'Small PRs'").get();
  curator.confirm(db, l.id);
  curator.confirm(db, l.id);
  assert.equal(db.prepare('SELECT confidence FROM learnings WHERE id = ?').get(l.id).confidence, 0.9);
});

test('a way-of-working rule already saved in another project becomes a global fact', () => {
  const [a] = curator.apply(db, { cwd: cwdA, items: [{ kind: 'memory', memory_type: 'feedback', title: 'English names in code', description: 'Name folders, routes and files in English, never Portuguese' }] });
  assert.equal(a.status, 'created');
  assert.equal(a.kind, 'memory');
  const [b] = curator.apply(db, { cwd: cwdB, items: [{ kind: 'memory', memory_type: 'feedback', title: 'English names', description: 'Name folders, routes and files in English, never in Portuguese' }] });
  assert.equal(b.status, 'patched', b.reason);
  assert.equal(b.kind, 'instructions');
  assert.match(b.note, /global fact/);
  assert.match(fs.readFileSync(path.join(tmp, 'claude', 'CLAUDE.md'), 'utf8'), /- Name folders, routes and files in English, never in Portuguese/);
});

test('maintenance archives unused learnings', async () => {
  const { maintain } = await import('../scripts/maintenance.mjs');
  // An old, never used, low-confidence memory decays.
  const [old] = curator.apply(db, { cwd: cwdA, items: [{ kind: 'memory', memory_type: 'project', title: 'Old trivia', description: 'Something nobody reads', confidence: 0.4 }] });
  db.prepare('UPDATE learnings SET created_at = ? WHERE id = ?').run(Date.now() - 90 * 86_400_000, old.id);

  const report = await maintain(db, { force: true });
  assert.equal(report.status, 'ok');
  assert.deepEqual(report.decayed, ['Old trivia']);
  assert.equal(db.prepare("SELECT status FROM learnings WHERE id = ?").get(old.id).status, 'archived');
  assert.match(db.prepare('SELECT text FROM notices ORDER BY id DESC').get().text, /🧹/);

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

test('learning backfill: oldest first, into the approval queue, deduplicated, not counted twice', () => {
  const proj = path.join(tmp, 'claude', 'projects', 'past');
  fs.mkdirSync(proj, { recursive: true });
  const fixture = fs.readFileSync(path.join(root, 'test', 'fixtures', 'session.jsonl'), 'utf8').replace(/"\/tmp\/proj"/g, JSON.stringify(cwdA));
  const old = (Date.now() - 3 * 86_400_000) / 1000;
  for (const [i, id] of ['past-a', 'past-b'].entries()) {
    const file = path.join(proj, `${id}.jsonl`);
    fs.writeFileSync(file, fixture);
    fs.utimesSync(file, old + i * 60, old + i * 60);
  }
  const queuedBefore = db.prepare("SELECT COUNT(*) n FROM candidates WHERE outcome = 'queued'").get().n;
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'review-worker.mjs'), '--backfill', '--learn', '--days', '30', '--limit', '10'], {
    env: process.env, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[1\/2\] past-a ok/);
  assert.match(r.stdout, /\[2\/2\] past-b ok/);
  const reviews = db.prepare("SELECT turns_reviewed, corrections FROM reviews WHERE trigger = 'backfill-learn'").all();
  assert.equal(reviews.length, 2);
  assert.ok(reviews.every((x) => x.turns_reviewed === 0 && x.corrections === 0));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM corrections WHERE session_id IN ('past-a', 'past-b')").get().n, 0);
  // Two sessions proposing the same two items leave two queued proposals, not four.
  const queued = db.prepare("SELECT session_id FROM candidates WHERE outcome = 'queued'").all();
  assert.equal(queued.length - queuedBefore, 2);
  assert.ok(queued.slice(-2).every((q) => q.session_id === 'past-b'));
  // Running it again finds nothing new to learn from.
  const again = spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'review-worker.mjs'), '--backfill', '--learn', '--dry-run'], { env: process.env, encoding: 'utf8' });
  assert.match(again.stdout, /"sessions":0/);
});

test('knowledge index finds existing documentation by keywords', async () => {
  const { buildIndex, chunkMarkdown } = await import('../scripts/knowledge.mjs');
  fs.writeFileSync(path.join(cwdA, 'CLAUDE.md'), '# Repo\n\n## Deploy\n\nZip with Python: Compress-Archive writes backslashes and breaks Linux App Service.\n\n## Tests\n\nRun pnpm test.\n');
  assert.equal(chunkMarkdown(fs.readFileSync(path.join(cwdA, 'CLAUDE.md'), 'utf8')).length, 2);
  const hits = buildIndex(cwdA).search('Compress-Archive zip Linux deploy', 2);
  assert.match(hits[0].file, /CLAUDE\.md$/);
  assert.equal(hits[0].heading, 'Deploy');
});

test('queue check drops covered proposals, merges duplicates, suggests fixes, keeps the rest', async () => {
  const { tidyQueue } = await import('../scripts/evaluate.mjs');
  for (const c of db.prepare("SELECT id FROM candidates WHERE outcome = 'queued'").all()) curator.decideQueued(db, c.id, false);
  const r = curator.apply(db, { cwd: cwdA, items: [
    { kind: 'memory', memory_type: 'project', title: 'Release checklist owner', description: 'Releases are cut by the backend lead', confidence: 0.8 },
    { kind: 'memory', memory_type: 'project', title: 'Zip deploys', description: 'DROPME zip with python', confidence: 0.8 },
    { kind: 'memory', memory_type: 'project', title: 'Who cuts releases', description: 'MERGEME the backend lead cuts releases', confidence: 0.8 },
    { kind: 'memory', memory_type: 'project', title: 'Delete AGENTS.md before removing a worktree', description: 'FIXME next dev writes it', confidence: 0.8 },
  ] }, { actor: 'background', autonomy: 'queue' });
  assert.deepEqual(r.map((x) => x.status), ['queued', 'queued', 'queued', 'queued']);
  const report = await tidyQueue(db);
  assert.deepEqual([report.kept, report.dropped, report.merged, report.suggested], [1, 1, 1, 1]);
  const rows = db.prepare('SELECT title, outcome, note FROM candidates WHERE triaged_at IS NOT NULL ORDER BY id').all();
  assert.equal(rows.find((x) => x.title === 'Zip deploys').outcome, 'dropped');
  assert.match(rows.find((x) => x.title === 'Zip deploys').note, /covered: already documented \(CLAUDE\.md\)/);
  assert.equal(rows.find((x) => x.title === 'Who cuts releases').outcome, 'merged');
  assert.equal(rows.find((x) => x.title.startsWith('Delete AGENTS')).outcome, 'suggested');
  assert.match(rows.find((x) => x.title.startsWith('Delete AGENTS')).note, /fix in the project/);
  assert.equal(rows.find((x) => x.title === 'Release checklist owner').outcome, 'queued');
  assert.equal((await tidyQueue(db)).total, 0, 'already checked items are not checked again');
});

test('a proposal owned by an existing doc becomes a changeset that waits for approval', async () => {
  const { tidyQueue } = await import('../scripts/evaluate.mjs');
  const claudeMd = path.join(cwdA, 'CLAUDE.md');
  curator.apply(db, { cwd: cwdA, items: [
    { kind: 'memory', memory_type: 'project', title: 'Deploy with the script', description: `ROUTEME:${claudeMd}`, confidence: 0.8 },
  ] }, { actor: 'background', autonomy: 'queue' });
  // Rule files and CLAUDE.md are only changed through approval, even in auto mode.
  await tidyQueue(db, { autonomy: 'auto' });
  const cs = db.prepare("SELECT * FROM changesets WHERE status = 'pending'").get();
  assert.equal(path.resolve(cs.file), path.resolve(claudeMd));
  assert.match(JSON.parse(cs.edits)[0].new, /Use the deploy script\./);
  const c = db.prepare('SELECT id, note, outcome FROM candidates WHERE changeset_id = ?').get(cs.id);
  assert.equal(c.outcome, 'queued');
  assert.match(c.note, /adds to .*CLAUDE\.md/);
  const r = curator.decideQueued(db, c.id, true);
  assert.equal(r.status, 'patched', r.reason);
  assert.match(fs.readFileSync(claudeMd, 'utf8'), /Run pnpm test\.\nUse the deploy script\./);
  assert.equal(db.prepare('SELECT status FROM changesets WHERE id = ?').get(cs.id).status, 'applied');
  assert.equal(db.prepare('SELECT outcome FROM candidates WHERE id = ?').get(c.id).outcome, 'patched');
});
