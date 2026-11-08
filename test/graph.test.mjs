// The knowledge graph (scripts/graph.mjs): which relations become edges, which do not,
// and what the dashboard route returns.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { buildGraph, focusGraph } from '../scripts/graph.mjs';
import { normalize } from '../scripts/paths.mjs';

const root = path.resolve('/kb');
const mem = (name, body, extra = {}) => ({
  kind: 'memory', file: path.join(root, 'projects', 'p1', 'memory', `${name}.md`), project_id: 'p1', project_name: 'app',
  text: `---\nname: ${name}\ndescription: ${name} memory\n---\n${body}\n`, ...extra,
});
const skill = (name, body, extra = {}) => ({
  kind: 'skill', name, file: path.join(root, 'skills', name.replace(':', '-'), 'SKILL.md'),
  text: `---\nname: ${name}\ndescription: the ${name} skill\n---\n${body}\n`, ...extra,
});
const id = (item) => normalize(item.file);
const edge = (g, a, b, type) => g.edges.find((e) => e.type === type && ((e.source === id(a) && e.target === id(b)) || (e.source === id(b) && e.target === id(a))));

test('wiki links and markdown links become edges; a link to nothing is reported as broken', () => {
  const a = mem('alpha', 'See [[beta]] and [[ghost-note]].');
  const b = mem('beta', 'Details in [the gamma file](gamma.md#usage).');
  const c = mem('gamma', 'Plain text.');
  const g = buildGraph([a, b, c]);
  assert.ok(edge(g, a, b, 'link'));
  assert.ok(edge(g, b, c, 'link'));
  assert.deepEqual(g.nodes.find((n) => n.id === id(a)).dangling, ['ghost-note']);
  assert.equal(g.stats.dangling, 1);
});

test('skill names: a distinctive name anywhere, a plain word only as code, command or "skill"', () => {
  const back = skill('app-back', 'Backend conventions.');
  const deploy = skill('deploy', 'Deploys the app.');
  const run = skill('run', 'Runs things.');
  const notes = mem('notes', 'Use app-back for handlers; we deploy on Fridays; run the tests. Not app-backend.');
  const guide = mem('guide', 'Start with the `deploy` skill, then /run.');
  const g = buildGraph([back, deploy, run, notes, guide]);
  assert.ok(edge(g, notes, back, 'mention'), 'hyphenated name as a word');
  assert.ok(!edge(g, notes, deploy, 'mention'), 'the verb "deploy" is not the skill');
  assert.ok(!edge(g, notes, run, 'mention'), 'the verb "run" is not the skill');
  assert.ok(edge(g, guide, deploy, 'mention'), 'backticked name');
  assert.ok(edge(g, guide, run, 'mention'), 'slash command');
});

test('a skill contains its reference files, which are not also "mentions" of it', () => {
  const s = skill('app-front', 'See reference/forms.md.');
  const ref = { kind: 'reference', file: path.join(root, 'skills', 'app-front', 'reference', 'forms.md'), text: 'Forms in app-front.' };
  const g = buildGraph([s, ref]);
  assert.ok(edge(g, s, ref, 'contains'));
  assert.ok(!edge(g, s, ref, 'mention'));
  assert.equal(g.nodes.find((n) => n.id === id(ref)).name, 'app-front/reference/forms.md');
});

test('items used together in enough sessions are linked; one session is not enough', () => {
  const a = skill('one-skill', 'A.');
  const b = skill('two-skill', 'B.');
  const c = mem('cee', 'C.');
  const usage = [
    { session: 's1', id: id(a) }, { session: 's1', id: id(b) }, { session: 's1', id: id(c) },
    { session: 's2', id: id(a) }, { session: 's2', id: id(b) },
  ];
  const g = buildGraph([a, b, c], { usage });
  assert.equal(edge(g, a, b, 'used')?.sessions, 2);
  assert.ok(!edge(g, a, c, 'used'));
});

test('plugin skills stay only when used or pointed to, unless all are asked for', () => {
  const used = skill('kit:lint', 'Lint.', { scope: 'plugin', uses: 3 });
  const named = skill('kit:format', 'Format.', { scope: 'plugin' });
  const idle = skill('kit:idle', 'Idle.', { scope: 'plugin' });
  const me = mem('me', 'Run kit:format before committing.');
  const ids = (g) => g.nodes.map((n) => n.id);
  const g = buildGraph([used, named, idle, me]);
  assert.ok(ids(g).includes(id(used)));
  assert.ok(ids(g).includes(id(named)));
  assert.ok(!ids(g).includes(id(idle)));
  assert.ok(buildGraph([used, named, idle, me], { plugins: 'all' }).nodes.some((n) => n.id === id(idle)));
});

test('similar wording links unrelated items as a hint; explicit relations are not repeated', () => {
  const words = 'stripe webhook signature retry idempotency invoice subscription checkout';
  const a = mem('billing-a', `${words} refunds`);
  const b = mem('billing-b', `${words} disputes`);
  const c = mem('linked', `${words} [[billing-a]]`);
  const d = mem('other', 'turnstile hardware serial port agent');
  const e = mem('other-2', 'calendar timezone holidays opening hours');
  const g = buildGraph([a, b, c, d, e]);
  assert.ok(edge(g, a, b, 'similar'));
  assert.ok(edge(g, c, a, 'link'));
  assert.ok(!edge(g, c, a, 'similar'));
  assert.ok(!edge(g, a, d, 'similar'));
});

test('projects become hubs; focusing keeps a project, what it relates to, and its hub', () => {
  const global = skill('shared-skill', 'Shared.');
  const inP1 = mem('in-p1', 'Uses shared-skill.');
  const inP2 = mem('in-p2', 'Elsewhere.', { project_id: 'p2', project_name: 'other', file: path.join(root, 'projects', 'p2', 'memory', 'in-p2.md') });
  const g = buildGraph([global, inP1, inP2]);
  assert.ok(g.nodes.some((n) => n.id === 'project:p1' && n.label === 'app'));
  assert.ok(g.edges.some((e) => e.type === 'belongs' && e.source === id(inP1) && e.target === 'project:p1'));
  const f = focusGraph(g, 'p1');
  const ids = f.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, [id(inP1), id(global), 'project:p1'].sort());
  assert.equal(f.stats.items, 2);
  assert.ok(f.edges.every((e) => ids.includes(e.source) && ids.includes(e.target)));
});

test('unconnected items are counted; node text never leaves the module', () => {
  const lonely = mem('lonely', 'Nothing points here.');
  const g = buildGraph([lonely]);
  assert.equal(g.stats.unconnected, 1);
  assert.equal(g.nodes.find((n) => n.id === id(lonely)).text, undefined);
});
