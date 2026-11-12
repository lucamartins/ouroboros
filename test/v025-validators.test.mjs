// v0.25, review III (validators): cases that still passed as additions, approvals and
// undo that lost a rule, and writes that could not be undone or overwrote an archive.
import assert from 'node:assert/strict';
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-v025v-'));
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

const kind = (text, edit) => {
  const r = cs.applyEdits(text, [edit]);
  assert.equal(r.applied.length, 1, JSON.stringify(r.rejected));
  return r.applied[0].corrects ? 'correction' : 'addition';
};
const mem = (cwd, title, body = 'x', extra = {}) => curator.apply(db, { cwd, items: [{ kind: 'memory', memory_type: 'project', title, description: title, body, ...extra }] }, { actor: 'manual' })[0];

test('M8: a bold lead-in and an unindented line glued under a rule are corrections', () => {
  const never = '# Rules\n\n**Never:**\n- commit secrets\n';
  assert.equal(kind(never, { old: '- commit secrets', new: '- commit secrets\n- run the tests before pushing' }), 'correction');
  assert.equal(kind(never, { append: '- run the tests before pushing', section: 'Rules' }), 'correction');
  assert.equal(kind('# R\n\n_Never:_\n- alpha\n', { old: '- alpha', new: '- alpha\n- beta' }), 'correction');
  // The append path trims the text, so the continuation arrives unindented.
  const rules = '# Rules\n\n- Always deploy from main.\n- Run the tests before pushing.\n';
  assert.equal(kind(rules, { old: '- Always deploy from main.', new: '- Always deploy from main.\n  except on Fridays, never deploy' }), 'correction');
  // The append path trims the text, so it would land glued under the item: it starts a paragraph instead.
  const glued = cs.applyEdits(rules, [{ append: '  except on Fridays, never deploy', section: 'Rules' }]).after;
  assert.equal(glued, '# Rules\n\n- Always deploy from main.\n- Run the tests before pushing.\n\nexcept on Fridays, never deploy\n');
  assert.equal(curator.appendToSection('# R\n\n- one\n  more of one\n', 'R', 'plain'), '# R\n\n- one\n  more of one\n\nplain\n');
  // A stated limit: under a paragraph line it reads as a new line in a plain-text file.
  assert.equal(kind('# R\n\nShip on Tuesdays.\n', { append: 'Actually never ship.', section: 'R' }), 'addition');
  // Still additions: a bullet, a new section, a paragraph after a blank line, an item under an ordinary list.
  assert.equal(kind(rules, { append: '- Tag every release.', section: 'Rules' }), 'addition');
  assert.equal(kind(rules, { append: '## Releases\n\n- Tag every release.', section: '' }), 'addition');
  assert.equal(kind(rules, { old: '- Run the tests before pushing.', new: '- Run the tests before pushing.\n\nTag every release.' }), 'addition');
  assert.equal(kind('# R\n\n## A\n\ntext\n\n## B\n\n- b\n', { append: '- more', section: 'B' }), 'addition');
});

test('M3: a memory_dir is kept only when it is the directory computed for the item\'s own project', () => {
  const computed = paths.memoryDirFor({ cwd: projA });
  const other = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-somewhere-else', 'memory');
  const ofB = paths.memoryDirFor({ cwd: projB });
  assert.equal(curator.checkedMemoryDir({ cwd: projA, memory_dir: computed }).ignored, null);
  for (const dir of [other, ofB]) {
    const r = curator.checkedMemoryDir({ cwd: projA, memory_dir: dir });
    assert.equal(r.ignored, dir, 'a card of one project cannot be written into another project\'s memory folder');
    assert.equal(r.memoryDir, undefined);
  }
});

test('enqueue: a candidate decided meanwhile is not queued again', () => {
  const item = { op: 'create', kind: 'memory', memory_type: 'feedback', title: 'Pin the node version', description: 'Pin the node version in CI', body: 'Pin it.' };
  const id = Number(db.prepare(`INSERT INTO candidates (review_id, session_id, project, kind, scope, title, summary, confidence, outcome, payload, cwd, ts)
    VALUES (0, 's1', 'p', 'memory', 'project', ?, ?, 0.8, 'rejected_by_user', '{}', ?, ?)`).run(item.title, item.description, projA, Date.now()).lastInsertRowid);
  const [r] = curator.apply(db, { cwd: projA, items: [{ ...item, candidateId: id }] }, { actor: 'background', autonomy: 'queue' });
  assert.notEqual(r.status, 'queued');
  assert.match(r.reason, /decided/);
  assert.equal(db.prepare('SELECT outcome FROM candidates WHERE id = ?').get(id).outcome, 'rejected_by_user', 'until v0.25 the rejection was overwritten with queued');
  // A pending row is still queued.
  const pid = Number(db.prepare(`INSERT INTO candidates (review_id, session_id, project, kind, scope, title, summary, confidence, outcome, payload, cwd, ts)
    VALUES (0, 's1', 'p', 'memory', 'project', 'Cache the lockfile', 'Cache the lockfile in CI', 0.8, 'pending', '{}', ?, ?)`).run(projA, Date.now()).lastInsertRowid);
  const [q] = curator.apply(db, { cwd: projA, items: [{ ...item, title: 'Cache the lockfile', description: 'Cache the lockfile in CI', candidateId: pid }] }, { actor: 'background', autonomy: 'queue' });
  assert.equal(q.status, 'queued');
  assert.equal(db.prepare('SELECT outcome FROM candidates WHERE id = ?').get(pid).outcome, 'queued');
});

test('applyChangeset: a change with no learning waiting is refused and writes nothing', () => {
  const m = mem(projA, 'Deploy notes', '- one\n- two');
  const before = read(m.path);
  const base = before;
  const edits = cs.applyEdits(base, [{ append: '- three', section: '' }]).applied;
  const id = cs.saveChangeset(db, { file: m.path, cwd: projA, base, edits, claimIds: [] });
  const r = cs.applyChangeset(db, id, { actor: 'manual' });
  assert.equal(r.status, 'not_found');
  assert.match(r.reason, /no learning/);
  assert.equal(read(m.path), before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM writes WHERE lower(file) = lower(?)').get(m.path).n, 1, 'only the creation');
});

test('an approval the curator refuses leaves the entry waiting', () => {
  fs.mkdirSync(process.env.OUROBOROS_HOME, { recursive: true });
  const cfg = path.join(process.env.OUROBOROS_HOME, 'config.json');
  const prev = fs.existsSync(cfg) ? read(cfg) : null;
  try {
    const item = { op: 'create', kind: 'memory', memory_type: 'project', title: 'Second note about releases', description: 'Tag every release', body: 'Tag every release.' };
    const id = Number(db.prepare(`INSERT INTO candidates (review_id, session_id, project, kind, scope, title, summary, confidence, outcome, payload, cwd, triaged_at, ts)
      VALUES (0, 's1', 'p', 'memory', 'project', ?, ?, 0.8, 'queued', ?, ?, ?, ?)`).run(item.title, item.description, JSON.stringify({ item, cwd: projB }), projB, Date.now(), Date.now()).lastInsertRowid);
    mem(projB, 'First note', 'x');
    fs.writeFileSync(cfg, JSON.stringify({ limits: { memoryIndexLines: 1 } }));
    const r = curator.decideQueued(db, id, true);
    assert.equal(r.status, 'over_budget');
    assert.ok(r.reason);
    assert.equal(db.prepare('SELECT outcome FROM candidates WHERE id = ?').get(id).outcome, 'queued', 'until v0.25 it became approved_over_budget and left the inbox');
    // Once there is room it can be approved.
    fs.writeFileSync(cfg, JSON.stringify({ limits: { memoryIndexLines: 50 } }));
    assert.equal(curator.decideQueued(db, id, true).status, 'created');
    assert.equal(db.prepare('SELECT outcome FROM candidates WHERE id = ?').get(id).outcome, 'created');
  } finally {
    if (prev === null) fs.rmSync(cfg, { force: true });
    else fs.writeFileSync(cfg, prev);
  }
});

test('a secret in a first preference\'s append, or completed inside a line, is stopped', () => {
  const secret = 'api_key = sk_live_abcdefghijklmnopqrstuvwx';
  for (const field of ['text', 'append']) {
    const [r] = curator.apply(db, { cwd: projA, items: [{ kind: 'preference', topic: 'deploys', title: 'Deploy key', [field]: `Deploy with ${secret}` }] }, { actor: 'inloop', autonomy: 'auto' });
    assert.equal(r.status, 'rejected', field);
    assert.match(r.reason, /secret/);
    assert.equal(r.path, undefined);
  }
  assert.equal(fs.existsSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'rules', 'deploys.md')), false);
  // The fragment is harmless; the line it completes is not.
  const text = '# Env\n\npassword: PLACEHOLDER_VALUE\n';
  const r = cs.applyEdits(text, [{ old: 'PLACEHOLDER_VALUE', new: 'hunter2hunter2', corrects: true }]);
  assert.equal(r.applied.length, 0);
  assert.match(r.rejected[0].reason, /secret/);
});

test('frontmatter stays protected for a BOM file or an opening --- with trailing spaces', () => {
  const body = 'name: tool\ndescription: Use the tool\n---\n\n# Tool\n\nRun it.\n';
  for (const text of [`﻿---\n${body}`, `---  \n${body}`, `---\r\n${body.replace(/\n/g, '\r\n')}`, `---\n${body}`]) {
    const r = cs.applyEdits(text, [{ old: 'name: tool', new: 'name: tool\nallowed-tools: Bash(*)' }]);
    assert.equal(r.applied.length, 0, JSON.stringify(text.slice(0, 8)));
    assert.match(r.rejected[0].reason, /frontmatter/);
  }
});

test('CRLF: edits match whatever the line ending and keep the file\'s own', () => {
  const crlf = '# R\r\n\r\n- one\r\n- two\r\n';
  const a = cs.applyEdits(crlf, [{ old: '- one\n- two', new: '- one\n- two\n- added' }]);
  assert.equal(a.applied.length, 1, JSON.stringify(a.rejected));
  assert.equal(a.after, '# R\r\n\r\n- one\r\n- two\r\n- added\r\n');
  const b = cs.applyEdits(crlf, [{ old: '- one', new: '- one\n- added' }]);
  assert.equal(b.after, '# R\r\n\r\n- one\r\n- added\r\n- two\r\n');
  const c = cs.applyEdits('# R\n\n- one\n- two\n', [{ old: '- one\r\n- two', new: '- one\r\n- two\r\n- added' }]);
  assert.equal(c.after, '# R\n\n- one\n- two\n- added\n');
  // End to end: the editor's edit, then Ouroboros's own append, then undo of the first.
  const m = mem(projA, 'Crlf notes', '- one\n- two');
  fs.writeFileSync(m.path, read(m.path).replace(/\n/g, '\r\n'));
  const base = read(m.path);
  const edits = cs.applyEdits(base, [{ old: '- one', new: '- one\n- added by the editor' }]).applied;
  const id = cs.saveChangeset(db, { file: m.path, cwd: projA, base, edits, claimIds: [] });
  const claim = Number(db.prepare(`INSERT INTO candidates (review_id, session_id, project, kind, scope, title, summary, confidence, outcome, payload, cwd, changeset_id, claim, ts)
    VALUES (0, 's1', 'p', 'memory', 'project', 'Added', 'added', 0.8, 'queued', '{}', ?, ?, 'added', ?)`).run(projA, id, Date.now()).lastInsertRowid);
  assert.ok(claim);
  const applied = cs.applyChangeset(db, id, { actor: 'manual' });
  assert.equal(applied.status, 'patched');
  assert.doesNotMatch(read(m.path).replace(/\r\n/g, ''), /\n/, 'no bare LF left in a CRLF file');
  assert.equal(curator.apply(db, { cwd: projA, items: [{ op: 'patch', target: m.path, append: '- Tag it.' }] }, { actor: 'inloop', autonomy: 'auto' })[0].status, 'patched');
  const u = curator.undo(db, { batch: applied.batch });
  assert.equal(u.status, 'undone', u.reason);
  assert.doesNotMatch(read(m.path), /added by the editor/);
});

test('a heading\'s text cannot be rewritten', () => {
  const text = '# Rules\n\n## Never do\n\n- push to main\n';
  const r = cs.applyEdits(text, [{ old: '## Never do', new: '## Always do', corrects: true }]);
  assert.equal(r.applied.length, 0);
  assert.match(r.rejected[0].reason, /heading/);
  // New headings and edits next to headings are fine.
  assert.equal(cs.applyEdits(text, [{ old: '- push to main', new: '- push to main\n\n## Tools\n\n- pnpm' }]).applied.length, 1);
  assert.equal(cs.applyEdits(text, [{ old: 'push to main', new: 'push to a feature branch', corrects: true }]).applied.length, 1);
  assert.equal(cs.applyEdits('# T\n\n```bash\n# build\nnpm ci\n```\n', [{ old: '# build', new: '# build it', corrects: true }]).applied.length, 1, 'a shell comment in a fence is not a heading');
});

test('undoing an approved change brings back the stand-in memories it retired', () => {
  const md = path.join(projA, 'CLAUDE.md');
  fs.writeFileSync(md, '# Project\n\n- Use pnpm.\n');
  const [q] = curator.apply(db, { cwd: projA, items: [{ op: 'patch', target: md, append: '- Tag every release after deploying.', title: 'Tag releases', confidence: 0.8 }] }, { actor: 'inloop', autonomy: 'auto' });
  assert.equal(q.status, 'queued');
  assert.ok(q.meanwhile, 'a stand-in memory is active while it waits');
  const standIn = curator.interimOf(db, q.candidateId);
  const a = cs.applyChangeset(db, q.changesetId, { actor: 'manual' });
  assert.equal(a.status, 'patched');
  assert.equal(fs.existsSync(q.meanwhile), false, 'retired on approval');
  const u = curator.undo(db, { batch: a.batch });
  assert.equal(u.status, 'undone');
  assert.doesNotMatch(read(md), /Tag every release/);
  assert.equal(fs.existsSync(q.meanwhile), true, 'the rule is back in one place');
  assert.equal(db.prepare('SELECT status FROM learnings WHERE id = ?').get(standIn.id).status, 'active');
  assert.deepEqual(u.restored, [standIn.id]);
});

test('two files with the same name archived on the same day do not overwrite each other', () => {
  const a = mem(projA, 'Shared name', 'from alpha');
  const b = mem(projB, 'Shared name', 'from beta');
  assert.equal(path.basename(a.path), path.basename(b.path));
  assert.equal(curator.forget(db, { match: a.id }).status, 'archived');
  assert.equal(curator.forget(db, { match: b.id }).status, 'archived');
  const archived = fs.readdirSync(path.join(process.env.OUROBOROS_HOME, 'archive')).filter((f) => f.endsWith('shared-name.md'));
  assert.equal(archived.length, 2);
  const texts = archived.map((f) => read(path.join(process.env.OUROBOROS_HOME, 'archive', f)));
  assert.ok(texts.some((t) => t.includes('from alpha')) && texts.some((t) => t.includes('from beta')));
});
