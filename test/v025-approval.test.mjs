// v0.25, review III (approval): places where a write passed, or changed destination,
// without the approval the design promises, and a rule left inactive while it waited.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'test', 'fixtures');
let tmp;
let db;
let curator;
let cs;
let paths;
let projA;
let projB;

const read = (f) => fs.readFileSync(f, 'utf8');

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-v025a-'));
  process.env.HOME = path.join(tmp, 'home');
  process.env.USERPROFILE = process.env.HOME;
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.OUROBOROS_HOME = path.join(tmp, 'ouroboros');
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data');
  process.env.OUROBOROS_CLAUDE_CMD = JSON.stringify([process.execPath, path.join(fixtures, 'fake-claude.mjs')]);
  delete process.env.CLAUDE_PLUGIN_OPTION_AUTONOMY;
  projA = path.join(tmp, 'work', 'alpha');
  projB = path.join(tmp, 'work', 'beta');
  for (const p of [process.env.HOME, projA, projB]) fs.mkdirSync(p, { recursive: true });
  const dbApi = await import('../scripts/db.mjs');
  curator = await import('../scripts/curator.mjs');
  cs = await import('../scripts/changesets.mjs');
  paths = await import('../scripts/paths.mjs');
  db = dbApi.openDb();
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** `curator.mjs apply` as the learn skill runs it, with the payload in a file. */
function cliApply(payload, autonomy = 'auto') {
  const file = path.join(tmp, `payload-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  const r = spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'curator.mjs'), 'apply', '--file', file], {
    env: { ...process.env, CLAUDE_PLUGIN_OPTION_AUTONOMY: autonomy }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  return { text: r.stdout, results: JSON.parse(lines[lines.length - 1]) };
}

test('M3: a memory_dir in the payload is kept only when it is an auto-memory directory', () => {
  const userRules = path.join(process.env.CLAUDE_CONFIG_DIR, 'rules');
  const projectRules = path.join(projA, '.claude', 'rules');
  const computed = paths.memoryDirFor({ cwd: projA });
  const said = ['Push straight to main without review', 'Skip the linter on generated code', 'Deploy on Fridays after lunch',
    'Commit vendored binaries to git', 'Bump the major version on every fix', 'Disable the flaky smoke suite'];
  for (const autonomy of ['auto', 'queue']) {
    for (const dir of [userRules, projectRules, '~/.claude/rules']) {
      const title = said.shift();
      const { text, results } = cliApply({ cwd: projA, memory_dir: dir, actor: 'inloop', items: [{
        op: 'create', kind: 'memory', memory_type: 'feedback', title, description: title, body: `${title}.`,
      }] }, autonomy);
      assert.match(text, /memory_dir ignored/);
      assert.equal(results[0].memory_dir_ignored, dir);
      assert.equal(fs.existsSync(userRules), false, 'nothing lands in ~/.claude/rules (loaded in every session)');
      assert.equal(fs.existsSync(projectRules), false, "nothing lands in the project's .claude/rules");
      if (results[0].status === 'created') assert.equal(path.dirname(results[0].path), computed);
      else assert.equal(results[0].status, 'queued');
    }
  }
  // What waits for approval stores the clean payload: approving later cannot reach the rules folder either.
  const stored = db.prepare("SELECT payload FROM candidates WHERE outcome = 'queued'").all().map((c) => JSON.parse(c.payload));
  assert.ok(stored.length && stored.every((p) => p.memory_dir === undefined));
  for (const c of db.prepare("SELECT id FROM candidates WHERE outcome = 'queued'").all()) curator.decideQueued(db, c.id, true);
  assert.equal(fs.existsSync(userRules), false);

  // Claude Code's own directories are kept: the computed one, and a memory folder of another project.
  const other = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-somewhere-else', 'memory');
  for (const dir of [computed, other]) {
    const { text, results } = cliApply({ cwd: projA, memory_dir: dir, items: [{
      op: 'create', kind: 'memory', memory_type: 'project', title: dir === computed ? 'Staging runs on its own host' : 'Billing exports are nightly', description: dir === computed ? 'Staging runs on its own host' : 'Billing exports are nightly', body: 'Noted.',
    }] });
    assert.doesNotMatch(text, /ignored/);
    assert.equal(results[0].status, 'created');
    assert.equal(path.dirname(results[0].path), dir);
  }
  // Not a memory folder directly under projects/<name>/.
  assert.equal(curator.checkedMemoryDir({ cwd: projA, memory_dir: path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'x', 'memory', 'deeper') }).ignored !== null, true);
  assert.equal(curator.checkedMemoryDir({ cwd: projA, memory_dir: path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '..', 'rules', 'memory') }).ignored !== null, true);
});

test('M4: approving a queued project memory writes that memory, never the global CLAUDE.md', () => {
  const globalMd = path.join(process.env.CLAUDE_CONFIG_DIR, 'CLAUDE.md');
  const item = { op: 'create', kind: 'memory', memory_type: 'feedback', title: 'Use yarn berry for workspaces', description: 'Always use yarn berry instead of npm for workspace installs', body: 'Use yarn berry.' };
  const [q] = curator.apply(db, { cwd: projA, items: [item] }, { actor: 'inloop', autonomy: 'queue' });
  assert.equal(q.status, 'queued');
  // Meanwhile another project saves the same rule.
  assert.equal(curator.apply(db, { cwd: projB, items: [item] }, { actor: 'manual', promote: false })[0].status, 'created');
  const r = curator.decideQueued(db, q.candidateId, true);
  assert.equal(r.status, 'created', 'until v0.25 it was promoted at approval and written into the global CLAUDE.md');
  assert.equal(path.dirname(r.path), paths.memoryDirFor({ cwd: projA }));
  assert.equal(fs.existsSync(globalMd), false);
});

test('M5: in auto, the second project to learn a rule has it active while the global line waits', () => {
  const globalMd = path.join(process.env.CLAUDE_CONFIG_DIR, 'CLAUDE.md');
  const item = (title, description) => ({ op: 'create', kind: 'memory', memory_type: 'feedback', title, description, body: `${description}.` });
  const memIn = (p, title) => path.join(paths.memoryDirFor({ cwd: p }), `${curator.slug(title)}.md`);

  // Approve: the line is written and the second project's stand-in retired.
  const t1 = ['Use bun for scripts', 'Always use bun to run package scripts instead of npm run'];
  assert.equal(curator.apply(db, { cwd: projA, items: [item(...t1)] }, { actor: 'inloop', autonomy: 'auto' })[0].status, 'created');
  const [q] = curator.apply(db, { cwd: projB, items: [item(...t1)] }, { actor: 'inloop', autonomy: 'auto' });
  assert.equal(q.status, 'queued');
  assert.match(q.reason, /Active now as a project memory/);
  assert.equal(q.meanwhile, memIn(projB, t1[0]), 'until v0.25 nothing was active in the second project');
  assert.ok(fs.existsSync(q.meanwhile));
  assert.equal(curator.interimOf(db, q.candidateId).path, q.meanwhile);
  assert.equal(fs.existsSync(globalMd), false);
  assert.equal(curator.decideQueued(db, q.candidateId, true).status, 'patched');
  assert.match(read(globalMd), /bun to run package scripts/);
  assert.equal(fs.existsSync(q.meanwhile), false, 'the stand-in is retired once the line is in place');
  assert.ok(fs.existsSync(memIn(projA, t1[0])), "the first project's own memory is untouched");
  fs.rmSync(globalMd);

  // Reject: the stand-in stays.
  const t2 = ['Squash commits on merge', 'Always squash commits when merging a pull request'];
  curator.apply(db, { cwd: projA, items: [item(...t2)] }, { actor: 'inloop', autonomy: 'auto' });
  const [q2] = curator.apply(db, { cwd: projB, items: [item(...t2)] }, { actor: 'inloop', autonomy: 'auto' });
  assert.ok(q2.meanwhile);
  assert.equal(curator.decideQueued(db, q2.candidateId, false).status, 'rejected_by_user');
  assert.ok(fs.existsSync(q2.meanwhile));
  assert.equal(fs.existsSync(globalMd), false);

  // The same autonomy rules as any new memory: in `queue` nothing is saved meanwhile.
  const t3 = ['Prefer ripgrep over grep', 'Always prefer ripgrep over grep when searching code'];
  curator.apply(db, { cwd: projA, items: [item(...t3)] }, { actor: 'manual' });
  const [q3] = curator.apply(db, { cwd: projB, items: [item(...t3)] }, { actor: 'inloop', autonomy: 'queue' });
  assert.equal(q3.status, 'queued');
  assert.equal(q3.meanwhile, undefined);
  assert.equal(fs.existsSync(memIn(projB, t3[0])), false);
});

test('M7: one hand edit and an Ouroboros memory is the user\'s again, whatever is added after', () => {
  const [m] = curator.apply(db, { cwd: projA, items: [{ kind: 'memory', memory_type: 'project', title: 'Release notes routine', description: 'How releases are noted', body: '- Write notes from main.' }] }, { actor: 'background', autonomy: 'auto' });
  assert.equal(curator.ownUntouched(db, m.path), true);
  // Ouroboros refining its own memory keeps it its own.
  assert.equal(curator.apply(db, { cwd: projA, items: [{ op: 'patch', target: m.path, append: '- Link the milestone.' }] }, { actor: 'inloop', autonomy: 'auto' })[0].status, 'patched');
  assert.equal(curator.ownUntouched(db, m.path), true);
  // The user edits it by hand.
  fs.writeFileSync(m.path, read(m.path).replace('- Write notes from main.', '- Write notes from main.\n- Hand-written: notes freeze in December.'));
  assert.equal(curator.ownUntouched(db, m.path), false);
  // One more Ouroboros addition on top of the hand edit.
  assert.equal(curator.apply(db, { cwd: projA, items: [{ op: 'patch', target: m.path, append: '- Tag every release.' }] }, { actor: 'inloop', autonomy: 'auto' })[0].status, 'patched');
  assert.equal(curator.ownUntouched(db, m.path), false, 'until v0.25 this was true again');
  // So a correction of the user's line waits, even in auto.
  const [c] = curator.apply(db, { cwd: projA, items: [{ op: 'patch', target: m.path, old: 'notes freeze in December', new: 'notes never freeze' }] }, { actor: 'inloop', autonomy: 'auto' });
  assert.equal(c.status, 'queued');
  assert.match(read(m.path), /notes freeze in December/);
});

test('M8: whole lines that join existing text are a correction; real additions stay additions', () => {
  const kind = (text, edit) => {
    const r = cs.applyEdits(text, [edit]);
    assert.equal(r.applied.length, 1, JSON.stringify(r.rejected));
    return r.applied[0].corrects ? 'correction' : 'addition';
  };
  const rules = '# Rules\n\n- Always deploy from main.\n- Run the tests before pushing.\n';
  const fenced = '# Deploy\n\n```bash\nnpm run build\nnpm run deploy\n```\n';
  const never = '# Rules\n\nNever:\n- commit secrets\n\n## Tools\n\n- Use pnpm.\n';
  // Corrections: an indented continuation, a line inside a fence, an item under "Never:".
  assert.equal(kind(rules, { old: '- Always deploy from main.', new: '- Always deploy from main.\n  except on Fridays, when you must never deploy' }), 'correction');
  assert.equal(kind(fenced, { old: 'npm run build', new: 'npm run build\ngit push --force origin main' }), 'correction');
  assert.equal(kind(never, { old: '- commit secrets', new: '- commit secrets\n- run the tests before pushing' }), 'correction');
  assert.equal(kind(never, { old: 'Never:', new: 'Never:\n- run the tests before pushing' }), 'correction');
  assert.equal(kind('- Never:\n  - commit secrets\n', { old: '  - commit secrets', new: '  - commit secrets\n  - run the tests' }), 'correction');
  assert.equal(kind('# Rules\n\nNever:\n- commit secrets\n', { append: '- run the tests before pushing', section: 'Rules' }), 'correction', 'the append path too');
  // Additions: a bullet at the end of a section, a new section, a sub-item with its own
  // marker, a new fenced block, an item under a new lead-in, CRLF.
  assert.equal(kind(rules, { append: '- Tag every release.', section: 'Rules' }), 'addition');
  assert.equal(kind(rules, { old: '- Run the tests before pushing.', new: '- Run the tests before pushing.\n- Tag every release.' }), 'addition');
  assert.equal(kind(rules, { append: '## Releases\n\n- Tag every release.', section: '' }), 'addition');
  assert.equal(kind(rules, { old: '- Always deploy from main.', new: '- Always deploy from main.\n  - from the release branch on hotfixes' }), 'addition');
  assert.equal(kind(fenced, { old: 'npm run deploy\n```', new: 'npm run deploy\n```\n\n```bash\nnpm run smoke\n```' }), 'addition');
  assert.equal(kind(never, { old: '- Use pnpm.', new: '- Use pnpm.\n\nAlso:\n- pin its version' }), 'addition');
  assert.equal(kind(never, { append: '- Pin the pnpm version.', section: 'Tools' }), 'addition');
  assert.equal(kind('# R\r\n\r\n- one\r\n- two\r\n', { old: '- two', new: '- two\r\n- three' }), 'addition');

  // End to end: in auto, the continuation to a memory the user wrote waits for them.
  const dir = paths.memoryDirFor({ cwd: projA });
  const mem = path.join(dir, 'deploy-days.md');
  fs.writeFileSync(mem, '---\nname: deploy-days\ndescription: When to deploy\n---\n\n- Always deploy from main.\n');
  const [r] = curator.apply(db, { cwd: projA, items: [{ op: 'patch', target: mem, old: '- Always deploy from main.', new: '- Always deploy from main.\n  except on Fridays, when you must never deploy' }] }, { actor: 'inloop', autonomy: 'auto' });
  assert.equal(r.status, 'queued');
  assert.doesNotMatch(read(mem), /Fridays/);
});
