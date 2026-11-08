// Single entry point for every Ouroboros hook: `node hook.mjs <EventName>` with the
// hook input JSON on stdin. Capture hooks only measure: they print nothing, never
// block, and always exit 0.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { options } from './config.mjs';
import { classifyPath, dataDir, projectKey, skillNameFromPath } from './paths.mjs';
import { profileForContext, readProfileText } from './profile.mjs';
import { RUBRIC_SHORT } from './rubric.mjs';
import { globMatch, loadSettings } from './settings.mjs';
import { countLines, readTranscript, usageSince } from './transcript.mjs';

const MIN_NODE = [22, 13];
/** Tool calls that make a turn "long" (recorded as a metric only). */
export const LONG_TURN_TOOL_CALLS = 15;
/** Early (recovery) reviews are at least this many user turns apart from any review. */
export const EARLY_REVIEW_MIN_TURNS = 5;
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
    const words = line.trim().split(/\s+/).filter((w) => !/^[A-Z_][A-Z0-9_]*=/.test(w));
    const cmd = words.filter((w) => !w.startsWith('-')).slice(0, 2).join(' ');
    return `${toolName}:${cmd}`;
  }
  return toolName;
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
  `).run(input.session_id, projectKey(input.cwd), input.cwd || null, input.transcript_path || null, now, now);
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

export const RESULT_RE = /\[ouroboros\]\s*reviewed=(\d+)\s+corrections=(\d+)\s+learned=(\d+)\s+patched=(\d+)/i;

/** Instructions sent through the Stop hook to ask for a periodic review. */
export function reviewRequest({ from, to, trigger, recoveries = [] }) {
  const why = trigger === 'recovery' ? 'after working through failures' : 'periodic';
  const signals = recoveries.map((r) => {
    let p = {};
    try { p = JSON.parse(r.payload || '{}'); } catch { /* ignore */ }
    return `- \`${r.target}\` failed ${p.failures || '?'}× before working${p.first_error ? ` (first error: ${String(p.first_error).split('\n')[0].slice(0, 120)})` : ''}`;
  });
  return [
    `Ouroboros learning review (${why}). Before finishing, review user turns ${from}–${to} of this session — only what happened since the last review.`,
    'Use the `ouroboros:learn` skill if anything passes its filters (corrections of your approach, preferences, conventions, working paths found after errors); be brief and mention each saved item in one line.',
    signals.length ? `Signals recorded in this stretch:\n${signals.join('\n')}` : '',
    'Count corrections: user turns in that range that redirected your approach, explicit or implicit.',
    'End your message with exactly this line (numbers filled in; learned/patched count only what you saved for this review), even when nothing was saved:',
    '[ouroboros] reviewed=<user turns reviewed> corrections=<n> learned=<items created> patched=<items updated>',
  ].filter(Boolean).join('\n');
}

/**
 * Whether the turn that just ended found a working path after failures: a recovery
 * (same command or file failed, then worked) with at least `minFailures` failures,
 * here or inside a subagent. A long turn alone is not a signal: a third of real turns
 * use 15+ tool calls, and most have nothing new to learn.
 */
export function recoveredThisTurn(db, sessionId, minFailures) {
  const turnStart = db.prepare("SELECT MAX(ts) t FROM events WHERE session_id = ? AND kind = 'turn'").get(sessionId).t || 0;
  return db.prepare("SELECT payload FROM events WHERE session_id = ? AND kind = 'recovery' AND ts >= ?").all(sessionId, turnStart)
    .some((r) => {
      try { return (JSON.parse(r.payload || '{}').failures || 0) >= minFailures; } catch { return false; }
    });
}

/** At most one early review every EARLY_REVIEW_MIN_TURNS user turns (after any review request). */
function earlyAllowed(db, sessionId, turns) {
  const last = db.prepare("SELECT payload FROM events WHERE session_id = ? AND kind = 'review_requested' ORDER BY id DESC LIMIT 1").get(sessionId);
  if (!last) return true;
  let at = 0;
  try { at = JSON.parse(last.payload || '{}').turns?.[1] || 0; } catch { /* ignore */ }
  return turns - at >= EARLY_REVIEW_MIN_TURNS;
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
  if (m) {
    insert.run(base.session, base.trigger, base.model, 'ok', null, Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]),
      base.input, base.output, base.cacheRead, base.cacheWrite, now - s.review_requested_at, s.started_at, now);
    db.prepare('UPDATE sessions SET review_cursor = ?, review_requested_at = NULL WHERE id = ?')
      .run(entries ? entries.length : s.review_cursor, input.session_id);
  } else {
    // No result line: the segment stays unreviewed and falls to the end-of-session review.
    insert.run(base.session, base.trigger, base.model, 'skipped', 'no result line', 0, 0, 0, 0,
      base.input, base.output, base.cacheRead, base.cacheWrite, now - s.review_requested_at, s.started_at, now);
    db.prepare('UPDATE sessions SET review_requested_at = NULL WHERE id = ?').run(input.session_id);
  }
}

/** Context injected at session start: the protocol plus the global profile. */
export function sessionContext(learnedSinceLastSession = '') {
  const text = readProfileText();
  const profile = text ? profileForContext(text) : '';
  const lang = options().learningLanguage;
  return [
    '<ouroboros>',
    PROTOCOL,
    lang === 'auto' ? '' : `Write learnings in ${lang === 'pt-BR' ? 'Brazilian Portuguese' : 'English'}.`,
    profile ? `\nWhat you already know about the user and their environment (from ~/.ouroboros/user.md):\n${profile}` : '',
    learnedSinceLastSession ? `\nLearned by the end-of-session review since the last session (already saved):\n${learnedSinceLastSession}` : '',
    '</ouroboros>',
  ].filter(Boolean).join('\n');
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

/** How many inbox entries wait for the user in a project (global entries included). */
export function inboxCount(db, project) {
  const mine = '(project IS NULL OR project = ?)';
  return db.prepare(`SELECT
      (SELECT COUNT(*) FROM candidates WHERE ${mine} AND (outcome IN ('conflict', 'suggested') OR (outcome = 'queued' AND changeset_id IS NULL)))
    + (SELECT COUNT(*) FROM changesets WHERE ${mine} AND status IN ('pending', 'stale')) n`).get(project, project).n;
}

const handlers = {
  SessionStart(db, input, now) {
    ensureSession(db, input, now);
    addEvent(db, input, now, 'session_start', input.source || null);
    // The dashboard runs outside hooks and can't see plugin options; leave a snapshot.
    fs.writeFileSync(path.join(dataDir(), 'options.json'), JSON.stringify({ ...options(), updatedAt: now }));
    if (options().learning) {
      // What the end-of-session reviewer learned since the last session start, for this
      // project (a notice from another project waits for a session there); maintenance
      // notices have no project and go to the next session anywhere.
      const notices = db.prepare('SELECT id, text FROM notices WHERE delivered_at IS NULL AND (project IS NULL OR project = ?) ORDER BY id')
        .all(projectKey(input.cwd));
      if (notices.length) {
        db.prepare(`UPDATE notices SET delivered_at = ? WHERE id IN (${notices.map(() => '?').join(',')})`).run(now, ...notices.map((n) => n.id));
      }
      const learnedText = notices.map((n) => n.text).join('\n');
      // What waits for the user's decision (this project's and global entries): said with
      // the notices, otherwise at most once a day.
      const waiting = inboxCount(db, projectKey(input.cwd));
      const remind = waiting && (learnedText || now - (Number(dbApi.getMeta(db, 'inbox_hint_at')) || 0) > 20 * 60 * 60 * 1000);
      if (remind) dbApi.setMeta(db, 'inbox_hint_at', now);
      const inboxLine = remind ? `${waiting} waiting for your decision: /ouroboros:inbox (or the dashboard)` : '';
      const message = [
        learnedText ? `Ouroboros, since your last session:\n${learnedText}\n(/ouroboros:undo or /ouroboros:forget to revert)` : '',
        inboxLine ? `${learnedText ? '' : 'Ouroboros: '}${inboxLine}` : '',
      ].filter(Boolean).join('\n');
      // Synchronous hook: stdout becomes session context; systemMessage is shown to the user.
      process.stdout.write(JSON.stringify({
        ...(message ? { systemMessage: message } : {}),
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: sessionContext(learnedText) },
      }));
    }
    // Sessions whose SessionEnd never ran a worker (crash, killed terminal) or whose
    // worker died: queue them again, at most a few per start.
    const stale = now - 10 * 60 * 1000;
    const orphans = db.prepare(`
      SELECT id FROM sessions
      WHERE id != ? AND (
        (queue_state = 'queued' AND COALESCE(ended_at, last_event_at) < ?) OR
        (queue_state = 'running' AND last_event_at < ?)
      )
      ORDER BY started_at DESC LIMIT 3
    `).all(input.session_id, stale, stale);
    // Daily upkeep (archive unused learnings, consolidate full budgets).
    if (options().learning && now - (Number(dbApi.getMeta(db, 'maintenance_at')) || 0) > 20 * 60 * 60 * 1000) {
      dbApi.setMeta(db, 'maintenance_at', now);
      spawnWorker(['--maintain']);
    }
    if (orphans.length && options().backgroundReview) {
      for (const { id } of orphans) {
        db.prepare("UPDATE sessions SET queue_state = 'queued', last_event_at = ? WHERE id = ?").run(now, id);
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
    if (streak) {
      db.prepare('DELETE FROM fail_streaks WHERE session_id = ? AND target = ?').run(input.session_id, target);
      addEvent(db, input, now, 'recovery', target, {
        failures: streak.count,
        first_error: streak.first_error,
        seconds: Math.round((now - streak.started_at) / 1000),
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
    db.prepare(`
      INSERT INTO fail_streaks (session_id, target, agent_id, count, first_error, started_at)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(session_id, target) DO UPDATE SET count = count + 1
    `).run(input.session_id, target, input.agent_id || null, error, now);
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
    if (!opts.learning || !opts.inloopReview || input.stop_hook_active || input.agent_id) return;
    const turnsSince = s.turns - s.turns_at_last_review;
    const trigger = turnsSince >= opts.reviewEveryTurns ? 'periodic'
      : recoveredThisTurn(db, input.session_id, opts.earlyReviewFailures) && earlyAllowed(db, input.session_id, s.turns) ? 'recovery'
        : null;
    if (!trigger) return;

    const line = input.transcript_path ? countLines(input.transcript_path) : null;
    db.prepare(`
      UPDATE sessions SET review_requested_at = ?, review_requested_line = ?, review_trigger = ?, turns_at_last_review = turns
      WHERE id = ?
    `).run(now, line, trigger, input.session_id);
    const since = db.prepare("SELECT MAX(ts) t FROM reviews WHERE session_id = ? AND status = 'ok'").get(input.session_id).t || s.started_at || 0;
    const recoveries = db.prepare("SELECT target, payload FROM events WHERE session_id = ? AND kind = 'recovery' AND ts > ? ORDER BY id DESC LIMIT 5")
      .all(input.session_id, since);
    addEvent(db, input, now, 'review_requested', trigger, { turns: [s.turns_at_last_review + 1, s.turns] });
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: reviewRequest({ from: s.turns_at_last_review + 1, to: s.turns, trigger, recoveries }),
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

  dbApi = await import('./db.mjs');
  const { openDb, logError } = dbApi;
  let db;
  try {
    db = openDb();
    handlers[event](db, input, Date.now());
  } catch (err) {
    if (db) logError(db, `hook:${event}`, err);
  } finally {
    db?.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().finally(() => process.exit(0));
}
