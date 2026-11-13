// Where a learning goes (review III, routing): a conflict the user confirmed is never
// dropped, a claim's own stand-in is not "existing knowledge" for its screen, a restored
// proposal is not screened away again, a route to an owner that cannot be told (or is not
// the project's or the user's) creates nothing, and grounding says when it could not look.
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
let base;
let curator;
let ev;
let cs;
let inbox;
let paths;
let dbApi;
let k;
let actions;
let s;

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-v025r-'));
  dbApi = await import('../scripts/db.mjs');
  curator = await import('../scripts/curator.mjs');
  ev = await import('../scripts/evaluate.mjs');
  cs = await import('../scripts/changesets.mjs');
  inbox = await import('../scripts/inbox.mjs');
  paths = await import('../scripts/paths.mjs');
  k = await import('../scripts/knowledge.mjs');
  actions = await import('../dashboard/actions.mjs');
});

after(() => {
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

afterEach(() => {
  delete process.env.FAKE_QUEUE_MOD;
  s?.db.close();
  s = null;
});

/** A fresh sandbox per test: its own home, config, data and project (a git repo with a rule file). */
function sandbox(name) {
  const tmp = fs.mkdtempSync(path.join(base, `${name}-`));
  process.env.HOME = path.join(tmp, 'home');
  process.env.USERPROFILE = process.env.HOME;
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.OUROBOROS_HOME = path.join(tmp, 'ouroboros');
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data');
  process.env.OUROBOROS_CLAUDE_CMD = JSON.stringify([process.execPath, path.join(fixtures, 'fake-queue.mjs')]);
  process.env.FAKE_QUEUE_LOG = path.join(tmp, 'calls.log');
  process.env.FAKE_QUEUE_PROMPTS = path.join(tmp, 'prompts');
  fs.mkdirSync(process.env.HOME, { recursive: true });
  const proj = path.join(tmp, 'work', 'p');
  const rules = path.join(proj, '.claude', 'rules', 'deploy.md');
  fs.mkdirSync(path.dirname(rules), { recursive: true });
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# P\n\nA small project.\n');
  fs.writeFileSync(rules, RULES);
  spawnSync('git', ['-C', proj, 'init', '-q']);
  spawnSync('git', ['-C', proj, 'add', '.']);
  const db = dbApi.openDb();
  db.prepare("INSERT INTO sessions (id, project, cwd, started_at) VALUES ('s1', ?, ?, ?)").run(paths.projectIdFor(proj), proj, Date.now());
  s = { tmp, proj, rules, db };
  return s;
}

/** A proposal from an end-of-session review, waiting for the evaluation, routed by the fake screen to `file` (a path or a bare name). */
function pending(cwd, title, claim, file, { autonomy = 'queue', extra = '' } = {}) {
  const evidence = `USER #1 ${extra}${file ? `ROUTEME:${file} CLAIM: ${claim}` : ''}`.trim();
  const item = { op: 'create', kind: 'memory', scope: 'project', memory_type: 'project', title, description: claim, confidence: 0.8, evidence };
  return Number(s.db.prepare(`INSERT INTO candidates (review_id, session_id, project, kind, scope, memory_type, title, summary, evidence, confidence, outcome, payload, cwd, ts)
    VALUES (0, 's1', ?, 'memory', 'project', 'project', ?, ?, ?, 0.8, 'pending', ?, ?, ?)`).run(paths.projectIdFor(cwd), title, claim, evidence,
    JSON.stringify({ item, cwd, trigger: 'session_end', actor: 'background', autonomy }), cwd, Date.now()).lastInsertRowid);
}

const row = (id) => s.db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
const learnings = () => s.db.prepare('SELECT title, path FROM learnings').all();
const prompts = (kind) => {
  const dir = process.env.FAKE_QUEUE_PROMPTS;
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(`-${kind}.txt`)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')) : [];
};
const mod = (source) => {
  const file = path.join(s.tmp, 'fake-mod.mjs');
  fs.writeFileSync(file, source);
  process.env.FAKE_QUEUE_MOD = file;
};

test('M14: a conflict the user confirmed whose edit cannot be written comes back as a conflict, never dropped', async () => {
  const { db, proj, rules } = sandbox('m14');
  const id = pending(proj, 'Deploy straight', 'CONFLICTME BADFRAG deploy straight to production.', rules);
  await ev.drainQueue(db);
  assert.equal(row(id).outcome, 'conflict', 'the editor held it for the user');
  assert.equal(inbox.resolveConflict(db, `cf:${id}`, 'new').status, 'requeued');
  await ev.drainQueue(db);
  const r = row(id);
  assert.equal(r.outcome, 'conflict', 'not dropped');
  assert.match(r.note, /you said it is a new rule, but it could not be written to deploy\.md \(the fragment is not in the file\)/);
  assert.equal(JSON.parse(r.payload).confirmed, undefined, 'a conflict again, to be decided again');
  assert.ok(inbox.inboxEntries(db).some((e) => e.key === `cf:${id}`));
  assert.equal(fs.readFileSync(rules, 'utf8'), RULES);
  assert.match(inbox.showEntry(db, `cf:${id}`).text, /could not be written/);
});

test('a conflict the user confirmed that the editor then calls contradicted or covered comes back as a conflict', async () => {
  for (const status of ['contradicted', 'covered']) {
    const { db, proj, rules } = sandbox(`confirmed-${status}`);
    const id = pending(proj, 'Deploy straight', 'CONFLICTME deploy straight to production.', rules);
    await ev.drainQueue(db);
    assert.equal(inbox.resolveConflict(db, `cf:${id}`, 'new').status, 'requeued');
    mod(`export function editor({ out }) { return { claims: out.claims.map((c) => ({ ...c, status: '${status}', reason: 'the workflow deploys to staging' })), edits: [] }; }`);
    await ev.drainQueue(db);
    const r = row(id);
    assert.equal(r.outcome, 'conflict', `${status}: until v0.25 the editor dropped what the user had confirmed`);
    assert.match(r.note, /you said it is a new rule, but the editor found .*the workflow deploys to staging/);
    assert.ok(inbox.inboxEntries(db).some((e) => e.key === `cf:${id}`));
    assert.equal(fs.readFileSync(rules, 'utf8'), RULES);
    s.db.close();
    s = null;
    delete process.env.FAKE_QUEUE_MOD;
  }
});

test('a proposal the user restored that the editor drops again goes back to the user', async () => {
  const { db, proj, rules } = sandbox('restored-editor');
  const id = pending(proj, 'Friday deploys', 'CONTRADICT deploy on Fridays is fine.', rules);
  await ev.drainQueue(db);
  assert.equal(row(id).outcome, 'dropped');
  assert.equal((await actions.runAction(db, 'restore', id)).status, 'restored');
  await ev.drainQueue(db);
  const r = row(id);
  assert.equal(r.outcome, 'queued', 'until v0.25 the editor dropped it again');
  assert.match(r.note, /you restored it, but the editor found the project says otherwise \(the code says otherwise\); nothing was written, you decide/);
  assert.ok(inbox.inboxEntries(db).some((e) => e.key === `it:${id}`));
  assert.equal(ev.queueHasWork(db), false, 'it is out of the queue');
});

test('a proposal the user decided while it was evaluated stays as the user left it', async () => {
  const { db, proj } = sandbox('decided');
  const id = pending(proj, 'Pin node', 'Pin the node version in CI.', null);
  // The rejection lands after the evaluation read the row (another process, the dashboard).
  db.prepare("UPDATE candidates SET outcome = 'rejected_by_user', note = 'not this', decided_at = ? WHERE id = ?").run(Date.now(), id);
  await ev.evaluate(db, [row(id)], { cwd: proj, sessionId: 's1', actor: 'background', autonomy: 'queue' });
  assert.deepEqual([row(id).outcome, row(id).note], ['rejected_by_user', 'not this'], 'until v0.25 it became "decided"');
});

test('a stale flag may only name a knowledge file of the proposal\'s project or the user\'s own', async () => {
  const { db, proj, tmp } = sandbox('stale-owner');
  const source = path.join(proj, 'package.json');
  fs.writeFileSync(source, '{ "scripts": { "deploy": "make deploy" } }\n');
  spawnSync('git', ['-C', proj, 'add', '.']);
  const stray = path.join(tmp, 'elsewhere', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(stray), { recursive: true });
  fs.writeFileSync(stray, '# Elsewhere\n\n- Deploy with npm run ship.\n');
  const flag = (file) => `export function screen({ out }) { return { verdicts: out.verdicts.map((v) => ({ ...v, stale: { file: ${JSON.stringify(file)}, source: ${JSON.stringify(source)}, claim: 'Deploy with make deploy.' } })) }; }`;
  const outdated = () => db.prepare("SELECT target FROM candidates WHERE title LIKE 'Outdated:%'").all().map((r) => r.target);
  mod(flag(stray));
  pending(proj, 'Deploy target', 'Deploys go through make.', null);
  await ev.drainQueue(db);
  assert.deepEqual(outdated(), [], 'until v0.25 a file outside the project could be flagged and changed');
  assert.equal(fs.readFileSync(stray, 'utf8'), '# Elsewhere\n\n- Deploy with npm run ship.\n');
  // The project's own CLAUDE.md, named by a bare name, is flagged.
  mod(flag('CLAUDE.md'));
  pending(proj, 'Deploy script', 'The deploy script is make deploy.', null);
  await ev.drainQueue(db);
  assert.deepEqual(outdated().map((f) => path.resolve(f)), [path.join(proj, 'CLAUDE.md')]);
});

test('a learning the user decided before the editor could be called stays decided when the call is called off', async () => {
  const { db, proj, rules } = sandbox('called-off');
  const id = pending(proj, 'Tag releases', 'Tag every release after deploying.', rules);
  db.prepare("UPDATE candidates SET outcome = 'queued', target = ? WHERE id = ?").run(rules, id);
  // Another process (the dashboard) rejects it after the evaluation took it, then the
  // lease turns out lost before the editor is called: the rows are not this process's any more.
  const tick = () => {
    db.prepare("UPDATE candidates SET outcome = 'rejected_by_user', note = 'not this', decided_at = ? WHERE id = ?").run(Date.now(), id);
    throw new ev.LeaseLost();
  };
  await ev.composeRoutes(db, new Map([[rules, [{ id, title: 'Tag releases', claim: 'Tag every release after deploying.' }]]]), { cwd: proj, tick });
  assert.deepEqual([row(id).outcome, row(id).note], ['rejected_by_user', 'not this'], 'the rejection stands');
  assert.equal(prompts('editor').length, 0, 'no editor call');
});

test('M15: the screen of a claim does not see its own stand-in memory as existing knowledge', async () => {
  const { db, proj } = sandbox('m15-standin');
  const md = path.join(proj, 'CLAUDE.md');
  // A screen that applies the rubric's "covered": an excerpt of a memory that holds the claim.
  mod(`export function screen({ prompt, out }) {
    const excerpts = [...prompt.matchAll(/<excerpt file="([^"]+)" kind="([^"]+)"[^>]*>\\n([\\s\\S]*?)\\n<\\/excerpt>/g)].map((m) => ({ file: m[1], kind: m[2], text: m[3] }));
    const claim = /^claim: (.+)$/m.exec(prompt)?.[1];
    const hit = claim && excerpts.find((e) => e.kind.startsWith('memory') && e.text.includes(claim));
    if (!hit) return undefined;
    return { verdicts: out.verdicts.map((v) => ({ id: v.id, verdict: 'drop', drop_kind: 'covered', reason: 'an excerpt already says it', covered_by: hit.file })) };
  }`);
  const claim = 'Deploy this project only through the release pipeline, never by hand.';
  const id = pending(proj, 'Release pipeline', claim, md, { autonomy: 'auto' });
  await ev.drainQueue(db);
  const standIn = curator.interimOf(db, id);
  assert.ok(standIn, 'the claim is known meanwhile as a project memory');
  assert.ok(cs.pendingChangeset(db, md));
  await ev.drainQueue(db, { force: true });
  const lastScreen = prompts('screen').pop();
  assert.ok(!lastScreen.includes(standIn.path), 'the re-screen was not shown the stand-in');
  assert.notEqual(row(id).outcome, 'dropped');
  assert.equal(row(id).outcome, 'queued');
  assert.ok(cs.pendingChangeset(db, md), 'the change to CLAUDE.md still waits for the user');
  assert.ok(curator.interimOf(db, id), 'the stand-in is still active');
});

test('M15: a dropped proposal the user restores is not dropped again by the next drain', async () => {
  const { db, proj } = sandbox('m15-restore');
  const restored = pending(proj, 'Run the linter', 'DROPME always run the linter before committing.', null);
  const other = pending(proj, 'Keep it short', 'DROPME keep commit messages short.', null);
  await ev.drainQueue(db);
  assert.equal(row(restored).outcome, 'dropped');
  assert.equal((await actions.runAction(db, 'restore', restored)).status, 'restored');
  assert.match(row(restored).note, /\(restored by you\)/);
  await ev.drainQueue(db);
  const r = row(restored);
  assert.equal(r.outcome, 'queued', 'it waits for the user as a new item');
  assert.match(r.note, /restored by you/);
  assert.ok(inbox.inboxEntries(db).some((e) => e.key === `it:${restored}`));
  assert.equal(row(other).outcome, 'dropped', 'what was not restored stays dropped');
});

test('M16: a bare owner name that matches a global and a project file goes to the project\'s file', async () => {
  const { db, proj } = sandbox('m16-project');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  const globalMd = path.join(process.env.CLAUDE_CONFIG_DIR, 'CLAUDE.md');
  fs.writeFileSync(globalMd, '# Global\n\n- Answer briefly.\n');
  assert.equal(path.resolve(k.resolveRouteOwner('CLAUDE.md', proj).file), path.join(proj, 'CLAUDE.md'));
  const id = pending(proj, 'Tag releases', 'Tag every release after deploying.', 'CLAUDE.md');
  await ev.drainQueue(db);
  assert.equal(row(id).outcome, 'queued');
  assert.equal(path.resolve(cs.pendingChangeset(db, path.join(proj, 'CLAUDE.md')).file), path.join(proj, 'CLAUDE.md'));
  assert.ok(!cs.pendingChangeset(db, globalMd), 'not the global file');
  assert.deepEqual(learnings(), [], 'nothing was created as a new item');
});

test('M16: an owner that cannot be told apart creates nothing and waits for the user with the reason', async () => {
  const { db, proj } = sandbox('m16-ambiguous');
  for (const skill of ['alpha', 'beta']) {
    const dir = path.join(proj, '.claude', 'skills', skill);
    fs.mkdirSync(path.join(dir, 'reference'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${skill}\ndescription: ${skill} procedures\n---\n\n# ${skill}\n`);
    fs.writeFileSync(path.join(dir, 'reference', 'notes.md'), `# Notes of ${skill}\n\n- Something.\n`);
  }
  const ambiguous = pending(proj, 'Notes rule', 'Keep the notes short.', 'notes.md');
  const missing = pending(proj, 'Ghost rule', 'Keep the ghosts friendly.', 'no-such-file.md');
  await ev.drainQueue(db);
  assert.match(row(ambiguous).note, /matches 2 files .* no rule picks one; nothing was created, you decide/);
  assert.match(row(missing).note, /no knowledge file of this project or yours is named no-such-file\.md; nothing was created/);
  for (const id of [ambiguous, missing]) {
    assert.deepEqual([row(id).outcome, row(id).changeset_id], ['queued', null]);
    assert.ok(row(id).triaged_at, 'out of the queue');
    assert.ok(inbox.inboxEntries(db).some((e) => e.key === `it:${id}`));
  }
  assert.deepEqual(learnings(), []);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM changesets').get().n, 0);
  assert.equal(ev.queueHasWork(db), false);
});

test('grounding says "could not check" when it could not look, and the editor is told it is no evidence', async () => {
  const { proj, tmp } = sandbox('ground');
  const claim = 'It reads `RETRY_LIMIT` from `src/config.ts`.';
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'config.ts'), 'export const RETRY_LIMIT = 3;\n');
  spawnSync('git', ['-C', proj, 'add', '.']);
  const labels = (g) => g.map((x) => `${x.id}: ${x.hits.length ? 'hits' : x.exists ? 'exists' : x.checked ? 'not found' : 'could not check'}`);
  const ids = [...k.identifiersIn(claim), 'NO_SUCH_THING'];
  assert.deepEqual(labels(k.groundIdentifiers(ids, proj)), ['RETRY_LIMIT: hits', 'src/config.ts: exists', 'NO_SUCH_THING: not found'], 'a completed search that finds nothing is evidence');
  // git cannot be started (not installed, or not on the worker's PATH): the same holds for a timeout or an overflowed buffer.
  const PATH = process.env.PATH;
  process.env.PATH = path.join(tmp, 'empty-bin');
  let noGit;
  try { noGit = k.groundIdentifiers(ids, proj); } finally { process.env.PATH = PATH; }
  assert.deepEqual(labels(noGit), ['RETRY_LIMIT: could not check', 'src/config.ts: exists', 'NO_SUCH_THING: could not check']);
  // Not a git repository at all: a file on disk exists, anything else is unknown.
  const plain = path.join(tmp, 'work', 'plain');
  fs.mkdirSync(path.join(plain, 'src'), { recursive: true });
  fs.writeFileSync(path.join(plain, 'src', 'config.ts'), 'x\n');
  assert.deepEqual(labels(k.groundIdentifiers(ids, plain)), ['RETRY_LIMIT: could not check', 'src/config.ts: exists', 'NO_SUCH_THING: could not check']);
  const text = ev.editorPrompt({ file: 'F', kind: 'instructions', view: { text: '# P', partial: false }, claims: [{ id: 1, claim }], grounding: noGit });
  const evidence = text.split('\nPROJECT EVIDENCE (')[1].split('\nELSEWHERE (')[0];
  assert.match(evidence, /`RETRY_LIMIT`: could not check/);
  assert.doesNotMatch(evidence, /`RETRY_LIMIT`: not found/);
  assert.match(evidence, /"could not check" means the lookup could not be made/);
});

test('changeset targets: a route may only name a knowledge file of the proposal\'s project or the user\'s own', async () => {
  const { db, proj, tmp, rules } = sandbox('targets');
  const otherMem = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-some-other-project', 'memory', 'MEMORY.md');
  const vendored = path.join(tmp, 'elsewhere', 'node_modules', 'pkg', 'skills', 'x', 'README.md');
  const stray = path.join(tmp, 'elsewhere', 'CLAUDE.md');
  for (const f of [otherMem, vendored, stray]) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '# Text\n\n- Something.\n');
  }
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  const globalMd = path.join(process.env.CLAUDE_CONFIG_DIR, 'CLAUDE.md');
  fs.writeFileSync(globalMd, '# Global\n\n- Answer briefly.\n');
  // The shape of the path is not the test (it still reads as a patchable kind elsewhere).
  assert.ok(k.PATCHABLE.has(k.knowledgeKind(otherMem)));
  assert.ok(k.PATCHABLE.has(k.knowledgeKind(stray)));
  for (const f of [otherMem, vendored, stray]) assert.match(k.resolveRouteOwner(f, proj).reason, /is not one of this project's knowledge files or yours/);
  for (const f of [rules, globalMd, path.join(proj, 'CLAUDE.md')]) assert.equal(path.resolve(k.resolveRouteOwner(f, proj).file), path.resolve(f));
  const before = [otherMem, vendored, stray].map((f) => fs.readFileSync(f, 'utf8'));
  const ids = [otherMem, vendored, stray].map((f, i) => pending(proj, `Elsewhere ${i}`, `Answer in French, case ${i}.`, f, { autonomy: 'auto' }));
  await ev.drainQueue(db);
  for (const id of ids) {
    assert.deepEqual([row(id).outcome, row(id).changeset_id], ['queued', null]);
    assert.match(row(id).note, /is not one of this project's knowledge files or yours; nothing was created, you decide/);
  }
  assert.deepEqual([otherMem, vendored, stray].map((f) => fs.readFileSync(f, 'utf8')), before, 'no file outside the knowledge set was touched');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM writes').get().n, 0);
  assert.deepEqual(learnings(), []);
});
