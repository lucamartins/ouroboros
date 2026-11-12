// Stand-in for `claude -p` in the evaluation-queue tests: answers as fake-claude.mjs
// does, except that
// - EDITORFAIL in an editor prompt, or SCREENFAIL in a screening prompt, fails the call;
// - SKIPCLAIM: the editor answers for every claim but the one that says it;
// - FAKE_QUEUE_RACE (JSON { during: 'editor' | 'screen', do, once, ... }) makes "another
//   process" act on the database while the call runs, once: a live session's patch
//   ('inloop-patch'), the user rejecting an entry ('reject'), or another process taking
//   the evaluation lease after this one was suspended past its expiry ('steal-lease');
// - FAKE_QUEUE_RACE may also run an SQL statement ('sql') or append text to a file ('write')
//   while the call runs;
// - FAKE_QUEUE_LOG names a file each call appends its kind to;
// - FAKE_QUEUE_PROMPTS names a folder each call writes its prompt to (<n>-<kind>.txt);
// - FAKE_QUEUE_MOD names a module exporting screen(ctx) and/or editor(ctx), ctx = { prompt, out }
//   (out: the default structured output); what it returns replaces the answer, undefined keeps it;
// - BADFRAG in an editor prompt: every edit's fragment is changed to one the file does not hold.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, '..', '..', 'scripts');
const load = (name) => import(pathToFileURL(path.join(scripts, name)).href);

let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', async () => {
  const args = process.argv.slice(2);
  const schema = args[args.indexOf('--json-schema') + 1] || '';
  const kind = schema.includes('"edits"') ? 'editor' : schema.includes('"verdicts"') ? 'screen' : 'other';
  if (process.env.FAKE_QUEUE_LOG) fs.appendFileSync(process.env.FAKE_QUEUE_LOG, `${kind}\n`);
  if (process.env.FAKE_QUEUE_PROMPTS) {
    fs.mkdirSync(process.env.FAKE_QUEUE_PROMPTS, { recursive: true });
    fs.writeFileSync(path.join(process.env.FAKE_QUEUE_PROMPTS, `${fs.readdirSync(process.env.FAKE_QUEUE_PROMPTS).length + 1}-${kind}.txt`), prompt);
  }
  await race(kind);
  if ((kind === 'editor' && prompt.includes('EDITORFAIL')) || (kind === 'screen' && prompt.includes('SCREENFAIL'))) {
    process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'model refused', total_cost_usd: 0.0042 }));
    return;
  }
  const r = spawnSync(process.execPath, [path.join(here, 'fake-claude.mjs'), ...args], { input: prompt, encoding: 'utf8' });
  const out = JSON.parse(r.stdout);
  if (kind === 'editor' && prompt.includes('SKIPCLAIM') && out.structured_output) {
    const skip = new Set([...prompt.matchAll(/<claim id="(\d+)"[^>]*>\n([\s\S]*?)\n<\/claim>/g)].filter((m) => m[2].includes('SKIPCLAIM')).map((m) => Number(m[1])));
    const s = out.structured_output;
    s.claims = s.claims.filter((c) => !skip.has(c.id));
    s.edits = s.edits.map((e) => ({ ...e, claims: e.claims.filter((id) => !skip.has(id)) })).filter((e) => e.claims.length);
  }
  if (kind === 'editor' && prompt.includes('BADFRAG') && out.structured_output) {
    out.structured_output.edits = out.structured_output.edits.map((e) => ({ ...e, old: `${e.old} (not in the file)` }));
  }
  if (process.env.FAKE_QUEUE_MOD && out.structured_output) {
    const mod = await import(pathToFileURL(process.env.FAKE_QUEUE_MOD).href);
    const replaced = await mod[kind]?.({ prompt, out: out.structured_output });
    if (replaced !== undefined) out.structured_output = replaced;
  }
  process.stdout.write(JSON.stringify(out));
});

async function race(kind) {
  const plan = JSON.parse(process.env.FAKE_QUEUE_RACE || '{}');
  if (plan.during !== kind || !plan.once || fs.existsSync(plan.once)) return;
  fs.writeFileSync(plan.once, 'done');
  const { openDb, acquireLease } = await load('db.mjs');
  const db = openDb();
  try {
    if (plan.do === 'inloop-patch') {
      const curator = await load('curator.mjs');
      curator.apply(db, { cwd: plan.cwd, session_id: 'live', trigger: 'periodic', items: [plan.item] }, { actor: 'inloop', autonomy: 'auto' });
    } else if (plan.do === 'reject') {
      const inbox = await load('inbox.mjs');
      inbox.reject(db, plan.key, { reason: 'not this' });
    } else if (plan.do === 'sql') {
      db.exec(plan.sql);
    } else if (plan.do === 'write') {
      fs.appendFileSync(plan.file, plan.text);
    } else if (plan.do === 'steal-lease') {
      const cur = db.prepare("SELECT value FROM meta WHERE key = 'lease:evaluate'").get().value;
      db.prepare("UPDATE meta SET value = ? WHERE key = 'lease:evaluate'").run(`${Date.now() - 1000}|${cur.split('|').slice(1).join('|')}`);
      fs.writeFileSync(`${plan.once}.token`, String(acquireLease(db, 'evaluate')));
    }
  } finally {
    db.close();
  }
}
