// v0.24: a control group for the correction rate, and two places where a file a person
// owns was written without asking (the global CLAUDE.md created by a mere proposal, a
// line added to a skill the user wrote).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'test', 'fixtures');
let tmp;
let db;
let dbApi;
let curator;
let cs;
let proj;
let hookEnv;

const read = (f) => fs.readFileSync(f, 'utf8');

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-v024-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.OUROBOROS_HOME = path.join(tmp, 'ouroboros');
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data');
  process.env.OUROBOROS_CLAUDE_CMD = JSON.stringify([process.execPath, path.join(fixtures, 'fake-claude.mjs')]);
  proj = path.join(tmp, 'work', 'app');
  fs.mkdirSync(proj, { recursive: true });
  spawnSync('git', ['-C', proj, 'init', '-q']);
  // One project of the user's is the control group.
  fs.mkdirSync(process.env.OUROBOROS_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.OUROBOROS_HOME, 'config.json'), JSON.stringify({ controlProjects: ['**/ctl-*'] }));
  dbApi = await import('../scripts/db.mjs');
  curator = await import('../scripts/curator.mjs');
  cs = await import('../scripts/changesets.mjs');
  db = dbApi.openDb();
  hookEnv = { ...process.env, CLAUDE_PLUGIN_DATA: path.join(tmp, 'data-hooks') };
  delete hookEnv.OUROBOROS_REVIEWER;
});

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

after(async () => {
  await settle(path.join(tmp, 'data-hooks', 'events.db'));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function hook(event, input, extraEnv = {}) {
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'hook.mjs'), event], {
    input: JSON.stringify({ transcript_path: path.join(fixtures, 'session.jsonl'), hook_event_name: event, ...input }),
    env: { ...hookEnv, ...extraEnv },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
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

test('a control project is measured with the same instrument and taught nothing', async () => {
  const every2 = { CLAUDE_PLUGIN_OPTION_REVIEW_EVERY_TURNS: '2' };
  const control = { session_id: 'ctl-session-1', cwd: path.join(tmp, 'work', 'ctl-billing') };
  const learning = { session_id: 'lrn-session-1', cwd: path.join(tmp, 'work', 'shop') };

  // The control session: no protocol at the start, no review asked in session.
  assert.equal(hook('SessionStart', { ...control, source: 'startup' }, every2), '');
  hook('UserPromptSubmit', control, every2);
  hook('UserPromptSubmit', control, every2);
  assert.equal(hook('Stop', { ...control, stop_hook_active: false }, every2), '');
  hook('SessionEnd', { ...control, reason: 'other' }, every2);
  // The same two turns in a project that learns.
  assert.match(JSON.parse(hook('SessionStart', { ...learning, source: 'startup' }, every2)).hookSpecificOutput.additionalContext, /ouroboros:learn/);
  hook('UserPromptSubmit', learning, every2);
  hook('UserPromptSubmit', learning, every2);
  assert.match(hook('Stop', { ...learning, stop_hook_active: false }, every2), /Ouroboros learning review/);
  hook('SessionEnd', { ...learning, reason: 'other' }, every2);

  const d = dbApi.openDb(path.join(tmp, 'data-hooks'));
  try {
    await waitFor(() => d.prepare("SELECT COUNT(*) n FROM sessions WHERE queue_state = 'done'").get().n === 2);
    assert.equal(d.prepare("SELECT control FROM sessions WHERE id = 'ctl-session-1'").get().control, 1);
    // Measured: the instrument's call, and what it would have learned; nothing written.
    const modes = (sid) => d.prepare('SELECT mode FROM reviews WHERE session_id = ? AND status = ? ORDER BY id').all(sid, 'ok').map((r) => r.mode);
    assert.deepEqual(modes('ctl-session-1'), ['corrections', 'measure']);
    assert.ok(modes('lrn-session-1').includes('background'));
    assert.equal(d.prepare("SELECT COUNT(*) n FROM writes WHERE session_id = 'ctl-session-1'").get().n, 0);
    assert.equal(d.prepare("SELECT COUNT(*) n FROM candidates WHERE session_id = 'ctl-session-1' AND outcome IS NOT NULL").get().n, 0);

    // The dashboard sets the two arms side by side, and keeps the control out of "before/after".
    const { createApi } = await import('../dashboard/api.mjs');
    const v = createApi(d)('value');
    assert.deepEqual([v.concurrent.control.turns, v.concurrent.control.corrections, v.concurrent.control.sessions], [2, 1, 1]);
    assert.equal(v.concurrent.learning.turns, 2);
    assert.equal(v.before.turns + v.after.turns, 2, 'only the learning project is in the before/after figures');
    assert.equal(v.series.reduce((n, day) => n + day.reviewedTurns, 0), 2);
  } finally {
    d.close();
  }
});

test('a proposal does not create the global CLAUDE.md: approving it does, and undo removes it', () => {
  const globalMd = path.join(process.env.CLAUDE_CONFIG_DIR, 'CLAUDE.md');
  assert.equal(fs.existsSync(globalMd), false);
  const [q] = curator.apply(db, { cwd: proj, items: [{ kind: 'global', text: 'Prefers answers in Portuguese', confidence: 0.8 }] }, { actor: 'inloop', autonomy: 'auto' });
  assert.equal(q.status, 'queued');
  assert.equal(fs.existsSync(globalMd), false, 'until v0.23 the file was written here, outside the ledger');
  // The same fact proposed again is recognized against the change that waits, still with no file.
  assert.equal(curator.apply(db, { cwd: proj, items: [{ kind: 'global', text: 'Prefers answers in Portuguese', confidence: 0.8 }] }, { actor: 'inloop', autonomy: 'auto' })[0].replaced, true);
  assert.equal(fs.existsSync(globalMd), false);

  const r = cs.applyChangeset(db, q.changesetId);
  assert.equal(r.status, 'patched', r.reason);
  assert.equal(read(globalMd), '# Global instructions\n\n- Prefers answers in Portuguese\n');
  // The ledger knows there was no file: undoing the change takes the file away again.
  assert.equal(db.prepare('SELECT before FROM writes WHERE batch = ?').get(r.batch).before, null);
  assert.equal(curator.undo(db, { batch: r.batch }).status, 'undone');
  assert.equal(fs.existsSync(globalMd), false);

  // An empty file is the same case: the change is composed on the title, and undo gives the empty file back.
  fs.writeFileSync(globalMd, '');
  const [q2] = curator.apply(db, { cwd: proj, items: [{ kind: 'global', text: 'Works on Windows with Git Bash', confidence: 0.8 }] }, { actor: 'inloop', autonomy: 'auto' });
  assert.equal(read(globalMd), '');
  const r2 = cs.applyChangeset(db, q2.changesetId);
  assert.equal(read(globalMd), '# Global instructions\n\n- Works on Windows with Git Bash\n');
  assert.equal(curator.undo(db, { batch: r2.batch }).status, 'undone');
  assert.equal(read(globalMd), '');
  fs.rmSync(globalMd);
});

test('a line for a skill the user wrote waits, however the skill is named; one Ouroboros created takes it', () => {
  const skill = path.join(process.env.CLAUDE_CONFIG_DIR, 'skills', 'release', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  const body = '---\nname: release\ndescription: Cut a release. Use when shipping.\n---\n\n# Release\n\n## Steps\n\n1. Update the changelog.\n';
  fs.writeFileSync(skill, body);
  const add = (target, actor = 'inloop') => curator.apply(db, { cwd: proj, session_id: 'sess-skill-1', items: [{ op: 'patch', kind: 'skill', target, section: 'Steps', append: '2. Tag the commit before publishing.', title: 'Tag before publishing', why: 'The user said so after a release without a tag.' }] }, { actor, autonomy: 'auto' })[0];

  // By path, by name, and when Claude says the user asked: the file is theirs.
  const byPath = add(skill);
  assert.equal(byPath.status, 'queued');
  assert.match(byPath.reason, /changes to a file you wrote .* are always confirmed/);
  assert.equal(add('release').status, 'queued');
  assert.equal(add(skill, 'requested').status, 'queued');
  assert.equal(read(skill), body);
  // Known meanwhile: a project memory stands in for the line until the user decides.
  assert.match(byPath.reason, /Active now as a project memory/);
  assert.match(read(byPath.meanwhile), /Tag the commit before publishing[\s\S]*proposed as a line for release/);

  // The user approves: the line is written and the stand-in retired.
  const pending = cs.pendingChangeset(db, skill);
  assert.equal(cs.applyChangeset(db, pending.id).status, 'patched');
  assert.match(read(skill), /1\. Update the changelog\.\n2\. Tag the commit before publishing\./);
  assert.equal(fs.existsSync(byPath.meanwhile), false);

  // A skill Ouroboros created is its own: an addition needs no approval in `auto`.
  const [own] = curator.apply(db, { cwd: proj, items: [{ kind: 'skill', scope: 'global', title: 'Rotate the API keys', description: 'Rotate the API keys. Use every quarter.', body: '## Steps\n\n1. Create the new key.', confidence: 0.7 }] }, { actor: 'inloop', autonomy: 'auto' });
  const [more] = curator.apply(db, { cwd: proj, items: [{ op: 'patch', kind: 'skill', target: own.path, section: 'Steps', append: '2. Revoke the old key.' }] }, { actor: 'background', autonomy: 'auto' });
  assert.equal(more.status, 'patched', more.reason);
});
