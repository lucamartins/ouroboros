// v0.25 (metrics): what the dashboard counts is what it says it counts. The page only draws
// what the API computes, so these assert the API (and, for the token retry, the page's own
// `act` function run against a stubbed fetch). The day buckets and the interval are tested
// in v025-rate.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;
let tmp;
let db;
let mod;
let projectIdFor;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-v025-metrics-'));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.OUROBOROS_HOME = path.join(tmp, 'ouroboros');
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data');
  for (const d of [process.env.CLAUDE_CONFIG_DIR, process.env.OUROBOROS_HOME, process.env.CLAUDE_PLUGIN_DATA]) fs.mkdirSync(d, { recursive: true });
  db = (await import('../scripts/db.mjs')).openDb();
  projectIdFor = (await import('../scripts/paths.mjs')).projectIdFor;
  mod = await import('../dashboard/api.mjs');
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function reset() {
  fs.rmSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'skills'), { recursive: true, force: true });
  for (const t of ['events', 'reviews', 'sessions', 'candidates', 'writes', 'learnings', 'meta']) db.prepare(`DELETE FROM ${t}`).run();
}
/** A fresh API per call: the project, inventory and graph caches are per instance. */
const get = (route, params = {}) => mod.createApi(db)(route, new URLSearchParams(params));
const session = (id, cwd, at, control = 0) => db.prepare('INSERT INTO sessions (id, project, cwd, started_at, turns, control) VALUES (?, ?, ?, ?, 10, ?)').run(id, projectIdFor(cwd), cwd, at, control);

function repo(name) {
  const dir = path.join(tmp, 'work', name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}
function skill(dir, name, description = 'Does one specific thing for this project.') {
  fs.mkdirSync(path.join(dir, '.claude', 'skills', name), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`);
  return path.join(dir, '.claude', 'skills', name, 'SKILL.md');
}
const learnSkill = (id, name, file, at) => db.prepare(`INSERT INTO learnings (id, kind, scope, name, title, path, status, origin_session, created_at, updated_at)
  VALUES (?, 'skill', 'project', ?, ?, ?, 'active', 'x0', ?, ?)`).run(id, name, name, file, at, at);
const used = (session_id, target, ts) => db.prepare("INSERT INTO events (session_id, ts, kind, target) VALUES (?, ?, 'skill_used', ?)").run(session_id, ts, target);

test('item 2: control sessions carry no fixed overhead', () => {
  reset();
  const now = Date.now();
  session('a', '/w/app', now - 3600e3);
  session('b', '/w/app', now - 3600e3);
  session('c1', '/w/ctl', now - 3600e3, 1);
  session('c2', '/w/ctl', now - 3600e3, 1);
  const c = get('cost', { days: 30 });
  assert.equal(c.overhead.sessions, 2, 'was 4 with the control sessions counted');
  assert.equal(c.overhead.tokens, Math.round(c.overhead.tokensPerSession * 2));
});

test('M21: automatic saves are not the user\'s approvals', () => {
  reset();
  const now = Date.now();
  session('s1', '/w/app', now - 3600e3);
  const cand = db.prepare(`INSERT INTO candidates (review_id, session_id, kind, title, summary, confidence, ts, outcome, learning_id, decided_at)
    VALUES (1, 's1', 'memory', ?, 'x', 0.8, ?, ?, ?, ?)`);
  const write = db.prepare("INSERT INTO writes (batch, learning_id, ts, op, actor, file, before, after) VALUES (?, ?, ?, 'create', ?, '/f.md', NULL, 'x')");
  for (let i = 0; i < 6; i++) { // saved by the evaluation itself
    cand.run(`auto ${i}`, now, 'created', `lrn_a${i}`, now);
    write.run(`b${i}`, `lrn_a${i}`, now - 20, 'background');
  }
  for (let i = 0; i < 4; i++) cand.run(`rejected ${i}`, now, 'rejected_by_user', null, now);
  let q = get('quality', { days: 30 });
  assert.equal(q.rejectedByUser, 4);
  assert.equal(q.saved, 6);
  assert.equal(q.approvalRate, 0, 'was 0.6: 6 of 10');

  // One approval the user made in the inbox (ledger actor "manual", at the moment of the decision).
  cand.run('approved', now, 'created', 'lrn_m', now);
  write.run('bm', 'lrn_m', now - 20, 'manual');
  q = get('quality', { days: 30 });
  assert.equal(q.approvalRate, 1 / 5);
  // A learning the user later edited by hand does not turn an automatic save into an approval.
  write.run('bm2', 'lrn_a0', now + 60_000, 'manual');
  assert.equal(get('quality', { days: 30 }).approvalRate, 1 / 5);
});

test('M22: a use is the learned item it is, and the share is over one set of sessions', () => {
  reset();
  const now = Date.now();
  const [alpha, beta] = [repo('alpha'), repo('beta')];
  const alphaSkill = skill(alpha, 'deploy');
  skill(beta, 'deploy');
  learnSkill('lrn_a', 'deploy', alphaSkill, now - 5 * DAY);
  session('a0', alpha, now - 5 * DAY);
  for (let i = 0; i < 9; i++) { session(`b${i}`, beta, now - i * 3600e3); used(`b${i}`, 'deploy', now - i * 3600e3); }
  // beta's own "deploy" is not the learned one: it was used 9 times and no learned item was opened.
  let v = get('value', { days: 30 });
  assert.equal(v.hits, 0);
  const rows = get('inventory', { kind: 'skills' }).groups.flatMap((g) => g.rows);
  assert.equal(rows.find((r) => r.project_name === 'beta').uses, 9);
  assert.equal(rows.find((r) => r.project_name === 'alpha').uses, 0, 'was 9: counted by bare name');

  // A session in alpha uses it: now it is a hit; the other project's sessions still are not.
  session('a1', alpha, now - 3600e3);
  used('a1', 'deploy', now - 1800e3);
  v = get('value', { days: 30 });
  assert.equal(v.hits, 1);
  assert.equal(v.series.reduce((n, d) => n + d.hits, 0), 1);
  assert.equal(get('inventory', { kind: 'skills' }).groups.flatMap((g) => g.rows).find((r) => r.project_name === 'alpha').uses, 1);

  // A personal learned skill is the item in any project.
  const mine = path.join(process.env.CLAUDE_CONFIG_DIR, 'skills', 'tidy', 'SKILL.md');
  fs.mkdirSync(path.dirname(mine), { recursive: true });
  fs.writeFileSync(mine, '---\nname: tidy\ndescription: Tidy\n---\n');
  db.prepare(`INSERT INTO learnings (id, kind, scope, name, title, path, status, origin_session, created_at, updated_at)
    VALUES ('lrn_p', 'skill', 'global', 'tidy', 'tidy', ?, 'active', 'x0', ?, ?)`).run(mine, now, now);
  used('b0', 'tidy', now);
  assert.equal(get('value', { days: 30 }).hits, 2);
});

test('M22: sessions are counted by their start on both sides, so the share never passes 100%', () => {
  reset();
  const now = Date.now();
  const skillFile = path.join(process.env.CLAUDE_CONFIG_DIR, 'skills', 'deploy-app', 'SKILL.md');
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.writeFileSync(skillFile, '---\nname: deploy-app\ndescription: Deploy\n---\n');
  db.prepare(`INSERT INTO learnings (id, kind, scope, name, title, path, status, origin_session, created_at, updated_at)
    VALUES ('lrn_1', 'skill', 'global', 'deploy-app', 'Deploy', ?, 'active', 'old-1', ?, ?)`).run(skillFile, now - 9 * DAY, now - 9 * DAY);
  // Two long sessions started before the period and used the skill inside it, one session started inside it.
  session('old-1', '/w/shop', now - 9 * DAY);
  session('old-2', '/w/shop', now - 8 * DAY);
  session('new-1', '/w/shop', now - 1 * DAY);
  for (const id of ['old-1', 'old-2', 'new-1']) used(id, 'deploy-app', now - 3600e3);
  const v = get('value', { days: 7 });
  assert.equal(v.sessions, 1);
  assert.equal(v.hits, 1, 'was 3 of 1 session (300%)');
  assert.ok(v.hits <= v.sessions);
  for (const d of v.series) assert.ok(d.hits <= d.sessions, `${d.day}: ${d.hits} of ${d.sessions}`);
  // A control session never counts on either side.
  session('ctl', '/w/shop', now - 3600e3, 1);
  used('ctl', 'deploy-app', now);
  const w = get('value', { days: 7 });
  assert.equal(w.hits, 1);
  assert.equal(w.sessions, 1);
});

test('item 6: the skill listing is what one session loads, not the sum over every project', () => {
  reset();
  const now = Date.now();
  const long = 'Does one specific thing for this project. '.repeat(12).trim();
  const repos = ['north', 'south', 'east'].map(repo);
  repos.forEach((dir, i) => {
    for (const s of ['build', 'test', 'release', 'triage']) skill(dir, `${path.basename(dir)}-${s}`, long);
    session(`s${i}`, dir, now - i * DAY);
  });
  // A linked worktree of north: a checkout with the same four skills.
  const wt = path.join(repos[0], '.claude', 'worktrees', 'w1');
  fs.mkdirSync(path.join(repos[0], '.git', 'worktrees', 'w1'), { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repos[0], '.git', 'worktrees', 'w1')}\n`);
  fs.writeFileSync(path.join(repos[0], '.git', 'worktrees', 'w1', 'commondir'), '../..\n');
  for (const s of ['build', 'test', 'release', 'triage']) skill(wt, `north-${s}`, long);
  session('s-wt', wt, now);
  const expected = ['build', 'test', 'release', 'triage'].reduce((n, s) => n + Math.min(long.length, 1536) + `north-${s}`.length + 4, 0);
  const l = get('health').skillListing;
  assert.equal(l.skills, 4, 'was 16: every project and the worktree copy');
  assert.equal(l.chars, expected);
  assert.equal(l.project, 'north');
  // A personal skill is in every session's listing, and adds to the largest project's.
  const mine = path.join(process.env.CLAUDE_CONFIG_DIR, 'skills', 'mine');
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, 'SKILL.md'), '---\nname: mine\ndescription: Mine\n---\n');
  assert.equal(get('health').skillListing.skills, 5);
  fs.rmSync(mine, { recursive: true, force: true });
});

test('item 7: the average per review divides by billed model calls', () => {
  reset();
  const now = Date.now();
  session('s1', '/w/shop', now - 3600e3);
  const ins = db.prepare('INSERT INTO reviews (session_id, mode, trigger, status, detail, cost_usd, session_started_at, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  ins.run('s1', 'background', 'session_end', 'ok', null, 0.10, now - 3600e3, now);
  ins.run('s1', 'background', 'session_end', 'skipped', 'only 1 user turn(s)', 0, now - 3600e3, now);
  ins.run('s1', 'background', 'session_end', 'skipped', 'monthly budget reached', 0, now - 3600e3, now);
  for (let i = 0; i < 3; i++) ins.run('maintenance', 'maintenance', 'triage-summary', 'ok', '{}', 0, null, now);
  const c = get('cost', { days: 30 });
  const bg = c.byMode.filter((m) => m.mode !== 'inloop');
  const usd = bg.reduce((n, m) => n + m.usd, 0);
  const billed = bg.reduce((n, m) => n + m.billed, 0);
  assert.equal(billed, 1);
  assert.ok(Math.abs(usd / billed - 0.10) < 1e-9, 'was 0.10 / 6 = $0.017');
  assert.equal(bg.reduce((n, m) => n + m.n, 0), 3, 'the bookkeeping rows are not reviews');
  assert.equal(c.series.at(-1).reviews, 3);
});

test('item 8: a refused token is fetched again and the action retried once', async () => {
  const src = fs.readFileSync(path.join(root, 'dashboard', 'public', 'app.js'), 'utf8');
  const code = src.slice(src.indexOf('let actionToken = null;'), src.indexOf('const toastEl'));
  assert.match(code, /async function act/);
  const calls = [];
  let current = 'old'; // the server's token; the page starts with the old one after a restart
  const fetchStub = async (url, opts) => {
    calls.push(opts?.headers?.['X-Ouroboros-Token'] || url);
    const ok = opts.headers['X-Ouroboros-Token'] === current;
    return { ok, status: ok ? 200 : 403, json: async () => (ok ? { status: 'created' } : { error: 'bad token' }) };
  };
  const apiStub = async () => ({ token: current });
  const act = new Function('fetch', 'api', `${code}; return act;`)(fetchStub, apiStub);
  assert.deepEqual(await act('approve', 'it:1'), { status: 'created' }); // loads 'old'
  current = 'new'; // the server restarted
  assert.deepEqual(await act('approve', 'it:2'), { status: 'created' }, 'no "bad token" until reload');
  assert.deepEqual(calls, ['old', 'old', 'new']);
  // Only a refused token is retried, and only once.
  const refuse = new Function('fetch', 'api', `${code}; return act;`)(async () => ({ ok: false, status: 403, json: async () => ({ error: 'bad token' }) }), apiStub);
  await assert.rejects(refuse('approve', 'it:3'), /bad token/);
  const origin = new Function('fetch', 'api', `${code}; return act;`)(async () => { calls.push('origin'); return { ok: false, status: 403, json: async () => ({ error: 'bad origin' }) }; }, apiStub);
  calls.length = 0;
  await assert.rejects(origin('approve', 'it:4'), /bad origin/);
  assert.deepEqual(calls, ['origin']);
});

test('item 9: a proposal with no session row is listed', () => {
  reset();
  const now = Date.now();
  session('s1', '/w/app', now - 3600e3);
  const ins = db.prepare("INSERT INTO candidates (review_id, session_id, kind, title, summary, confidence, ts, outcome, cwd) VALUES (1, ?, 'memory', ?, 'x', 0.6, ?, 'queued', '/w/app')");
  ins.run('s1', 'With a session', now);
  ins.run('inloop', 'Without a session', now); // curator.apply with no session id stores the actor as session id
  const p = get('proposals', {});
  assert.equal(p.total, 2, 'was 1: the inner join dropped it');
  assert.deepEqual(p.rows.map((r) => r.title).sort(), ['With a session', 'Without a session']);
  assert.ok(p.rows.every((r) => r.session_started_at > 0));
  assert.equal(get('proposals', { days: 7 }).total, 2);
  assert.equal(get('proposals', { q: 'Without' }).total, 1);
  assert.equal(get('activity_counts', {}).proposals, 2);
});

test('item 10: System warns when Claude Code\'s auto memory is off', () => {
  reset();
  const dir = path.join(tmp, 'work', 'app');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  session('s1', dir, Date.now());
  const optionsFile = path.join(process.env.CLAUDE_PLUGIN_DATA, 'options.json');
  assert.equal(get('health').autoMemory, null, 'nothing reported yet');
  fs.writeFileSync(optionsFile, JSON.stringify({ learning: true, autoMemory: { on: true, reason: null, project: projectIdFor(dir) } }));
  assert.equal(get('health').autoMemory.on, true);
  assert.equal(get('health').autoMemory.text, null);
  fs.writeFileSync(optionsFile, JSON.stringify({ learning: true, autoMemory: { on: false, reason: 'CLAUDE_CODE_DISABLE_AUTO_MEMORY is set', project: projectIdFor(dir) } }));
  const am = get('health').autoMemory;
  assert.equal(am.on, false);
  assert.equal(am.project_name, 'app');
  assert.match(am.text, /auto memory is off for app \(CLAUDE_CODE_DISABLE_AUTO_MEMORY is set\)/);
  assert.match(am.text, /not loaded by Claude Code/);
  assert.match(am.text, /Ouroboros adds its own index/);
  fs.rmSync(optionsFile);
});
