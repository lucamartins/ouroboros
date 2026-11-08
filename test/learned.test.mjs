// Knowledge > Learned: one entry per write with what it learned and why; files Ouroboros
// did not create cannot be archived; "Keep" protects a learning from maintenance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

let tmp;
let db;
let curator;
let api;
let cwd;
let skill;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-learned-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.OUROBOROS_HOME = path.join(tmp, 'ouroboros');
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data');
  cwd = path.join(tmp, 'work', 'app');
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
  skill = path.join(tmp, 'claude', 'skills', 'local-dev', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '---\nname: local-dev\ndescription: Run the app locally\n---\n\n# Local dev\n\n## Pitfalls\n\n- Port 3000 must be free.\n');
  curator = await import('../scripts/curator.mjs');
  const dbApi = await import('../scripts/db.mjs');
  db = dbApi.openDb();
  db.prepare("INSERT INTO sessions (id, project, cwd, started_at) VALUES ('sess-1', 'app', ?, ?)").run(cwd, Date.now());
  api = (await import('../dashboard/api.mjs')).createApi(db);
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('a patch records what it learned, why and the session; the dashboard shows the change itself', () => {
  const [r] = curator.apply(db, {
    cwd, session_id: 'sess-1', items: [{
      op: 'patch', kind: 'skill', target: skill, section: 'Pitfalls', append: '- The API dies with SQL error 207 when a migration is missing; apply it first.',
      title: 'Missing migration makes the API die at startup', why: 'The API crashed twice before the migration was applied.',
    }],
  }, { actor: 'inloop', autonomy: 'auto' });
  assert.equal(r.status, 'patched', r.reason);
  const [c] = api('changes');
  assert.equal(c.title, 'Missing migration makes the API die at startup');
  assert.equal(c.why, 'The API crashed twice before the migration was applied.');
  assert.equal(c.session.id, 'sess-1');
  assert.equal(c.actor, 'inloop');
  assert.deepEqual(c.files[0].hunks[0].after, ['- The API dies with SQL error 207 when a migration is missing; apply it first.']);
  assert.equal(c.learning.own, false);
  assert.equal(c.canArchive, false, 'a file Ouroboros did not create cannot be archived');
  assert.equal(c.lifecycle, null, 'maintenance never archives it, so there is nothing to keep');
});

test('a write recorded without a title is named by its first added line', () => {
  db.prepare('UPDATE writes SET title = NULL, why = NULL').run();
  const [c] = api('changes');
  assert.equal(c.title, 'The API dies with SQL error 207 when a migration is missing; apply it first.');
  db.prepare("UPDATE writes SET after = replace(after, 'apply it first.', 'apply it first. Then restart the `api` container.')").run();
  assert.equal(api('changes')[0].title, 'The API dies with SQL error 207 when a migration is missing; apply it first.', 'cut at the first sentence, without backticks');
  db.prepare("UPDATE writes SET after = replace(after, ' Then restart the `api` container.', '')").run();
});

test('archiving a file Ouroboros only changed is refused; its changes are undone one by one', () => {
  const lid = db.prepare('SELECT id FROM learnings WHERE lower(path) = lower(?)').get(skill).id;
  const f = curator.forget(db, { match: lid });
  assert.equal(f.status, 'refused');
  assert.ok(fs.existsSync(skill), 'the skill is still there');
  const [c] = api('changes');
  const u = curator.undo(db, { batch: c.batch });
  assert.equal(u.status, 'undone', u.reason);
  assert.doesNotMatch(fs.readFileSync(skill, 'utf8'), /SQL error 207/);
  assert.equal(api('changes')[0].undone, true);
});

test('Keep: a kept learning is not archived when unused; the dashboard says when one would be', async () => {
  const [m] = curator.apply(db, { cwd, items: [{ kind: 'memory', memory_type: 'project', title: 'Seed before e2e', description: 'Seed the local database before end-to-end tests', confidence: 0.5, why: 'The e2e run failed on an empty database.' }] });
  assert.equal(m.status, 'created', m.reason);
  const entry = api('changes').find((c) => c.learning?.id === m.id);
  assert.equal(entry.lifecycle.state, 'decays');
  assert.ok(entry.lifecycle.at > Date.now());
  assert.equal(entry.canArchive, true);

  const old = Date.now() - 90 * 86_400_000;
  db.prepare('UPDATE learnings SET created_at = ?, last_used_at = NULL WHERE id = ?').run(old, m.id);
  assert.equal(curator.pin(db, m.id, true).status, 'kept');
  assert.equal(api('changes').find((c) => c.learning?.id === m.id).lifecycle.state, 'kept');
  const { decay } = await import('../scripts/maintenance.mjs');
  const { loadSettings } = await import('../scripts/settings.mjs');
  assert.deepEqual(decay(db, loadSettings()), []);
  curator.pin(db, m.id, false);
  assert.deepEqual(decay(db, loadSettings()), ['Seed before e2e']);
});
