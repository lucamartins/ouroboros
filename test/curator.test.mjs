import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

let tmp;
let db;
let curator;
let cwd;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-curator-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.OUROBOROS_HOME = path.join(tmp, 'ouroboros');
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data');
  cwd = path.join(tmp, 'work', 'app');
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  curator = await import('../scripts/curator.mjs');
  const { openDb } = await import('../scripts/db.mjs');
  db = openDb();
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  fs.mkdirSync(process.env.OUROBOROS_HOME, { recursive: true });
  fs.writeFileSync(path.join(process.env.OUROBOROS_HOME, 'config.json'), JSON.stringify({
    routing: [{ match: '**/routed-*', skillsDir: path.join(tmp, 'skills-repo'), linkInto: path.join(tmp, 'claude', 'skills') }],
    limits: {},
  }));
});

const apply = (items, extra = {}) => curator.apply(db, { cwd, items, ...extra });
const memoryDir = () => path.join(tmp, 'claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
const read = (f) => fs.readFileSync(f, 'utf8');

test('a global fact is an addition to the global CLAUDE.md, deduplicated against what it says', async () => {
  const file = path.join(tmp, 'claude', 'CLAUDE.md');
  fs.rmSync(file, { force: true });
  const [r] = apply([{ kind: 'global', text: 'Prefers concise answers in Portuguese' }]);
  assert.equal(r.status, 'patched', r.reason);
  assert.equal(r.path, file);
  assert.equal(read(file), '# Global instructions\n\n- Prefers concise answers in Portuguese\n');
  const [dup] = apply([{ kind: 'global', text: 'prefers concise answers in portuguese!' }]);
  assert.equal(dup.status, 'duplicate');
  // The old kind name still works, and "section" places the fact under its heading.
  fs.writeFileSync(file, '# Me\n\n## Language\n\n- Portuguese in chat\n\n## Git\n\n- Small commits\n');
  const [s] = apply([{ kind: 'profile', block: 'user', section: 'Language', text: 'Files on disk are in English' }]);
  assert.equal(s.status, 'patched', s.reason);
  assert.match(read(file), /## Language\n\n- Portuguese in chat\n- Files on disk are in English\n\n## Git/);
  // Claude Code loads the file itself: the session context no longer repeats it.
  const { sessionContext } = await import('../scripts/hook.mjs');
  assert.doesNotMatch(sessionContext(), /Files on disk are in English/);
});

test('a global memory becomes a global fact; proposed by Claude or the reviewer it waits for approval', () => {
  const file = path.join(tmp, 'claude', 'CLAUDE.md');
  fs.writeFileSync(file, '# Me\n');
  const [r] = apply([{ kind: 'memory', scope: 'global', memory_type: 'reference', title: 'gh is authenticated as octocat' }]);
  assert.equal(r.status, 'patched', r.reason);
  assert.equal(r.kind, 'instructions');
  assert.match(read(file), /- gh is authenticated as octocat/);
  const [q] = curator.apply(db, { cwd, items: [{ kind: 'global', text: 'Uses Windows with Git Bash for hooks', confidence: 0.9 }] }, { actor: 'background', autonomy: 'auto' });
  assert.equal(q.status, 'queued', q.reason);
  assert.ok(q.changesetId);
  assert.doesNotMatch(read(file), /Git Bash/);
});

test('project memories go to the native memory dir with an index line', () => {
  const [r] = apply([{ kind: 'memory', memory_type: 'feedback', title: 'Use pnpm, not npm', description: 'This repo uses pnpm workspaces', body: 'Use pnpm.\n\n**Why:** lockfile.' }]);
  assert.equal(r.status, 'created', r.reason);
  assert.equal(r.path, path.join(memoryDir(), 'use-pnpm-not-npm.md'));
  const file = read(r.path);
  assert.match(file, /^---\nname: use-pnpm-not-npm\ndescription: This repo uses pnpm workspaces\nmetadata:\n {2}type: feedback\n {2}origin: ouroboros/);
  assert.match(read(path.join(memoryDir(), 'MEMORY.md')), /^- \[Use pnpm, not npm\]\(use-pnpm-not-npm\.md\) — This repo uses pnpm workspaces\n$/);
  const [dup] = apply([{ kind: 'memory', title: 'Use pnpm not npm', description: 'this repo uses pnpm workspaces' }]);
  assert.equal(dup.status, 'duplicate');
});

test('secrets are rejected', () => {
  const [r] = apply([{ kind: 'memory', title: 'Stripe key', body: 'key is sk_live_abcdefghijklmnop' }]);
  assert.equal(r.status, 'rejected');
  assert.match(r.reason, /secret/);
});

test('skills: global ones get the learned- prefix; project ones follow routing and links', () => {
  const [g] = apply([{ kind: 'skill', scope: 'global', name: 'zip deploy', title: 'Zip deploy', description: 'Build a Linux zip on Windows. Use when packaging a deploy.', body: '## Steps\n1. python' }]);
  assert.equal(g.status, 'created', g.reason);
  assert.equal(g.path, path.join(tmp, 'claude', 'skills', 'learned-zip-deploy', 'SKILL.md'));

  const routedCwd = path.join(tmp, 'work', 'routed-api');
  fs.mkdirSync(routedCwd, { recursive: true });
  const [p] = apply([{ kind: 'skill', scope: 'project', project_dir: routedCwd, name: 'seed-db', title: 'Seed the database', description: 'Seed the local database. Use before E2E runs.', body: 'Run the seeder.' }]);
  assert.equal(p.status, 'created', p.reason);
  assert.equal(p.path, path.join(tmp, 'skills-repo', 'seed-db', 'SKILL.md'));
  const link = path.join(tmp, 'claude', 'skills', 'seed-db');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(link, 'SKILL.md')));

  const [tooLong] = apply([{ kind: 'skill', scope: 'global', title: 'X', description: 'd'.repeat(300), body: 'b' }]);
  assert.equal(tooLong.status, 'rejected');
});

test('patch, undo, conflict, forget and undo of forget', () => {
  const file = path.join(memoryDir(), 'use-pnpm-not-npm.md');
  const [p] = apply([{ op: 'patch', kind: 'memory', target: 'use-pnpm-not-npm', old: 'Use pnpm.', new: 'Use pnpm 9.', description: 'This repo uses pnpm 9 workspaces' }]);
  assert.equal(p.status, 'patched', p.reason);
  assert.match(read(file), /Use pnpm 9\./);
  assert.match(read(path.join(memoryDir(), 'MEMORY.md')), /— This repo uses pnpm 9 workspaces/);

  const u = curator.undo(db, { last: true });
  assert.equal(u.status, 'undone');
  assert.match(read(file), /Use pnpm\.\n/);
  assert.match(read(path.join(memoryDir(), 'MEMORY.md')), /— This repo uses pnpm workspaces/);

  // Undo the skill link created earlier? No: the last remaining write is the routed skill.
  const [p2] = apply([{ op: 'patch', kind: 'memory', target: 'use-pnpm-not-npm', old: 'Use pnpm.', new: 'Use pnpm!' }]);
  assert.equal(p2.status, 'patched');
  // A later, unrelated edit survives the undo: only the patched line goes back.
  fs.appendFileSync(file, 'hand edit\n');
  const u2 = curator.undo(db, { last: true });
  assert.equal(u2.status, 'undone', u2.reason);
  assert.match(read(file), /Use pnpm\.\n/);
  assert.match(read(file), /hand edit\n/);
  // When the patched line itself was edited since, undo refuses.
  const [p3] = apply([{ op: 'patch', kind: 'memory', target: 'use-pnpm-not-npm', old: 'Use pnpm.', new: 'Use pnpm!' }]);
  assert.equal(p3.status, 'patched');
  fs.writeFileSync(file, read(file).replace('Use pnpm!', 'Use pnpm?'));
  assert.equal(curator.undo(db, { last: true }).status, 'conflict');
  fs.writeFileSync(file, read(file).replace('Use pnpm?', 'Use pnpm.'));

  const f = curator.forget(db, { match: 'use-pnpm-not-npm' });
  assert.equal(f.status, 'archived', f.reason);
  assert.equal(fs.existsSync(file), false);
  assert.doesNotMatch(read(path.join(memoryDir(), 'MEMORY.md')), /use-pnpm-not-npm/);
  assert.equal(fs.readdirSync(path.join(process.env.OUROBOROS_HOME, 'archive')).length, 1);

  const back = curator.undo(db, { last: true });
  assert.equal(back.status, 'undone');
  assert.ok(fs.existsSync(file));
  assert.equal(db.prepare('SELECT status FROM learnings WHERE path = ?').get(file).status, 'active');
});

test('undo of a created skill removes the file, its folder and its link', () => {
  const link = path.join(tmp, 'claude', 'skills', 'seed-db');
  const id = db.prepare("SELECT id FROM learnings WHERE name = 'seed-db'").get().id;
  const r = curator.undo(db, { id });
  assert.equal(r.status, 'undone', r.reason);
  assert.equal(fs.existsSync(path.join(tmp, 'skills-repo', 'seed-db')), false);
  assert.throws(() => fs.lstatSync(link));
  assert.equal(db.prepare('SELECT status FROM learnings WHERE id = ?').get(id).status, 'reverted');
});

test('patching a native skill is allowed and does not count as a learned skill', () => {
  const dir = path.join(tmp, 'claude', 'skills', 'native-one');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: native-one\ndescription: Native.\n---\n\nStep A\n');
  const [r] = apply([{ op: 'patch', kind: 'skill', target: 'native-one', old: 'Step A', new: 'Step A, then B' }]);
  assert.equal(r.status, 'patched', r.reason);
  assert.match(read(path.join(dir, 'SKILL.md')), /Step A, then B/);
  const inv = curator.inventoryText(db, { cwd });
  assert.match(inv, /learned\)/);
  assert.match(inv, /native-one/);
});

test('patching the description of a skill with a multi-line description replaces the whole value', () => {
  const dir = path.join(tmp, 'claude', 'skills', 'folded-one');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, '---\nname: folded-one\ndescription: >\n  Old text that\n  spans lines.\nallowed-tools: Read\n---\n\nStep A\n');
  const [r] = apply([{ op: 'patch', kind: 'skill', target: 'folded-one', description: 'New text. Use when testing.' }]);
  assert.equal(r.status, 'patched', r.reason);
  assert.equal(read(file), '---\nname: folded-one\ndescription: New text. Use when testing.\nallowed-tools: Read\n---\n\nStep A\n');
});

test('patch targets outside memories, skills, rules and CLAUDE.md files are refused', () => {
  const [r] = apply([{ op: 'patch', target: path.join(cwd, 'package.json'), old: 'a', new: 'b' }]);
  assert.equal(r.status, 'rejected');
});
