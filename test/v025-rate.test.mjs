// v0.25 (rate): the Overview verdict needs a usable baseline and an interval, control
// sessions stay out of the learning arm's figures and charts, the daily series has one
// bucket per calendar day across clock changes, the chart is the 7-day moving average,
// and the System page shows what in-session reviews yield. The page only draws what the
// API computes, so everything here asserts the API.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86_400_000;
let tmp;
let db;
let api;
let compareArms;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-v025-rate-'));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.OUROBOROS_HOME = path.join(tmp, 'ouroboros');
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data');
  const dbApi = await import('../scripts/db.mjs');
  db = dbApi.openDb();
  const mod = await import('../dashboard/api.mjs');
  compareArms = mod.compareArms;
  api = mod.createApi(db);
});

after(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function reset() {
  for (const t of ['reviews', 'sessions', 'meta']) db.prepare(`DELETE FROM ${t}`).run();
}

let seq = 0;
/** A session with one corrections-instrument review: `turns` reviewed, `corrections` found. */
function measured({ at, turns, corrections, control = 0 }) {
  const id = `s${++seq}`;
  db.prepare('INSERT INTO sessions (id, project, cwd, started_at, turns, control) VALUES (?, ?, ?, ?, ?, ?)').run(id, '-w-app', '/w/app', at, turns, control);
  db.prepare(`INSERT INTO reviews (session_id, mode, trigger, status, instrument, turns_reviewed, corrections, session_started_at, ts)
    VALUES (?, 'corrections', 'session_end', 'ok', 'corrections', ?, ?, ?, ?)`).run(id, turns, corrections, at, at);
  return id;
}

const enable = (at) => db.prepare("INSERT INTO meta (key, value) VALUES ('learning_enabled_at', ?)").run(String(at));
const get = (route, params = {}) => api(route, new URLSearchParams(params));
const keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('A4: a tiny baseline is not a baseline, and a missing one says how to get one', () => {
  reset();
  const now = Date.now();
  enable(now - 10 * DAY);
  measured({ at: now - 2 * DAY, turns: 250, corrections: 10 });
  let v = get('value', { days: 30 });
  assert.equal(v.verdict.state, 'no-baseline');
  assert.match(v.verdict.text, /no baseline/i);
  assert.match(v.verdict.text, /\/ouroboros:backfill measure/);
  assert.match(v.verdict.text, /control/);

  // One 4-turn session before (50 per 100) against 250 turns after: it used to be "46.0 fewer", green.
  measured({ at: now - 11 * DAY, turns: 4, corrections: 2 });
  v = get('value', { days: 30 });
  assert.equal(v.verdict.state, 'short');
  assert.deepEqual(v.verdict.short, ['a'], 'the baseline is the short side');
  assert.match(v.verdict.text, /baseline has 4 reviewed turns/);
  assert.doesNotMatch(v.verdict.text, /fewer/);
});

test('A4: the short side is named, either one or both', () => {
  reset();
  const now = Date.now();
  enable(now - 10 * DAY);
  measured({ at: now - 20 * DAY, turns: 300, corrections: 30 });
  measured({ at: now - 2 * DAY, turns: 50, corrections: 1 });
  let v = get('value', { days: 60 });
  assert.deepEqual(v.verdict.short, ['b']);
  assert.match(v.verdict.text, /50 turns were reviewed since learning turned on/);
  assert.doesNotMatch(v.verdict.text, /baseline has/);

  reset();
  enable(now - 10 * DAY);
  measured({ at: now - 20 * DAY, turns: 120, corrections: 12 });
  measured({ at: now - 2 * DAY, turns: 50, corrections: 1 });
  v = get('value', { days: 60 });
  assert.deepEqual(v.verdict.short, ['a', 'b']);
  assert.match(v.verdict.text, /baseline has 120 reviewed turns and 50 turns were reviewed since learning turned on/);
});

test('A4: the verdict follows the 95% interval of the difference', () => {
  // Newcombe's interval (each arm's Wilson interval, combined), on known numbers: 10% on 1000 turns against 6% on 1000.
  const c = compareArms({ turns: 1000, corrections: 100 }, { turns: 1000, corrections: 60 });
  const wilson = (k, n) => {
    const p = k / n; const z = 1.96;
    const mid = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
    const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
    return { p, l: mid - half, u: mid + half };
  };
  const w1 = wilson(100, 1000);
  const w2 = wilson(60, 1000);
  assert.ok(Math.abs(c.diff - -4) < 1e-9);
  assert.ok(Math.abs(c.low - (-0.04 - Math.sqrt((w2.p - w2.l) ** 2 + (w1.u - w1.p) ** 2)) * 100) < 1e-9);
  assert.ok(Math.abs(c.high - (-0.04 + Math.sqrt((w2.u - w2.p) ** 2 + (w1.p - w1.l) ** 2)) * 100) < 1e-9);
  assert.equal(c.state, 'lower');

  // 10 vs 7 per 100 on 200 turns each: a 3-point drop that fits inside the noise (about +-6).
  const noise = compareArms({ turns: 200, corrections: 20 }, { turns: 200, corrections: 14 });
  assert.equal(noise.state, 'unclear');
  assert.ok(noise.low < 0 && noise.high > 0);
  assert.equal(compareArms({ turns: 1000, corrections: 60 }, { turns: 1000, corrections: 100 }).state, 'higher');
  assert.equal(compareArms({ turns: 199, corrections: 1 }, { turns: 1000, corrections: 100 }).state, 'short');

  reset();
  const now = Date.now();
  enable(now - 10 * DAY);
  measured({ at: now - 20 * DAY, turns: 200, corrections: 20 });
  measured({ at: now - 2 * DAY, turns: 200, corrections: 14 });
  let v = get('value', { days: 60 });
  assert.equal(v.verdict.state, 'unclear', 'a lower rate inside the noise is not "lower"');
  assert.match(v.verdict.text, /^No difference can be told yet: −3\.0 per 100 turns, 95% interval −\d+\.\d to \+\d+\.\d, which includes zero/);

  reset();
  enable(now - 10 * DAY);
  measured({ at: now - 20 * DAY, turns: 1000, corrections: 100 });
  measured({ at: now - 2 * DAY, turns: 1000, corrections: 60 });
  v = get('value', { days: 60 });
  assert.equal(v.verdict.state, 'lower');
  assert.match(v.verdict.text, /^You correct Claude 4\.0 fewer times per 100 turns than before learning turned on \(95% interval −\d\.\d to −\d\.\d\)\.$/);

  reset();
  enable(now - 10 * DAY);
  measured({ at: now - 20 * DAY, turns: 1000, corrections: 60 });
  measured({ at: now - 2 * DAY, turns: 1000, corrections: 100 });
  v = get('value', { days: 60 });
  assert.equal(v.verdict.state, 'higher');
  assert.match(v.verdict.text, /more times per 100 turns/);
});

test('A4: the other two states keep their sentences', () => {
  reset();
  assert.equal(get('value', { days: 30 }).verdict.state, 'baseline');
  enable(Date.now() - DAY);
  assert.equal(get('value', { days: 30 }).verdict.text, 'Learning is on, but no session after it has been reviewed yet.');
});

test('A4: the control comparison uses the same rule', () => {
  reset();
  const now = Date.now();
  enable(now - 30 * DAY);
  measured({ at: now - 3 * DAY, turns: 1000, corrections: 60 });
  measured({ at: now - 3 * DAY, turns: 150, corrections: 30, control: 1 });
  let v = get('value', { days: 30 });
  assert.equal(v.concurrent.verdict.state, 'short');
  assert.deepEqual(v.concurrent.verdict.short, ['a'], 'the control side is short');
  assert.match(v.concurrent.verdict.text, /control projects have 150 reviewed turns/);

  measured({ at: now - 2 * DAY, turns: 850, corrections: 170, control: 1 }); // control: 200 of 1000
  v = get('value', { days: 30 });
  assert.equal(v.concurrent.verdict.state, 'lower');
  assert.match(v.concurrent.verdict.text, /^Learning projects have 14\.0 fewer corrections per 100 turns than control projects/);
});

test('M17: control sessions are in neither the trend nor the baseline figure', () => {
  reset();
  const now = Date.now();
  measured({ at: now - 1 * DAY, turns: 100, corrections: 2 });
  measured({ at: now - 1 * DAY, turns: 100, corrections: 20, control: 1 });
  const o = get('overview', { days: 30 });
  assert.equal(o.reviewed.turns, 100);
  assert.equal(o.correctionRate, 2, 'was 11 with the control session mixed in');
  assert.equal(o.series.reduce((n, d) => n + d.reviewedTurns, 0), 100);
  assert.equal(o.series.reduce((n, d) => n + d.corrections, 0), 2);
  assert.equal(o.series.reduce((n, d) => n + d.turns, 0), 100, 'user turns of the learning arm only');
  assert.equal(o.totals.sessions, 1);
  const v = get('value', { days: 30 });
  assert.equal(v.sessions, 1);
  assert.equal(v.series.reduce((n, d) => n + d.sessions, 0), 1);
});

test('M18: one bucket per calendar day across both clock changes, and where the clock skips midnight', () => {
  // A fixed "now" (a Date shim in the child) a few hours after each change, so the test does not depend on
  // when it runs; Santiago and Havana skip local midnight, which used to drop today's bucket until 01:00.
  const script = path.join(tmp, 'dst-child.mjs');
  fs.writeFileSync(script, `
    const fake = Date.parse(process.argv[2]);
    const RealDate = Date;
    globalThis.Date = class extends RealDate { constructor(...a) { if (a.length === 0) super(fake); else super(...a); } static now() { return fake; } };
    const { openDb } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'scripts', 'db.mjs')).href)});
    const { createApi } = await import(${JSON.stringify(pathToFileURL(path.join(root, 'dashboard', 'api.mjs')).href)});
    const db = openDb();
    const now = Date.now();
    db.prepare('INSERT INTO sessions (id, project, cwd, started_at, turns) VALUES (?, ?, ?, ?, ?)').run('t1', '-w-app', '/w/app', now - 1800e3, 50);
    db.prepare("INSERT INTO reviews (session_id, mode, trigger, status, instrument, turns_reviewed, corrections, cost_usd, session_started_at, ts) VALUES ('t1', 'corrections', 'session_end', 'ok', 'corrections', 50, 5, 0.02, ?, ?)").run(now - 1800e3, now);
    const api = createApi(db);
    const key = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const out = {};
    for (const days of [1, 2, 7, 30, 90, 365]) {
      const p = new URLSearchParams({ days });
      const expected = [];
      for (let i = days - 1; i >= 0; i--) { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i); expected.push(key(d)); }
      out[days] = { expected, overview: api('overview', p).series, value: api('value', p).series, cost: api('cost', p).series };
    }
    console.log(JSON.stringify(out));
  `);
  // [zone, local "now"] as UTC instants: shortly after the spring and the autumn change of each zone.
  const cases = [
    ['America/New_York', '2026-03-08T12:00:00Z'], ['America/New_York', '2026-11-01T12:00:00Z'],
    ['Australia/Sydney', '2026-04-05T04:00:00Z'], ['Australia/Sydney', '2026-10-04T04:00:00Z'],
    ['America/Santiago', '2026-09-07T03:30:00Z'], // 00:30 on the day after midnight was skipped
    ['America/Santiago', '2026-09-06T04:30:00Z'], // 01:30 on the day midnight was skipped
    ['America/Havana', '2026-03-09T04:30:00Z'], ['America/Havana', '2026-03-08T05:30:00Z'],
    ['UTC', '2026-06-01T00:30:00Z'],
  ];
  for (const [TZ, at] of cases) {
    const slug = `${TZ.replace('/', '-')}-${at.slice(0, 10)}`;
    const r = spawnSync(process.execPath, ['--no-warnings', script, at], {
      env: { ...process.env, TZ, OUROBOROS_HOME: path.join(tmp, `dst-${slug}`), CLAUDE_PLUGIN_DATA: path.join(tmp, `dst-data-${slug}`) },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    for (const [days, { expected, ...routes }] of Object.entries(out)) {
      for (const [name, series] of Object.entries(routes)) {
        assert.deepEqual(series.map((d) => d.day), expected, `${TZ} at ${at}: ${name} over ${days} days`);
      }
    }
    assert.equal(out[30].overview.at(-1).sessions, 1, `${TZ} at ${at}: today's session is in the chart`);
    assert.equal(out[30].overview.at(-1).corrections, 5);
    assert.ok(out[30].cost.at(-1).usd > 0, `${TZ} at ${at}: today's cost is in the chart`);
  }
});

test('section 9.2: the chart is the pooled rate of the trailing 7 days', () => {
  reset();
  const now = Date.now();
  // Six ordinary days at 2 per 100, then one day of 2 turns with 1 correction: a raw ratio of 50.
  for (let i = 7; i >= 2; i--) measured({ at: now - i * DAY, turns: 100, corrections: 2 });
  measured({ at: now - 1 * DAY, turns: 2, corrections: 1 });
  const o = get('overview', { days: 30 });
  const spike = o.series.find((d) => d.day === keyOf(new Date(now - DAY)));
  assert.equal(spike.reviewedTurns, 2, 'the day keeps its own numbers for the tooltip');
  assert.equal(spike.corrections, 1);
  assert.ok(spike.rate7 > 2 && spike.rate7 < 3, `pooled rate, not 50: ${spike.rate7}`);
  const win = o.series.slice(-8, -1); // the spike day (yesterday) and the six before it
  assert.equal(spike.turns7, win.reduce((n, d) => n + d.reviewedTurns, 0));
  assert.equal(spike.corrections7, win.reduce((n, d) => n + d.corrections, 0));
  assert.ok(Math.abs(spike.rate7 - (spike.corrections7 / spike.turns7) * 100) < 1e-9);
  assert.equal(o.series[0].rate7, null, 'a window with no reviewed turns draws nothing');
  // Days before the period still feed the first days' windows.
  const narrow = get('overview', { days: 2 });
  assert.equal(narrow.series.length, 2);
  assert.equal(narrow.series[0].turns7, 602, 'the 7 days ending yesterday: six 100-turn days and the 2-turn one');
});

test('new: in-session reviews report how many saved something, were skipped and what they read', () => {
  reset();
  const now = Date.now();
  const insert = db.prepare(`INSERT INTO reviews (session_id, mode, trigger, status, detail, learned, patched, input_tokens, cache_read_tokens, cache_write_tokens, ts)
    VALUES ('x', 'inloop', 'periodic', ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run('ok', null, 1, 0, 10, 40_000, 1000, now);
  insert.run('ok', null, 0, 1, 10, 60_000, 1000, now);
  insert.run('ok', null, 0, 0, 10, 80_000, 1000, now);
  insert.run('ok', null, 0, 0, 10, 100_000, 1000, now);
  insert.run('skipped', 'context of 91234 tokens is over inloop_review_max_context (80000): left to the end-of-session review', 0, 0, 0, 0, 0, now);
  insert.run('skipped', 'context of 120000 tokens is over inloop_review_max_context (80000): left to the end-of-session review', 0, 0, 0, 0, 0, now);
  insert.run('skipped', 'no result line', 0, 0, 5, 5, 5, now);
  insert.run('ok', null, 5, 0, 1, 1, 1, now - 100 * DAY); // outside the period
  db.prepare("INSERT INTO reviews (session_id, mode, trigger, status, turns_reviewed, ts) VALUES ('x', 'background', 'session_end', 'ok', 5, ?)").run(now);
  const c = get('cost', { days: 30 });
  assert.equal(c.inloop.reviews, 7);
  assert.equal(c.inloop.finished, 4);
  assert.equal(c.inloop.saved, 2, 'learned + patched > 0');
  assert.equal(c.inloop.skipped.reduce((n, x) => n + x.n, 0), 3);
  assert.deepEqual(c.inloop.skipped[0], { detail: 'context of N tokens is over inloop_review_max_context (N): left to the end-of-session review', n: 2 });
  assert.equal(c.inloop.avgTokensRead, Math.round((41_010 + 61_010 + 81_010 + 101_010) / 4));
});

test('review III: the interval does not collapse at zero corrections, and zero has no sign', () => {
  // 0 of 300 against 0 of 300 used to read "95% interval 0.0 to 0.0": the normal approximation has no spread at p = 0.
  const c = compareArms({ turns: 300, corrections: 0 }, { turns: 300, corrections: 0 });
  assert.equal(c.state, 'unclear');
  assert.equal(c.diff, 0);
  assert.ok(c.low < -0.5 && c.high > 0.5, `${c.low} to ${c.high}`);
  // One side at zero: the other side's rate is still told apart from it.
  const one = compareArms({ turns: 300, corrections: 0 }, { turns: 300, corrections: 30 });
  assert.equal(one.state, 'higher');
  assert.ok(one.low > 0);

  reset();
  const now = Date.now();
  enable(now - 10 * DAY);
  measured({ at: now - 20 * DAY, turns: 300, corrections: 0 });
  measured({ at: now - 2 * DAY, turns: 300, corrections: 0 });
  const v = get('value', { days: 60 });
  assert.equal(v.verdict.state, 'unclear');
  assert.match(v.verdict.text, /^No difference can be told yet: 0\.0 per 100 turns, 95% interval −1\.\d to \+1\.\d, which includes zero/);
  assert.doesNotMatch(v.verdict.text, /[+−]0\.0|0\.0 to 0\.0/);

  // A bound that rounds to zero loses its sign: a tiny negative never prints "−0.0".
  measured({ at: now - 2 * DAY, turns: 100_000, corrections: 1, control: 1 });
  measured({ at: now - 2 * DAY, turns: 100_000, corrections: 1 });
  const cc = get('value', { days: 60 }).concurrent.verdict;
  assert.doesNotMatch(cc.text, /[+−]0\.0(?!\d)/);
});
