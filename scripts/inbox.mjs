// The inbox: everything that waits for the user's decision, and the decisions on it.
// Shared by the dashboard (buttons) and the `inbox` skill (one item at a time, in the
// conversation, where Claude and the user can discuss and edit an item before deciding).
//
// Entry keys: "cf:<id>" a conflict with a written rule, "cs:<id>" a change to an existing
// file (changeset), "it:<id>" a new item (memory, skill, profile fact), "sg:<id>" a fix the
// project could make once (suggested instead of learning a workaround).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.mjs';
import { applyChangeset, applyEdits, claimsOf, getChangeset, hashText, rejectChangeset } from './changesets.mjs';
import { containsSecret, decideQueued, writeText } from './curator.mjs';
import { projectKey } from './paths.mjs';
import { lineDiff } from './textdiff.mjs';

const CONTEXT_LINES = 2;

function payloadOf(row) {
  try { return JSON.parse(row?.payload || '{}'); } catch { return {}; }
}

function readOrNull(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function oneLine(s, max = 160) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Parse "cf:12" / "cs:5" / "it:33" / "sg:40"; a bare number is a queued item (dashboard keys). */
export function parseKey(key) {
  const m = /^(cf|cs|it|sg):(\d+)$/.exec(String(key ?? '').trim());
  if (m) return { type: m[1], id: Number(m[2]) };
  if (/^\d+$/.test(String(key ?? '').trim())) return { type: 'it', id: Number(key) };
  return null;
}

// ---------- listing ----------

/**
 * What waits for the user, oldest session first: conflicts, changes to files, new items,
 * then suggested fixes. `project` (a directory) keeps the entries of that project and the
 * global ones.
 */
export function inboxEntries(db, { project } = {}) {
  const key = project ? projectKey(project) : null;
  const mine = (row) => !key || !row.project || row.project === key;
  const started = (row) => row.session_started_at || row.ts || row.created_at || 0;
  const conflicts = db.prepare(`
    SELECT c.*, s.started_at session_started_at FROM candidates c LEFT JOIN sessions s ON s.id = c.session_id
    WHERE c.outcome = 'conflict' ORDER BY COALESCE(s.started_at, c.ts), c.id`).all().filter(mine)
    .map((c) => ({ key: `cf:${c.id}`, type: 'conflict', title: c.title, file: c.target || null, project: c.project, cwd: c.cwd, at: started(c) }));
  const changes = db.prepare("SELECT * FROM changesets WHERE status IN ('pending', 'stale') ORDER BY id").all().filter(mine).map((cs) => {
    const claims = claimsOf(db, cs.id);
    return {
      key: `cs:${cs.id}`, type: 'change', file: cs.file, project: cs.project, cwd: cs.cwd, stale: cs.status === 'stale', corrects: !!cs.corrects,
      title: claims.length === 1 ? claims[0].title : `${claims.length} updates to ${path.basename(cs.file)}`,
      claims: claims.map((c) => c.title), at: claims.reduce((m, c) => Math.min(m, started(c)), cs.created_at),
    };
  });
  const items = db.prepare(`
    SELECT c.*, s.started_at session_started_at FROM candidates c LEFT JOIN sessions s ON s.id = c.session_id
    WHERE c.outcome = 'queued' AND c.changeset_id IS NULL ORDER BY COALESCE(s.started_at, c.ts), c.id`).all().filter(mine).map((c) => {
    const item = payloadOf(c).item || {};
    return {
      key: `it:${c.id}`, type: 'item', title: c.title, kind: item.kind || c.kind, op: item.op || 'create', file: item.target || null,
      memory_type: item.memory_type || c.memory_type || null, block: item.block || null, project: c.project, cwd: c.cwd, at: started(c),
      evaluated: !!c.triaged_at,
    };
  });
  const suggestions = db.prepare(`
    SELECT c.*, s.started_at session_started_at FROM candidates c LEFT JOIN sessions s ON s.id = c.session_id
    WHERE c.outcome = 'suggested' ORDER BY COALESCE(s.started_at, c.ts), c.id`).all().filter(mine)
    .map((c) => ({ key: `sg:${c.id}`, type: 'suggestion', title: c.title, project: c.project, cwd: c.cwd, at: started(c) }));
  const byTime = (a, b) => a.at - b.at;
  return [...conflicts.sort(byTime), ...changes.sort(byTime), ...items.sort(byTime), ...suggestions.sort(byTime)];
}

const TYPE_LABEL = { conflict: 'Conflict', change: 'Change', item: 'New', suggestion: 'Suggested fix' };

function where(e) {
  if (e.file) return e.file;
  if (e.type === 'item') {
    if (e.kind === 'profile') return `profile (${e.block || 'user'})`;
    return `${e.kind}${e.memory_type ? ` · ${e.memory_type}` : ''}${e.cwd ? ` · ${path.basename(e.cwd)}` : ''}`;
  }
  return e.cwd ? path.basename(e.cwd) : '';
}

export function listText(entries) {
  if (!entries.length) return 'The inbox is empty.';
  const NOUN = { conflict: ['conflict', 'conflicts'], change: ['change to a file', 'changes to files'], item: ['new item', 'new items'], suggestion: ['suggested fix', 'suggested fixes'] };
  const counts = Object.entries(entries.reduce((m, e) => ({ ...m, [e.type]: (m[e.type] || 0) + 1 }), {}))
    .map(([t, n]) => `${n} ${NOUN[t][n > 1 ? 1 : 0]}`);
  const lines = entries.map((e, i) => {
    const flags = [e.stale ? 'stale' : null, e.corrects ? 'rewrites text' : null].filter(Boolean);
    return `${String(i + 1).padStart(2)}. [${e.key}] ${TYPE_LABEL[e.type]}${flags.length ? ` (${flags.join(', ')})` : ''}: ${oneLine(e.title, 110)}\n      → ${where(e)}`;
  });
  return `${entries.length} waiting: ${counts.join(', ')}\n\n${lines.join('\n')}`;
}

// ---------- detail ----------

/** A unified diff of two texts with a little context, for reading in the terminal. */
export function unifiedDiff(before, after, { context = CONTEXT_LINES } = {}) {
  const A = String(before ?? '').split('\n');
  const hunks = lineDiff(before ?? '', after ?? '');
  if (!hunks.length) return '(no change)';
  const out = [];
  let shift = 0;
  for (const h of hunks) {
    const from = Math.max(0, h.at - context);
    const to = Math.min(A.length, h.at + h.before.length + context);
    out.push(`@@ line ${h.at + 1 + shift} @@`);
    for (const l of A.slice(from, h.at)) out.push(`  ${l}`);
    for (const l of h.before) out.push(`- ${l}`);
    for (const l of h.after) out.push(`+ ${l}`);
    for (const l of A.slice(h.at + h.before.length, to)) out.push(`  ${l}`);
    shift += h.after.length - h.before.length;
  }
  return out.join('\n');
}

function claimLines(c) {
  return [
    `- [${c.id}] ${c.title}`,
    c.claim || c.summary ? `    claim: ${oneLine(c.claim || c.summary, 600)}` : null,
    c.evidence ? `    evidence: ${oneLine(c.evidence, 300)}` : null,
    c.note ? `    note: ${oneLine(c.note, 400)}` : null,
  ].filter(Boolean);
}

/** Everything needed to judge one entry: what, where, why, and the exact text change. */
export function showEntry(db, key) {
  const k = parseKey(key);
  if (!k) return { status: 'not_found', reason: `unknown key ${key}` };
  if (k.type === 'cs') {
    const cs = getChangeset(db, k.id);
    if (!cs || !['pending', 'stale'].includes(cs.status)) return { status: 'not_found', reason: 'no pending change with that id' };
    const current = readOrNull(cs.file);
    const edits = JSON.parse(cs.edits);
    const res = current === null ? null : applyEdits(current, edits);
    const claims = claimsOf(db, cs.id);
    const text = [
      `Change ${key} to ${cs.file}${cs.status === 'stale' ? ' (STALE: the file changed since it was composed)' : ''}`,
      cs.corrects ? 'It rewrites existing text (a correction), not only adds.' : 'It only adds text.',
      cs.note ? `Note: ${oneLine(cs.note, 400)}` : null,
      '',
      `Learnings it implements (${claims.length}):`,
      ...claims.flatMap(claimLines),
      '',
      'Edits:',
      ...edits.map((e, i) => `${i + 1}. ${e.append !== undefined ? `append under "${e.section || '(end)'}"` : 'replace'}${e.claims?.length ? ` for [${e.claims.join(', ')}]` : ''}${e.why ? ` — ${oneLine(e.why, 200)}` : ''}`),
      '',
      current === null ? 'The file no longer exists.'
        : res.rejected.length ? `These edits no longer apply to the current file: ${res.rejected.map((r) => r.reason).join('; ')}`
          : `Diff against the current file:\n${unifiedDiff(current, res.after)}`,
    ].filter((l) => l !== null);
    return { status: 'ok', key, type: 'change', file: cs.file, stale: cs.status === 'stale', edits, claims: claims.map((c) => c.id), text: text.join('\n') };
  }
  const c = db.prepare('SELECT c.*, s.started_at session_started_at, s.cwd session_cwd FROM candidates c LEFT JOIN sessions s ON s.id = c.session_id WHERE c.id = ?').get(k.id);
  const expected = { cf: 'conflict', it: 'queued', sg: 'suggested' }[k.type];
  if (!c || c.outcome !== expected || (k.type === 'it' && c.changeset_id)) return { status: 'not_found', reason: `no ${TYPE_LABEL[{ cf: 'conflict', it: 'item', sg: 'suggestion' }[k.type]].toLowerCase()} waiting with that id` };
  const when = c.session_started_at ? new Date(c.session_started_at).toISOString().slice(0, 16).replace('T', ' ') : null;
  const origin = `From ${c.session_id === 'manual' || c.session_id === 'inloop' ? `a ${c.session_id} save` : `session ${c.session_id}`}${when ? ` (${when})` : ''}${c.cwd ? ` in ${c.cwd}` : ''}.`;
  if (k.type === 'cf') {
    const current = c.target ? readOrNull(c.target) : null;
    const text = [
      `Conflict ${key}: ${c.title}`,
      origin,
      `It contradicts what is written in: ${c.target || '(unknown file)'}${c.target && current === null ? ' (file no longer exists)' : ''}`,
      '',
      `New claim: ${c.claim || c.summary || ''}`,
      c.summary && c.claim && c.summary !== c.claim ? `As proposed:\n${c.summary}` : null,
      c.evidence ? `Evidence: ${oneLine(c.evidence, 400)}` : null,
      c.note ? `Why it was held: ${c.note.replace(/^conflict:\s*/, '')}` : null,
      '',
      'Decide: "keep" (the written rule stands; the claim is rejected) or "new" (it is a new rule: the file is corrected to say it).',
    ].filter((l) => l !== null);
    return { status: 'ok', key, type: 'conflict', file: c.target || null, text: text.join('\n') };
  }
  if (k.type === 'sg') {
    const text = [
      `Suggested fix ${key}: ${c.title}`,
      origin,
      '',
      c.summary ? `What was learned: ${c.summary}` : null,
      c.note ? `Why a fix instead: ${c.note.replace(/^suggest(ed)?:\s*/, '')}` : null,
      c.evidence ? `Evidence: ${oneLine(c.evidence, 400)}` : null,
      '',
      'Make the fix in the project (then "done"), or "dismiss" it.',
    ].filter((l) => l !== null);
    return { status: 'ok', key, type: 'suggestion', text: text.join('\n') };
  }
  const item = payloadOf(c).item || {};
  const fields = item.kind === 'profile'
    ? [`Profile fact (${item.block || 'user'}): ${item.text || c.title}`]
    : [
      `Kind: ${item.kind}${item.memory_type ? ` · ${item.memory_type}` : ''} · ${item.scope || 'project'}${item.op === 'patch' ? ` · patch of ${item.target}` : ''}`,
      item.name ? `Name: ${item.name}` : null,
      `Title: ${item.title || c.title}`,
      item.description ? `Description: ${item.description}` : null,
      item.project_dir || c.cwd ? `Project: ${item.project_dir || c.cwd}` : null,
      item.body ? `Body:\n${item.body}` : null,
      item.append !== undefined ? `Adds under "${item.section || '(end)'}":\n${item.append}` : null,
      item.old !== undefined ? `Replaces:\n${item.old}\nwith:\n${item.new ?? ''}` : null,
    ];
  const text = [
    `New ${item.kind || c.kind} ${key}: ${c.title}`,
    origin,
    `Confidence ${c.confidence ?? item.confidence ?? '?'}${c.triaged_at ? '' : ' · not evaluated yet (no duplicate check against existing knowledge has run)'}.`,
    c.evidence || item.evidence ? `Evidence: ${oneLine(c.evidence || item.evidence, 400)}` : null,
    c.note ? `Note: ${oneLine(c.note, 400)}` : null,
    '',
    ...fields,
  ].filter((l) => l !== null);
  return { status: 'ok', key, type: 'item', item, text: text.join('\n') };
}

// ---------- decisions ----------

function note(db, id, text) {
  if (text) db.prepare("UPDATE candidates SET note = TRIM(COALESCE(note, '') || ' ' || ?) WHERE id = ?").run(`(you: ${oneLine(text, 300)})`, id);
}

/** Approve an entry as it is. */
export function approve(db, key) {
  const k = parseKey(key);
  if (!k) return { status: 'not_found', reason: `unknown key ${key}` };
  if (k.type === 'cs') {
    if (getChangeset(db, k.id)?.status === 'stale') return { status: 'stale', reason: 'the file changed since this was composed: edit it against the current file, or let the editor compose it again' };
    return applyChangeset(db, k.id, { actor: 'manual' });
  }
  if (k.type === 'it') return decideQueued(db, k.id, true);
  if (k.type === 'cf') return { status: 'invalid', reason: 'a conflict is settled with resolve (keep or new)' };
  return { status: 'invalid', reason: 'a suggested fix is made in the project, then marked done or dismissed' };
}

/**
 * Reject an entry, with an optional reason (kept with it). Rejecting one learning of a
 * change (`it:<id>` of a claim) composes the rest again: `recompose` in the result.
 */
export function reject(db, key, { reason } = {}) {
  const k = parseKey(key);
  if (!k) return { status: 'not_found', reason: `unknown key ${key}` };
  if (k.type === 'cs') {
    for (const c of claimsOf(db, k.id)) note(db, c.id, reason);
    return rejectChangeset(db, k.id);
  }
  if (k.type === 'cf') return resolveConflict(db, key, 'keep', { reason });
  if (k.type === 'sg') return dismiss(db, key, { reason });
  note(db, k.id, reason);
  return decideQueued(db, k.id, false);
}

/** Mark a suggested fix as handled: `done` (the user made it) or dismissed. */
export function dismiss(db, key, { reason, done = false } = {}) {
  const k = parseKey(key);
  if (!k || (k.type !== 'sg' && k.type !== 'it')) return { status: 'not_found', reason: `not a suggestion: ${key}` };
  note(db, k.id, done ? reason || 'fixed in the project' : reason);
  const r = db.prepare("UPDATE candidates SET outcome = ?, decided_at = ? WHERE id = ? AND outcome = 'suggested'").run(done ? 'fixed' : 'dismissed', Date.now(), k.id);
  return r.changes ? { status: done ? 'fixed' : 'dismissed' } : { status: 'not_found', reason: 'no suggestion waiting with that id' };
}

/** Check edits against the current text of a file, without writing. */
function tryEdits(file, edits) {
  if (!Array.isArray(edits) || !edits.length) return { error: 'no edits given' };
  const current = readOrNull(file);
  if (current === null) return { error: `the file no longer exists: ${file}` };
  const res = applyEdits(current, edits);
  if (res.rejected.length) return { error: res.rejected.map((r) => `${r.reason}${r.edit.old ? ` (old: "${oneLine(r.edit.old, 60)}")` : ''}`).join('; ') };
  if (!res.applied.length) return { error: 'nothing to apply' };
  return { current, ...res };
}

/**
 * Approve a change with the user's version of it. For a change to a file (`cs:`) the
 * edits replace the proposed ones (`drop` lists learnings of it the user rejected); for a
 * new item (`it:`) the given fields replace the proposed ones (`replace: true` swaps the
 * whole item, e.g. to route it to another file).
 */
export function editAndApprove(db, key, { edits, drop = [], item, replace = false, reason } = {}) {
  const k = parseKey(key);
  if (!k) return { status: 'not_found', reason: `unknown key ${key}` };
  if (k.type === 'cs') {
    const cs = getChangeset(db, k.id);
    if (!cs || !['pending', 'stale'].includes(cs.status)) return { status: 'not_found', reason: 'no pending change with that id' };
    const t = tryEdits(cs.file, edits);
    if (t.error) return { status: 'invalid', reason: t.error };
    const now = Date.now();
    const dropped = new Set(drop.map(Number));
    for (const c of claimsOf(db, k.id)) {
      if (!dropped.has(c.id)) continue;
      db.prepare("UPDATE candidates SET outcome = 'rejected_by_user', decided_at = ? WHERE id = ?").run(now, c.id);
    }
    if (!claimsOf(db, k.id).length) return { status: 'invalid', reason: 'every learning of this change was dropped: reject it instead' };
    for (const c of claimsOf(db, k.id)) note(db, c.id, reason || 'edited before approving');
    db.prepare("UPDATE changesets SET edits = ?, base_hash = ?, corrects = ?, status = 'pending', note = ? WHERE id = ?")
      .run(JSON.stringify(t.applied), hashText(t.current), t.applied.some((e) => e.corrects) ? 1 : 0, 'edited by you before approving', k.id);
    return { ...applyChangeset(db, k.id, { actor: 'manual' }), edited: true };
  }
  if (k.type === 'it') {
    const c = db.prepare("SELECT * FROM candidates WHERE id = ? AND outcome = 'queued'").get(k.id);
    if (!c) return { status: 'not_found', reason: 'no queued item with that id' };
    if (c.changeset_id) return { status: 'invalid', reason: `it is part of change cs:${c.changeset_id}: edit that change` };
    if (!item || typeof item !== 'object') return { status: 'invalid', reason: 'no item fields given' };
    const p = payloadOf(c);
    const next = replace ? { ...item } : { ...(p.item || {}), ...item };
    if (containsSecret(next.title, next.description, next.body, next.text, next.append, next.new)) return { status: 'rejected', reason: 'looks like it contains a secret' };
    db.prepare('UPDATE candidates SET payload = ?, title = ? WHERE id = ?')
      .run(JSON.stringify({ ...p, item: next }), String(next.title || next.text || c.title).slice(0, 200), c.id);
    note(db, c.id, reason || 'edited before approving');
    return { ...decideQueued(db, k.id, true), edited: true };
  }
  if (k.type === 'cf') return resolveConflict(db, key, 'new', { edits, reason });
  return { status: 'invalid', reason: 'a suggested fix is made in the project, not edited here' };
}

/**
 * Settle a conflict. "keep": the written rule stands and the claim is rejected. "new": it
 * is a new rule; with `edits` (the correction, composed in the conversation) the file is
 * written now, otherwise the claim goes back to the queue for the editor to compose
 * (`requeued`: run the evaluation to get the change).
 */
export function resolveConflict(db, key, choice, { edits, reason } = {}) {
  const k = parseKey(key);
  const c = k?.type === 'cf' || k?.type === 'it' ? db.prepare("SELECT * FROM candidates WHERE id = ? AND outcome = 'conflict'").get(k.id) : null;
  if (!c) return { status: 'not_found', reason: 'no conflict waiting with that id' };
  if (choice !== 'new') {
    note(db, c.id, reason);
    db.prepare("UPDATE candidates SET outcome = 'rejected_by_user', decided_at = ? WHERE id = ?").run(Date.now(), c.id);
    return { status: 'rejected_by_user', title: c.title };
  }
  if (edits?.length) {
    if (!c.target) return { status: 'invalid', reason: 'the conflict names no file to correct' };
    const t = tryEdits(c.target, edits);
    if (t.error) return { status: 'invalid', reason: t.error };
    const r = writeText(db, {
      file: c.target, after: t.after, actor: 'manual', expectBefore: t.current, title: c.title,
      why: `You settled a conflict: it is a new rule. ${oneLine(c.claim || c.summary, 400)}${reason ? ` (${oneLine(reason, 200)})` : ''}`,
      confidence: Math.max(0.7, c.confidence ?? 0.6), sessionId: c.session_id,
    });
    if (r.status !== 'patched') return r;
    db.prepare("UPDATE candidates SET outcome = 'patched', learning_id = ?, decided_at = ?, note = TRIM(COALESCE(note, '') || ' (you: it is a new rule)') WHERE id = ?").run(r.id, Date.now(), c.id);
    return { ...r, title: c.title };
  }
  db.prepare("UPDATE candidates SET outcome = 'queued', triaged_at = NULL, decided_at = NULL, payload = ?, note = ? WHERE id = ?")
    .run(JSON.stringify({ ...payloadOf(c), confirmed: true }), 'you said it is a new rule', c.id);
  return { status: 'requeued', title: c.title };
}

/**
 * What an edit would do, without writing: the diff against the current file (a change or
 * a conflict), or the item as it would be saved (a new item).
 */
export function previewEdit(db, key, { edits, item, replace = false } = {}) {
  const k = parseKey(key);
  if (!k) return { status: 'not_found', reason: `unknown key ${key}` };
  if (k.type === 'cs' || k.type === 'cf') {
    const file = k.type === 'cs' ? getChangeset(db, k.id)?.file
      : db.prepare("SELECT target FROM candidates WHERE id = ? AND outcome = 'conflict'").get(k.id)?.target;
    if (!file) return { status: 'not_found', reason: 'nothing waiting with that key, or no file to change' };
    const t = tryEdits(file, edits);
    if (t.error) return { status: 'invalid', reason: t.error };
    const rewrites = t.applied.some((e) => e.corrects);
    return { status: 'ok', text: `${file}${rewrites ? ' (rewrites existing text)' : ''}\n${unifiedDiff(t.current, t.after)}` };
  }
  if (k.type === 'it') {
    const c = db.prepare("SELECT * FROM candidates WHERE id = ? AND outcome = 'queued' AND changeset_id IS NULL").get(k.id);
    if (!c) return { status: 'not_found', reason: 'no queued item with that id' };
    const next = replace ? { ...item } : { ...(payloadOf(c).item || {}), ...(item || {}) };
    return { status: 'ok', text: JSON.stringify(next, null, 2) };
  }
  return { status: 'invalid', reason: 'nothing to preview for a suggested fix' };
}

// ---------- CLI ----------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
    else { args[a.slice(2)] = next; i++; }
  }
  return args;
}

function readInput(args) {
  if (args.file) return fs.readFileSync(args.file, 'utf8');
  if (process.stdin.isTTY) return '';
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

const ICON = { created: '📝 learned', patched: '📝 updated', rejected_by_user: '✗ rejected', dismissed: '✗ dismissed', fixed: '✓ fixed', requeued: '⏳ queued for the editor', stale: '⚠ stale', invalid: '⚠ not applied', not_found: '⚠ not found', rejected: '✗ refused', duplicate: '↺ duplicate' };

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.data) process.env.CLAUDE_PLUGIN_DATA = args.data;
  const [cmd, key, choice] = args._;
  const db = openDb();
  try {
    let r;
    if (cmd === 'list') {
      const entries = inboxEntries(db, { project: args.project && args.project !== true ? args.project : undefined });
      console.log(args.json ? JSON.stringify(entries) : listText(entries));
      return;
    }
    if (cmd === 'show') {
      r = showEntry(db, key);
      console.log(r.status === 'ok' ? r.text : `⚠ ${r.reason}`);
      return;
    }
    const reason = typeof args.reason === 'string' ? args.reason : undefined;
    if (cmd === 'approve') r = approve(db, key);
    else if (cmd === 'reject') r = reject(db, key, { reason });
    else if (cmd === 'dismiss') r = dismiss(db, key, { reason });
    else if (cmd === 'done') r = dismiss(db, key, { reason, done: true });
    else if (cmd === 'edit' || cmd === 'resolve' || cmd === 'preview') {
      const raw = readInput(args).replace(/^﻿/, '').trim();
      let input = {};
      if (raw) {
        try { input = JSON.parse(raw); } catch (err) { console.log(`⚠ invalid JSON: ${err.message}`); process.exitCode = 1; return; }
      }
      if (cmd === 'preview') {
        const p = previewEdit(db, key, input);
        console.log(p.status === 'ok' ? p.text : `⚠ ${p.reason}`);
        return;
      }
      r = cmd === 'edit' ? editAndApprove(db, key, { ...input, reason: input.reason || reason })
        : resolveConflict(db, key, choice, { edits: input.edits, reason: input.reason || reason });
    } else {
      console.log('usage: inbox.mjs list [--project <dir>] | show <key> | preview <key> (JSON on stdin) | approve <key> | reject <key> [--reason ..] | edit <key> (JSON on stdin) | resolve <cf:key> keep|new [JSON on stdin] | done <sg:key> | dismiss <sg:key>');
      process.exitCode = 1;
      return;
    }
    // A conflict sent back to the queue, or a change that lost one learning, needs the
    // editor: run the evaluation in the background.
    if (r.status === 'requeued' || r.recompose) {
      const { spawnWorker } = await import('./hook.mjs');
      spawnWorker(['--drain']);
    }
    console.log(`${ICON[r.status] || r.status}: ${r.title || key}${r.reason ? ` — ${r.reason}` : ''}${r.path ? ` → ${r.path}` : ''}`);
    console.log(JSON.stringify(r));
  } finally {
    db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
