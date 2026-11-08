// v0.7 learning evaluation: grounding, owner files (including skill references), one
// changeset per file, safe edits, rebase on approval, recomposition, in-session edits.
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
let ev;
let cs;
let k;
let proj;
let rules;
let skill;
let ref;

function git(...args) {
  const r = spawnSync('git', ['-C', proj, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-eval-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.OUROBOROS_HOME = path.join(tmp, 'ouroboros');
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data');
  process.env.OUROBOROS_CLAUDE_CMD = JSON.stringify([process.execPath, path.join(root, 'test', 'fixtures', 'fake-claude.mjs')]);
  proj = path.join(tmp, 'work', 'p');
  rules = path.join(proj, '.claude', 'rules', 'deploy.md');
  skill = path.join(tmp, 'claude', 'skills', 'tool', 'SKILL.md');
  ref = path.join(tmp, 'claude', 'skills', 'tool', 'reference', 'glossary.md');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.mkdirSync(path.dirname(rules), { recursive: true });
  fs.mkdirSync(path.dirname(ref), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'config.ts'), 'export const RETRY_LIMIT = 3;\n');
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# P\n\nA small project.\n');
  fs.writeFileSync(rules, '# Deploy\n\n- Deploy with `npm run deploy`.\n- Staging first.\n');
  fs.writeFileSync(skill, '---\nname: tool\ndescription: Use the tool\n---\n\n# Tool\n\nRun the tool.\n');
  fs.writeFileSync(ref, '# Glossary\n\n| Term | Meaning |\n|---|---|\n| plan | a price |\n');
  git('init', '-q');
  git('add', '.');
  curator = await import('../scripts/curator.mjs');
  ev = await import('../scripts/evaluate.mjs');
  cs = await import('../scripts/changesets.mjs');
  k = await import('../scripts/knowledge.mjs');
  db = (await import('../scripts/db.mjs')).openDb();
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** Queue proposals routed to `file`, one per claim, and run the queue check. */
async function propose(file, claims, { autonomy = 'queue' } = {}) {
  curator.apply(db, { cwd: proj, items: claims.map((c) => ({ kind: 'memory', memory_type: 'project', title: c.slice(0, 40), description: c, evidence: `ROUTEME:${file} CLAIM: ${c}`, confidence: 0.8 })) },
    { actor: 'background', autonomy: 'queue' });
  return ev.tidyQueue(db, { autonomy });
}

function pending(file) {
  return cs.pendingChangeset(db, file);
}

test('applyEdits keeps only safe edits', () => {
  const text = '---\nname: x\n---\n\n# A\n\nOne line here.\nTwo line here.\n\n## B\n\nThree things.\n';
  const r = cs.applyEdits(text, [
    { old: 'not in the file', new: 'x' },
    { old: 'line here.', new: 'y' },
    { old: 'One line here.', new: 'One line here.\nAdded after it.' },
    { old: 'Two line here.', new: 'Two lines here.', corrects: true },
    { old: '---\nname: x', new: '---\nname: y', corrects: true },
    { old: '## B\n\nThree things.', new: 'Three things.', corrects: true },
    { old: 'Three things.', new: 'Three things. key sk_live_abcdefghijklmnopqrstuvwx' },
  ]);
  assert.deepEqual(r.rejected.map((x) => x.reason), [
    'the fragment is not in the file',
    'the fragment appears 2 times',
    'changes the frontmatter',
    'removes a heading',
    'adds something that looks like a secret',
  ]);
  assert.equal(r.applied.length, 2);
  assert.match(r.after, /One line here\.\nAdded after it\.\nTwo lines here\./);
});

test('an edit that rewrites text is a correction, however small', () => {
  const doc = '# Deploy\n\nRun migrations on startup in staging.\n';
  for (const next of ['Never run migrations on startup in staging.', 'Run migrations on startup in production, not staging.', 'Run migrations on startup in staging']) {
    const r = cs.applyEdits(doc, [{ old: 'Run migrations on startup in staging.', new: next }]);
    assert.equal(r.applied.length, 1);
    assert.equal(r.applied[0].corrects, true, next);
    assert.equal(r.applied[0].rewrites, true, next);
  }
  // A pure insertion stays an addition.
  const add = cs.applyEdits(doc, [{ old: 'Run migrations on startup in staging.', new: 'Run migrations on startup in staging.\nSeed data after.' }]);
  assert.equal(add.applied[0].corrects, undefined);
  // A changeset holding a rewrite waits for the user even in auto mode.
  assert.equal(curator.needsApproval({ op: 'patch', corrects: true, kind: 'skill', confidence: 0.9 }, 'background', 'auto'), true);
});

test('a secret is caught in the added text even when the file already looks like it has one', () => {
  const doc = '# Notes\n\nExample: token: abcdefghijkl\n';
  const r = cs.applyEdits(doc, [{ old: 'Example: token: abcdefghijkl', new: 'Example: token: abcdefghijkl\nReal key: sk-ABCDEFGHIJKLMNOPQRSTUVWX' }]);
  assert.equal(r.applied.length, 0);
  assert.equal(r.rejected[0].reason, 'adds something that looks like a secret');
});

test('identifiers a learning names are looked up in the tracked files', () => {
  const ids = k.identifiersIn('Set `RETRY_LIMIT` in src/config.ts and call useMissingThing before `deploy --dry-run-all`.');
  assert.ok(ids.includes('RETRY_LIMIT') && ids.includes('src/config.ts') && ids.includes('useMissingThing') && ids.includes('--dry-run-all'));
  const g = Object.fromEntries(k.groundIdentifiers(ids, proj).map((x) => [x.id, x]));
  assert.match(g.RETRY_LIMIT.hits[0].file, /config\.ts$/);
  assert.equal(g['src/config.ts'].exists, true);
  assert.equal(g.useMissingThing.exists, false);
});

test('skill reference files are owners, listed under their skill', () => {
  assert.equal(k.knowledgeKind(ref), 'skill');
  const owner = k.ownersMap(proj).find((o) => o.name === 'tool');
  assert.deepEqual(owner.references, ['reference/glossary.md']);
  assert.equal(path.resolve(k.resolveOwner('tool/reference/glossary.md', proj)), path.resolve(ref));
  assert.equal(path.resolve(k.resolveOwner(rules, proj)), path.resolve(rules));
});

test('learnings for one file compose one changeset; a later one joins it', async () => {
  await propose(rules, ['Run the smoke test after deploying.', 'Never deploy on Fridays.']);
  const first = pending(rules);
  assert.equal(cs.claimsOf(db, first.id).length, 2);
  assert.equal(JSON.parse(first.edits).length, 1, 'both additions in one coherent edit');
  await propose(rules, ['Tag the release before deploying.']);
  assert.equal(cs.getChangeset(db, first.id).status, 'superseded');
  const second = pending(rules);
  const claims = cs.claimsOf(db, second.id);
  assert.equal(claims.length, 3);
  const edit = JSON.parse(second.edits)[0].new;
  for (const t of ['smoke test', 'Fridays', 'Tag the release']) assert.ok(edit.includes(t), t);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM changesets WHERE status = 'pending' AND file = ?").get(second.file).n, 1);
});

test('covered and contradicted learnings are dropped with the editor reason', async () => {
  await propose(rules, ['Staging first.', 'CONTRADICT deploys use yarn']);
  const rows = db.prepare("SELECT title, outcome, note FROM candidates WHERE title IN ('Staging first.', 'CONTRADICT deploys use yarn')").all();
  assert.deepEqual(rows.map((r) => r.outcome), ['dropped', 'dropped']);
  assert.match(rows[0].note, /^covered \[editor\]/);
  assert.match(rows[1].note, /^unverified \[editor\]/);
  assert.equal(cs.claimsOf(db, pending(rules).id).length, 3, 'the waiting changeset keeps its learnings');
});

test('rejecting one learning of a changeset composes the rest again without it', async () => {
  const before = pending(rules);
  const fridays = cs.claimsOf(db, before.id).find((c) => c.claim.includes('Fridays'));
  const r = curator.decideQueued(db, fridays.id, false);
  assert.equal(r.recompose, true);
  assert.equal(cs.getChangeset(db, before.id).status, 'stale');
  const report = await ev.tidyQueue(db);
  assert.equal(report.recomposed, 1);
  const after = pending(rules);
  assert.equal(cs.claimsOf(db, after.id).length, 2);
  assert.ok(!JSON.parse(after.edits)[0].new.includes('Fridays'));
});

test('approving re-applies the edits on a file that changed elsewhere; a broken anchor goes stale', async () => {
  const current = pending(rules);
  fs.writeFileSync(rules, fs.readFileSync(rules, 'utf8').replace('# Deploy\n', '# Deploy\n\nOwned by the platform team.\n'));
  const c = cs.claimsOf(db, current.id)[0];
  const r = curator.decideQueued(db, c.id, true);
  assert.equal(r.status, 'patched', r.reason);
  assert.equal(r.rebased, true);
  const text = fs.readFileSync(rules, 'utf8');
  assert.match(text, /Owned by the platform team\./);
  assert.match(text, /Staging first\.\nRun the smoke test after deploying\.\nTag the release before deploying\./);
  assert.ok(cs.claimsOf(db, current.id, { all: true }).every((x) => x.outcome === 'patched'));

  await propose(rules, ['Announce deploys in the team channel.']);
  const next = pending(rules);
  fs.writeFileSync(rules, fs.readFileSync(rules, 'utf8').replace('Tag the release before deploying.', 'Tag every release.'));
  const s = cs.applyChangeset(db, next.id);
  assert.equal(s.status, 'stale');
  await ev.tidyQueue(db);
  const again = pending(rules);
  assert.match(JSON.parse(again.edits)[0].old, /Tag every release\./);
});

test('corrections replace the wrong text and wait for approval even in auto mode', async () => {
  await propose(skill, ['FIX:Run the tool.=>Run the tool with --safe.'], { autonomy: 'auto' });
  const p = pending(skill);
  assert.equal(p.corrects, 1);
  const r = cs.applyChangeset(db, p.id);
  assert.equal(r.status, 'patched', r.reason);
  assert.match(fs.readFileSync(skill, 'utf8'), /Run the tool with --safe\./);
});

test('in auto mode an addition to a skill reference file is written at once', async () => {
  await propose(ref, ['| term | the length of a plan |'], { autonomy: 'auto' });
  assert.equal(pending(ref), undefined);
  assert.match(fs.readFileSync(ref, 'utf8'), /\| plan \| a price \|\n\| term \| the length of a plan \|/);
  const row = db.prepare("SELECT outcome, learning_id FROM candidates WHERE claim LIKE '| term |%'").get();
  assert.equal(row.outcome, 'patched');
  assert.ok(row.learning_id);
});

test('patches Claude writes in session for one file join a single changeset', () => {
  const claudeMd = path.join(proj, 'CLAUDE.md');
  const items = [
    { op: 'patch', kind: 'memory', target: claudeMd, section: '', append: 'Use Node 22.', title: 'Node version', confidence: 0.8 },
    { op: 'patch', kind: 'memory', target: claudeMd, old: 'A small project.', new: 'A small project with one service.', title: 'Scope', confidence: 0.8 },
  ];
  const r = curator.apply(db, { cwd: proj, items }, { actor: 'claude', autonomy: 'auto' });
  assert.deepEqual(r.map((x) => x.status), ['queued', 'queued']);
  const p = pending(claudeMd);
  assert.equal(cs.claimsOf(db, p.id).length, 2);
  assert.equal(JSON.parse(p.edits).length, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM changesets WHERE status = 'superseded' AND file = ?").get(p.file).n, 1);
  assert.equal(cs.applyChangeset(db, p.id).status, 'patched');
  assert.equal(fs.readFileSync(claudeMd, 'utf8'), '# P\n\nA small project with one service.\nUse Node 22.\n');
});

test('a stale flag counts only when it cites a real source of truth', () => {
  fs.mkdirSync(path.join(proj, '.github', 'workflows'), { recursive: true });
  const wf = path.join(proj, '.github', 'workflows', 'deploy.yml');
  fs.writeFileSync(wf, 'on:\n  workflow_dispatch:\n');
  assert.equal(path.resolve(ev.staleSource('.github/workflows/deploy.yml', proj)), path.resolve(wf));
  assert.equal(path.resolve(ev.staleSource(wf, proj)), path.resolve(wf));
  assert.equal(ev.staleSource(rules, proj), null, 'a knowledge file is not a source of truth');
  assert.equal(ev.staleSource('the user said so', proj), null);
  assert.equal(ev.staleSource('', proj), null);
});

test('a conflict waits for the user; "it is a new rule" sends it to the editor as confirmed', async () => {
  await propose(rules, ['CONFLICTME deploy on Fridays after all']);
  const c = db.prepare("SELECT * FROM candidates WHERE claim LIKE 'CONFLICTME%'").get();
  assert.equal(c.outcome, 'conflict', 'never dropped silently');
  assert.match(c.note, /^conflict:/);
  // What the dashboard's "It is a new rule" does:
  const payload = JSON.parse(c.payload);
  db.prepare("UPDATE candidates SET outcome = 'queued', triaged_at = NULL, payload = ? WHERE id = ?").run(JSON.stringify({ ...payload, confirmed: true }), c.id);
  await ev.tidyQueue(db);
  const after = db.prepare('SELECT outcome, changeset_id FROM candidates WHERE id = ?').get(c.id);
  assert.equal(after.outcome, 'queued');
  assert.ok(after.changeset_id);
  assert.match(cs.getChangeset(db, after.changeset_id).edits, /CONFLICTME deploy on Fridays/);
});
