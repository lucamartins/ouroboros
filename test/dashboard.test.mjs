// The dashboard API at scale: every list is paged with an honest total, filters run on the
// server, the inbox is grouped by project and file with one count everywhere, bulk
// decisions are made by filter on the server, and projects get readable names.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

let tmp;
let db;
let api;
let runAction;
let inbox;
let hook;
let projectKey;
let alpha;
let beta;
let worktree;

const DAY = 86_400_000;

function queueItem({ cwd, session, title, kind = 'memory', target = null }) {
  const item = { op: target ? 'patch' : 'create', kind, title, description: `${title} (description)`, target };
  return Number(db.prepare(`INSERT INTO candidates (review_id, session_id, project, kind, title, summary, confidence, ts, outcome, payload, cwd, target, triaged_at)
    VALUES (1, ?, ?, ?, ?, ?, 0.6, ?, 'queued', ?, ?, ?, ?)`).run(session, projectKey(cwd), kind, title, `${title}: summary`, Date.now(), JSON.stringify({ item }), cwd, target, Date.now()).lastInsertRowid);
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-dashboard-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.OUROBOROS_HOME = path.join(tmp, 'ouroboros');
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data');
  alpha = path.join(tmp, 'work', 'alpha');
  beta = path.join(tmp, 'work', 'beta');
  for (const dir of [alpha, beta]) fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  // A linked worktree of alpha: its sessions belong to alpha.
  worktree = path.join(alpha, '.claude', 'worktrees', 'w1');
  fs.mkdirSync(path.join(alpha, '.git', 'worktrees', 'w1'), { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(alpha, '.git', 'worktrees', 'w1')}\n`);
  fs.writeFileSync(path.join(alpha, '.git', 'worktrees', 'w1', 'commondir'), '../..\n');
  // A plugin with skills, and a personal skill.
  const pluginDir = path.join(tmp, 'claude', 'plugins', 'cache', 'mk', 'kit', '1.0.0');
  fs.mkdirSync(path.join(pluginDir, 'skills', 'lint'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'skills', 'lint', 'SKILL.md'), '---\nname: lint\ndescription: Lint the code with qzxlint\n---\n');
  fs.writeFileSync(path.join(tmp, 'claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'kit@mk': [{ installPath: pluginDir }] } }));
  fs.mkdirSync(path.join(tmp, 'claude', 'skills', 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Deploy the app\n---\n');

  const paths = await import('../scripts/paths.mjs');
  projectKey = paths.projectKey;
  const dbApi = await import('../scripts/db.mjs');
  db = dbApi.openDb();
  inbox = await import('../scripts/inbox.mjs');
  hook = await import('../scripts/hook.mjs');
  ({ runAction } = await import('../dashboard/actions.mjs'));
  api = (await import('../dashboard/api.mjs')).createApi(db);

  const insSession = db.prepare('INSERT INTO sessions (id, project, cwd, started_at, turns) VALUES (?, ?, ?, ?, 10)');
  const now = Date.now();
  for (let i = 0; i < 120; i++) {
    const cwd = i % 3 === 0 ? beta : i % 3 === 1 ? alpha : worktree;
    insSession.run(`s${i}`, projectKey(cwd), cwd, now - i * DAY);
  }
  insSession.run('home', projectKey(os.homedir()), os.homedir(), now);
  const insCorrection = db.prepare("INSERT INTO corrections (review_id, session_id, quote, kind, ts) VALUES (1, ?, ?, 'explicit', ?)");
  for (let i = 0; i < 70; i++) insCorrection.run(`s${i}`, i % 10 === 0 ? `use the seed script (${i})` : `not like that (${i})`, now);
  for (let i = 0; i < 30; i++) queueItem({ cwd: alpha, session: 's1', title: `Alpha memory ${i}` });
  for (let i = 0; i < 5; i++) queueItem({ cwd: worktree, session: 's2', title: `Alpha skill ${i}`, kind: 'skill' });
  for (let i = 0; i < 4; i++) queueItem({ cwd: beta, session: 's0', title: `Beta memory ${i}` });
  db.prepare(`INSERT INTO candidates (review_id, session_id, project, kind, title, summary, confidence, ts, outcome, cwd, note)
    VALUES (1, 's0', ?, 'memory', 'Workaround', 'x', 0.5, ?, 'suggested', ?, 'fix in the project: add a script')`).run(projectKey(beta), now, beta);
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('list routes page with an honest total, and filter on the server', () => {
  const first = api('sessions');
  assert.equal(first.total, 121);
  assert.equal(first.rows.length, 50, 'the default page is 50 rows');
  const last = api('sessions', { offset: 100, limit: 50 });
  assert.equal(last.rows.length, 21);
  assert.ok(first.rows[0].started_at >= first.rows[1].started_at, 'newest first by default');
  assert.ok(api('sessions', { dir: 'asc' }).rows[0].started_at <= api('sessions', { dir: 'asc' }).rows[1].started_at);
  assert.equal(api('sessions', { days: 10 }).total, 11, 'the last 10 days (with the home session)');

  const seed = api('corrections', { q: 'seed' });
  assert.equal(seed.total, 7);
  assert.ok(seed.rows.every((r) => r.quote.includes('seed')));
  assert.equal(api('corrections', { q: '100%_' }).total, 0, 'LIKE wildcards in the query are literal');
  assert.deepEqual(Object.keys(api('activity_counts')).sort(), ['corrections', 'dropped', 'proposals', 'reviews', 'sessions']);
});

test('projects: a worktree belongs to its repository; the home folder is ~', () => {
  const { rows } = api('projects');
  const names = rows.map((p) => p.name).sort();
  assert.deepEqual(names, ['alpha', 'beta', '~'].sort(), 'the worktree is not a project of its own');
  const alphaId = rows.find((p) => p.name === 'alpha').id;
  assert.equal(api('sessions', { project: alphaId }).total, 80, 'alpha sessions include the worktree ones');
  const s = api('sessions', { project: alphaId, limit: 5 }).rows;
  assert.ok(s.every((r) => r.project_name === 'alpha'));
});

test('the inbox is one count everywhere and groups by project, then by file or kind', () => {
  const c = api('counts');
  const entries = inbox.inboxEntries(db);
  assert.equal(c.total, entries.length);
  assert.equal(c.total, hook.inboxCounts(db).total);
  assert.equal(api('quality', { days: 30 }).inbox, c.total, 'System shows the same number as the badge');

  const view = api('inbox', { per: 20 });
  assert.equal(view.total, 40);
  const a = view.projects.find((p) => p.name === 'alpha');
  assert.equal(a.total, 35, 'worktree entries join the alpha project');
  const memories = a.groups.find((g) => g.label === 'New memories');
  assert.equal(memories.total, 30);
  assert.equal(memories.entries.length, 20, 'a big group shows its first 20');
  const rest = api('inbox', { group: memories.id, offset: 20, limit: 50 });
  assert.equal(rest.total, 30);
  assert.equal(rest.rows.length, 10);
  assert.ok(rest.rows.every((r) => r.type === 'item' && r.key.startsWith('it:')));
  const b = view.projects.find((p) => p.name === 'beta');
  assert.ok(b.groups.some((g) => g.label === 'Suggested fixes' && g.approvable === 0));
  assert.equal(api('inbox', { project: b.id }).total, 5, 'the project filter');
});

test('bulk decisions run on the server by filter, and only for the count the user confirmed', async () => {
  const view = api('inbox', { per: 1 });
  const skills = view.projects.find((p) => p.name === 'alpha').groups.find((g) => g.label === 'New skills');
  assert.equal(skills.rejectable, 5);
  assert.equal((await runAction(db, 'reject_many', ['it:1', 'it:2'], api)).status, 'invalid', 'a key list from the client is refused');
  const stale = await runAction(db, 'reject_many', { group: skills.id, expect: 4 }, api);
  assert.equal(stale.status, 'changed');
  assert.equal(api('counts').total, 40, 'nothing was decided');
  const r = await runAction(db, 'reject_many', { group: skills.id, expect: 5 }, api);
  assert.equal(r.status, 'done');
  assert.equal(r.rejected, 5);
  assert.equal(api('counts').total, 35, 'only that group');
  const beta = view.projects.find((p) => p.name === 'beta');
  const all = await runAction(db, 'reject_many', { project: beta.id, expect: 4 }, api);
  assert.equal(all.rejected, 4, 'the fix is not rejected in bulk');
  assert.equal(api('inbox', { project: beta.id }).total, 1);
});

test('Overview misses count the period; the inventory groups by scope with plugin skills', () => {
  const o = api('overview', { days: 30 });
  assert.equal(typeof o.misses, 'number');
  assert.equal(api('value', { days: 30 }).misses, undefined, 'no all-time list under a period label');
  const inv = api('inventory', { kind: 'skills' });
  // (The session in the real home folder may add a "project" group: that folder's .claude/skills.)
  const group = (id) => inv.groups.find((g) => g.id === id);
  assert.equal(inv.groups[0].id, 'personal', 'personal first');
  assert.equal(group('personal').total, 1);
  assert.equal(group('plugin').rows[0].name, 'kit:lint');
  assert.equal(api('inventory', { kind: 'skills', q: 'qzxlint' }).total, 1);
  assert.equal(api('inventory', { kind: 'skills', group: 'plugin', offset: 0, limit: 10 }).rows.length, 1);
  assert.equal(api('nope'), undefined);
});

test('a skill file is named by its skill in titles', async () => {
  const { fileDisplayName } = await import('../scripts/changesets.mjs');
  assert.equal(fileDisplayName(String.raw`C:\Users\x\.claude\skills\acme-local\SKILL.md`), 'acme-local');
  assert.equal(fileDisplayName('/home/x/.claude/skills/acme/reference/business-rules.md'), 'acme/reference/business-rules.md');
  assert.equal(fileDisplayName('/repo/.claude/rules/testing.md'), 'testing.md');
});

test('the graph route draws skills and memories, leaves idle plugin skills out, and never sends raw file paths', () => {
  const skillsDir = path.join(tmp, 'claude', 'skills');
  fs.writeFileSync(path.join(skillsDir, 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Deploy the app\n---\nRun the `kit:lint` skill first.\n');
  const g = api('graph', {});
  const names = g.nodes.map((n) => n.name);
  assert.ok(names.includes('deploy'));
  assert.ok(names.includes('kit:lint'), 'a plugin skill a personal skill names is kept');
  assert.ok(g.nodes.every((n) => !('file' in n) && !('text' in n)));
  assert.ok(g.edges.some((e) => e.type === 'mention'));
  assert.equal(typeof g.stats.items, 'number');
  fs.writeFileSync(path.join(skillsDir, 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Deploy the app\n---\n');
});
