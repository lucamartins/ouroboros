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
import { fileURLToPath } from 'node:url';

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
  // The formula of the brief, on known numbers: 10% on 1000 turns against 6% on 1000.
  const c = compareArms({ turns: 1000, corrections: 100 }, { turns: 1000, corrections: 60 });
  const se = Math.sqrt((0.1 * 0.9) / 1000 + (0.06 * 0.94) / 1000);
  assert.ok(Math.abs(c.diff - -4) < 1e-9);
  assert.ok(Math.abs(c.low - (-0.04 - 1.96 * se) * 100) < 1e-9);
  assert.ok(Math.abs(c.high - (-0.04 + 1.96 * se) * 100) < 1e-9);
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

test('M18: one bucket per calendar day across both clock changes', () => {
  const script = path.join(tmp, 'dst-child.mjs');
  fs.writeFileSync(script, `
    const { openDb } = await import(${JSON.stringify(path.join(root, 'scripts', 'db.mjs'))});
    const { createApi } = await import(${JSON.stringify(path.join(root, 'dashboard', 'api.mjs'))});
    const db = openDb();
    const now = Date.now();
    db.prepare('INSERT INTO sessions (id, project, cwd, started_at, turns) VALUES (?, ?, ?, ?, ?)').run('t1', '-w-app', '/w/app', now - 3600e3, 50);
    db.prepare("INSERT INTO reviews (session_id, mode, trigger, status, instrument, turns_reviewed, corrections, cost_usd, session_started_at, ts) VALUES ('t1', 'corrections', 'session_end', 'ok', 'corrections', 50, 5, 0.02, ?, ?)").run(now - 3600e3, now);
    const api = createApi(db);
    const key = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const out = {};
    for (const days of [7, 30, 90, 365]) {
      const p = new URLSearchParams({ days });
      // The calendar in the child's own time zone: today, and the days before it one by one.
      const expected = [];
      for (let i = days - 1; i >= 0; i--) { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i); expected.push(key(d)); }
      out[days] = { expected, overview: api('overview', p).series, value: api('value', p).series, cost: api('cost', p).series };
    }
    console.log(JSON.stringify(out));
  `);
  for (const TZ of ['America/New_York', 'Australia/Sydney', 'UTC']) {
    const slug = TZ.replace('/', '-');
    const r = spawnSync(process.execPath, ['--no-warnings', script], {
      env: { ...process.env, TZ, OUROBOROS_HOME: path.join(tmp, `dst-${slug}`), CLAUDE_PLUGIN_DATA: path.join(tmp, `dst-data-${slug}`) },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    for (const [days, { expected, ...routes }] of Object.entries(out)) {
      for (const [name, series] of Object.entries(routes)) {
        assert.deepEqual(series.map((d) => d.day), expected, `${TZ}: ${name} over ${days} days`);
      }
    }
    assert.equal(out[30].overview.at(-1).sessions, 1, `${TZ}: today's session is in the chart`);
    assert.equal(out[30].overview.at(-1).corrections, 5);
    assert.ok(out[30].cost.at(-1).usd > 0, `${TZ}: today's cost is in the chart`);
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
