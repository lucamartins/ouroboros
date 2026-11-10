// Measures the learning evaluation with the real model (costs a few cents per run).
//
//   node eval.mjs --synthetic [--model haiku]
//       Builds the fake project in test/eval/synthetic.json in a temp dir, runs every
//       proposal through the evaluation and scores each against its known right outcome.
//   node eval.mjs --sessions [--model haiku] [--runs 2] [--only id,id]
//       Scores the two calls that read sessions (the corrections instrument and the
//       end-of-session reviewer) on cases taken from real mistakes; each case runs
//       several times, because the same call can answer differently.
//   node eval.mjs --replay [--data <dir>] [--limit 40]
//       Replays the proposals YOU approved or rejected, on a copy of the database (no
//       file is written), and reports how often the evaluation agrees with you.
//
// Run it after changing the rubric or a prompt; compare the score before and after.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    out[a.slice(2)] = next && !next.startsWith('--') ? (i++, next) : true;
  }
  return out;
}

function pad(s, n) {
  const t = String(s);
  return t.length >= n ? t.slice(0, n) : t + ' '.repeat(n - t.length);
}

async function synthetic({ model, judge }) {
  const spec = JSON.parse(fs.readFileSync(path.join(here, '..', 'test', 'eval', 'synthetic.json'), 'utf8'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-eval-'));
  // The model call keeps the real Claude config (its login); knowledge lives in tmp.
  process.env.OUROBOROS_REVIEWER_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || '';
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.OUROBOROS_HOME = path.join(tmp, 'ouroboros');
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data');
  if (model) process.env.CLAUDE_PLUGIN_OPTION_REVIEWER_MODEL = model;
  if (judge) process.env.CLAUDE_PLUGIN_OPTION_JUDGE_MODEL = judge;
  const proj = path.join(tmp, 'work', 'shop');
  for (const [rel, text] of Object.entries(spec.project)) {
    fs.mkdirSync(path.dirname(path.join(proj, rel)), { recursive: true });
    fs.writeFileSync(path.join(proj, rel), text);
  }
  for (const [rel, text] of Object.entries(spec.parent || {})) {
    // Files above the project (Claude Code loads CLAUDE.md files from every parent directory).
    fs.mkdirSync(path.dirname(path.join(proj, '..', rel)), { recursive: true });
    fs.writeFileSync(path.join(proj, '..', rel), text);
  }
  for (const [rel, text] of Object.entries(spec.skills)) {
    const file = path.join(tmp, 'claude', 'skills', rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  spawnSync('git', ['-C', proj, 'init', '-q']);
  spawnSync('git', ['-C', proj, 'add', '.']);

  const { openDb } = await import('./db.mjs');
  const curator = await import('./curator.mjs');
  const { tidyQueue } = await import('./evaluate.mjs');
  const db = openDb();
  const ids = new Map();
  for (const c of spec.cases) {
    const [r] = curator.apply(db, { cwd: proj, session_id: `eval-${c.id}`, items: [{ confidence: 0.8, scope: 'project', ...c.proposal }] }, { actor: 'background', autonomy: 'queue' });
    ids.set(c.id, r.candidateId);
  }
  const started = Date.now();
  const report = await tidyQueue(db, { autonomy: 'queue' });

  const row = (id) => db.prepare('SELECT c.*, cs.file cs_file, cs.corrects cs_corrects FROM candidates c LEFT JOIN changesets cs ON cs.id = c.changeset_id WHERE c.id = ?').get(id);
  const results = [];
  const describeRow = (r) => `${r.outcome}${r.cs_file ? ` → ${path.relative(tmp, r.cs_file).replace(/\\/g, '/')}${r.cs_corrects ? ' (corrects)' : ''}` : ''}${r.note ? ` · ${r.note.slice(0, 110)}` : ''}`;
  for (const c of spec.cases.filter((x) => x.expect)) {
    const r = row(ids.get(c.id));
    const e = c.expect;
    let ok = e.outcome.includes(r.outcome);
    if (ok && e.file && r.outcome === 'queued') ok = !!r.cs_file && r.cs_file.replace(/\\/g, '/').endsWith(e.file);
    if (ok && e.corrects) ok = !!r.cs_corrects;
    if (ok && e.type === 'item') ok = !r.changeset_id;
    results.push({ id: c.id, ok, got: describeRow(r) });
  }
  const groups = new Map();
  for (const c of spec.cases.filter((x) => x.group)) {
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group).push(c);
  }
  for (const [g, cases] of groups) {
    const rows = cases.map((c) => row(ids.get(c.id)));
    // Waiting together in one changeset counts once.
    const waiting = new Set(rows.filter((r) => r.outcome === 'queued').map((r) => (r.changeset_id ? `cs${r.changeset_id}` : `c${r.id}`)));
    const atMostOne = cases.some((c) => c.atMostOne);
    const sameChange = waiting.size === 1 && rows.filter((r) => r.outcome === 'queued').length > 1;
    const ok = atMostOne ? waiting.size <= 1 && !(sameChange && atMostOne) : waiting.size === 1;
    results.push({ id: `group:${g}`, ok, got: rows.map(describeRow).join(' | ') });
  }
  db.close();
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${pad(r.id, 22)} ${r.got}`);
  console.log(`\nscore ${passed}/${results.length} · cost $${report.cost.toFixed(4)} · ${Math.round((Date.now() - started) / 1000)} s`);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  return { passed, total: results.length, cost: report.cost };
}

async function replay({ data, limit }) {
  const { dataDir } = await import('./paths.mjs');
  const src = path.join(dataDir(data), 'events.db');
  if (!fs.existsSync(src)) throw new Error(`no database at ${src}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-replay-'));
  // A consistent copy (WAL included) via VACUUM INTO.
  const { DatabaseSync } = await import('node:sqlite');
  const live = new DatabaseSync(src, { readOnly: true });
  live.exec(`VACUUM INTO '${path.join(tmp, 'events.db').replace(/'/g, "''")}'`);
  live.close();
  process.env.CLAUDE_PLUGIN_DATA = tmp;
  const { openDb } = await import('./db.mjs');
  const { tidyQueue } = await import('./evaluate.mjs');
  const db = openDb(tmp);
  const decided = db.prepare(`
    SELECT c.id, c.title, c.outcome, l.path learned_path FROM candidates c LEFT JOIN learnings l ON l.id = c.learning_id
    WHERE c.decided_at IS NOT NULL AND c.payload IS NOT NULL
      AND (c.outcome = 'rejected_by_user' OR c.outcome LIKE 'approved_%' OR (c.outcome IN ('created', 'patched') AND c.payload LIKE '%"actor":"manual"%') OR c.outcome IN ('created', 'patched'))
    ORDER BY c.decided_at DESC LIMIT ?`).all(Number(limit) || 40)
    .filter((c) => c.outcome === 'rejected_by_user' || c.learned_path || c.outcome.startsWith('approved_'));
  if (!decided.length) {
    console.log('Nothing to replay yet: approve or reject some proposals in the dashboard first.');
    return null;
  }
  // Everything else is set aside; the decided ones wait again, unchecked.
  db.prepare("UPDATE candidates SET outcome = 'replay_ignored' WHERE outcome = 'queued'").run();
  db.prepare("UPDATE changesets SET status = 'superseded' WHERE status IN ('pending', 'stale')").run();
  const mark = db.prepare("UPDATE candidates SET outcome = 'queued', triaged_at = NULL, changeset_id = NULL, decided_at = NULL WHERE id = ?");
  for (const c of decided) mark.run(c.id);
  const report = await tidyQueue(db, { autonomy: 'queue' });
  let agree = 0;
  const rows = [];
  for (const c of decided) {
    const r = db.prepare('SELECT c.outcome, c.note, cs.file FROM candidates c LEFT JOIN changesets cs ON cs.id = c.changeset_id WHERE c.id = ?').get(c.id);
    const userKept = c.outcome !== 'rejected_by_user';
    // An approved learning is in its file now: "covered by that file" agrees with you.
    const coveredByItself = c.learned_path && /covered/.test(r.note || '') && (r.note || '').toLowerCase().includes(path.basename(c.learned_path).toLowerCase());
    const systemKept = r.outcome === 'queued' || coveredByItself;
    const ok = userKept === systemKept;
    if (ok) agree++;
    rows.push(`${ok ? 'AGREE   ' : 'DISAGREE'} you ${userKept ? 'kept   ' : 'rejected'} · now ${r.outcome}${r.file ? ` → ${path.basename(r.file)}` : ''} · ${c.title.slice(0, 60)}${ok ? '' : ` · ${String(r.note || '').slice(0, 100)}`}`);
  }
  db.close();
  for (const l of rows) console.log(l);
  console.log(`\nagreement ${agree}/${decided.length} (${Math.round((agree / decided.length) * 100)}%) · cost $${report.cost.toFixed(4)}`);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  return { agree, total: decided.length, cost: report.cost };
}

/**
 * The two calls that read sessions, scored against cases taken from real mistakes
 * (test/eval/sessions.json): the corrections instrument (which user turns it counts)
 * and the end-of-session reviewer (what it proposes). Models vary from run to run, so
 * each case runs `runs` times and the score is the share of runs that got it right.
 */
async function sessionsEval({ model, runs = 2, only = null }) {
  const spec = JSON.parse(fs.readFileSync(path.join(here, '..', 'test', 'eval', 'sessions.json'), 'utf8'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ouroboros-eval-'));
  process.env.OUROBOROS_REVIEWER_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || '';
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.CLAUDE_PLUGIN_DATA = path.join(tmp, 'data');
  const worker = await import('./review-worker.mjs');
  const { buildDigest } = await import('./transcript.mjs');
  const use = model || 'haiku';
  const digestOf = (c) => {
    const entries = c.turns.map(([who, text]) => (who === 'u'
      ? { type: 'user', origin: { kind: 'human' }, message: { content: text } }
      : { type: 'assistant', message: { content: [{ type: 'text', text }] } }));
    return buildDigest(entries, { fromLine: c.from || 0, contextTurns: 3 }).text;
  };
  const started = Date.now();
  let cost = 0;
  let good = 0;
  let total = 0;
  const call = async (prompt, schema) => {
    const r = await worker.runModel({ prompt, schema, model: use });
    cost += Number(r.total_cost_usd) || 0;
    return r.structured_output;
  };
  const tally = (id, results) => {
    const ok = results.filter((r) => r.ok).length;
    good += ok;
    total += results.length;
    const miss = results.filter((r) => !r.ok).map((r) => r.why).filter(Boolean);
    console.log(`${ok === results.length ? 'PASS' : ok ? 'FLAKY' : 'FAIL'}  ${pad(id, 44)} ${ok}/${results.length}${miss.length ? `  ${[...new Set(miss)].join(' | ').slice(0, 200)}` : ''}`);
  };
  console.log(`corrections instrument (${use}, ${runs} runs per case)`);
  for (const c of spec.instrument.filter((x) => !only || only.includes(x.id))) {
    const results = [];
    for (let i = 0; i < runs; i++) {
      const out = await call(worker.correctionsPrompt({ digest: digestOf(c) }), worker.CORRECTIONS_ONLY_SCHEMA);
      const counted = new Set((out.corrections || []).map((x) => x.user_turn));
      const missed = c.must.filter((n) => !counted.has(n));
      const wrong = c.mustNot.filter((n) => counted.has(n));
      results.push({ ok: !missed.length && !wrong.length, why: [missed.length ? `missed #${missed.join(',#')}` : '', wrong.length ? `counted #${wrong.join(',#')}` : ''].filter(Boolean).join(' ') });
    }
    tally(c.id, results);
  }
  console.log(`\nend-of-session reviewer (${use}, ${runs} runs per case)`);
  for (const c of spec.reviewer.filter((x) => !only || only.includes(x.id))) {
    const results = [];
    for (let i = 0; i < runs; i++) {
      const out = await call(worker.learnPrompt({ digest: digestOf(c), inventory: c.inventory || '(nothing saved yet)', state: c.state || '', lang: 'en' }), worker.LEARN_SCHEMA);
      const items = out.items || [];
      const textOf = (it) => [it.title, it.text, it.description, it.body].filter(Boolean).join(' ');
      const e = c.expect;
      const why = [];
      if (e.max !== undefined && items.length > e.max) why.push(`proposed ${items.length}: ${items.map((it) => it.title).join('; ').slice(0, 120)}`);
      for (const s of e.some || []) {
        const hit = items.find((it) => new RegExp(s.match, 'i').test(textOf(it)) && (!s.kind || it.kind === s.kind) && (!s.refines || it.refines === s.refines));
        if (!hit) why.push(`no item /${s.match}/${s.kind ? ` as ${s.kind}` : ''}${s.refines ? ` refining ${s.refines}` : ''}`);
      }
      for (const n of e.none || []) {
        const hit = items.find((it) => new RegExp(n, 'i').test(textOf(it)));
        if (hit) why.push(`proposed /${n}/: ${hit.title}`);
      }
      results.push({ ok: !why.length, why: why.join('; ') });
    }
    tally(c.id, results);
  }
  console.log(`\nscore ${good}/${total} runs right · cost $${cost.toFixed(4)} · ${Math.round((Date.now() - started) / 1000)} s`);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  return { good, total, cost };
}

const a = args(process.argv.slice(2));
if (a.synthetic) await synthetic({ model: typeof a.model === 'string' ? a.model : null, judge: typeof a.judge === 'string' ? a.judge : null });
else if (a.sessions) await sessionsEval({ model: typeof a.model === 'string' ? a.model : null, runs: Number(a.runs) || 2, only: typeof a.only === 'string' ? a.only.split(',') : null });
else if (a.replay) await replay({ data: typeof a.data === 'string' ? a.data : undefined, limit: a.limit });
else console.log('usage: node eval.mjs --synthetic [--model <m>] [--judge <m>] | --replay [--data <dir>] [--limit <n>]');
