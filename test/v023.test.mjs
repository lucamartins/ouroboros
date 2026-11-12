// v0.23 mechanism review: each defect found by reproducing it against the code, and the
// one the user asked about (a learned file deleted outside Ouroboros), with the test
// that would have caught it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let tmp;
let db;
let dbApi;
let curator;
let cs;
let proj;
let home;
let hookEnv;

const read = (f) => fs.readFileSync(f, 'utf8');

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-v023-'));
  home = path.join(tmp, 'home');
  // "~" must resolve inside the sandbox: paths.mjs reads the home folder when it loads.
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.OUROBOROS_HOME = path.join(tmp, 'ouroboros');
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data');
  process.env.OUROBOROS_CLAUDE_CMD = JSON.stringify([process.execPath, path.join(root, 'test', 'fixtures', 'fake-claude.mjs')]);
  proj = path.join(home, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  spawnSync('git', ['-C', proj, 'init', '-q']);
  dbApi = await import('../scripts/db.mjs');
  curator = await import('../scripts/curator.mjs');
  cs = await import('../scripts/changesets.mjs');
  db = dbApi.openDb();
  hookEnv = { ...process.env, CLAUDE_PLUGIN_DATA: path.join(tmp, 'data-hooks') };
  delete hookEnv.OUROBOROS_REVIEWER;
});

after(async () => {
  await settle(path.join(tmp, 'data-hooks', 'events.db'));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function hook(event, input, extraEnv = {}) {
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'hook.mjs'), event], {
    input: JSON.stringify({ session_id: 'h1', cwd: proj, hook_event_name: event, ...input }),
    env: { ...hookEnv, ...extraEnv },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function open(file) {
  const d = new DatabaseSync(file);
  d.exec('PRAGMA busy_timeout = 5000');
  return d;
}

// Let hook-spawned review workers finish before the temp dir goes away.
async function settle(file) {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    try {
      const d = new DatabaseSync(file);
      try {
        d.exec('PRAGMA busy_timeout = 5000');
        if (!d.prepare("SELECT 1 FROM sessions WHERE queue_state IN ('queued', 'running')").get()) return;
      } finally { d.close(); }
    } catch (e) { if (!/locked|busy|unable to open/i.test(String(e?.message))) return; }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const hookDb = () => open(path.join(tmp, 'data-hooks', 'events.db'));

async function waitFor(fn, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    let v;
    try { v = fn(); } catch (e) { if (!/locked|busy/i.test(String(e?.message))) throw e; }
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
}

const user = (text, origin = 'human') => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, origin: { kind: origin }, timestamp: new Date().toISOString() });
const assistant = (text, usage = null) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }], ...(usage ? { usage } : {}) } });

test('the daily maintenance runs when a session start asks for it', async () => {
  // The hook used to write "ran now" before starting the worker, which then found it had
  // run a moment ago and left: upkeep never happened.
  hook('SessionStart', { source: 'startup' });
  const d = hookDb();
  await waitFor(() => d.prepare('SELECT COUNT(*) n FROM maintenance').get().n === 1);
  // A second session the same day starts no second run.
  hook('SessionStart', { session_id: 'h1b', source: 'startup' });
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(d.prepare('SELECT COUNT(*) n FROM maintenance').get().n, 1);
  d.close();

  const { maintain } = await import('../scripts/maintenance.mjs');
  assert.equal((await maintain(db)).status, 'ok', 'the first run of the day is taken without --force');
  assert.equal((await maintain(db)).status, 'skipped');
  assert.equal((await maintain(db, { now: Date.now() + 20 * 60 * 60 * 1000 })).status, 'ok', 'and the next one 20 hours later');
});

test('a "~" target meets the same approval rules as its absolute path', () => {
  const file = path.join(proj, 'CLAUDE.md');
  fs.writeFileSync(file, '# Proj\n\n- Run the tests before pushing.\n');
  const patch = (target, autonomy, actor) => curator.apply(db, { cwd: proj, items: [{ op: 'patch', target, append: '- Skip the lint on hotfixes.', title: 'Skip lint' }] }, { actor, autonomy })[0];
  // A change to a CLAUDE.md always waits, whatever the autonomy and whoever asked.
  assert.equal(patch('~/proj/CLAUDE.md', 'auto', 'inloop').status, 'queued');
  assert.equal(patch('~/proj/CLAUDE.md', 'queue', 'requested').status, 'queued');
  assert.equal(patch(file, 'auto', 'inloop').status, 'queued');
  assert.equal(read(file), '# Proj\n\n- Run the tests before pushing.\n');
  for (const c of db.prepare("SELECT id FROM candidates WHERE outcome = 'queued'").all()) curator.decideQueued(db, c.id, false);
});

test('an addition only adds whole lines; words put inside a line are a correction', async () => {
  const { isInsertion } = await import('../scripts/textdiff.mjs');
  const text = '# Deploy\n\n- run the tests before pushing\n- Use pnpm for installs\n';
  const edit = (old, next) => cs.applyEdits(text, [{ old, new: next }]);
  // The old words survive in each of these, and each changes what the file says.
  for (const [old, next] of [
    ['run the tests before pushing', 'do not run the tests before pushing'],
    ['Use pnpm for installs', 'Never Use pnpm for installs'],
    ['run the tests before pushing', 'run the tests before pushing only when asked; otherwise skip them'],
    ['run the tests', 'run the tests\n- and nothing else'], // a fragment that ends mid-line: the rest of the line moves
  ]) {
    const r = edit(old, next);
    assert.equal(r.applied.length, 1, next);
    assert.equal(r.applied[0].corrects, true, next);
    assert.equal(r.applied[0].rewrites, true, next);
  }
  // A new line after an existing one is an addition.
  const add = edit('- Use pnpm for installs', '- Use pnpm for installs\n- Pin the pnpm version in CI');
  assert.equal(add.applied[0].corrects, undefined);
  assert.equal(add.after, `${text}- Pin the pnpm version in CI\n`);
  assert.equal(isInsertion('a\nb\n', 'a\nx\nb\n'), true);
  assert.equal(isInsertion('a\nb', 'a\nb\nc'), true);
  assert.equal(isInsertion('a  \nb\n', 'a\nb\nc\n'), true, 'trailing whitespace aside');
  assert.equal(isInsertion('a\nb\n', 'a\nb c\n'), false);
  assert.equal(isInsertion('a\nb\n', 'b\na\n'), false);

  // In `auto`, on a skill Ouroboros created itself: a rewrite waits; a line added does not.
  const [made] = curator.apply(db, { cwd: proj, items: [{ kind: 'skill', scope: 'global', title: 'Deploy the app', description: 'Deploy the app. Use when releasing.', body: '## Steps\n\n1. run the tests before pushing', confidence: 0.7 }] }, { actor: 'inloop', autonomy: 'auto' });
  const skill = made.path;
  const body = read(skill);
  const apply = (item) => curator.apply(db, { cwd: proj, items: [{ op: 'patch', kind: 'skill', target: skill, ...item }] }, { actor: 'inloop', autonomy: 'auto' })[0];
  assert.equal(apply({ old: 'run the tests before pushing', new: 'do not run the tests before pushing', title: 'negate' }).status, 'queued');
  assert.equal(read(skill), body);
  assert.equal(apply({ description: 'Deploy the app. Never on Fridays.', title: 'describe' }).status, 'queued', 'a description is one line: extending it rewrites it');
  assert.equal(apply({ old: '1. run the tests before pushing', new: '1. run the tests before pushing\n2. tag the release', title: 'step' }).status, 'patched');
  assert.match(read(skill), /\n2\. tag the release\n/);
  for (const c of db.prepare("SELECT id FROM candidates WHERE outcome = 'queued'").all()) curator.decideQueued(db, c.id, false);
});

test('an early review is for a working path, not for fixing code or waiting out a flaky command', () => {
  const requested = (out) => (out ? JSON.parse(out).hookSpecificOutput.additionalContext : '');
  const fail = (sid, command) => hook('PostToolUseFailure', { session_id: sid, tool_name: 'Bash', tool_input: { command }, error: 'Exit code 1' });
  const ok = (sid, tool, input) => hook('PostToolUse', { session_id: sid, tool_name: tool, tool_input: input, tool_response: {} });
  const stop = (sid) => requested(hook('Stop', { session_id: sid, stop_hook_active: false }));

  // Tests that fail until the code is fixed: files were written between the failures and the success.
  hook('UserPromptSubmit', { session_id: 'w1' });
  fail('w1', 'npm test');
  ok('w1', 'Edit', { file_path: path.join(proj, 'a.js') });
  fail('w1', 'npm test');
  ok('w1', 'Edit', { file_path: path.join(proj, 'a.js') });
  ok('w1', 'Bash', { command: 'npm test' });
  assert.equal(stop('w1'), '');

  // The same command repeated until it answered: nothing changed, nothing else ran.
  hook('UserPromptSubmit', { session_id: 'w2' });
  fail('w2', 'curl -sf http://localhost:3000/health');
  fail('w2', 'curl -sf http://localhost:3000/health');
  ok('w2', 'Bash', { command: 'curl -sf http://localhost:3000/health' });
  assert.equal(stop('w2'), '');

  // Another command in between made it work: that is a path worth a look.
  hook('UserPromptSubmit', { session_id: 'w3' });
  fail('w3', 'npm run e2e');
  fail('w3', 'npm run e2e');
  ok('w3', 'Bash', { command: 'docker compose up -d db' });
  ok('w3', 'Bash', { command: 'npm run e2e' });
  assert.match(stop('w3'), /`Bash:npm run` failed 2× before working/);

  const d = hookDb();
  const payload = (sid) => JSON.parse(d.prepare("SELECT payload FROM events WHERE session_id = ? AND kind = 'recovery'").get(sid).payload);
  assert.deepEqual([payload('w1').edits, payload('w2').changed, payload('w2').commands, payload('w3').commands], [2, false, 0, 1]);
  d.close();
});

test('the review cadence counts turns the user typed, and a very large context is left to the end-of-session review', () => {
  const requested = (out) => (out ? JSON.parse(out).hookSpecificOutput.additionalContext : '');
  const every2 = { CLAUDE_PLUGIN_OPTION_REVIEW_EVERY_TURNS: '2' };
  const t1 = path.join(tmp, 'cadence.jsonl');
  // Two prompts reached the hook, one of them a background subagent reporting back.
  fs.writeFileSync(t1, `${[user('add the endpoint'), assistant('Done.'), user('<task-notification>agent finished</task-notification>', 'task-notification'), assistant('Noted.')].join('\n')}\n`);
  const sid = { session_id: 'c1', transcript_path: t1 };
  hook('UserPromptSubmit', sid, every2);
  hook('UserPromptSubmit', sid, every2);
  assert.equal(requested(hook('Stop', { ...sid, stop_hook_active: false }, every2)), '', 'one typed turn is not two');
  fs.appendFileSync(t1, `${[user('now the tests'), assistant('Added.')].join('\n')}\n`);
  hook('UserPromptSubmit', sid, every2);
  assert.match(requested(hook('Stop', { ...sid, stop_hook_active: false }, every2)), /Ouroboros learning review \(periodic\)/);

  const t2 = path.join(tmp, 'big.jsonl');
  const usage = { input_tokens: 10, cache_read_input_tokens: 190_000, cache_creation_input_tokens: 4000, output_tokens: 50 };
  fs.writeFileSync(t2, `${[user('one'), assistant('ok'), user('two'), assistant('ok', usage)].join('\n')}\n`);
  const big = { session_id: 'c2', transcript_path: t2 };
  hook('UserPromptSubmit', big, every2);
  hook('UserPromptSubmit', big, every2);
  assert.equal(requested(hook('Stop', { ...big, stop_hook_active: false }, every2)), '');
  const d = hookDb();
  const skipped = d.prepare("SELECT status, detail FROM reviews WHERE session_id = 'c2'").get();
  assert.equal(skipped.status, 'skipped');
  assert.match(skipped.detail, /194010 tokens is over inloop_review_max_context \(150000\)/);
  assert.equal(d.prepare("SELECT review_requested_at FROM sessions WHERE id = 'c2'").get().review_requested_at, null);
  d.close();
  // The same context with the limit lifted: the review is asked for.
  const lifted = { session_id: 'c3', transcript_path: t2 };
  const noLimit = { ...every2, CLAUDE_PLUGIN_OPTION_INLOOP_REVIEW_MAX_CONTEXT: '0' };
  hook('UserPromptSubmit', lifted, noLimit);
  hook('UserPromptSubmit', lifted, noLimit);
  assert.match(requested(hook('Stop', { ...lifted, stop_hook_active: false }, noLimit)), /periodic/);
});

test('a review that stops before the last part resumes there instead of skipping the rest', async () => {
  const worker = await import('../scripts/review-worker.mjs');
  const { buildDigest, readTranscript } = await import('../scripts/transcript.mjs');
  const flag = path.join(tmp, 'fail-part-2');
  const fake = path.join(tmp, 'flaky-claude.mjs');
  fs.writeFileSync(fake, `import fs from 'node:fs';
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  // Whatever holds the session's last turn fails while the flag is there.
  if (fs.existsSync(${JSON.stringify(flag)}) && prompt.includes('turn 70 x')) { console.error('boom'); process.exit(1); }
  console.log(JSON.stringify({ is_error: false, structured_output: { corrections: [], items: [] }, usage: {}, total_cost_usd: 0.001 }));
});
`);
  const transcript = path.join(tmp, 'long.jsonl');
  const lines = [];
  for (let i = 1; i <= 70; i++) lines.push(user(`turn ${i} ${'x'.repeat(1900)}`), assistant(`ok ${i}`));
  fs.writeFileSync(transcript, `${lines.join('\n')}\n`);
  const digest = buildDigest(readTranscript(transcript));
  assert.equal(digest.chunks.length, 2);
  assert.equal(digest.partTurns[0] + digest.partTurns[1], 70);
  db.prepare("INSERT INTO sessions (id, project, cwd, transcript_path, started_at, turns, queue_state) VALUES ('long', 'p', ?, ?, ?, 70, 'queued')").run(proj, transcript, Date.now());

  const realCmd = process.env.OUROBOROS_CLAUDE_CMD;
  process.env.OUROBOROS_CLAUDE_CMD = JSON.stringify([process.execPath, fake]);
  try {
    fs.writeFileSync(flag, '1');
    assert.equal(await worker.reviewSession(db, 'long', 'session_end'), 'partial');
    let s = db.prepare("SELECT queue_state, review_cursor, measure_cursor FROM sessions WHERE id = 'long'").get();
    assert.equal(s.queue_state, 'waiting');
    assert.equal(s.review_cursor, digest.partStarts[1], 'the cursor stops where the unread part starts');
    assert.ok(s.review_cursor > 0 && s.review_cursor < 140);
    assert.equal(s.measure_cursor, 0, 'a partial measurement is not counted and is taken again');
    const first = db.prepare("SELECT turns_reviewed, detail FROM reviews WHERE session_id = 'long' AND mode = 'background'").get();
    assert.equal(first.turns_reviewed, digest.partTurns[0]);
    assert.match(first.detail, /reviewed in 1 of 2 parts; stopped early \(a part failed\): the rest is reviewed later/);

    // Later (the session-start sweep queues it again): the rest is reviewed, once.
    fs.rmSync(flag);
    db.prepare("UPDATE sessions SET queue_state = 'queued' WHERE id = 'long'").run();
    assert.equal(await worker.reviewSession(db, 'long', 'orphan'), 'ok');
    s = db.prepare("SELECT queue_state, review_cursor, measure_cursor FROM sessions WHERE id = 'long'").get();
    assert.deepEqual({ ...s }, { queue_state: 'done', review_cursor: 140, measure_cursor: 140 });
    const reviews = db.prepare("SELECT turns_reviewed FROM reviews WHERE session_id = 'long' AND mode = 'background' ORDER BY id").all();
    assert.equal(reviews[0].turns_reviewed + reviews[1].turns_reviewed, 70, 'every turn reviewed exactly once');
    assert.equal(db.prepare("SELECT turns_reviewed FROM reviews WHERE session_id = 'long' AND instrument = 'corrections'").get().turns_reviewed, 70);

    // A part that keeps failing is given up after three tries, and the review says so.
    db.prepare("INSERT INTO sessions (id, project, cwd, transcript_path, started_at, turns, queue_state) VALUES ('stuck', 'p', ?, ?, ?, 70, 'queued')").run(proj, transcript, Date.now());
    fs.writeFileSync(flag, '1');
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await worker.reviewSession(db, 'stuck', 'session_end'));
      if (i < 2) db.prepare("UPDATE sessions SET queue_state = 'queued' WHERE id = 'stuck'").run();
    }
    // The first try reads part 1; from then on the failing part is the only one left.
    assert.deepEqual(results, ['partial', 'failed', 'failed']);
    assert.equal(db.prepare("SELECT queue_state FROM sessions WHERE id = 'stuck'").get().queue_state, 'waiting');
    db.prepare("UPDATE sessions SET queue_state = 'queued' WHERE id = 'stuck'").run();
    assert.equal(await worker.reviewSession(db, 'stuck', 'orphan'), 'failed');
    assert.equal(db.prepare("SELECT queue_state FROM sessions WHERE id = 'stuck'").get().queue_state, 'failed', 'three failed calls: given up');
  } finally {
    process.env.OUROBOROS_CLAUDE_CMD = realCmd;
    fs.rmSync(flag, { force: true });
  }
});

test('a skill proposed by the end-of-session review waits for the user, whatever the autonomy', () => {
  const skill = (name) => ({ kind: 'skill', scope: 'global', title: name, description: `${name}. Use when packaging a deploy from Windows.`, body: '## Steps\n1. Use tar, not Compress-Archive.', confidence: 0.8 });
  const [bg] = curator.apply(db, { cwd: proj, items: [skill('Zip for Linux')] }, { actor: 'background', autonomy: 'auto' });
  assert.equal(bg.status, 'queued');
  assert.match(bg.reason, /a skill proposed by the end-of-session review is always confirmed/);
  // The user's decision writes it; Claude saving one in session follows the autonomy setting.
  const c = db.prepare("SELECT id FROM candidates WHERE outcome = 'queued' AND kind = 'skill' AND title = 'Zip for Linux'").get();
  assert.equal(curator.decideQueued(db, c.id, true).status, 'created');
  assert.equal(curator.apply(db, { cwd: proj, items: [skill('Rotate the staging certificate')] }, { actor: 'inloop', autonomy: 'auto' })[0].status, 'created');
  // A memory from the same reviewer is still written in `auto`.
  const [mem] = curator.apply(db, { cwd: proj, items: [{ kind: 'memory', memory_type: 'project', title: 'Staging database', description: 'Staging uses the shared Postgres on host db-stg', confidence: 0.7 }] }, { actor: 'background', autonomy: 'auto' });
  assert.equal(mem.status, 'created');
});

test('the secret check sees credentials in URLs, bearer tokens and passwords said in prose', () => {
  for (const s of [
    'DATABASE_URL=postgres://admin:Sup3rS3cretPw@db.internal:5432/app',
    'Use the key AIzaSyA1234567890abcdefghijklmnopqrstuv for maps',
    'Authorization: Bearer 9f8e7d6c5b4a39281706f5e4d3c2b1a0',
    'the admin password is hunter2hunter2',
    'token: abcdefgh12345678',
    'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz',
    'password: $2b$10$N9qo8uLOickgx2ZMRZoMye', // starts like a variable, is not one
  ]) assert.equal(curator.containsSecret(s), true, s);
  // Where a secret lives, or what it is called, is not the secret.
  for (const s of [
    'run with --token-file path/to/file.txt',
    'set api_key = os.environ["STRIPE_KEY"] in settings',
    'the password is injected by CI, never committed',
    'connect with postgres://user:<password>@localhost/app',
    'send it as Authorization: Bearer $GITHUB_TOKEN',
    'token: ${{ secrets.NPM_TOKEN }}',
  ]) assert.equal(curator.containsSecret(s), false, s);
});

test('skills pre-approve only their own script, and a decision is not a curator command', () => {
  for (const name of fs.readdirSync(path.join(root, 'skills'))) {
    const text = read(path.join(root, 'skills', name, 'SKILL.md'));
    const frontmatter = text.split(/\r?\n---/)[0];
    assert.doesNotMatch(frontmatter, /Bash\(node:\*\)|Bash\(node \*\)/, `${name}: any node command would run without a prompt`);
    const rules = [...frontmatter.matchAll(/Bash\((.+)\)/g)].map((m) => m[1]);
    assert.ok(rules.length, `${name} runs a script`);
    // The script each rule names is one the skill's body actually calls.
    for (const rule of rules) {
      const script = /\*([\w./-]+\.mjs)\*/.exec(rule)?.[1];
      assert.ok(script && text.includes(`\${CLAUDE_PLUGIN_ROOT}/${script}`), `${name}: ${rule}`);
    }
  }
  // Approving is the user's act (the inbox, the dashboard): `curator.mjs`, which the
  // learn skill may run without a prompt, has no such command.
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'curator.mjs'), 'approve', '--id', '1', '--data', process.env.CLAUDE_PLUGIN_DATA], { encoding: 'utf8', env: process.env });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /usage:/);
});

test('a learned file deleted outside Ouroboros becomes "removed", is not counted, and is not saved again unasked', async () => {
  const item = { kind: 'memory', memory_type: 'feedback', title: 'Never rebase shared branches', description: 'Merge main into shared branches instead of rebasing them', body: 'Merge, never rebase.\n\n**Why:** others have the branch.\n**How to apply:** always.', confidence: 0.6 };
  const [m] = curator.apply(db, { cwd: proj, session_id: 'sess-del-1', items: [item] }, { actor: 'inloop', autonomy: 'auto' });
  assert.equal(m.status, 'created');
  const indexFile = path.join(path.dirname(m.path), 'MEMORY.md');
  assert.match(read(indexFile), /never-rebase-shared-branches\.md/);
  const [sk] = curator.apply(db, { cwd: proj, items: [{ kind: 'skill', scope: 'global', title: 'Reset the local stack', description: 'Reset the local stack. Use when containers are in a bad state.', body: '## Steps\n1. docker compose down -v', confidence: 0.6 }] }, { actor: 'inloop', autonomy: 'auto' });
  const learnedSkills = () => db.prepare("SELECT COUNT(*) n FROM learnings WHERE kind = 'skill' AND status = 'active' AND origin_session IS NOT 'native'").get().n;
  const skillsBefore = learnedSkills();

  // The user deletes the memory in a file manager (its index line stays) and the skill's folder.
  const saved = read(m.path);
  fs.rmSync(m.path);
  fs.rmSync(path.dirname(sk.path), { recursive: true });
  assert.equal(curator.reconcile(db).removed.length, 2);
  assert.equal(db.prepare('SELECT status FROM learnings WHERE id = ?').get(m.id).status, 'removed');
  assert.equal(learnedSkills(), skillsBefore - 1, 'a deleted skill no longer counts against the budget');
  assert.doesNotMatch(read(indexFile), /never-rebase-shared-branches\.md/, 'the index line that pointed at nothing is gone');
  assert.equal(db.prepare("SELECT op FROM writes WHERE file = ? ORDER BY id DESC").get(indexFile).op, 'cleanup', 'through the ledger');
  const notice = db.prepare("SELECT text FROM notices WHERE text LIKE '%deleted outside Ouroboros%' ORDER BY id DESC").all().map((n) => n.text).join('\n');
  assert.match(notice, /Never rebase shared branches/);
  assert.match(notice, /Reset the local stack/);
  assert.equal(curator.reconcile(db).removed.length, 0, 'said once');

  // The reviews see it as something taken out, like a rejection.
  const { rejectionDocs } = await import('../scripts/triage.mjs');
  assert.ok(rejectionDocs(db).some((r) => /Never rebase shared branches.*deleted afterwards/.test(r.text)));
  // In session, Claude is told, and saves it again only with a reason.
  const again = curator.apply(db, { cwd: proj, items: [item] }, { actor: 'inloop', autonomy: 'auto', ownerCheck: true })[0];
  assert.equal(again.status, 'was_removed');
  assert.equal(fs.existsSync(m.path), false);
  // Archiving or undoing something already gone brings the record in step instead of failing.
  assert.equal(curator.undo(db, { id: sk.id }).status, 'undone');
  assert.equal(db.prepare('SELECT status FROM learnings WHERE id = ?').get(sk.id).status, 'reverted');

  // The file comes back (a restored backup): the learning is active again.
  fs.writeFileSync(m.path, saved);
  assert.deepEqual(curator.reconcile(db).restored.map((l) => l.id), [m.id]);
  assert.equal(db.prepare('SELECT status FROM learnings WHERE id = ?').get(m.id).status, 'active');
  // Deleted again, then asked for again: a new learning takes the path, and the old record stays removed.
  fs.rmSync(m.path);
  assert.equal(curator.forget(db, { match: m.id }).status, 'removed');
  const asked = curator.apply(db, { cwd: proj, items: [{ ...item, removed_checked: true }] }, { actor: 'inloop', autonomy: 'auto', ownerCheck: true })[0];
  assert.equal(asked.status, 'created');
  assert.notEqual(asked.id, m.id);
  assert.equal(curator.reconcile(db).restored.length, 0);
  assert.equal(db.prepare('SELECT status FROM learnings WHERE id = ?').get(m.id).status, 'removed');

  // A project skill lives in the repository: gone may only mean "on another branch".
  // It leaves the counts and comes back with its file, with no notice and no grudge.
  const [ps] = curator.apply(db, { cwd: proj, items: [{ kind: 'skill', scope: 'project', title: 'Seed the demo tenant', description: 'Seed the demo tenant. Use before a demo.', body: '## Steps\n1. pnpm seed:demo', confidence: 0.6 }] }, { actor: 'inloop', autonomy: 'auto' });
  assert.ok(ps.path.startsWith(path.join(proj, '.claude', 'skills')));
  const skillText = read(ps.path);
  const noticesBefore = db.prepare('SELECT COUNT(*) n FROM notices').get().n;
  fs.rmSync(path.dirname(ps.path), { recursive: true });
  assert.deepEqual(curator.reconcile(db).removed.map((l) => l.id), [ps.id]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notices').get().n, noticesBefore);
  assert.ok(!rejectionDocs(db).some((r) => /Seed the demo tenant/.test(r.text)));
  fs.mkdirSync(path.dirname(ps.path), { recursive: true });
  fs.writeFileSync(ps.path, skillText);
  assert.deepEqual(curator.reconcile(db).restored.map((l) => l.id), [ps.id]);
});
