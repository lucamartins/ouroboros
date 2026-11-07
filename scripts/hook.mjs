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

const MIN_NODE = [22, 13];
const here = path.dirname(fileURLToPath(import.meta.url));

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

function countSkillUse(db, name, now) {
  const bare = String(name).split(':').pop();
  db.prepare("UPDATE learnings SET uses = uses + 1, last_used_at = ? WHERE status = 'active' AND kind = 'skill' AND name = ?")
    .run(now, bare);
}

export const PROTOCOL = `Ouroboros (self-learning) is active. Without being asked, save what you learn through the \`ouroboros:learn\` skill — it deduplicates, routes and can be undone:
- a user preference or way of working, a correction of your approach, a project convention, an environment fact;
- when the user explicitly asks you to remember something, save it right away;
- create or patch a skill when you worked out a reusable multi-step workflow, found the working path after errors, or the user corrected your approach.
Prefer patching what exists over creating new. Don't save what is derivable from the code or CLAUDE.md, ephemeral task details, or secrets. After saving, tell the user in one line: "📝 learned: …".`;

/** Context injected at session start: the protocol plus the global profile. */
export function sessionContext() {
  const text = readProfileText();
  const profile = text ? profileForContext(text) : '';
  return [
    '<ouroboros>',
    PROTOCOL,
    profile ? `\nWhat you already know about the user and their environment (from ~/.ouroboros/user.md):\n${profile}` : '',
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

const handlers = {
  SessionStart(db, input, now) {
    ensureSession(db, input, now);
    addEvent(db, input, now, 'session_start', input.source || null);
    // The dashboard runs outside hooks and can't see plugin options; leave a snapshot.
    fs.writeFileSync(path.join(dataDir(), 'options.json'), JSON.stringify({ ...options(), updatedAt: now }));
    if (options().learning) {
      // Synchronous hook: stdout becomes session context.
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: sessionContext() },
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
    if (orphans.length && options().measureReview) {
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
      countSkillUse(db, input.command_name, now);
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
      countSkillUse(db, ti.skill, now);
    }
    if (ti.file_path) {
      const cls = classifyPath(ti.file_path);
      if (cls && tool === 'Read') {
        addEvent(db, input, now, `${cls}_read`, ti.file_path);
        db.prepare("UPDATE learnings SET uses = uses + 1, last_used_at = ? WHERE status = 'active' AND lower(path) = lower(?)")
          .run(now, ti.file_path);
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
    const s = db.prepare('SELECT turn_tool_calls FROM sessions WHERE id = ?').get(input.session_id);
    if (s && s.turn_tool_calls >= options().longTurnToolCalls) {
      addEvent(db, input, now, 'long_turn', null, { tool_calls: s.turn_tool_calls });
    }
  },

  SessionEnd(db, input, now) {
    ensureSession(db, input, now);
    db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?').run(now, input.reason || null, input.session_id);
    addEvent(db, input, now, 'session_end', input.reason || null);
    if (!options().measureReview) return;
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

  if (!nodeSupported()) {
    if (event === 'SessionStart') {
      process.stdout.write(JSON.stringify({
        systemMessage: `Ouroboros needs Node.js ${MIN_NODE.join('.')} or newer (found ${process.versions.node}); it is not recording anything.`,
      }));
    }
    return;
  }

  const { openDb, logError } = await import('./db.mjs');
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
