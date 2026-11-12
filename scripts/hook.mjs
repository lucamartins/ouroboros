// Single entry point for every Ouroboros hook: `node hook.mjs <EventName>` with the
// hook input JSON on stdin. Capture hooks only measure: they print nothing, never
// block, and always exit 0.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { options, optionsFromEnvOnly } from './config.mjs';
import { autoMemoryStatus, classifyPath, dataDir, memoryDirFor, normalize, projectIdFor, skillNameFromPath } from './paths.mjs';
import { rekeyProjects, retireProfile } from './migrate.mjs';
import { RUBRIC_SHORT } from './rubric.mjs';
import { sessionStateText } from './session-state.mjs';
import { globMatch, loadSettings } from './settings.mjs';
import { contextTokens, countLines, inheritedLines, isHumanPrompt, readTranscript, usageSince } from './transcript.mjs';

const MIN_NODE = [22, 13];
/** Tool calls that make a turn "long" (recorded as a metric only). */
export const LONG_TURN_TOOL_CALLS = 15;
/** Early (recovery) reviews are at least this many user turns apart from any review. */
export const EARLY_REVIEW_MIN_TURNS = 5;
export const MAINTENANCE_EVERY_MS = 20 * 60 * 60 * 1000;
/** A review left to finish later is tried again after this long. */
const RETRY_AFTER_MS = 30 * 60 * 1000;
/** A session with no event for this long and no SessionEnd is taken as ended. */
export const IDLE_AS_ENDED_MS = 6 * 60 * 60 * 1000;
/** ...unless its last event is older than this: then it is left to a backfill. */
const IDLE_AS_ENDED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const here = path.dirname(fileURLToPath(import.meta.url));
// db.mjs needs node:sqlite, so it is loaded only after the Node version check.
let dbApi;

export function nodeSupported(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

/** Stable key used to pair failures with a later success of "the same thing". */
export function targetOf(toolName, input = {}) {
  if (input.file_path) return `${toolName}:${input.file_path}`;
  if (input.notebook_path) return `${toolName}:${input.notebook_path}`;
  if ((toolName === 'Bash' || toolName === 'PowerShell') && typeof input.command === 'string') {
    // First real command of the first line, without leading `cd X &&`, env assignments
    // or flags: "cd api && dotnet test --filter X" -> "dotnet test".
    let line = input.command.split('\n').find((l) => l.trim()) || '';
    line = line.replace(/^\s*(cd|Set-Location|pushd)\s+[^;&|]+(&&|;)\s*/i, '');
    // The first command ends at a shell operator or a redirection: "ls -la && grep x" is "ls".
    const words = [];
    for (const w of line.trim().split(/\s+/)) {
      if (/^(&&|\|\|?|;|&|\d*[<>])/.test(w)) break;
      if (!/^[A-Z_][A-Z0-9_]*=/.test(w)) words.push(w.replace(/;+$/, ''));
      if (w.endsWith(';')) break;
    }
    const cmd = words.filter((w) => w && !w.startsWith('-')).slice(0, 2).join(' ');
    return `${toolName}:${cmd}`;
  }
  return toolName;
}

/** The whole command of a shell call, as one line, to tell a retry from a different invocation. */
function commandText(toolName, input = {}) {
  return COMMAND_TOOL_RE.test(toolName) && typeof input.command === 'string' ? input.command.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function ensureSession(db, input, now) {
  db.prepare(`
    INSERT INTO sessions (id, project, cwd, transcript_path, started_at, last_event_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      transcript_path = COALESCE(excluded.transcript_path, sessions.transcript_path),
      last_event_at = excluded.last_event_at
  `).run(input.session_id, projectIdFor(input.cwd), input.cwd || null, input.transcript_path || null, now, now);
}

function addEvent(db, input, now, kind, target = null, payload = null) {
  db.prepare('INSERT INTO events (session_id, agent_id, ts, kind, target, payload) VALUES (?, ?, ?, ?, ?, ?)')
    .run(input.session_id, input.agent_id || null, now, kind, target, payload ? JSON.stringify(payload) : null);
}

/** First use in a session reinforces a learning (+0.1 confidence, max 0.9). */
const USE_SQL = `
  UPDATE learnings SET uses = uses + 1, last_used_at = :now,
    confidence = MIN(0.9, COALESCE(confidence, 0.5) + CASE WHEN COALESCE(last_used_at, 0) < :sessionStart THEN 0.1 ELSE 0 END)
  WHERE status = 'active' AND `;

function sessionStart(db, sessionId) {
  return db.prepare('SELECT started_at FROM sessions WHERE id = ?').get(sessionId)?.started_at || 0;
}

function countSkillUse(db, name, now, sessionId) {
  const bare = String(name).split(':').pop();
  db.prepare(`${USE_SQL} kind = 'skill' AND name = :name`).run({ now, sessionStart: sessionStart(db, sessionId), name: bare });
}

function countMemoryRead(db, file, now, sessionId) {
  db.prepare(`${USE_SQL} lower(path) = lower(:file)`).run({ now, sessionStart: sessionStart(db, sessionId), file });
}

export const PROTOCOL = `Ouroboros (self-learning) is active. Without being asked, save what you learn through the \`ouroboros:learn\` skill — it deduplicates, routes and can be undone:
- a user preference or way of working, a correction of your approach, a project convention, an environment fact;
- when the user explicitly asks you to remember something, save it right away;
- create or patch a skill when you worked out a reusable multi-step workflow, found the working path after errors, or the user corrected your approach.
${RUBRIC_SHORT} No secrets. After saving, tell the user in one line: "📝 learned: …".`;

/** Projects listed in ~/.ouroboros/config.json `excludeProjects` are left alone entirely. */
export function isExcluded(cwd) {
  if (!cwd) return false;
  const { excludeProjects = [] } = loadSettings();
  return excludeProjects.some((p) => typeof p === 'string' && globMatch(p, cwd));
}

/**
 * Projects listed in `controlProjects` are the control group: Ouroboros measures their
 * sessions with the same instrument and teaches nothing there (no protocol, no reviews
 * that write). "Before and after" compares two periods, in which the work, the model
 * and the user's own habits also changed; a control compares the same weeks.
 */
export function isControl(cwd) {
  if (!cwd) return false;
  const { controlProjects = [] } = loadSettings();
  return controlProjects.some((p) => typeof p === 'string' && globMatch(p, cwd));
}

export const RESULT_RE = /\[ouroboros\]\s*reviewed=(\d+)\s+corrections=(\d+)\s+learned=(\d+)\s+patched=(\d+)/i;

const FILE_TOOL_RE = /^(Edit|MultiEdit|Write|Read|NotebookEdit):/;
const FILE_WRITE_TOOL_RE = /^(Edit|MultiEdit|Write|NotebookEdit)$/;
const COMMAND_TOOL_RE = /^(Bash|PowerShell)$/;

/**
 * Whether a recovery reads as finding the working path: a command that failed at least
 * `minFailures` times and then worked because the command changed, or because another
 * command was run in between. Three other things look the same and are everyday work:
 * an edit or a read retried until it applied; tests that fail until the code is fixed
 * (files were written between the failures and the success: the lesson, if any, is in
 * the code); and the same command repeated until a flaky service answered (nothing
 * changed and nothing else ran). Recoveries recorded before v0.23 carry no such detail
 * and are taken as they were.
 */
export function isWorkingPath(r, minFailures = 2) {
  if (FILE_TOOL_RE.test(String(r?.target || ''))) return false;
  let p;
  try { p = JSON.parse(r.payload || '{}'); } catch { return false; }
  if ((p.failures || 0) < minFailures) return false;
  if (p.edits === undefined) return true;
  if (p.edits > 0) return false;
  return !!p.changed || (p.commands || 0) > 0;
}

/** The recoveries worth showing to a review (see `isWorkingPath`): listing the rest buried the real ones. */
export function significantRecoveries(rows, minFailures = 2) {
  return (rows || []).filter((r) => isWorkingPath(r, minFailures));
}

/**
 * Instructions sent through the Stop hook to ask for a periodic review. Claude Code
 * shows this text to the user every time, so it carries only what changes from one
 * review to the next (the range, the signals, the session's state, the result line);
 * how to review lives in the `learn` skill ("Periodic reviews").
 */
export function reviewRequest({ from, to, trigger, recoveries = [], state = '' }) {
  const why = trigger === 'recovery' ? 'after working through failures' : 'periodic';
  const signals = recoveries.map((r) => {
    let p = {};
    try { p = JSON.parse(r.payload || '{}'); } catch { /* ignore */ }
    return `- \`${r.target}\` failed ${p.failures || '?'}× before working${p.first_error ? ` (first error: ${String(p.first_error).split('\n')[0].slice(0, 120)})` : ''}`;
  });
  return [
    `Ouroboros learning review (${why}): user turns ${from}–${to} only. Follow "Periodic reviews" in the \`ouroboros:learn\` skill; be brief, and say so in one line when nothing is worth keeping.`,
    signals.length ? `Worked through failures:\n${signals.join('\n')}` : '',
    state,
    'End with exactly this line: [ouroboros] reviewed=<user turns reviewed> corrections=<n> learned=<items created> patched=<items updated>',
  ].filter(Boolean).join('\n');
}

/**
 * Whether the turn that just ended found a working path after failures (`isWorkingPath`),
 * here or inside a subagent. A long turn alone is not a signal: a third of real turns
 * use 15+ tool calls, and most have nothing new to learn.
 */
export function recoveredThisTurn(db, sessionId, minFailures) {
  return db.prepare("SELECT target, payload FROM events WHERE session_id = ? AND kind = 'recovery' AND ts >= ?").all(sessionId, turnStartOf(db, sessionId))
    .some((r) => isWorkingPath(r, minFailures));
}

/** When the session's current user turn started (0 before the first one). */
function turnStartOf(db, sessionId) {
  return db.prepare("SELECT MAX(ts) t FROM events WHERE session_id = ? AND kind = 'turn'").get(sessionId).t || 0;
}

/** At most one early review every EARLY_REVIEW_MIN_TURNS user turns (after any review request). */
function earlyAllowed(db, sessionId, turns) {
  const last = db.prepare("SELECT payload FROM events WHERE session_id = ? AND kind IN ('review_requested', 'review_skipped') ORDER BY id DESC LIMIT 1").get(sessionId);
  if (!last) return true;
  let at = 0;
  try { at = JSON.parse(last.payload || '{}').turns?.[1] || 0; } catch { /* ignore */ }
  return turns - at >= EARLY_REVIEW_MIN_TURNS;
}

/**
 * A forked session (SessionStart `source: "fork"`) starts with a copy of its parent's
 * transcript under a new id, so its cursors at 0 would review and measure the parent's
 * turns a second time. Moves them past the copy (`inheritedLines`); returns that line.
 * Done when the transcript is read, not at SessionStart, so it does not matter whether
 * the copy is on disk yet when that hook runs.
 */
export function skipInherited(db, sessionId, entries) {
  const s = db.prepare('SELECT started_at FROM sessions WHERE id = ?').get(sessionId);
  if (!s || !entries?.length) return 0;
  // Without a SessionStart that said "fork" (a backfilled session) only the transcript's own marker counts.
  const forked = !!s.started_at && !!db.prepare("SELECT 1 FROM events WHERE session_id = ? AND kind = 'session_start' AND target = 'fork'").get(sessionId);
  const n = inheritedLines(entries, forked ? s.started_at : null);
  if (n) {
    db.prepare(`UPDATE sessions SET review_cursor = MAX(review_cursor, :n), measure_cursor = MAX(measure_cursor, :n),
      review_requested_line = MAX(COALESCE(review_requested_line, 0), :n) WHERE id = :id`).run({ n, id: sessionId });
  }
  return n;
}

const LEARN_SKILL_RE = /^(ouroboros:)?learn$/;

/**
 * Whether a step that saves learnings failed or was denied in entries [fromLine, end):
 * an error result for a `Skill` call of the learn skill, for a shell call that runs
 * `curator.mjs` (the skill's apply step), or for any tool called after the learn skill
 * (the Write of the payload file, a read it needed).
 */
export function learnStepFailed(entries, fromLine = 0) {
  const learnCalls = new Set();
  let learning = false;
  for (let i = fromLine; i < entries.length; i++) {
    const e = entries[i];
    if (!e || e.isSidechain || !Array.isArray(e.message?.content)) continue;
    for (const c of e.message.content) {
      if (e.type === 'assistant' && c?.type === 'tool_use') {
        const ti = c.input || {};
        if ((c.name === 'Skill' && LEARN_SKILL_RE.test(String(ti.skill || ''))) || (COMMAND_TOOL_RE.test(c.name) && /curator\.mjs/.test(String(ti.command || '')))) learning = true;
        if (learning) learnCalls.add(c.id);
      } else if (e.type === 'user' && c?.type === 'tool_result' && c.is_error && learnCalls.has(c.tool_use_id)) return true;
    }
  }
  return false;
}

/**
 * A review that did not close its stretch (it could not save, or left no result line)
 * leaves the cursor where it was, so the end-of-session review reads the stretch. A later
 * in-session review that succeeds moves the cursor to the end of the transcript, so it
 * has to be asked to cover the stretch too: the first turn not yet saved is kept in an
 * event, and the next request starts there.
 */
function markUnsaved(db, input, now) {
  const last = db.prepare("SELECT payload FROM events WHERE session_id = ? AND kind = 'review_requested' ORDER BY id DESC LIMIT 1").get(input.session_id);
  let from = null;
  try { from = JSON.parse(last?.payload || '{}').turns?.[0] ?? null; } catch { /* ignore */ }
  if (from) addEvent(db, input, now, 'review_unsaved', null, { from });
}

/** The first turn an earlier in-session review left unsaved, if no review has succeeded since. */
function unsavedFrom(db, sessionId) {
  const u = db.prepare("SELECT ts, payload FROM events WHERE session_id = ? AND kind = 'review_unsaved' ORDER BY id DESC LIMIT 1").get(sessionId);
  if (!u) return null;
  if (db.prepare("SELECT 1 FROM reviews WHERE session_id = ? AND mode = 'inloop' AND status = 'ok' AND ts >= ?").get(sessionId, u.ts)) return null;
  try { return JSON.parse(u.payload || '{}').from || null; } catch { return null; }
}

/** Record the outcome of a requested in-loop review and move the cursor. */
function finishInloopReview(db, input, s, now) {
  const m = RESULT_RE.exec(String(input.last_assistant_message || ''));
  let entries = null;
  try { entries = input.transcript_path ? readTranscript(input.transcript_path) : null; } catch { /* unreadable */ }
  const usage = entries ? usageSince(entries, s.review_requested_line || 0) : null;
  const base = {
    session: input.session_id, trigger: s.review_trigger, model: usage?.model,
    input: usage?.input || 0, output: usage?.output || 0, cacheRead: usage?.cacheRead || 0, cacheWrite: usage?.cacheWrite || 0,
  };
  const insert = db.prepare(`
    INSERT INTO reviews (session_id, mode, trigger, model, status, detail, turns_reviewed, corrections, learned, patched,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, session_started_at, ts)
    VALUES (?, 'inloop', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`);
  if (m && !Number(m[3]) && !Number(m[4]) && entries && learnStepFailed(entries, s.review_requested_line || 0)) {
    // "learned=0" because saving failed (the skill was denied, the curator errored), not
    // because nothing was worth keeping: the cursor stays and the end-of-session review
    // reads the stretch. Until v0.25 an explicit "remember that" was lost this way.
    insert.run(base.session, base.trigger, base.model, 'skipped', 'could not save: the learn step failed or was denied; left to the end-of-session review', 0, 0, 0, 0,
      base.input, base.output, base.cacheRead, base.cacheWrite, now - s.review_requested_at, s.started_at, now);
    db.prepare('UPDATE sessions SET review_requested_at = NULL WHERE id = ?').run(input.session_id);
    markUnsaved(db, input, now);
  } else if (m) {
    insert.run(base.session, base.trigger, base.model, 'ok', null, Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]),
      base.input, base.output, base.cacheRead, base.cacheWrite, now - s.review_requested_at, s.started_at, now);
    db.prepare('UPDATE sessions SET review_cursor = ?, review_requested_at = NULL WHERE id = ?')
      .run(entries ? entries.length : s.review_cursor, input.session_id);
  } else {
    // No result line: the segment stays unreviewed and falls to the end-of-session review.
    insert.run(base.session, base.trigger, base.model, 'skipped', 'no result line', 0, 0, 0, 0,
      base.input, base.output, base.cacheRead, base.cacheWrite, now - s.review_requested_at, s.started_at, now);
    db.prepare('UPDATE sessions SET review_requested_at = NULL WHERE id = ?').run(input.session_id);
    markUnsaved(db, input, now);
  }
}

/** Context injected at session start: the learning protocol (global facts live in ~/.claude/CLAUDE.md, which Claude Code loads itself). */
export function sessionContext(learnedSinceLastSession = '', memories = null) {
  const lang = options().learningLanguage;
  return [
    '<ouroboros>',
    PROTOCOL,
    lang === 'auto' ? '' : `Write learnings in ${lang === 'pt-BR' ? 'Brazilian Portuguese' : 'English'}.`,
    learnedSinceLastSession ? `\nLearned by the end-of-session review since the last session (already saved):\n${learnedSinceLastSession}` : '',
    memories?.lines.length
      ? `\nAuto memory is off in this session, so Claude Code did not load the project memories Ouroboros saved. Their MEMORY.md lines (files in ${memories.dir}; read one when it applies):\n${memories.lines.join('\n')}${memories.more ? `\n(${memories.more} more in ${path.join(memories.dir, 'MEMORY.md')})` : ''}`
      : '',
    '</ouroboros>',
  ].filter(Boolean).join('\n');
}

const MEMORY_INDEX_MAX_LINES = 40;
const MEMORY_INDEX_MAX_CHARS = 4000;

/**
 * The MEMORY.md lines of the active project memories Ouroboros saved for `cwd` (newest
 * first, capped in lines and characters), for a session where Claude Code loads no auto
 * memory. Native memories are left out: they were never Ouroboros's to load.
 */
export function learnedMemoryIndex(db, cwd) {
  const dir = memoryDirFor({ cwd });
  const mine = db.prepare("SELECT title, path FROM learnings WHERE kind = 'memory' AND status = 'active' AND origin_session IS NOT 'native' ORDER BY updated_at DESC").all()
    .filter((l) => normalize(path.dirname(path.resolve(l.path))) === normalize(dir));
  if (!mine.length) return null;
  let index = '';
  try { index = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'); } catch { /* no index: the titles stand in */ }
  const indexLines = index.split(/\r?\n/);
  const lines = [];
  let chars = 0;
  for (const l of mine) {
    const name = path.basename(l.path);
    const line = (indexLines.find((x) => x.includes(`](${name})`)) || `- [${l.title}](${name})`).trim();
    if (lines.length >= MEMORY_INDEX_MAX_LINES || chars + line.length > MEMORY_INDEX_MAX_CHARS) break;
    lines.push(line);
    chars += line.length + 1;
  }
  return { dir, lines, more: mine.length - lines.length };
}

export function spawnWorker(args, env = process.env) {
  const child = spawn(process.execPath, ['--no-warnings', path.join(here, 'review-worker.mjs'), ...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  child.unref();
}

/**
 * What waits for the user, by kind, with the same rule as `inboxEntries` (inbox.mjs):
 * conflicts, pending or stale changes to files, queued items not part of a change, and
 * suggested fixes. With `project` (a project key), that project's entries and the global
 * ones; without it, everything. The dashboard badge and the SessionStart hint use this.
 */
export function inboxCounts(db, project = null) {
  const mine = project ? '(project IS NULL OR project = ?) AND' : '';
  const args = project ? [project] : [];
  const n = (sql) => db.prepare(sql).get(...args).n;
  const conflicts = n(`SELECT COUNT(*) n FROM candidates WHERE ${mine} outcome = 'conflict'`);
  const changes = n(`SELECT COUNT(*) n FROM changesets WHERE ${mine} status IN ('pending', 'stale')`);
  const items = n(`SELECT COUNT(*) n FROM candidates WHERE ${mine} outcome = 'queued' AND changeset_id IS NULL`);
  const fixes = n(`SELECT COUNT(*) n FROM candidates WHERE ${mine} outcome = 'suggested'`);
  return { conflicts, changes, items, fixes, total: conflicts + changes + items + fixes };
}

/** How many inbox entries wait for the user in a project (global entries included). */
export function inboxCount(db, project) {
  return inboxCounts(db, project).total;
}

const handlers = {
  async SessionStart(db, input, now) {
    // v0.18: one key per repository (before: per folder, so worktrees were strangers).
    try { rekeyProjects(db); } catch (err) { dbApi.logError(db, 'migrate:projects', err); }
    ensureSession(db, input, now);
    const control = isControl(input.cwd);
    db.prepare('UPDATE sessions SET control = ? WHERE id = ?').run(control ? 1 : 0, input.session_id);
    addEvent(db, input, now, 'session_start', input.source || null);
    // Without auto memory Claude Code loads no MEMORY.md: what Ouroboros saves as project
    // memories would be saved, announced and never read.
    const autoMemory = autoMemoryStatus(input.cwd);
    // The dashboard runs outside hooks and can't see plugin options; leave a snapshot
    // (of this hook's own options: the environment or the defaults, never the old snapshot).
    fs.writeFileSync(path.join(dataDir(), 'options.json'), JSON.stringify({
      ...options(), autoMemory: { ...autoMemory, project: projectIdFor(input.cwd) }, updatedAt: now,
    }));
    if (options().learning && !control) {
      // Files deleted outside Ouroboros (by the user, or by Claude Code tidying its
      // memory): the records follow, and the notice below says so.
      try {
        const { reconcile } = await import('./curator.mjs');
        reconcile(db, now);
      } catch (err) { dbApi.logError(db, 'hook:reconcile', err); }
      // What the end-of-session reviewer learned since the last session start, for this
      // project (a notice from another project waits for a session there); maintenance
      // notices have no project and go to the next session anywhere.
      const notices = db.prepare('SELECT id, text FROM notices WHERE delivered_at IS NULL AND (project IS NULL OR project = ?) ORDER BY id')
        .all(projectIdFor(input.cwd));
      if (notices.length) {
        db.prepare(`UPDATE notices SET delivered_at = ? WHERE id IN (${notices.map(() => '?').join(',')})`).run(now, ...notices.map((n) => n.id));
      }
      // Several reviews can report the same thing (a change still waiting): say it once.
      const learnedText = [...new Set(notices.flatMap((n) => String(n.text).split('\n')))].join('\n');
      // What waits for the user's decision (this project's and global entries): said with
      // the notices, otherwise at most once a day.
      const waiting = inboxCount(db, projectIdFor(input.cwd));
      const remind = waiting && (learnedText || now - (Number(dbApi.getMeta(db, 'inbox_hint_at')) || 0) > 20 * 60 * 60 * 1000);
      if (remind) dbApi.setMeta(db, 'inbox_hint_at', now);
      const inboxLine = remind ? `${waiting} waiting for your decision: /ouroboros:inbox (or the dashboard)` : '';
      // Auto memory off: said once per project (again only after it was seen on in
      // between), and the memories Ouroboros saved here go into the context instead.
      const memoryKey = `auto_memory:${projectIdFor(input.cwd)}`;
      const wasOff = dbApi.getMeta(db, memoryKey) === 'off';
      dbApi.setMeta(db, memoryKey, autoMemory.on ? 'on' : 'off');
      const memoryLine = !autoMemory.on && !wasOff
        ? `Ouroboros: Claude Code does not load auto memory here (${autoMemory.reason}), so the project memories Ouroboros saves are not loaded by Claude Code in this project. Ouroboros adds the ones it saved to the session context instead.`
        : '';
      const memories = autoMemory.on ? null : learnedMemoryIndex(db, input.cwd);
      const message = [
        learnedText ? `Ouroboros, since your last session:\n${learnedText}\n(/ouroboros:undo or /ouroboros:forget to revert)` : '',
        inboxLine ? `${learnedText ? '' : 'Ouroboros: '}${inboxLine}` : '',
        memoryLine,
      ].filter(Boolean).join('\n');
      // Synchronous hook: stdout becomes session context; systemMessage is shown to the user.
      process.stdout.write(JSON.stringify({
        ...(message ? { systemMessage: message } : {}),
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: sessionContext(learnedText, memories) },
      }));
    }
    // Sessions whose SessionEnd never ran a worker (crash, killed terminal) or whose
    // worker died: queue them again, at most a few per start.
    const stale = now - 10 * 60 * 1000;
    // Also reviews left to finish later (a part of a long session failed, the model
    // call failed, the month's budget ran out): tried again once there is budget.
    const canSpend = dbApi.monthSpend(db) < options().monthlyBudgetUsd;
    // And sessions whose SessionEnd never ran at all (a crash, a killed terminal, the hook
    // cut short): nothing queued them, so they were never reviewed or measured. Long idle
    // is taken as the end; if one goes on later, its cursors make the next review read
    // only the new part. Older ones are left alone: learning from them now, with nobody
    // watching, is what `/ouroboros:backfill learn` asks for approval for.
    const orphans = db.prepare(`
      SELECT id, queue_state FROM sessions
      WHERE id != ? AND (
        (queue_state = 'queued' AND COALESCE(ended_at, last_event_at) < ?) OR
        (queue_state = 'running' AND last_event_at < ?) OR
        (queue_state = 'waiting' AND ? AND COALESCE(reviewed_at, last_event_at) < ?) OR
        (queue_state IS NULL AND ended_at IS NULL AND turns >= 2 AND last_event_at < ? AND last_event_at >= ?)
      )
      ORDER BY started_at DESC LIMIT 3
    `).all(input.session_id, stale, stale, canSpend ? 1 : 0, now - RETRY_AFTER_MS, now - IDLE_AS_ENDED_MS, now - IDLE_AS_ENDED_MAX_AGE_MS);
    // v0.12: the old global profile becomes proposals for the global CLAUDE.md.
    try {
      if (retireProfile(db, now) && options().learning) spawnWorker(['--drain']);
    } catch (err) {
      dbApi.logError(db, 'migrate:profile', err);
    }
    // Daily upkeep (archive unused learnings, trim full budgets, retry what waits). The
    // worker claims the run itself (`maintain`): until v0.22 this hook wrote the time
    // first, the worker then read "ran a moment ago" and left, and upkeep never ran.
    if (options().learning && now - (Number(dbApi.getMeta(db, 'maintenance_at')) || 0) > MAINTENANCE_EVERY_MS) {
      spawnWorker(['--maintain']);
    }
    if (orphans.length && options().backgroundReview) {
      for (const { id, queue_state: state } of orphans) {
        if (state === null) {
          // What SessionEnd would have set, ended at its last event.
          const reason = `no SessionEnd: idle over ${IDLE_AS_ENDED_MS / 3_600_000} h`;
          // One statement claims it (two SessionStarts at once sweep the same session);
          // only the one that changed the row records the end and starts the worker.
          const claimed = db.prepare(`UPDATE sessions SET ended_at = last_event_at, end_reason = ?, review_requested_at = NULL,
            queue_state = 'queued', last_event_at = ? WHERE id = ? AND queue_state IS NULL AND ended_at IS NULL`).run(reason, now, id);
          if (!claimed.changes) continue;
          db.prepare("INSERT INTO events (session_id, ts, kind, target) VALUES (?, ?, 'session_end', ?)").run(id, now, reason);
        } else {
          db.prepare("UPDATE sessions SET queue_state = 'queued', last_event_at = ? WHERE id = ?").run(now, id);
        }
        spawnWorker(['--session', id, '--trigger', 'orphan']);
      }
    }
  },

  UserPromptSubmit(db, input, now) {
    ensureSession(db, input, now);
    db.prepare('UPDATE sessions SET turns = turns + 1, turn_tool_calls = 0 WHERE id = ?').run(input.session_id);
    addEvent(db, input, now, 'turn');
  },

  UserPromptExpansion(db, input, now) {
    ensureSession(db, input, now);
    if (input.expansion_type === 'slash_command' && input.command_name) {
      addEvent(db, input, now, 'skill_used', input.command_name, { via: 'typed', source: input.command_source || null });
      countSkillUse(db, input.command_name, now, input.session_id);
    }
  },

  PostToolUse(db, input, now) {
    ensureSession(db, input, now);
    db.prepare('UPDATE sessions SET tool_calls = tool_calls + 1, turn_tool_calls = turn_tool_calls + 1 WHERE id = ?')
      .run(input.session_id);
    const tool = input.tool_name || '';
    const ti = input.tool_input || {};

    if (tool === 'Skill' && ti.skill) {
      addEvent(db, input, now, 'skill_used', ti.skill, { via: 'tool' });
      countSkillUse(db, ti.skill, now, input.session_id);
    }
    if (ti.file_path) {
      const cls = classifyPath(ti.file_path);
      if (cls && tool === 'Read') {
        addEvent(db, input, now, `${cls}_read`, ti.file_path);
        countMemoryRead(db, ti.file_path, now, input.session_id);
      } else if (cls && /^(Write|Edit|MultiEdit)$/.test(tool)) {
        addEvent(db, input, now, `${cls}_write`, ti.file_path, {
          tool,
          op: input.tool_response?.type || (tool === 'Write' ? 'write' : 'edit'),
          skill: cls === 'skill' ? skillNameFromPath(ti.file_path) : undefined,
        });
      }
    }

    // A success on a target that had failed closes the streak as a recovery:
    // "found the working path after errors", the strongest procedural signal.
    const target = targetOf(tool, ti);
    const streak = db.prepare('SELECT * FROM fail_streaks WHERE session_id = ? AND target = ?').get(input.session_id, target);
    if (streak) db.prepare('DELETE FROM fail_streaks WHERE session_id = ? AND target = ?').run(input.session_id, target);
    // What ran while other commands were failing tells a working path from fixing code
    // (files written) and from waiting out a flaky command (nothing else happened).
    const between = FILE_WRITE_TOOL_RE.test(tool) ? 'edits' : COMMAND_TOOL_RE.test(tool) ? 'others' : null;
    if (between) db.prepare(`UPDATE fail_streaks SET ${between} = ${between} + 1 WHERE session_id = ? AND target != ?`).run(input.session_id, target);
    // Only within one turn: a failure three turns ago and a success now are two events,
    // not Claude working its way through an error.
    if (streak && streak.started_at >= turnStartOf(db, input.session_id)) {
      addEvent(db, input, now, 'recovery', target, {
        failures: streak.count,
        first_error: streak.first_error,
        seconds: Math.round((now - streak.started_at) / 1000),
        edits: streak.edits || 0,
        commands: streak.others || 0,
        changed: commandText(tool, ti) !== (streak.first_command || ''),
      });
    }
  },

  PostToolUseFailure(db, input, now) {
    ensureSession(db, input, now);
    if (input.is_interrupt) return;
    db.prepare('UPDATE sessions SET tool_calls = tool_calls + 1, turn_tool_calls = turn_tool_calls + 1, tool_fails = tool_fails + 1 WHERE id = ?')
      .run(input.session_id);
    const target = targetOf(input.tool_name || '', input.tool_input || {});
    const error = String(input.error || '').slice(0, 400);
    // A streak left open by an earlier turn starts over.
    db.prepare('DELETE FROM fail_streaks WHERE session_id = ? AND target = ? AND started_at < ?').run(input.session_id, target, turnStartOf(db, input.session_id));
    db.prepare(`
      INSERT INTO fail_streaks (session_id, target, agent_id, count, first_error, started_at, first_command)
      VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(session_id, target) DO UPDATE SET count = count + 1
    `).run(input.session_id, target, input.agent_id || null, error, now, commandText(input.tool_name || '', input.tool_input || {}));
    addEvent(db, input, now, 'tool_fail', target, { error: error.slice(0, 200) });
  },

  Stop(db, input, now) {
    ensureSession(db, input, now);
    const opts = options();
    const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(input.session_id);
    if (s.turn_tool_calls >= LONG_TURN_TOOL_CALLS && !input.stop_hook_active) {
      addEvent(db, input, now, 'long_turn', null, { tool_calls: s.turn_tool_calls });
    }

    // 1. A review was requested at the previous Stop: record its result line.
    if (s.review_requested_at) {
      finishInloopReview(db, input, s, now);
      return;
    }

    // 2. Decide whether to ask for a periodic review now.
    if (!opts.learning || !opts.inloopReview || input.stop_hook_active || input.agent_id || s.control) return;
    // Background agents or commands are still running: Claude stopped only to wait for
    // them, in the middle of the work. The review waits for a stop that ends something.
    if (Array.isArray(input.background_tasks) && input.background_tasks.length) return;
    const turnsSince = s.turns - s.turns_at_last_review;
    const early = recoveredThisTurn(db, input.session_id, opts.earlyReviewFailures) && earlyAllowed(db, input.session_id, s.turns);
    if (turnsSince < opts.reviewEveryTurns && !early) return;

    // A review is due by the counter. The transcript settles two things before asking.
    let entries = null;
    try { entries = input.transcript_path ? readTranscript(input.transcript_path) : null; } catch { /* unreadable: trust the counter */ }
    let periodic = turnsSince >= opts.reviewEveryTurns;
    if (periodic && entries) {
      // UserPromptSubmit also fires for prompts nobody typed (a scheduled task, a
      // background subagent reporting back, a message from another session), so the
      // counter runs ahead in agentic sessions. The cadence is in turns the user typed,
      // read the same way the reviews read them.
      // A fork's copy of its parent's turns is not this session's.
      const from = Math.min(Math.max(s.review_requested_line || 0, skipInherited(db, input.session_id, entries)), entries.length);
      const typed = entries.slice(from >= entries.length ? 0 : from).filter(isHumanPrompt).length;
      if (typed < opts.reviewEveryTurns) {
        periodic = false;
        db.prepare('UPDATE sessions SET turns_at_last_review = ? WHERE id = ?').run(Math.max(s.turns_at_last_review, s.turns - typed), input.session_id);
      }
    }
    const trigger = periodic ? 'periodic' : early ? 'recovery' : null;
    if (!trigger) return;
    const line = entries ? entries.length : input.transcript_path ? countLines(input.transcript_path) : null;

    // An in-session review reads the whole context again (twice at least: the skill,
    // then the answer), on the session's own model, outside `monthly_budget_usd`. Past
    // a size it costs more than it is worth: the stretch is left to the end-of-session
    // reviewer, which reads a digest with a small model, inside the budget.
    const context = entries ? contextTokens(entries) : 0;
    if (opts.inloopReviewMaxContext > 0 && context > opts.inloopReviewMaxContext) {
      db.prepare('UPDATE sessions SET turns_at_last_review = turns, review_requested_line = ? WHERE id = ?').run(line, input.session_id);
      addEvent(db, input, now, 'review_skipped', trigger, { turns: [s.turns_at_last_review + 1, s.turns], context });
      db.prepare(`
        INSERT INTO reviews (session_id, mode, trigger, status, detail, session_started_at, ts)
        VALUES (?, 'inloop', ?, 'skipped', ?, ?, ?)`).run(input.session_id, trigger,
        `context of ${context} tokens is over inloop_review_max_context (${opts.inloopReviewMaxContext}): left to the end-of-session review`, s.started_at, now);
      return;
    }

    db.prepare(`
      UPDATE sessions SET review_requested_at = ?, review_requested_line = ?, review_trigger = ?, turns_at_last_review = turns
      WHERE id = ?
    `).run(now, line, trigger, input.session_id);
    const since = db.prepare("SELECT MAX(ts) t FROM reviews WHERE session_id = ? AND status = 'ok'").get(input.session_id).t || s.started_at || 0;
    const recoveries = significantRecoveries(db.prepare("SELECT target, payload FROM events WHERE session_id = ? AND kind = 'recovery' AND ts > ? ORDER BY id DESC LIMIT 20")
      .all(input.session_id, since), opts.earlyReviewFailures).slice(0, 5);
    const fromTurn = unsavedFrom(db, input.session_id) || s.turns_at_last_review + 1;
    addEvent(db, input, now, 'review_requested', trigger, { turns: [fromTurn, s.turns] });
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: reviewRequest({
          from: fromTurn, to: s.turns, trigger, recoveries,
          state: sessionStateText(db, input.session_id, { audience: 'claude' }),
        }),
      },
    }));
  },

  SessionEnd(db, input, now) {
    ensureSession(db, input, now);
    db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ?, review_requested_at = NULL WHERE id = ?').run(now, input.reason || null, input.session_id);
    addEvent(db, input, now, 'session_end', input.reason || null);
    if (!options().backgroundReview) return;
    const res = db.prepare(`
      UPDATE sessions SET queue_state = 'queued'
      WHERE id = ? AND (queue_state IS NULL OR queue_state IN ('done', 'skipped', 'failed'))
    `).run(input.session_id);
    if (res.changes) spawnWorker(['--session', input.session_id, '--trigger', 'session_end']);
  },
};

async function main() {
  const event = process.argv[2];
  // The reviewer's own model calls run in --safe-mode (no hooks), but guard anyway.
  if (process.env.OUROBOROS_REVIEWER === '1' || !handlers[event]) return;

  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  if (!input?.session_id) return;
  if (isExcluded(input.cwd)) return;

  if (!nodeSupported()) {
    if (event === 'SessionStart') {
      process.stdout.write(JSON.stringify({
        systemMessage: `Ouroboros needs Node.js ${MIN_NODE.join('.')} or newer (found ${process.versions.node}); it is not recording anything.`,
      }));
    }
    return;
  }

  optionsFromEnvOnly();
  dbApi = await import('./db.mjs');
  const { openDb, logError } = dbApi;
  let db;
  try {
    db = openDb();
    await handlers[event](db, input, Date.now());
  } catch (err) {
    if (db) logError(db, `hook:${event}`, err);
  } finally {
    db?.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().finally(() => process.exit(0));
}
