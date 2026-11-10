// End-to-end: run the real hook dispatcher as Claude Code would (JSON on stdin),
// against a throwaway data dir, with a fake `claude` for the review worker.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-test-'));
  env = {
    ...process.env,
    CLAUDE_PLUGIN_DATA: path.join(tmp, 'data'),
    CLAUDE_CONFIG_DIR: path.join(tmp, 'claude'),
    OUROBOROS_HOME: path.join(tmp, 'ouroboros'),
    OUROBOROS_CLAUDE_CMD: JSON.stringify([process.execPath, path.join(fixtures, 'fake-claude.mjs')]),
  };
  delete env.OUROBOROS_REVIEWER;
});

after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

function hook(event, input, extraEnv = {}) {
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'hook.mjs'), event], {
    input: JSON.stringify({ session_id: 's1', cwd: '/tmp/proj', transcript_path: path.join(fixtures, 'session.jsonl'), hook_event_name: event, ...input }),
    env: { ...env, ...extraEnv },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

function db() {
  return new DatabaseSync(path.join(tmp, 'data', 'events.db'));
}

async function waitFor(fn, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
}

test('capture: turns, skills, memory writes, recovery and long turns', () => {
  const start = JSON.parse(hook('SessionStart', { source: 'startup' }));
  assert.equal(start.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(start.hookSpecificOutput.additionalContext, /ouroboros:learn/);
  hook('UserPromptSubmit', { prompt: 'install the deps' });
  hook('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm install' }, error: 'Exit code 1' });
  hook('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'cd x && npm install --force' }, error: 'Exit code 1' });
  hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm install' }, tool_response: {} });
  hook('PostToolUse', { tool_name: 'Skill', tool_input: { skill: 'deploy' } });
  hook('UserPromptExpansion', { expansion_type: 'slash_command', command_name: 'review', command_source: 'plugin' });
  hook('PostToolUse', {
    tool_name: 'Write',
    tool_input: { file_path: path.join(tmp, 'claude', 'projects', 'p', 'memory', 'pnpm.md') },
    tool_response: { type: 'create' },
    agent_id: 'sub-1',
  });
  hook('Stop', { stop_hook_active: false });

  const d = db();
  const s = d.prepare('SELECT * FROM sessions WHERE id = ?').get('s1');
  assert.equal(s.turns, 1);
  assert.equal(s.tool_calls, 5);
  assert.equal(s.tool_fails, 2);
  assert.equal(s.project, '-tmp-proj');

  const kinds = d.prepare('SELECT kind, target, agent_id, payload FROM events ORDER BY id').all();
  const recovery = kinds.find((k) => k.kind === 'recovery');
  assert.equal(recovery.target, 'Bash:npm install');
  assert.equal(JSON.parse(recovery.payload).failures, 2);
  assert.deepEqual(kinds.filter((k) => k.kind === 'skill_used').map((k) => k.target), ['deploy', 'review']);
  const write = kinds.find((k) => k.kind === 'memory_write');
  assert.equal(write.agent_id, 'sub-1');
  // The turn worked through two failures: an early review was requested at once.
  assert.equal(kinds.find((k) => k.kind === 'review_requested')?.target, 'recovery');
  assert.equal(d.prepare('SELECT COUNT(*) n FROM fail_streaks').get().n, 0);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM errors').get().n, 0);
  d.close();
});

test('SessionEnd runs a background review that writes learnings and leaves a notice', async () => {
  hook('SessionEnd', { reason: 'prompt_input_exit' });
  const d = db();
  const review = await waitFor(() => d.prepare("SELECT * FROM reviews WHERE session_id = ? AND mode = 'background'").get('s1'));
  assert.equal(review.status, 'ok', review.detail);
  assert.equal(review.turns_reviewed, 2);
  assert.equal(review.corrections, 1);
  assert.equal(review.cost_usd, 0.0042);
  // The correction rate has its own pass over the whole session; the learning review's count is not part of it.
  assert.equal(review.instrument, null);
  const measured = d.prepare("SELECT * FROM reviews WHERE session_id = ? AND mode = 'corrections'").get('s1');
  assert.deepEqual([measured.status, measured.instrument, measured.turns_reviewed, measured.corrections], ['ok', 'corrections', 2, 1]);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM corrections WHERE session_id = ?').get('s1').n, 1, 'quotes are listed once, from the instrument');
  const s = await waitFor(() => {
    const row = d.prepare('SELECT queue_state, review_cursor FROM sessions WHERE id = ?').get('s1');
    return row.queue_state === 'done' && row;
  });
  assert.ok(s.review_cursor > 0);
  // The project fact is written; the global one waits as a change to the global CLAUDE.md.
  const rows = d.prepare('SELECT outcome, target, changeset_id FROM candidates ORDER BY id').all();
  assert.deepEqual(rows.map((r) => r.outcome), ['created', 'queued']);
  assert.equal(path.resolve(rows[1].target), path.join(tmp, 'claude', 'CLAUDE.md'));
  assert.equal(d.prepare('SELECT status FROM changesets WHERE id = ?').get(rows[1].changeset_id).status, 'pending');
  assert.equal(d.prepare("SELECT learned FROM reviews WHERE session_id = ? AND mode = 'background'").get('s1').learned, 1);
  d.close();
  assert.ok(fs.existsSync(path.join(tmp, 'claude', 'projects', '-tmp-proj', 'memory', 'use-pnpm.md')));
  assert.equal(fs.existsSync(path.join(tmp, 'ouroboros', 'user.md')), false);
  assert.doesNotMatch(fs.readFileSync(path.join(tmp, 'claude', 'CLAUDE.md'), 'utf8'), /Git Bash/);

  const first = JSON.parse(hook('SessionStart', { session_id: 's3', source: 'startup' }));
  assert.match(first.systemMessage, /📝 learned: Use pnpm/);
  assert.match(first.systemMessage, /waiting for approval: CLAUDE\.md/);
  assert.doesNotMatch(first.hookSpecificOutput.additionalContext, /Git Bash/);
  const second = JSON.parse(hook('SessionStart', { session_id: 's3b', source: 'startup' }));
  assert.equal(second.systemMessage, undefined);
});

test('a repeated finding reinforces what was saved; the editor finds nothing new to add', async () => {
  const d = db();
  const before = d.prepare("SELECT confidence FROM learnings WHERE path LIKE '%use-pnpm.md'").get().confidence;
  hook('UserPromptSubmit', { session_id: 's6' });
  hook('SessionEnd', { session_id: 's6', reason: 'other' });
  await waitFor(() => d.prepare("SELECT queue_state FROM sessions WHERE id = 's6'").get()?.queue_state === 'done');
  // The global fact is already waiting for approval: merged into the waiting one.
  const rows = d.prepare("SELECT kind, outcome, note FROM candidates WHERE session_id = 's6' AND outcome != 'queued' ORDER BY id").all();
  assert.deepEqual(rows.map((r) => r.outcome), ['duplicate', 'merged']);
  assert.match(rows[0].note, /covered \[editor\]/);
  assert.ok(d.prepare("SELECT confidence FROM learnings WHERE path LIKE '%use-pnpm.md'").get().confidence > before);
  assert.equal(d.prepare("SELECT COUNT(*) n FROM reviews WHERE session_id = 's6' AND trigger = 'editor'").get().n, 1);
  d.close();
});

test('with learning off the end-of-session review only measures', async () => {
  const off = { CLAUDE_PLUGIN_OPTION_LEARNING: 'false' };
  hook('UserPromptSubmit', { session_id: 's4' }, off);
  hook('SessionEnd', { session_id: 's4', reason: 'other' }, off);
  const d = db();
  const review = await waitFor(() => d.prepare("SELECT * FROM reviews WHERE session_id = 's4'").get());
  assert.equal(review.mode, 'measure', review.detail);
  assert.equal(review.status, 'ok', review.detail);
  assert.equal(review.instrument, 'corrections', 'a measure-mode review is the instrument: one call, no second pass');
  assert.equal(d.prepare("SELECT COUNT(*) n FROM reviews WHERE session_id = 's4'").get().n, 1);
  const c = await waitFor(() => d.prepare("SELECT * FROM candidates WHERE session_id = 's4'").get());
  assert.equal(c.outcome, null);
  d.close();
});

test('periodic in-loop review: request, result line, cursor and skips', () => {
  const every2 = { CLAUDE_PLUGIN_OPTION_REVIEW_EVERY_TURNS: '2' };
  const sid = { session_id: 's5' };
  hook('UserPromptSubmit', sid, every2);
  assert.equal(hook('Stop', { ...sid, stop_hook_active: false }, every2), '');
  hook('UserPromptSubmit', sid, every2);
  const req = JSON.parse(hook('Stop', { ...sid, stop_hook_active: false }, every2));
  assert.equal(req.hookSpecificOutput.hookEventName, 'Stop');
  assert.match(req.hookSpecificOutput.additionalContext, /user turns 1–2/);
  assert.match(req.hookSpecificOutput.additionalContext, /\[ouroboros\] reviewed=/);

  const done = hook('Stop', { ...sid, stop_hook_active: true, last_assistant_message: '📝 learned: x\n[ouroboros] reviewed=2 corrections=1 learned=1 patched=0' }, every2);
  assert.equal(done, '');
  let d = db();
  const r = d.prepare("SELECT * FROM reviews WHERE session_id = 's5' AND mode = 'inloop'").get();
  assert.equal(r.status, 'ok');
  assert.equal(r.corrections, 1);
  assert.equal(r.learned, 1);
  assert.equal(r.trigger, 'periodic');
  const s = d.prepare("SELECT review_cursor, review_requested_at FROM sessions WHERE id = 's5'").get();
  assert.equal(s.review_cursor, 12);
  assert.equal(s.review_requested_at, null);
  d.close();

  // Next window: requested, but Claude ends without the result line.
  hook('UserPromptSubmit', sid, every2);
  hook('UserPromptSubmit', sid, every2);
  assert.notEqual(hook('Stop', { ...sid, stop_hook_active: false }, every2), '');
  hook('Stop', { ...sid, stop_hook_active: true, last_assistant_message: 'done' }, every2);
  d = db();
  assert.equal(d.prepare("SELECT status FROM reviews WHERE session_id = 's5' ORDER BY id DESC").get().status, 'skipped');
  d.close();

  // Learning off: no requests at all.
  hook('UserPromptSubmit', sid, every2);
  hook('UserPromptSubmit', sid, every2);
  assert.equal(hook('Stop', { ...sid, stop_hook_active: false }, { ...every2, CLAUDE_PLUGIN_OPTION_LEARNING: 'false' }), '');
});

test('early review: after a turn that worked through repeated failures, not after a merely long one', () => {
  const sid = { session_id: 's9' };
  const requested = (out) => (out ? JSON.parse(out).hookSpecificOutput.additionalContext : '');
  const finish = () => hook('Stop', { ...sid, stop_hook_active: true, last_assistant_message: '[ouroboros] reviewed=1 corrections=0 learned=0 patched=0' });
  const turn = ({ calls = 0, failures = 0 } = {}) => {
    hook('UserPromptSubmit', sid);
    for (let i = 0; i < calls; i++) hook('PostToolUse', { ...sid, tool_name: 'Read', tool_input: { file_path: `/f${i}` }, tool_response: {} });
    for (let i = 0; i < failures; i++) hook('PostToolUseFailure', { ...sid, tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1' });
    if (failures) hook('PostToolUse', { ...sid, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: {} });
    return requested(hook('Stop', { ...sid, stop_hook_active: false }));
  };
  // A long turn (20 tool calls) with nothing failing: no review.
  assert.equal(turn({ calls: 20 }), '');
  // One failure, then success: below the default threshold of 2.
  assert.equal(turn({ failures: 1 }), '');
  // Two failures on the same command, then success: review right away, naming the signal.
  const req = turn({ failures: 2 });
  assert.match(req, /after working through failures/);
  assert.match(req, /`Bash:npm test` failed 2× before working/);
  finish();
  // Another recovery two turns later: too soon (at most one early review every 5 turns).
  turn();
  assert.equal(turn({ failures: 3 }), '');
  turn();
  turn();
  // Five turns after the last request: allowed again.
  assert.match(turn({ failures: 2 }), /after working through failures/);
  finish();
  const d = db();
  const reviews = d.prepare("SELECT trigger FROM reviews WHERE session_id = 's9' AND mode = 'inloop'").all();
  assert.deepEqual(reviews.map((r) => r.trigger), ['recovery', 'recovery']);
  assert.ok(d.prepare("SELECT 1 FROM events WHERE session_id = 's9' AND kind = 'long_turn'").get(), 'long turns are still recorded');
  d.close();
});

test('a recovery is one turn working through an error; retrying a file edit asks for no early review', () => {
  const sid = { session_id: 's10' };
  const fail = (tool, input) => hook('PostToolUseFailure', { ...sid, tool_name: tool, tool_input: input, error: 'failed' });
  const ok = (tool, input) => hook('PostToolUse', { ...sid, tool_name: tool, tool_input: input, tool_response: {} });
  const recoveries = () => { const d = db(); const n = d.prepare("SELECT COUNT(*) n FROM events WHERE session_id = 's10' AND kind = 'recovery'").get().n; d.close(); return n; };
  // Two failures in one turn, the success in a later one: not a recovery, and the streak is gone.
  hook('UserPromptSubmit', sid);
  fail('Bash', { command: 'pnpm build' });
  fail('Bash', { command: 'pnpm build' });
  hook('UserPromptSubmit', sid);
  ok('Bash', { command: 'pnpm build' });
  assert.equal(recoveries(), 0);
  // A failure left open by an earlier turn does not add to this turn's streak.
  fail('Bash', { command: 'pnpm lint' });
  hook('UserPromptSubmit', sid);
  fail('Bash', { command: 'pnpm lint' });
  ok('Bash', { command: 'pnpm lint' });
  const d = db();
  assert.equal(JSON.parse(d.prepare("SELECT payload FROM events WHERE session_id = 's10' AND kind = 'recovery'").get().payload).failures, 1);
  d.close();
  // An edit that needed three tries is recorded, but it is mechanics: no early review.
  hook('UserPromptSubmit', sid);
  for (let i = 0; i < 3; i++) fail('Edit', { file_path: '/tmp/proj/a.ts' });
  ok('Edit', { file_path: '/tmp/proj/a.ts' });
  assert.equal(recoveries(), 2);
  assert.equal(hook('Stop', { ...sid, stop_hook_active: false }), '');
});

test('learning can be turned off; reads of learned items count as uses', () => {
  const off = spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'hook.mjs'), 'SessionStart'], {
    input: JSON.stringify({ session_id: 's2', cwd: '/tmp/proj', hook_event_name: 'SessionStart', source: 'startup' }),
    env: { ...env, CLAUDE_PLUGIN_OPTION_LEARNING: 'false' },
    encoding: 'utf8',
  });
  assert.equal(off.stdout, '');

  const file = path.join(tmp, 'claude', 'projects', 'p', 'memory', 'pnpm.md');
  const d = db();
  d.prepare("INSERT INTO learnings (id, kind, scope, name, title, path, status, created_at, updated_at) VALUES ('lrn_t', 'memory', 'project', 'pnpm', 'pnpm', ?, 'active', 0, 0)").run(file);
  d.close();
  hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: file }, tool_response: {} });
  const d2 = db();
  assert.equal(d2.prepare("SELECT uses FROM learnings WHERE id = 'lrn_t'").get().uses, 1);
  d2.close();
});

test('reviewer sessions and malformed input are ignored', () => {
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'hook.mjs'), 'UserPromptSubmit'], {
    input: JSON.stringify({ session_id: 'reviewer' }),
    env: { ...env, OUROBOROS_REVIEWER: '1' },
  });
  assert.equal(r.status, 0);
  const bad = spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'hook.mjs'), 'Stop'], { input: '{nope', env });
  assert.equal(bad.status, 0);
  const d = db();
  assert.equal(d.prepare("SELECT COUNT(*) n FROM sessions WHERE id = 'reviewer'").get().n, 0);
  d.close();
});
