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
  assert.match(forClaude, /\[c\d+\] waiting for approval → .*CLAUDE\.md: Prefers small pull requests/);
  assert.match(forClaude, new RegExp(`\\[o${obs.id}\\] The staging deploy`));
  assert.match(state.sessionStateText(db, sid), /set "refines" to its \[ref\]/);
  assert.equal(state.sessionStateText(db, 'another-session'), '');

  const inv = spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'curator.mjs'), 'inventory', '--cwd', proj, '--session', sid], { encoding: 'utf8' });
  assert.match(inv.stdout, /## This session so far\nAlready handled by earlier reviews of this session:/);

  assert.match(cli({ cwd: proj, session_id: sid, actor: 'inloop', items: [], resolve: [`o${obs.id}`] }).stdout, /settled: 1/);
  assert.equal(state.openObservations(db, sid).length, 0);
});

test('the periodic review request and the end-of-session prompt carry the state and the recorded recoveries', async () => {
  const { reviewRequest } = await import('../scripts/hook.mjs');
  const text = state.sessionStateText(db, 'sess-state-0001', { audience: 'claude' });
  assert.match(reviewRequest({ from: 11, to: 13, trigger: 'periodic', state: text }), /Already handled by earlier reviews of this session:[\s\S]*pass it in "open"/);
  const prompt = worker.learnPrompt({ digest: 'd', inventory: 'i', state: 'STATE', signals: '- Bash:pnpm test failed 3x before working' });
  assert.match(prompt, /This session so far:\nSTATE\n/);
  assert.match(prompt, /failed, then worked[\s\S]*pnpm test failed 3x/);
  assert.ok(worker.LEARN_SCHEMA.properties.items.items.properties.refines);
});

test('one last turn after an earlier review is reviewed; a one-turn session with nothing behind it is not', async () => {
  session('alone', [user('what does this repo do?'), assistant('It is a plugin.')]);
  assert.equal(await worker.reviewSession(db, 'alone', 'session_end'), 'short');

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
