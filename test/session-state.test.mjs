// v0.15 session learning state: what a later review of a session knows about the
// earlier ones (saved, queued, left open), the context of an unreviewed tail, and
// refinements folded into what the session already saved.
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
let state;
let worker;
let transcript;
let paths;
let proj;

const user = (text) => JSON.stringify({ type: 'user', origin: { kind: 'human' }, timestamp: new Date().toISOString(), message: { content: text } });
const assistant = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

function session(id, lines, { cursor = 0 } = {}) {
  const file = path.join(tmp, `${id}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  db.prepare("INSERT INTO sessions (id, project, cwd, transcript_path, started_at, review_cursor, queue_state) VALUES (?, ?, ?, ?, ?, ?, 'queued')")
    .run(id, paths.projectKey(proj), proj, file, Date.now() - 60_000, cursor);
  return file;
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-state-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.OUROBOROS_HOME = path.join(tmp, 'ouroboros');
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data');
  process.env.OUROBOROS_CLAUDE_CMD = JSON.stringify([process.execPath, path.join(root, 'test', 'fixtures', 'fake-claude.mjs')]);
  process.env.CLAUDE_PLUGIN_OPTION_MONTHLY_BUDGET_USD = '5';
  proj = path.join(tmp, 'work', 'p');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  curator = await import('../scripts/curator.mjs');
  state = await import('../scripts/session-state.mjs');
  worker = await import('../scripts/review-worker.mjs');
  transcript = await import('../scripts/transcript.mjs');
  paths = await import('../scripts/paths.mjs');
  db = (await import('../scripts/db.mjs')).openDb();
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('a tail digest shows the turns before the cursor as context and keeps the end of what the user answers', () => {
  const question = `Here is the plan. ${'detail '.repeat(300)}Two decisions for you: 1. use pnpm? 2. deploy from main?`;
  const lines = [user('set up the project'), assistant('Done.'), user('now plan the release'), assistant(question), user('1. yes 2. no, from release branches'), assistant(`Noted. ${'more '.repeat(300)}Should I also tag it?`), user('yes')];
  const entries = transcript.readTranscript(session('ctx', lines));
  const d = transcript.buildDigest(entries, { fromLine: 4, contextTurns: 3 });
  assert.equal(d.humanTurns, 2, 'context turns are not counted');
  assert.match(d.text, /\[EARLIER USER\] now plan the release/);
  assert.match(d.text, /\[EARLIER ASSISTANT\] Here is the plan\..*deploy from main\?/, 'the question at the end of a long message survives');
  assert.ok(d.text.indexOf('[CONTEXT] The part to review starts here.') < d.text.indexOf('[USER #1] 1. yes 2. no'));
  assert.match(d.text, /\[ASSISTANT\] Noted\..*Should I also tag it\?\n\[USER #2\] yes/);
  assert.doesNotMatch(transcript.buildDigest(entries, { fromLine: 0, contextTurns: 3 }).text, /EARLIER/);
});

test('the state lists what the session saved, queued and left open; observations open and close through apply', () => {
  const sid = 'sess-state-0001';
  const [saved, queued] = curator.apply(db, { cwd: proj, session_id: sid, items: [
    { kind: 'memory', memory_type: 'project', title: 'Deploys go through release branches', description: 'Where deploys start from', body: 'Deploy from release/* branches, never from main', why: 'the user corrected a deploy from main', confidence: 0.7 },
    { kind: 'global', text: 'Prefers small pull requests', confidence: 0.8 },
  ] }, { actor: 'inloop', autonomy: 'auto' });
  assert.deepEqual([saved.status, queued.status], ['created', 'queued']);

  const cli = (payload) => spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'curator.mjs'), 'apply'], { input: JSON.stringify(payload), encoding: 'utf8' });
  assert.match(cli({ cwd: proj, session_id: sid, actor: 'inloop', items: [], open: ['The staging deploy may need a manual cache purge (seen once, not confirmed)'] }).stdout, /left open for the next review: 1/);
  const [obs] = state.openObservations(db, sid);
  assert.match(obs.text, /cache purge/);

  const forClaude = state.sessionStateText(db, sid, { audience: 'claude' });
  assert.match(forClaude, new RegExp(`\\[${saved.id}\\] saved → .*deploys-go-through-release-branches\\.md: Deploys go through release branches`));
  assert.match(forClaude, /\[c\d+\] waiting for approval → .*CLAUDE\.md: Prefers small pull requests$/m, 'a title that only repeats the text is said once');
  assert.match(forClaude, new RegExp(`\\[o${obs.id}\\] The staging deploy`));
  assert.match(state.sessionStateText(db, sid), /set "refines" to its \[ref\]/);
  assert.equal(state.sessionStateText(db, 'another-session'), '');

  const inv = spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'curator.mjs'), 'inventory', '--cwd', proj, '--session', sid], { encoding: 'utf8' });
  assert.match(inv.stdout, /## This session so far\nAlready handled this session \(do not save again/);

  assert.match(cli({ cwd: proj, session_id: sid, actor: 'inloop', items: [], resolve: [`o${obs.id}`] }).stdout, /settled: 1/);
  assert.equal(state.openObservations(db, sid).length, 0);
});

test('the periodic review request and the end-of-session prompt carry the state and the recorded recoveries', async () => {
  const { reviewRequest } = await import('../scripts/hook.mjs');
  const text = state.sessionStateText(db, 'sess-state-0001', { audience: 'claude' });
  const request = reviewRequest({ from: 11, to: 13, trigger: 'periodic', state: text });
  assert.match(request, /^Ouroboros learning review \(periodic\): user turns 11–13 only\. Follow "Periodic reviews"/);
  assert.match(request, /Already handled this session[\s\S]*\nEnd with exactly this line: \[ouroboros\] reviewed=/);
  // Claude Code prints the request to the user at every review: it stays short.
  assert.ok(request.split('\n').length <= 8, request);
  const skill = fs.readFileSync(path.join(root, 'skills', 'learn', 'SKILL.md'), 'utf8');
  assert.match(skill, /Do not save again what is listed as handled/, 'what left the request lives in the skill');
  const prompt = worker.learnPrompt({ digest: 'd', inventory: 'i', state: 'STATE', signals: '- Bash:pnpm test failed 3x before working' });
  assert.match(prompt, /This session so far:\nSTATE\n/);
  assert.match(prompt, /failed, then worked[\s\S]*pnpm test failed 3x/);
  assert.ok(worker.LEARN_SCHEMA.properties.items.items.properties.refines);
});

test('one last turn after an earlier review is reviewed; a one-turn session with nothing behind it is not', async () => {
  session('alone', [user('what does this repo do?'), assistant('It is a plugin.')]);
  assert.equal(await worker.reviewSession(db, 'alone', 'session_end'), 'short');
  // Skipped is not reviewed: when the session goes on, the next review reads that turn too.
  assert.equal(db.prepare("SELECT review_cursor FROM sessions WHERE id = 'alone'").get().review_cursor, 0);
  fs.appendFileSync(path.join(tmp, 'alone.jsonl'), `${[user('no, I asked about the tests'), assistant('Sorry: it uses node:test.')].join('\n')}\n`);
  db.prepare("UPDATE sessions SET queue_state = 'queued' WHERE id = 'alone'").run();
  assert.equal(await worker.reviewSession(db, 'alone', 'session_end'), 'ok');
  assert.equal(db.prepare("SELECT turns_reviewed FROM reviews WHERE session_id = 'alone' AND mode = 'background' AND status = 'ok'").get().turns_reviewed, 2);

  session('tail', [user('deploy it'), assistant('Deploying from main.'), user('ok'), assistant('Done.'), user('no, never deploy from main'), assistant('Understood.')], { cursor: 4 });
  db.prepare("INSERT INTO reviews (session_id, mode, trigger, status, turns_reviewed, ts) VALUES ('tail', 'inloop', 'periodic', 'ok', 2, ?)").run(Date.now() - 1000);
  state.addObservations(db, 'tail', ['Deploying from main may be wrong here']);
  assert.equal(await worker.reviewSession(db, 'tail', 'session_end'), 'ok');
  const review = db.prepare("SELECT * FROM reviews WHERE session_id = 'tail' AND mode = 'background' AND trigger = 'session_end'").get();
  assert.equal(review.turns_reviewed, 1);
  assert.equal(state.openObservations(db, 'tail').length, 0, 'the last review of the session closes what was left open');
});

test('an item that refines what the session already saved is folded into that file', async () => {
  const { tidyQueue } = await import('../scripts/evaluate.mjs');
  const sid = 'sess-state-0001';
  const saved = state.sessionLearnings(db, sid).find((l) => l.status === 'saved');
  const item = { op: 'create', kind: 'memory', scope: 'project', memory_type: 'project', title: 'Hotfixes deploy from hotfix branches', description: 'Hotfixes deploy from hotfix/* branches', confidence: 0.8, refines: saved.ref };
  db.prepare(`INSERT INTO candidates (review_id, session_id, project, kind, scope, title, summary, confidence, outcome, payload, cwd, ts)
    VALUES (0, ?, ?, 'memory', 'project', ?, ?, 0.8, 'pending', ?, ?, ?)`).run(sid, paths.projectKey(proj), item.title, item.description,
    JSON.stringify({ item, cwd: proj, trigger: 'session_end', actor: 'background', autonomy: 'auto' }), proj, Date.now());
  const report = await tidyQueue(db, { autonomy: 'auto' });
  assert.deepEqual([report.routed, report.created, report.patched], [1, 0, 1]);
  assert.match(fs.readFileSync(saved.file, 'utf8'), /never from main\nHotfixes deploy from hotfix\/\* branches/);
  assert.equal(fs.readdirSync(path.dirname(saved.file)).filter((f) => /hotfix/.test(f)).length, 0, 'no second memory');
});

test('refining a memory Ouroboros wrote and nobody edited needs no approval in auto, and its description and index line follow', async () => {
  const { tidyQueue } = await import('../scripts/evaluate.mjs');
  const sid = 'sess-state-0001';
  const saved = state.sessionLearnings(db, sid).find((l) => l.status === 'saved' && l.op === 'create');
  const index = path.join(path.dirname(saved.file), 'MEMORY.md');
  assert.equal(curator.ownUntouched(db, saved.file), true);
  const propose = (claim, autonomy = 'auto') => {
    const item = { op: 'create', kind: 'memory', scope: 'project', memory_type: 'project', title: 'Deploy branches changed', description: claim, confidence: 0.8, refines: saved.ref };
    db.prepare(`INSERT INTO candidates (review_id, session_id, project, kind, scope, title, summary, confidence, outcome, payload, cwd, ts)
      VALUES (0, ?, ?, 'memory', 'project', ?, ?, 0.8, 'pending', ?, ?, ?)`).run(sid, paths.projectKey(proj), item.title, claim,
      JSON.stringify({ item, cwd: proj, trigger: 'session_end', actor: 'background', autonomy }), proj, Date.now());
    return tidyQueue(db, { autonomy });
  };
  // A rewrite of the body plus a new one-line description: written at once.
  const r = await propose('FIX:never from main=>never from main or develop\nDESC:Where deploys and hotfixes start from, and where they never do');
  assert.equal(r.patched, 1);
  const text = fs.readFileSync(saved.file, 'utf8');
  assert.match(text, /never from main or develop/);
  assert.match(text, /^description: Where deploys and hotfixes start from, and where they never do$/m);
  assert.match(text, /^name: /m, 'the rest of the frontmatter is intact');
  assert.match(fs.readFileSync(index, 'utf8'), /\(deploys-go-through-release-branches\.md\) — Where deploys and hotfixes start from, and where they never do/);
  // Undo takes back the file and its index line together.
  assert.equal(curator.undo(db, { last: true }).status, 'undone');
  assert.doesNotMatch(fs.readFileSync(saved.file, 'utf8'), /develop/);
  assert.match(fs.readFileSync(index, 'utf8'), /— Where deploys start from/);

  // Outside auto, and once the user has edited the file by hand, a rewrite waits as before.
  assert.equal((await propose('FIX:never from main=>never from main or staging', 'hybrid')).patched, 0);
  for (const c of db.prepare("SELECT id FROM candidates WHERE outcome = 'queued' AND changeset_id IS NOT NULL").all()) curator.decideQueued(db, c.id, false);
  fs.appendFileSync(saved.file, '\nA note the user added by hand.\n');
  assert.equal(curator.ownUntouched(db, saved.file), false);
  const held = await propose('FIX:never from main=>never from main or trunk');
  assert.deepEqual([held.patched, held.queued], [0, 1]);
  assert.doesNotMatch(fs.readFileSync(saved.file, 'utf8'), /trunk/);
});

test('a description edit cannot touch anything else in the frontmatter', async () => {
  const { applyEdits } = await import('../scripts/changesets.mjs');
  const text = '---\nname: x\ndescription: Old summary\nmetadata:\n  type: feedback\n---\n\nBody line here.\n';
  const ok = applyEdits(text, [{ description: 'New summary' }]);
  assert.equal(ok.rejected.length, 0);
  assert.match(ok.after, /^description: New summary$/m);
  assert.equal(ok.applied[0].corrects, true, 'always a correction');
  assert.match(ok.after, /name: x\n[\s\S]*metadata:\n  type: feedback/);
  assert.equal(applyEdits(text, [{ description: '' }]).rejected.length, 1);
  assert.equal(applyEdits(text, [{ old: 'name: x', new: 'name: y' }]).rejected[0].reason, 'changes the frontmatter');
});
