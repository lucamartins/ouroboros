// Read-only JSON API for the dashboard.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { changesetView } from '../scripts/changesets.mjs';
import { getMeta, monthSpend, monthStart } from '../scripts/db.mjs';
import { blockChars, parseProfile, readProfileText } from '../scripts/profile.mjs';
import { loadSettings } from '../scripts/settings.mjs';
import { listInstructionFiles, listMemories, listSkills, userProfile } from '../scripts/inventory.mjs';
import { dataDir, normalize } from '../scripts/paths.mjs';
import { sessionContext } from '../scripts/hook.mjs';

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

/** Characters Ouroboros adds to every session's context (protocol + profile). */
function overheadChars() {
  try { return sessionContext().length; } catch { return null; }
}

function knownCwds(db) {
  return db.prepare('SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL ORDER BY started_at DESC LIMIT 100').all().map((r) => r.cwd);
}

function rangeStart(params, fallback = 30) {
  const days = Math.min(Math.max(Number(params.get('days')) || fallback, 1), 365);
  const start = new Date(Date.now() - (days - 1) * DAY);
  start.setHours(0, 0, 0, 0);
  return { days, since: start.getTime() };
}

function emptySeries(since, make) {
  const m = new Map();
  for (let t = since; t <= Date.now(); t += DAY) m.set(dayKey(t), { day: dayKey(t), ...make() });
  return m;
}

/** Sessions that used at least one learned memory or skill (profile facts are always in context). */
const HITS_SQL = `
  SELECT e.session_id, MIN(e.ts) ts FROM events e
  JOIN learnings l ON l.status = 'active' AND l.origin_session IS NOT 'native' AND (
    (e.kind = 'skill_used' AND l.kind = 'skill' AND (e.target = l.name OR e.target LIKE '%:' || l.name)) OR
    (e.kind = 'memory_read' AND lower(e.target) = lower(l.path)))
  WHERE e.ts >= ? GROUP BY e.session_id`;

export function createApi(db) {
  const routes = {
    ping: () => ({ app: 'ouroboros' }),

    /** What waits for the user, for the navigation badge; plus the plugin version. */
    counts() {
      const n = (sql) => db.prepare(sql).get().n;
      let version = null;
      try { version = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json'), 'utf8')).version; } catch { /* unknown */ }
      return {
        version,
        options: readOptions(),
        conflicts: n("SELECT COUNT(*) n FROM candidates WHERE outcome = 'conflict'"),
        items: n("SELECT COUNT(*) n FROM candidates WHERE outcome = 'queued' AND changeset_id IS NULL"),
        changes: n("SELECT COUNT(*) n FROM changesets WHERE status IN ('pending', 'stale')"),
        fixes: n("SELECT COUNT(*) n FROM candidates WHERE outcome = 'suggested'"),
      };
    },

    value(params) {
      const { days, since } = rangeStart(params, 90);
      const enabledAt = Number(getMeta(db, 'learning_enabled_at')) || null;
      const split = db.prepare(`
        SELECT CASE WHEN ? IS NOT NULL AND COALESCE(session_started_at, ts) >= ? THEN 'after' ELSE 'before' END phase,
               COUNT(DISTINCT session_id) sessions, COALESCE(SUM(turns_reviewed), 0) turns, COALESCE(SUM(corrections), 0) corrections
        FROM reviews WHERE status = 'ok' GROUP BY phase`).all(enabledAt, enabledAt ?? 0);
      const phase = (p) => {
        const r = split.find((x) => x.phase === p) || { sessions: 0, turns: 0, corrections: 0 };
        return { ...r, rate: r.turns ? (r.corrections / r.turns) * 100 : null };
      };
      const series = emptySeries(since, () => ({ reviewedTurns: 0, corrections: 0, misses: 0, sessions: 0, hits: 0 }));
      for (const r of db.prepare("SELECT COALESCE(session_started_at, ts) t, turns_reviewed, corrections FROM reviews WHERE status = 'ok' AND COALESCE(session_started_at, ts) >= ?").all(since)) {
        const d = series.get(dayKey(r.t));
        if (d) { d.reviewedTurns += r.turns_reviewed; d.corrections += r.corrections; }
      }
      for (const r of db.prepare('SELECT s.started_at t FROM candidates c JOIN sessions s ON s.id = c.session_id WHERE c.repeats IS NOT NULL AND s.started_at >= ?').all(since)) {
        const d = series.get(dayKey(r.t));
        if (d) d.misses++;
      }
      for (const r of db.prepare('SELECT started_at t FROM sessions WHERE started_at >= ?').all(since)) {
        const d = series.get(dayKey(r.t));
        if (d) d.sessions++;
      }
      const hits = db.prepare(HITS_SQL).all(since);
      for (const r of hits) {
        const d = series.get(dayKey(r.ts));
        if (d) d.hits++;
      }
      const sessions = db.prepare('SELECT COUNT(*) n FROM sessions WHERE started_at >= ?').get(since).n;
      const top = db.prepare(`
        SELECT id, kind, title, uses, last_used_at, confidence FROM learnings
        WHERE status = 'active' AND origin_session IS NOT 'native' ORDER BY uses DESC, updated_at DESC LIMIT 10`).all();
      const misses = db.prepare(`
        SELECT c.title, c.repeats, s.started_at FROM candidates c JOIN sessions s ON s.id = c.session_id
        WHERE c.repeats IS NOT NULL ORDER BY s.started_at DESC LIMIT 20`).all();
      return { days, enabledAt, before: phase('before'), after: phase('after'), series: [...series.values()], hits: hits.length, sessions, top, misses };
    },

    cost(params) {
      const { days, since } = rangeStart(params, 30);
      const opts = readOptions();
      const series = emptySeries(since, () => ({ usd: 0, inloopTokens: 0, reviews: 0 }));
      for (const r of db.prepare('SELECT ts, mode, cost_usd, input_tokens, output_tokens, cache_write_tokens FROM reviews WHERE ts >= ?').all(since)) {
        const d = series.get(dayKey(r.ts));
        if (!d) continue;
        d.usd += r.cost_usd;
        d.reviews++;
        if (r.mode === 'inloop') d.inloopTokens += r.input_tokens + r.output_tokens + r.cache_write_tokens;
      }
      const byMode = db.prepare(`
        SELECT mode, COUNT(*) n, COALESCE(SUM(cost_usd), 0) usd, COALESCE(SUM(output_tokens), 0) output,
               COALESCE(SUM(input_tokens + cache_write_tokens), 0) input, COALESCE(SUM(cache_read_tokens), 0) cache_read
        FROM reviews WHERE ts >= ? GROUP BY mode`).all(since);
      const recent = db.prepare(`
        SELECT r.ts, r.mode, r.trigger, r.status, r.detail, r.turns_reviewed, r.corrections, r.learned, r.patched,
               r.input_tokens + r.cache_write_tokens input, r.cache_read_tokens cache_read, r.output_tokens output, r.cost_usd, s.cwd, s.project
        FROM reviews r LEFT JOIN sessions s ON s.id = r.session_id WHERE r.trigger IS NOT 'triage-summary' ORDER BY r.ts DESC LIMIT 40`).all();
      const sessions = db.prepare('SELECT COUNT(*) n FROM sessions WHERE started_at >= ?').get(since).n;
      const hits = db.prepare(HITS_SQL).all(since).length;
      const contextChars = opts?.learning === false ? 0 : (overheadChars() || 0);
      return {
        days,
        month: { usd: monthSpend(db), budget: opts?.monthlyBudgetUsd ?? null },
        byMode,
        series: [...series.values()],
        overhead: { charsPerSession: contextChars, tokensPerSession: Math.round(contextChars / 4), sessions, tokens: Math.round((contextChars / 4) * sessions) },
        hits,
        recent,
      };
    },

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
        queued: db.prepare("SELECT COUNT(*) n FROM candidates WHERE outcome IN ('queued', 'conflict')").get().n,
        maintenance: db.prepare('SELECT ts, archived, merged, cost_usd FROM maintenance ORDER BY id DESC LIMIT 1').get() || null,
        cost: { month: monthSpend(db), budget: opts?.monthlyBudgetUsd ?? null, monthStart: monthStart() },
        options: opts,
        series: [...series.values()],
        sessions,
      };
    },

    queue() {
      // Two kinds of entries: new items (memories, skills, profile facts) and changes to
      // an existing file (changesets, each with the learnings it implements).
      const items = db.prepare(`
        SELECT c.id, c.kind, c.scope, c.memory_type, c.title, c.summary, c.evidence, c.confidence, c.ts, c.cwd, c.project, c.payload, c.note, c.triaged_at,
               s.started_at session_started_at
        FROM candidates c LEFT JOIN sessions s ON s.id = c.session_id
        WHERE c.outcome = 'queued' AND c.changeset_id IS NULL
        ORDER BY COALESCE(s.started_at, c.ts), c.id LIMIT 500`).all().map((r) => {
        let item = {};
        try { item = JSON.parse(r.payload || '{}').item || {}; } catch { /* ignore */ }
        const { payload, ...rest } = r;
        return { ...rest, key: String(r.id), type: 'item', op: item.op || 'create', target: item.target || null, block: item.block || null, description: item.description || null };
      });
      const changes = db.prepare("SELECT * FROM changesets WHERE status IN ('pending', 'stale') ORDER BY id").all().map((cs) => changesetView(db, cs));
      // Natural order: by when the originating session happened, oldest first.
      return [...items, ...changes].sort((a, b) => (a.session_started_at || a.ts || a.created_at || 0) - (b.session_started_at || b.ts || b.created_at || 0));
    },

    conflicts() {
      return db.prepare(`
        SELECT c.id, c.title, c.claim, c.summary, c.note, c.evidence, c.target, c.cwd, c.project, s.started_at session_started_at
        FROM candidates c LEFT JOIN sessions s ON s.id = c.session_id
        WHERE c.outcome = 'conflict' ORDER BY COALESCE(s.started_at, c.ts), c.id LIMIT 100`).all();
    },

    suggestions() {
      return db.prepare(`
        SELECT c.id, c.title, c.summary, c.note, c.cwd, c.project, s.started_at session_started_at
        FROM candidates c LEFT JOIN sessions s ON s.id = c.session_id
        WHERE c.outcome = 'suggested' ORDER BY COALESCE(s.started_at, c.ts) DESC, c.id LIMIT 100`).all();
    },

    dropped() {
      return db.prepare(`
        SELECT c.id, c.kind, c.title, c.summary, c.outcome, c.note, c.decided_at, s.started_at session_started_at, c.cwd, c.project
        FROM candidates c LEFT JOIN sessions s ON s.id = c.session_id
        WHERE c.outcome IN ('dropped', 'merged') ORDER BY c.decided_at DESC, c.id LIMIT 200`).all();
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

    quality(params) {
      const days = Math.min(Math.max(Number(params.get('days')) || 30, 1), 365);
      const since = Date.now() - days * DAY;
      const outcomes = db.prepare('SELECT outcome, note FROM candidates WHERE ts >= ? AND outcome IS NOT NULL').all(since);
      const count = (o) => outcomes.filter((x) => x.outcome === o).length;
      const dropReasons = {};
      for (const x of outcomes.filter((o) => o.outcome === 'dropped')) {
        const reason = String(x.note || 'dropped').split(/[:[]/)[0].trim() || 'dropped';
        dropReasons[reason] = (dropReasons[reason] || 0) + 1;
      }
      const writes = db.prepare('SELECT COUNT(DISTINCT batch) n, COUNT(DISTINCT CASE WHEN reverted_at IS NOT NULL THEN batch END) undone FROM writes WHERE ts >= ?').get(since);
      const decided = db.prepare("SELECT outcome FROM candidates WHERE decided_at >= ? AND outcome IN ('created', 'patched', 'rejected_by_user') OR (decided_at >= ? AND outcome LIKE 'approved_%')").all(since, since);
      const approved = decided.filter((d) => d.outcome !== 'rejected_by_user').length;
      return {
        days,
        proposed: outcomes.length,
        saved: count('created') + count('patched'),
        queued: count('queued'),
        conflicts: count('conflict'),
        dropped: count('dropped'),
        merged: count('merged'),
        rejectedByUser: count('rejected_by_user'),
        suggested: count('suggested') + count('dismissed'),
        duplicates: count('duplicate'),
        changes: db.prepare("SELECT status, COUNT(*) n FROM changesets WHERE created_at >= ? GROUP BY status").all(since),
        dropReasons,
        approvalRate: decided.length ? approved / decided.length : null,
        undoRate: writes.n ? writes.undone / writes.n : null,
        writes: writes.n,
      };
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
