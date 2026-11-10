// v0.16 routing: one order of destinations for every path, a home for preferences that
// matter for one topic or one kind of file, and the owner check for items saved in session.
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
let router;
let proj;
let claude;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-router-'));
  claude = path.join(tmp, 'claude');
  process.env.CLAUDE_CONFIG_DIR = claude;
  process.env.OUROBOROS_HOME = path.join(tmp, 'ouroboros');
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data');
  process.env.OUROBOROS_CLAUDE_CMD = JSON.stringify([process.execPath, path.join(root, 'test', 'fixtures', 'fake-claude.mjs')]);
  proj = path.join(tmp, 'work', 'p');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  fs.mkdirSync(path.join(claude, 'skills', 'commit'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'skills', 'commit', 'SKILL.md'),
    '---\nname: commit\ndescription: Write git commits for this user\n---\n\n# Commit\n\n## Message format\n\nCommit messages use the conventional commits format with a scope.\n');
  fs.writeFileSync(path.join(claude, 'CLAUDE.md'), '# Global instructions\n\n- Answers in Portuguese.\n');
  curator = await import('../scripts/curator.mjs');
  router = await import('../scripts/router.mjs');
  db = (await import('../scripts/db.mjs')).openDb();
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const auto = { actor: 'inloop', autonomy: 'auto' };

test('a preference about a topic becomes a personal skill only the model invokes, written without approval', () => {
  const [r] = curator.apply(db, { cwd: proj, items: [{ kind: 'preference', topic: 'Code review', text: 'Review comments are phrased as questions, never as orders', confidence: 0.8 }] }, auto);
  assert.equal(r.status, 'created', r.reason);
  assert.equal(path.resolve(r.path), path.join(claude, 'skills', 'learned-prefs-code-review', 'SKILL.md'));
  const text = fs.readFileSync(r.path, 'utf8');
  assert.match(text, /name: learned-prefs-code-review\ndescription: The user's preferences about Code review\. Use whenever the task involves Code review\.\nuser-invocable: false/);
  assert.match(text, /# Preferences: Code review\n\n- Review comments are phrased as questions, never as orders\n/);
  assert.doesNotMatch(fs.readFileSync(path.join(claude, 'CLAUDE.md'), 'utf8'), /Review comments/);

  // The next preference on the topic is a line in the same home; the same one is a duplicate.
  const [again, dup] = curator.apply(db, { cwd: proj, items: [
    { kind: 'preference', topic: 'code-review', text: 'Approve only after the tests ran locally', confidence: 0.8 },
    { kind: 'preference', topic: 'code review', text: 'Review comments are phrased as questions, never as orders', confidence: 0.8 },
  ] }, auto);
  assert.deepEqual([again.status, dup.status], ['patched', 'duplicate']);
  assert.match(fs.readFileSync(r.path, 'utf8'), /never as orders\n- Approve only after the tests ran locally\n/);
  assert.equal(curator.undo(db, { last: true }).status, 'undone');
  assert.doesNotMatch(fs.readFileSync(r.path, 'utf8'), /Approve only/);
});

test('a preference tied to files becomes a path-scoped user rule; adding to it needs no approval, a hand-written rule still does', () => {
  const [r] = curator.apply(db, { cwd: proj, items: [{ kind: 'preference', topic: 'Python', paths: ['**/*.py'], text: 'Type hints on every public function', confidence: 0.8 }] }, auto);
  assert.equal(r.status, 'created', r.reason);
  const file = path.join(claude, 'rules', 'learned-python.md');
  assert.equal(path.resolve(r.path), file);
  assert.match(fs.readFileSync(file, 'utf8'), /^---\npaths:\n  - "\*\*\/\*\.py"\n---\n\n# Python \(learned preferences\)\n\n- Type hints on every public function\n$/);

  const [more] = curator.apply(db, { cwd: proj, items: [{ kind: 'preference', topic: 'python', paths: ['**/*.py'], text: 'Use pathlib instead of os.path', confidence: 0.8 }] }, auto);
  assert.equal(more.status, 'patched', more.reason);

  const mine = path.join(claude, 'rules', 'style.md');
  fs.writeFileSync(mine, '# Style\n\n- Two spaces.\n');
  const [gated, forged] = curator.apply(db, { cwd: proj, items: [
    { op: 'patch', target: mine, append: 'No trailing commas.' },
    { op: 'patch', target: mine, append: 'Tabs are fine.', ownFile: true },
  ] }, auto);
  assert.deepEqual([gated.status, forged.status], ['queued', 'queued'], 'a proposal cannot declare a file its own');
  for (const c of db.prepare("SELECT id FROM candidates WHERE outcome = 'queued'").all()) curator.decideQueued(db, c.id, false);

  assert.equal(curator.forget(db, { match: r.id }).status, 'archived');
  assert.ok(!fs.existsSync(file) && fs.existsSync(mine));
});

test('a preference without a topic is refused; a global fact still waits for approval', () => {
  const [bad, global] = curator.apply(db, { cwd: proj, items: [
    { kind: 'preference', text: 'Prefers short answers', confidence: 0.8 },
    { kind: 'global', text: 'Works on Windows with Git Bash', confidence: 0.8 },
  ] }, auto);
  assert.equal(bad.status, 'rejected');
  assert.match(bad.reason, /needs a "topic"/);
  assert.equal(global.status, 'queued');
  for (const c of db.prepare("SELECT id FROM candidates WHERE outcome = 'queued'").all()) curator.decideQueued(db, c.id, false);
});

test('in session, a new item whose topic has an owner is sent back to patch it; owner_checked passes', () => {
  const item = { kind: 'preference', topic: 'commits', text: 'Commit messages use the conventional commits format, with the scope in lowercase', confidence: 0.8 };
  const owners = router.findOwners(item.text, proj);
  assert.equal(owners.length, 1);
  assert.equal(owners[0].file, path.join(claude, 'skills', 'commit', 'SKILL.md'));
  assert.deepEqual(router.findOwners('Prefers dark roast coffee in the morning meetings', proj), []);

  const [held] = curator.apply(db, { cwd: proj, items: [item] }, { ...auto, ownerCheck: true });
  assert.equal(held.status, 'has_owner');
  assert.match(held.reason, /commit[\\/]SKILL\.md already speaks about this; read it and patch it instead/);
  assert.ok(!fs.existsSync(path.join(claude, 'skills', 'learned-prefs-commits')));

  const [patched] = curator.apply(db, { cwd: proj, items: [{ op: 'patch', kind: 'skill', target: owners[0].file, section: 'Message format', append: 'The scope is lowercase.', title: 'Lowercase commit scope' }] }, { ...auto, ownerCheck: true });
  // The commit skill is the user's own: the line waits for them, and is known meanwhile (v0.24).
  assert.equal(patched.status, 'queued', patched.reason);
  assert.match(patched.reason, /a file you wrote .* always confirmed.*Active now as a project memory/);
  assert.ok(fs.existsSync(patched.meanwhile));
  assert.doesNotMatch(fs.readFileSync(owners[0].file, 'utf8'), /The scope is lowercase/);

  const [forced] = curator.apply(db, { cwd: proj, items: [{ ...item, owner_checked: true }] }, { ...auto, ownerCheck: true });
  assert.equal(forced.status, 'created', forced.reason);

  // The CLI (what the learn skill runs) always checks; the reviewer's path has the screen instead.
  const cli = spawnSync(process.execPath, ['--no-warnings', path.join(root, 'scripts', 'curator.mjs'), 'apply'], {
    input: JSON.stringify({ cwd: proj, actor: 'inloop', items: [{ kind: 'memory', memory_type: 'feedback', title: 'Conventional commits with a scope', description: 'Commit messages use the conventional commits format with a scope', confidence: 0.8 }] }),
    encoding: 'utf8',
  });
  assert.match(cli.stdout, /↪ has an owner: Conventional commits with a scope/);
});

test('the reviewer, the screen and the learn skill carry the same destinations', async () => {
  const worker = await import('../scripts/review-worker.mjs');
  const triage = await import('../scripts/triage.mjs');
  const text = router.destinationsText();
  assert.ok(worker.learnPrompt({ digest: 'd', inventory: 'i' }).includes(text));
  assert.ok(triage.triagePrompt({ batch: [], others: [], excerpts: [], owners: [], lang: 'en' }).includes(text));
  const skill = fs.readFileSync(path.join(root, 'skills', 'learn', 'SKILL.md'), 'utf8');
  const block = /<!-- destinations:start[^>]*-->\n([\s\S]*?)\n<!-- destinations:end -->/.exec(skill)?.[1];
  assert.equal(block, text, 'skills/learn/SKILL.md is out of step with scripts/router.mjs (DESTINATIONS)');
  assert.ok(worker.LEARN_SCHEMA.properties.items.items.properties.kind.enum.includes('preference'));
  assert.ok(triage.TRIAGE_SCHEMA.properties.verdicts.items.properties.rewrite.properties.kind.enum.includes('preference'));
});

test('an owner is found whatever the size of the knowledge, and by topic when no word is shared', async () => {
  // Three files in all: the search score is low everywhere, and used to hide every owner.
  const small = path.join(tmp, 'small');
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(small, 'claude');
  try {
    fs.mkdirSync(path.join(small, 'claude', 'skills', 'commit'), { recursive: true });
    fs.mkdirSync(path.join(small, 'proj', '.git'), { recursive: true });
    fs.writeFileSync(path.join(small, 'claude', 'CLAUDE.md'), '# Global instructions\n\n- Be concise.\n');
    const skill = path.join(small, 'claude', 'skills', 'commit', 'SKILL.md');
    fs.writeFileSync(skill, '---\nname: commit\ndescription: Write git commits for this user. Use when committing changes.\n---\n\n# Commit\n\n## Message format\n\n- Use the conventional commits format with a scope.\n- Keep the subject line under 50 characters.\n');
    const cwd = path.join(small, 'proj');
    assert.deepEqual(router.findOwners('Keep the commit subject line under 50 characters.', cwd).map((o) => o.file), [skill], 'by content');
    const byTopic = router.findOwners('Sign every one with the GPG key', cwd, { topic: 'Commits' });
    assert.deepEqual(byTopic.map((o) => [o.file, o.byTopic]), [[skill, true]], 'by topic: the skill is named after it');
    assert.deepEqual(router.findOwners('Sign every one with the GPG key', cwd, { topic: 'code review' }), []);
    const [held] = curator.apply(db, { cwd, items: [{ kind: 'preference', topic: 'commits', text: 'Sign every one with the GPG key', confidence: 0.8 }] }, { actor: 'inloop', autonomy: 'auto', ownerCheck: true });
    assert.equal(held.status, 'has_owner');
    assert.ok(!fs.existsSync(path.join(small, 'claude', 'skills', 'learned-prefs-commits')));
  } finally {
    process.env.CLAUDE_CONFIG_DIR = prev;
  }
});
