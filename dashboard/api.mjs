// Read-only JSON API for the dashboard.
import fs from 'node:fs';
import path from 'node:path';
import { getMeta, monthSpend, monthStart } from '../scripts/db.mjs';
import { blockChars, parseProfile, readProfileText } from '../scripts/profile.mjs';
import { loadSettings } from '../scripts/settings.mjs';
import { listInstructionFiles, listMemories, listSkills, userProfile } from '../scripts/inventory.mjs';
import { dataDir, normalize } from '../scripts/paths.mjs';

const DAY = 86_400_000;
const MEMORY_INDEX_LINE_LIMIT = 200; // Claude Code loads the first 200 lines / 25KB of MEMORY.md
const MEMORY_INDEX_BYTE_LIMIT = 25_000;

function readOptions() {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir(), 'options.json'), 'utf8')); } catch { return null; }
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function knownCwds(db) {
  return db.prepare('SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL ORDER BY started_at DESC LIMIT 100').all().map((r) => r.cwd);
}

export function createApi(db) {
  const routes = {
    ping: () => ({ app: 'ouroboros' }),

    overview(params) {
      const days = Math.min(Math.max(Number(params.get('days')) || 30, 1), 365);
      const now = Date.now();
      const start = new Date(now - (days - 1) * DAY);
      start.setHours(0, 0, 0, 0);
      const since = start.getTime();

      const totals = db.prepare(`
        SELECT COUNT(*) sessions, COALESCE(SUM(turns),0) turns, COALESCE(SUM(tool_calls),0) tool_calls,
               COALESCE(SUM(tool_fails),0) tool_fails
        FROM sessions WHERE started_at >= ?`).get(since);
      const reviewed = db.prepare(`
        SELECT COUNT(*) n, COALESCE(SUM(turns_reviewed),0) turns, COALESCE(SUM(corrections),0) corrections
        FROM reviews WHERE status = 'ok' AND COALESCE(session_started_at, ts) >= ?`).get(since);
      const candidates = db.prepare(`
        SELECT kind, COUNT(*) n FROM candidates c JOIN sessions s ON s.id = c.session_id
        WHERE s.started_at >= ? GROUP BY kind`).all(since);
      const misses = db.prepare(`
        SELECT COUNT(*) n FROM candidates c JOIN sessions s ON s.id = c.session_id
        WHERE s.started_at >= ? AND c.repeats IS NOT NULL`).get(since).n;
      const recoveries = db.prepare("SELECT COUNT(*) n FROM events WHERE kind = 'recovery' AND ts >= ?").get(since).n;
      const opts = readOptions();
      const learned = Object.fromEntries(db.prepare("SELECT kind, COUNT(*) n FROM learnings WHERE status = 'active' AND origin_session IS NOT 'native' GROUP BY kind").all().map((r) => [r.kind, r.n]));
      const patchedNative = db.prepare("SELECT COUNT(*) n FROM learnings WHERE origin_session = 'native' AND status = 'active'").get().n;
      const enabledAt = Number(getMeta(db, 'learning_enabled_at')) || null;

      // Daily series, attributed to the day the session started.
      const series = new Map();
      for (let t = since; t <= now; t += DAY) series.set(dayKey(t), { day: dayKey(t), sessions: 0, turns: 0, reviewedTurns: 0, corrections: 0, cost: 0 });
      for (const r of db.prepare('SELECT started_at, turns FROM sessions WHERE started_at >= ?').all(since)) {
        const d = series.get(dayKey(r.started_at));
        if (d) { d.sessions++; d.turns += r.turns; }
      }
      for (const r of db.prepare("SELECT COALESCE(session_started_at, ts) t, turns_reviewed, corrections FROM reviews WHERE status = 'ok' AND COALESCE(session_started_at, ts) >= ?").all(since)) {
        const d = series.get(dayKey(r.t));
        if (d) { d.reviewedTurns += r.turns_reviewed; d.corrections += r.corrections; }
      }
      for (const r of db.prepare('SELECT ts, cost_usd FROM reviews WHERE ts >= ?').all(since)) {
        const d = series.get(dayKey(r.ts));
        if (d) d.cost += r.cost_usd;
      }

      const sessions = db.prepare(`
        SELECT s.id, s.project, s.cwd, s.started_at, s.turns, s.tool_calls, s.tool_fails, s.queue_state,
          (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.kind = 'recovery') recoveries,
          (SELECT COALESCE(SUM(corrections),0) FROM reviews r WHERE r.session_id = s.id AND r.status = 'ok') corrections,
          (SELECT COUNT(*) FROM candidates c WHERE c.session_id = s.id) candidates,
          (SELECT COALESCE(SUM(cost_usd),0) FROM reviews r WHERE r.session_id = s.id) cost
        FROM sessions s ORDER BY s.started_at DESC LIMIT 25`).all();

      return {
        days,
        totals: { ...totals, recoveries },
        reviewed,
        correctionRate: reviewed.turns ? (reviewed.corrections / reviewed.turns) * 100 : null,
        candidates: Object.fromEntries(candidates.map((c) => [c.kind, c.n])),
        misses,
        learned: { ...learned, patchedNative, enabledAt },
        cost: { month: monthSpend(db), budget: opts?.monthlyBudgetUsd ?? null, monthStart: monthStart() },
        options: opts,
        series: [...series.values()],
        sessions,
      };
    },

    learnings() {
      const learned = db.prepare(`
        SELECT id, kind, scope, memory_type, block, project, name, title, path, confidence, status, trigger,
               created_at, updated_at, uses, last_used_at,
               (SELECT COUNT(*) FROM writes w WHERE w.learning_id = l.id AND w.reverted_at IS NULL) writes
        FROM learnings l ORDER BY updated_at DESC LIMIT 300`).all();
      const writes = db.prepare(`
        SELECT w.batch, MIN(w.ts) ts, w.op, w.actor, MAX(w.reverted_at) reverted_at, l.title, l.kind, l.id learning_id,
               GROUP_CONCAT(w.file, '\n') files
        FROM writes w LEFT JOIN learnings l ON l.id = w.learning_id
        GROUP BY w.batch ORDER BY MIN(w.id) DESC LIMIT 50`).all();
      const candidates = db.prepare(`
        SELECT c.*, s.started_at session_started_at, s.cwd FROM candidates c
        JOIN sessions s ON s.id = c.session_id ORDER BY s.started_at DESC, c.id LIMIT 300`).all();
      const corrections = db.prepare(`
        SELECT c.quote, c.kind, c.session_id, s.started_at session_started_at, s.project, s.cwd FROM corrections c
        JOIN sessions s ON s.id = c.session_id ORDER BY s.started_at DESC, c.id LIMIT 300`).all();
      return { learned, writes, candidates, corrections };
    },

    inventory() {
      const cwds = knownCwds(db);
      const reads = new Map();
      for (const r of db.prepare("SELECT target, COUNT(*) n, MAX(ts) last FROM events WHERE kind IN ('memory_read','profile_read') GROUP BY target").all()) {
        reads.set(normalize(r.target), r);
      }
      const uses = new Map();
      for (const r of db.prepare("SELECT target, COUNT(*) n, MAX(ts) last FROM events WHERE kind = 'skill_used' GROUP BY target").all()) {
        const name = String(r.target).split(':').pop();
        const prev = uses.get(name);
        uses.set(name, { n: (prev?.n || 0) + r.n, last: Math.max(prev?.last || 0, r.last) });
      }
      const memories = listMemories().map((m) => {
        const r = reads.get(normalize(m.file));
        return { ...m, reads: r?.n || 0, lastRead: r?.last || null };
      });
      const skills = listSkills(cwds).map((s) => {
        const u = uses.get(s.name);
        return { ...s, uses: u?.n || 0, lastUsed: u?.last || null };
      });
      return { memories, skills, instructions: listInstructionFiles(cwds), profile: userProfile() };
    },

    health() {
      const cwds = knownCwds(db);
      const indexes = listMemories().filter((m) => m.index).map((m) => ({
        project: m.project, lines: m.lines, chars: m.chars,
        lineLimit: MEMORY_INDEX_LINE_LIMIT, byteLimit: MEMORY_INDEX_BYTE_LIMIT,
      }));
      const skills = listSkills(cwds).filter((s) => !s.userOnly);
      const listingChars = skills.reduce((n, s) => n + Math.min(s.descriptionChars, 1536) + s.name.length + 4, 0);
      const queue = db.prepare('SELECT COALESCE(queue_state, \'none\') state, COUNT(*) n FROM sessions GROUP BY queue_state').all();
      const failedReviews = db.prepare("SELECT session_id, detail, ts FROM reviews WHERE status = 'failed' ORDER BY ts DESC LIMIT 10").all();
      const skippedReviews = db.prepare("SELECT detail, COUNT(*) n FROM reviews WHERE status = 'skipped' GROUP BY detail ORDER BY n DESC LIMIT 10").all();
      const errors = db.prepare('SELECT ts, source, substr(message, 1, 400) message FROM errors ORDER BY ts DESC LIMIT 20').all();
      const capture = db.prepare("SELECT MAX(ts) last, SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) day FROM events").get(Date.now() - DAY);
      const settings = loadSettings();
      const blocks = parseProfile(readProfileText() ?? '');
      const learnedSkills = db.prepare("SELECT COUNT(*) n FROM learnings WHERE kind = 'skill' AND status = 'active' AND origin_session IS NOT 'native'").get().n;
      return {
        budgets: {
          userBlock: { used: blockChars(blocks.user), limit: settings.limits.userBlockChars, items: blocks.user.length },
          environmentBlock: { used: blockChars(blocks.environment), limit: settings.limits.environmentBlockChars, items: blocks.environment.length },
          learnedSkills: { used: learnedSkills, limit: settings.limits.learnedSkills },
          memoryIndexLines: settings.limits.memoryIndexLines,
        },
        indexes,
        skillListing: { skills: skills.length, chars: listingChars, tokens: Math.round(listingChars / 4) },
        queue, failedReviews, skippedReviews, errors,
        capture: { lastEventAt: capture.last, eventsLast24h: capture.day || 0 },
        profile: userProfile(),
        options: readOptions(),
      };
    },
  };

  return (name, params) => (routes[name] ? routes[name](params) : undefined);
}
