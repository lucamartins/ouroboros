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
    CLAUDE_PLUGIN_OPTION_LONG_TURN_TOOL_CALLS: '3',
  };
  delete env.OUROBOROS_REVIEWER;
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function hook(event, input) {
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'hook.mjs'), event], {
    input: JSON.stringify({ session_id: 's1', cwd: '/tmp/proj', transcript_path: path.join(fixtures, 'session.jsonl'), hook_event_name: event, ...input }),
    env,
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
  assert.ok(kinds.some((k) => k.kind === 'long_turn'));
  assert.equal(d.prepare('SELECT COUNT(*) n FROM fail_streaks').get().n, 0);
  assert.equal(d.prepare('SELECT COUNT(*) n FROM errors').get().n, 0);
  d.close();
});

test('SessionEnd queues a measure review that records corrections and candidates', async () => {
  hook('SessionEnd', { reason: 'prompt_input_exit' });
  const d = db();
  const review = await waitFor(() => d.prepare('SELECT * FROM reviews WHERE session_id = ?').get('s1'));
  assert.equal(review.status, 'ok', review.detail);
  assert.equal(review.mode, 'measure');
  assert.equal(review.turns_reviewed, 2);
  assert.equal(review.corrections, 1);
  assert.equal(review.cost_usd, 0.0042);
  const s = await waitFor(() => {
    const row = d.prepare('SELECT queue_state, review_cursor FROM sessions WHERE id = ?').get('s1');
    return row.queue_state === 'done' && row;
  });
  assert.ok(s.review_cursor > 0);
  assert.equal(d.prepare('SELECT title FROM candidates').get().title, 'Use pnpm');
  d.close();
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
