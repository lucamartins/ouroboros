// v0.25, capture: what the hooks and the transcript reader count as the session's own
// turns (a compaction summary, a fork's copy of its parent), sessions that never got a
// SessionEnd, an in-session review that could not save, and auto memory turned off.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'test', 'fixtures');
let tmp;
let env;
let transcript;
let hookApi;
let paths;

const HOUR = 3_600_000;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-v025c-'));
  const sandbox = {
    HOME: path.join(tmp, 'home'),
    USERPROFILE: path.join(tmp, 'home'),
    CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
    OUROBOROS_HOME: path.join(tmp, 'ouroboros'),
    CLAUDE_PLUGIN_DATA: path.join(tmp, 'data'),
  };
  Object.assign(process.env, sandbox);
  fs.mkdirSync(sandbox.HOME, { recursive: true });
  env = {
    ...process.env, ...sandbox,
    OUROBOROS_CLAUDE_CMD: JSON.stringify([process.execPath, path.join(fixtures, 'fake-claude.mjs')]),
  };
  // The session's environment decides auto memory; these tests set it themselves.
  for (const k of ['OUROBOROS_REVIEWER', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_REMOTE_MEMORY_DIR', 'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY']) delete env[k];
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_PLUGIN_OPTION_')) delete env[k];
  transcript = await import('../scripts/transcript.mjs');
  hookApi = await import('../scripts/hook.mjs');
  paths = await import('../scripts/paths.mjs');
});

after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

function hook(event, input, extraEnv = {}) {
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'hook.mjs'), event], {
    input: JSON.stringify({ hook_event_name: event, ...input }),
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function query(sql, ...args) {
  const d = new DatabaseSync(path.join(tmp, 'data', 'events.db'));
  try { return d.prepare(sql).all(...args); } finally { d.close(); }
}

function run(sql, ...args) {
  const d = new DatabaseSync(path.join(tmp, 'data', 'events.db'));
  try { d.prepare(sql).run(...args); } finally { d.close(); }
}

async function waitFor(fn, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
}

function projectDir(name) {
  const dir = path.join(tmp, 'work', name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const line = (o) => `${JSON.stringify(o)}\n`;
const prompt = (text, ts) => line({ type: 'user', message: { role: 'user', content: text }, timestamp: new Date(ts).toISOString() });
const answer = (text, ts) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: new Date(ts).toISOString() });

test('A2: a compaction summary is not a user turn: not counted, not quoted, not context', () => {
  const entries = transcript.readTranscript(path.join(fixtures, 'compacted.jsonl'));
  const summary = entries.find((e) => e?.isCompactSummary);
  assert.equal(transcript.isHumanPrompt(summary), false);
  const d = transcript.buildDigest(entries);
  assert.equal(d.humanTurns, 2);
  assert.doesNotMatch(d.text, /being continued from a previous conversation/);
  assert.match(d.text, /\[USER #2\] Now add left-pad/);
  // USER #2 is what the user typed after the compaction, not the model's summary.
  assert.match(d.userTurns[1].text, /left-pad/);
  // The EARLIER context of a tail that starts after the compaction quotes the user, not the summary.
  const tail = transcript.buildDigest(entries, { fromLine: entries.findIndex((e) => e?.uuid === 'u2'), contextTurns: 3 });
  assert.equal(tail.humanTurns, 1);
  assert.doesNotMatch(tail.text, /being continued/);
  assert.match(tail.text, /\[EARLIER USER\] In this project we always use pnpm/);
});

test('A1: with auto memory off, the user is told once and the memories Ouroboros saved go into the context', () => {
  const proj = projectDir('nomem');
  // One memory Ouroboros saved for this project and one the user's Claude saved itself.
  const dir = paths.memoryDirFor({ cwd: proj });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'use-pnpm.md'), '---\nname: use-pnpm\n---\nUse pnpm.\n');
  fs.writeFileSync(path.join(dir, 'native-note.md'), '---\nname: native-note\n---\nA native note.\n');
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '- [Native note](native-note.md) — written by Claude\n- [Use pnpm](use-pnpm.md) — This repo uses pnpm, never npm\n');
  hook('SessionStart', { session_id: 'mem-0', cwd: proj, source: 'startup' }); // creates the database
  const now = Date.now();
  run(`INSERT INTO learnings (id, kind, scope, project, name, title, path, status, origin_session, created_at, updated_at)
    VALUES ('lrn_pnpm', 'memory', 'project', 'p', 'use-pnpm', 'Use pnpm', ?, 'active', 'mem-x', ?, ?),
           ('lrn_native', 'memory', 'project', 'p', 'native-note', 'Native note', ?, 'active', 'native', ?, ?)`,
  path.join(dir, 'use-pnpm.md'), now, now, path.join(dir, 'native-note.md'), now, now);
  run("DELETE FROM meta WHERE key LIKE 'auto_memory:%'");

  const off = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  const first = JSON.parse(hook('SessionStart', { session_id: 'mem-1', cwd: proj, source: 'startup' }, off));
  assert.match(first.systemMessage, /does not load auto memory here \(CLAUDE_CODE_DISABLE_AUTO_MEMORY is set\)/);
  const ctx = first.hookSpecificOutput.additionalContext;
  assert.match(ctx, /- \[Use pnpm\]\(use-pnpm\.md\) — This repo uses pnpm, never npm/);
  assert.ok(ctx.includes(dir), 'the directory, so Claude can read the files');
  assert.doesNotMatch(ctx, /native-note/);
  const snap = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'options.json'), 'utf8'));
  assert.equal(snap.autoMemory.on, false);
  assert.match(snap.autoMemory.reason, /CLAUDE_CODE_DISABLE_AUTO_MEMORY/);

  // Said once: the next start only injects.
  const second = JSON.parse(hook('SessionStart', { session_id: 'mem-2', cwd: proj, source: 'startup' }, off));
  assert.equal(second.systemMessage, undefined);
  assert.match(second.hookSpecificOutput.additionalContext, /use-pnpm\.md/);

  // On (an explicit falsy value forces it on): nothing changes.
  const on = JSON.parse(hook('SessionStart', { session_id: 'mem-3', cwd: proj, source: 'startup' }, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0', CLAUDE_CODE_REMOTE: 'true' }));
  assert.equal(on.systemMessage, undefined);
  assert.doesNotMatch(on.hookSpecificOutput.additionalContext, /use-pnpm/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'options.json'), 'utf8')).autoMemory.on, true);
  // Off again after it was seen on: said again.
  const again = JSON.parse(hook('SessionStart', { session_id: 'mem-4', cwd: proj, source: 'startup' }, { CLAUDE_CODE_SIMPLE: '1' }));
  assert.match(again.systemMessage, /--bare/);

  // The other ways it is off.
  assert.match(paths.autoMemoryStatus(proj, { CLAUDE_CODE_REMOTE: 'true' }).reason, /cloud/);
  assert.equal(paths.autoMemoryStatus(proj, { CLAUDE_CODE_REMOTE: 'true', CLAUDE_CODE_REMOTE_MEMORY_DIR: '/mem' }).on, true);
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ autoMemoryEnabled: false }));
  assert.match(paths.autoMemoryStatus(proj, {}).reason, /autoMemoryEnabled is false/);
  assert.equal(paths.autoMemoryStatus(proj, { CLAUDE_CODE_DISABLE_AUTO_MEMORY: 'false' }).on, true);
  assert.equal(paths.autoMemoryStatus(projectDir('withmem'), {}).on, true);
});

test('M1: an in-session review whose learn step was denied leaves the stretch to the end-of-session review', () => {
  const proj = projectDir('denied');
  const every1 = { CLAUDE_PLUGIN_OPTION_REVIEW_EVERY_TURNS: '1' };
  const runCase = (id, denied) => {
    const t = path.join(tmp, `${id}.jsonl`);
    const now = Date.now();
    fs.writeFileSync(t, prompt('We always use pnpm here. Remember that.', now) + answer('`pnpm install`', now + 1));
    const sid = { session_id: id, cwd: proj, transcript_path: t };
    hook('SessionStart', { ...sid, source: 'startup' }, every1);
    hook('UserPromptSubmit', sid, every1);
    assert.match(hook('Stop', { ...sid, stop_hook_active: false }, every1), /learning review/);
    // The review: the learn skill is called and refused.
    fs.appendFileSync(t, line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'sk1', name: 'Skill', input: { skill: 'ouroboros:learn', args: 'save: use pnpm' } }] } })
      + line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sk1', is_error: denied, content: denied ? 'Execute skill: ouroboros:learn' : 'Launching skill: ouroboros:learn' }] } })
      + answer('Nothing saved.\n[ouroboros] reviewed=1 corrections=0 learned=0 patched=0', now + 2));
    hook('Stop', { ...sid, stop_hook_active: true, last_assistant_message: 'Nothing saved.\n[ouroboros] reviewed=1 corrections=0 learned=0 patched=0' }, every1);
    return {
      review: query("SELECT status, detail FROM reviews WHERE session_id = ? AND mode = 'inloop'", id)[0],
      session: query('SELECT review_cursor, review_requested_at FROM sessions WHERE id = ?', id)[0],
    };
  };
  const denied = runCase('m1-denied', true);
  assert.equal(denied.review.status, 'skipped');
  assert.match(denied.review.detail, /could not save/);
  assert.equal(denied.session.review_cursor, 0, 'the cursor stays');
  assert.equal(denied.session.review_requested_at, null);
  // A review that simply found nothing still closes the stretch.
  const nothing = runCase('m1-nothing', false);
  assert.equal(nothing.review.status, 'ok');
  assert.equal(nothing.session.review_cursor, 5);
  // The apply step through the shell counts too.
  assert.equal(hookApi.learnStepFailed([
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'node "/p/scripts/curator.mjs" apply --json x' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', is_error: true, content: 'Permission denied' }] } },
  ]), true);
});

test('M2: a session with no SessionEnd is reviewed once idle; if it goes on, only the new part is read', async () => {
  const proj = projectDir('crashed');
  const t = path.join(tmp, 'crashed.jsonl');
  const old = Date.now() - 7 * HOUR;
  fs.writeFileSync(t, prompt('install the deps', old) + answer('Running npm install.', old + 1) + prompt('no, use pnpm', old + 2) + answer('Done with pnpm.', old + 3));
  const sid = { session_id: 'm2-crashed', cwd: proj, transcript_path: t };
  hook('SessionStart', { ...sid, source: 'startup' });
  hook('UserPromptSubmit', sid);
  hook('UserPromptSubmit', sid);
  // A short one and one too old are left alone.
  hook('SessionStart', { session_id: 'm2-short', cwd: proj, transcript_path: t, source: 'startup' });
  hook('UserPromptSubmit', { session_id: 'm2-short', cwd: proj, transcript_path: t });
  hook('SessionStart', { session_id: 'm2-ancient', cwd: proj, transcript_path: t, source: 'startup' });
  hook('UserPromptSubmit', { session_id: 'm2-ancient', cwd: proj, transcript_path: t });
  hook('UserPromptSubmit', { session_id: 'm2-ancient', cwd: proj, transcript_path: t });
  // No SessionEnd: the terminal was killed seven hours ago.
  run("UPDATE sessions SET started_at = ?, last_event_at = ? WHERE id IN ('m2-crashed', 'm2-short')", old, old);
  run("UPDATE sessions SET started_at = ?, last_event_at = ? WHERE id = 'm2-ancient'", old - 30 * 24 * HOUR, old - 30 * 24 * HOUR);

  hook('SessionStart', { session_id: 'm2-next', cwd: proj, source: 'startup', transcript_path: t });
  const s = await waitFor(() => query("SELECT * FROM sessions WHERE id = 'm2-crashed' AND queue_state IN ('done', 'skipped')")[0]);
  assert.equal(s.ended_at, old, 'ended at its last event');
  assert.match(s.end_reason, /no SessionEnd/);
  assert.equal(s.measure_cursor, 4);
  assert.equal(s.review_cursor, 4);
  assert.deepEqual(query("SELECT turns_reviewed FROM reviews WHERE session_id = 'm2-crashed' AND instrument = 'corrections'").map((r) => r.turns_reviewed), [2]);
  assert.deepEqual(query("SELECT queue_state, ended_at FROM sessions WHERE id IN ('m2-short', 'm2-ancient') ORDER BY id").map((r) => ({ ...r })), [
    { queue_state: null, ended_at: null }, { queue_state: null, ended_at: null }]);

  // It was only idle: the user comes back to it.
  const now = Date.now();
  fs.appendFileSync(t, prompt('now add left-pad', now) + answer('pnpm add left-pad', now + 1));
  hook('SessionStart', { ...sid, source: 'resume' });
  hook('UserPromptSubmit', sid);
  hook('SessionEnd', { ...sid, reason: 'other' });
  const measured = await waitFor(() => {
    const rows = query("SELECT turns_reviewed FROM reviews WHERE session_id = 'm2-crashed' AND instrument = 'corrections' ORDER BY id");
    return rows.length === 2 && query("SELECT 1 FROM sessions WHERE id = 'm2-crashed' AND queue_state IN ('done', 'skipped')").length && rows;
  });
  assert.deepEqual(measured.map((r) => r.turns_reviewed), [2, 1], 'the instrument measures only the new turn');
  const reviews = query("SELECT turns_reviewed FROM reviews WHERE session_id = 'm2-crashed' AND mode = 'background' AND trigger IN ('orphan', 'session_end') ORDER BY id");
  assert.deepEqual(reviews.map((r) => r.turns_reviewed), [2, 1], 'the review reads only the new tail');
  assert.equal(query("SELECT review_cursor FROM sessions WHERE id = 'm2-crashed'")[0].review_cursor, 6);
});

test('M6: a forked session neither reviews nor measures what it copied from its parent', async () => {
  const proj = projectDir('forked');
  const t = path.join(tmp, 'fork.jsonl');
  const parent = Date.now() - HOUR;
  // What the fork's transcript looks like: metadata, the queued new prompt, then the
  // parent's entries (their timestamps, the fork's sessionId), then the fork's own turns.
  fs.writeFileSync(t, line({ type: 'mode', mode: 'normal', sessionId: 'm6-fork' })
    + line({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(Date.now() + 5).toISOString(), sessionId: 'm6-fork' })
    + prompt('install the deps', parent) + answer('Running npm install.', parent + 1)
    + prompt('no, use pnpm', parent + 2) + answer('Done with pnpm.', parent + 3)
    + prompt('and the lockfile?', parent + 4) + answer('Committed.', parent + 5));
  const sid = { session_id: 'm6-fork', cwd: proj, transcript_path: t };
  const every2 = { CLAUDE_PLUGIN_OPTION_REVIEW_EVERY_TURNS: '2' };
  hook('SessionStart', { ...sid, source: 'fork' }, every2);
  const now = Date.now() + 10;
  fs.appendFileSync(t, prompt('which command runs the tests?', now) + answer('`pnpm test`', now + 1));
  const entries = transcript.readTranscript(t);
  const start = query("SELECT started_at FROM sessions WHERE id = 'm6-fork'")[0].started_at;
  assert.equal(transcript.inheritedLines(entries, start), 8);
  // The counter says two turns (one typed, one that nobody typed); the parent's three
  // prompts do not make up the difference.
  hook('UserPromptSubmit', sid, every2);
  hook('UserPromptSubmit', sid, every2);
  assert.equal(hook('Stop', { ...sid, stop_hook_active: false }, every2), '');
  hook('SessionEnd', { ...sid, reason: 'other' }, every2);
  await waitFor(() => query("SELECT 1 FROM sessions WHERE id = 'm6-fork' AND queue_state IN ('done', 'skipped')").length);
  assert.deepEqual(query("SELECT turns_reviewed FROM reviews WHERE session_id = 'm6-fork' AND instrument = 'corrections'").map((r) => r.turns_reviewed), [1]);
  const review = query("SELECT status, turns_reviewed FROM reviews WHERE session_id = 'm6-fork' AND mode = 'background' AND trigger = 'session_end'")[0];
  assert.equal(review.turns_reviewed, 1);
  // A session that is not a fork keeps reading from the start.
  assert.equal(hookApi.skipInherited({ prepare: () => ({ get: () => null }) }, 'x', entries), 0);
});

test('low: shell operators are not part of a command target', () => {
  assert.equal(hookApi.targetOf('Bash', { command: 'ls -la && grep foo x' }), 'Bash:ls');
  assert.equal(hookApi.targetOf('Bash', { command: 'FOO=1 npm test 2>&1 | tail -5' }), 'Bash:npm test');
  assert.equal(hookApi.targetOf('Bash', { command: 'cd api && dotnet test --filter X' }), 'Bash:dotnet test');
  assert.equal(hookApi.targetOf('Bash', { command: 'git status; git diff' }), 'Bash:git status');
});

test('low: the SessionEnd hook declares no timeout', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.equal(hooks.SessionEnd[0].hooks[0].timeout, undefined, 'plugins cannot raise the 1.5 s SessionEnd limit');
});

test('low: a hook takes its options from the environment or the defaults, never the old snapshot', () => {
  // A value set once (with --plugin-dir, say) and then reset: the hook takes the default and records it.
  const snap = path.join(tmp, 'data', 'options.json');
  fs.writeFileSync(snap, JSON.stringify({ autonomy: 'queue', reviewEveryTurns: 3, updatedAt: 1 }));
  hook('SessionStart', { session_id: 'opt-1', cwd: projectDir('opts'), source: 'startup' });
  const written = JSON.parse(fs.readFileSync(snap, 'utf8'));
  assert.equal(written.autonomy, 'auto');
  assert.equal(written.reviewEveryTurns, 10);
  // A value that is set still reaches the snapshot.
  hook('SessionStart', { session_id: 'opt-2', cwd: projectDir('opts'), source: 'startup' }, { CLAUDE_PLUGIN_OPTION_AUTONOMY: 'hybrid' });
  assert.equal(JSON.parse(fs.readFileSync(snap, 'utf8')).autonomy, 'hybrid');
});

// ---- Review III, follow-up ----

test('M1 (follow-up): a later successful in-session review is asked to cover the stretch that could not be saved', () => {
  const proj = projectDir('later-ok');
  const every1 = { CLAUDE_PLUGIN_OPTION_REVIEW_EVERY_TURNS: '1' };
  const t = path.join(tmp, 'later-ok.jsonl');
  let ts = Date.now();
  fs.writeFileSync(t, prompt('We always use pnpm here. Remember that from now on.', ts++) + answer('ok', ts++));
  const sid = { session_id: 'm1-later', cwd: proj, transcript_path: t };
  const review = (id, isError, result) => {
    fs.appendFileSync(t, line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Skill', input: { skill: 'ouroboros:learn' } }] } })
      + line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] } })
      + answer(result, ts++));
    hook('Stop', { ...sid, stop_hook_active: true, last_assistant_message: result }, every1);
  };
  const ask = () => {
    hook('UserPromptSubmit', sid, every1);
    return JSON.parse(hook('Stop', { ...sid, stop_hook_active: false }, every1)).hookSpecificOutput.additionalContext;
  };
  hook('SessionStart', { ...sid, source: 'startup' }, every1);
  assert.match(ask(), /user turns 1–1 only/);
  review('sk1', true, '[ouroboros] reviewed=1 corrections=0 learned=0 patched=0');
  assert.equal(query('SELECT review_cursor FROM sessions WHERE id = ?', 'm1-later')[0].review_cursor, 0, 'the cursor stays');
  // Another turn; the next request starts at the turn that was not saved, not after it.
  fs.appendFileSync(t, prompt('Now add a README section.', ts++) + answer('done', ts++));
  assert.match(ask(), /user turns 1–2 only/);
  // That one fails too: the next still starts at turn 1 ...
  review('sk2', true, '[ouroboros] reviewed=2 corrections=0 learned=0 patched=0');
  fs.appendFileSync(t, prompt('And the tests.', ts++) + answer('done', ts++));
  assert.match(ask(), /user turns 1–3 only/);
  // ... until one succeeds: after it the cursor moves on, and the next request is for new turns only.
  review('sk3', false, '[ouroboros] reviewed=3 corrections=0 learned=1 patched=0');
  assert.ok(query('SELECT review_cursor FROM sessions WHERE id = ?', 'm1-later')[0].review_cursor > 0);
  fs.appendFileSync(t, prompt('One more thing.', ts++) + answer('done', ts++));
  assert.match(ask(), /user turns 4–4 only/);
});

test('M1 (follow-up): a denied Write of the payload file is a failed save', () => {
  const entries = (writeFailed) => [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'ouroboros:learn' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'Launching skill' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/tmp/payload.json', content: '{}' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w1', is_error: writeFailed, content: writeFailed ? 'Permission to use Write has been denied.' : 'ok' }] } },
  ];
  assert.equal(hookApi.learnStepFailed(entries(true)), true);
  assert.equal(hookApi.learnStepFailed(entries(false)), false);
  // A tool that failed before the learn skill was called is not the save.
  const before = entries(false);
  before.unshift(
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r0', name: 'Read', input: {} }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r0', is_error: true, content: 'No such file' }] } });
  assert.equal(hookApi.learnStepFailed(before), false);
});

test('M6 (follow-up): the worker alone skips a fork\'s inherited turns when no Stop ever asked for a review', async () => {
  const proj = projectDir('fork-worker');
  const t = path.join(tmp, 'fork-worker.jsonl');
  const parent = Date.now() - HOUR;
  fs.writeFileSync(t, line({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(Date.now() + 5).toISOString(), sessionId: 'm6-worker' })
    + prompt('install the deps', parent) + answer('Running npm install.', parent + 1)
    + prompt('no, use pnpm', parent + 2) + answer('Done with pnpm.', parent + 3));
  const sid = { session_id: 'm6-worker', cwd: proj, transcript_path: t };
  hook('SessionStart', { ...sid, source: 'fork' });
  const now = Date.now() + 10;
  fs.appendFileSync(t, prompt('which command runs the tests?', now) + answer('`pnpm test`', now + 1));
  hook('UserPromptSubmit', sid);
  // No Stop: nothing but the worker can move the cursors past the copy.
  assert.equal(query("SELECT review_cursor FROM sessions WHERE id = 'm6-worker'")[0].review_cursor, 0);
  hook('SessionEnd', { ...sid, reason: 'other' });
  await waitFor(() => query("SELECT 1 FROM sessions WHERE id = 'm6-worker' AND queue_state IN ('done', 'skipped')").length);
  assert.deepEqual(query("SELECT turns_reviewed FROM reviews WHERE session_id = 'm6-worker' AND instrument = 'corrections'").map((r) => r.turns_reviewed), [1]);
  assert.equal(query("SELECT turns_reviewed FROM reviews WHERE session_id = 'm6-worker' AND mode = 'background' AND trigger = 'session_end'")[0].turns_reviewed, 1);
});

test('M6 (follow-up): the transcript marks a fork\'s copied entries with forkedFrom, which needs no start time', () => {
  const parent = Date.now() - HOUR;
  const fork = (o) => ({ ...o, forkedFrom: { sessionId: 'parent-id', messageUuid: 'x' } });
  const entries = [
    { type: 'mode', mode: 'normal' },
    fork(JSON.parse(prompt('install the deps', parent))), fork(JSON.parse(answer('Running npm install.', parent + 1))),
    JSON.parse(prompt('which command runs the tests?', parent + 2)), JSON.parse(answer('`pnpm test`', parent + 3)),
  ];
  // A session Ouroboros never saw start (a backfill): no start time, the marker alone.
  assert.equal(transcript.inheritedLines(entries, null), 3);
  assert.equal(transcript.inheritedLines(entries.slice(3), null), 0, 'an ordinary session has no marker');
  const db = { prepare: (sql) => ({ get: () => (/FROM sessions/.test(sql) ? { started_at: null } : null), run: () => ({ changes: 1 }) }) };
  assert.equal(hookApi.skipInherited(db, 'backfilled', entries), 3);
});

test('A1 (follow-up): auto memory under CLAUDE_CODE_REMOTE_MEMORY_DIR, and safe mode turns it off', () => {
  const proj = projectDir('remote-mem');
  const had = process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR;
  const mem = path.join(tmp, 'remote-memory');
  try {
    delete process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR;
    assert.ok(paths.memoryDirFor({ cwd: proj }).startsWith(path.join(paths.claudeDir(), 'projects') + path.sep));
    process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR = mem;
    const dir = paths.memoryDirFor({ cwd: proj });
    assert.ok(dir.startsWith(path.join(mem, 'projects') + path.sep), dir);
    assert.ok(dir.endsWith(`${path.sep}memory`));
    // An explicit setting still wins.
    assert.equal(paths.memoryDirFor({ memoryDir: path.join(tmp, 'elsewhere') }), path.join(tmp, 'elsewhere'));
  } finally {
    if (had === undefined) delete process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR; else process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR = had;
  }
  assert.match(paths.autoMemoryStatus(proj, { CLAUDE_CODE_SAFE_MODE: '1' }).reason, /safe mode/);
  assert.equal(paths.autoMemoryStatus(proj, { CLAUDE_CODE_SAFE_MODE: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0' }).on, true);
});

test('M2 (follow-up): two SessionStarts at once record one session_end for the swept session', async () => {
  const proj = projectDir('sweep-race');
  const t = path.join(tmp, 'sweep-race.jsonl');
  const old = Date.now() - 7 * HOUR;
  fs.writeFileSync(t, prompt('install the deps', old) + answer('ok', old + 1));
  const sid = { session_id: 'm2-race', cwd: proj, transcript_path: t };
  hook('SessionStart', { ...sid, source: 'startup' });
  hook('UserPromptSubmit', sid);
  hook('UserPromptSubmit', sid);
  run("UPDATE sessions SET started_at = ?, last_event_at = ? WHERE id = 'm2-race'", old, old);
  const start = (id) => new Promise((resolve) => {
    const c = spawn(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'hook.mjs'), 'SessionStart'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('close', resolve);
    c.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: id, cwd: proj, source: 'startup' }));
  });
  await Promise.all([start('m2-race-a'), start('m2-race-b')]);
  await waitFor(() => query("SELECT 1 FROM sessions WHERE id = 'm2-race' AND queue_state IN ('done', 'skipped')").length);
  assert.equal(query("SELECT COUNT(*) n FROM events WHERE session_id = 'm2-race' AND kind = 'session_end'")[0].n, 1);
});
