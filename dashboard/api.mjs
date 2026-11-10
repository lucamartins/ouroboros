// Read-only JSON API for the dashboard.
//
// Every list route returns `{ rows, total }` and takes `limit` (default 50), `offset`,
// `q` (a case-insensitive substring of the row's text), `project` (a project id from the
// `projects` route) and, where it applies, `kind`, `outcome`, `days`, `sort` and `dir`.
// Nothing is cut silently: `total` always counts every row that matches.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { changesetView, fileDisplayName, getChangeset } from '../scripts/changesets.mjs';
import { getMeta, monthSpend, monthStart } from '../scripts/db.mjs';
import { actsThroughIndex } from '../scripts/maintenance.mjs';
import { loadSettings } from '../scripts/settings.mjs';
import { listInstructionFiles, listMemories, listPluginSkills, listSkills } from '../scripts/inventory.mjs';
import { claudeDir, dataDir, home, normalize, ouroborosDir, projectKey, repoRoot } from '../scripts/paths.mjs';
import { inboxCounts, sessionContext } from '../scripts/hook.mjs';
import { inboxEntries } from '../scripts/inbox.mjs';
import { buildGraph, focusGraph } from '../scripts/graph.mjs';
import { knowledgeFiles, knowledgeKind } from '../scripts/knowledge.mjs';
import { lineDiff } from '../scripts/textdiff.mjs';

const DAY = 86_400_000;
const MEMORY_INDEX_LINE_LIMIT = 200; // Claude Code loads the first 200 lines / 25KB of MEMORY.md
const MEMORY_INDEX_BYTE_LIMIT = 25_000;

/** Unused learnings below this confidence are archived after `archiveAfterDaysUnused` (maintenance.mjs). */
const KEEP_CONFIDENCE = 0.7;
const MAX_HUNKS = 6;
const MAX_HUNK_LINES = 12;

/** Page size of list routes when the caller does not ask for one, and the most it may ask. */
export const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
/** Inbox entries shown per group before "Load more"; inventory rows per group likewise. */
export const INBOX_GROUP_SIZE = 20;
const INVENTORY_GROUP_SIZE = 20;
/** The filesystem inventory is scanned at most this often (pagination and sorting reuse it). */
const INVENTORY_TTL_MS = 5000;

function bodyOf(text) {
  return String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

/** What one write changed in one file, for display: hunks, or the new file's text. */
function writeView(w) {
  const name = path.basename(w.file);
  const isLink = [w.before, w.after].some((x) => x && String(x).startsWith('@link:'));
  if (isLink) return null;
  if (name === 'MEMORY.md' && w.op !== 'consolidate') return null; // index lines mirror the memory itself
  if (normalize(w.file).includes('/.ouroboros/archive/')) return null;
  if (w.before === null) return { file: w.file, created: true, text: bodyOf(w.after).slice(0, 1500) };
  if (w.after === null) return { file: w.file, removed: true };
  const hunks = lineDiff(w.before, w.after).slice(0, MAX_HUNKS).map((h) => ({
    before: h.before.slice(0, MAX_HUNK_LINES), after: h.after.slice(0, MAX_HUNK_LINES),
    more: Math.max(0, h.before.length - MAX_HUNK_LINES) + Math.max(0, h.after.length - MAX_HUNK_LINES),
  }));
  return { file: w.file, hunks };
}

/** A readable title for a write recorded before writes carried one: its first added line. */
function fallbackTitle(files, learning) {
  for (const f of files) {
    const line = (f.hunks || []).flatMap((h) => h.after).find((l) => l.replace(/[-*#|>\s]/g, '').length > 8)
      || (f.text || '').split(/\r?\n/).find((l) => l.replace(/[-*#|>\s]/g, '').length > 8);
    if (line) {
      const text = line.replace(/^[\s>*#|-]+/, '').replace(/\s*<!--.*?-->\s*$/, '').replace(/`/g, '').replace(/\*\*/g, '');
      // The first sentence, or a cut at a word boundary.
      // A sentence ends before a capital letter (so "e.g. in" does not end it).
      const sentence = /^(.{20,170}?[.!?])(?=\s+[A-Z]|\s*$)/.exec(text)?.[1];
      if (sentence) return sentence;
      return text.length > 160 ? `${text.slice(0, 160).replace(/\s+\S*$/, '')}…` : text;
    }
  }
  return learning?.title || (files[0] ? path.basename(files[0].file) : 'change');
}

function readOptions() {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir(), 'options.json'), 'utf8')); } catch { return null; }
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Characters Ouroboros adds to every session's context (the learning protocol). */
function overheadChars() {
  try { return sessionContext().length; } catch { return null; }
}

function knownCwds(db) {
  return db.prepare('SELECT cwd, MAX(started_at) last FROM sessions WHERE cwd IS NOT NULL GROUP BY cwd ORDER BY last DESC').all().map((r) => r.cwd);
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

/** A path as the user reads it: the home directory as `~`, forward slashes. */
export function tilde(file) {
  if (!file) return '';
  const f = String(file).replace(/\\/g, '/');
  const h = home.replace(/\\/g, '/');
  return f.toLowerCase() === h.toLowerCase() ? '~' : f.toLowerCase().startsWith(`${h.toLowerCase()}/`) ? `~${f.slice(h.length)}` : f;
}

// ---------- list parameters ----------

function toParams(params) {
  return params instanceof URLSearchParams ? params : new URLSearchParams(params || {});
}

function paging(params) {
  return {
    limit: Math.min(Math.max(Math.trunc(Number(params.get('limit'))) || DEFAULT_LIMIT, 1), MAX_LIMIT),
    offset: Math.max(Math.trunc(Number(params.get('offset'))) || 0, 0),
    q: String(params.get('q') || '').trim().slice(0, 200),
    project: params.get('project') || null,
  };
}

/** Sort direction: `dir=asc|desc`, else the route's default. */
function dirOf(params, fallback = 'desc') {
  const d = params.get('dir');
  return (d === 'asc' || d === 'desc' ? d : fallback).toUpperCase();
}

/** `days=N` keeps the last N days (1–3650); absent or `all`, no limit. */
function sinceOf(params) {
  const days = Number(params.get('days'));
  if (!days || days < 1) return null;
  const start = new Date(Date.now() - (Math.min(days, 3650) - 1) * DAY);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

const likeArg = (q) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const LIKE = "LIKE ? ESCAPE '\\'";
const contains = (q, ...xs) => !q || xs.some((x) => String(x ?? '').toLowerCase().includes(q.toLowerCase()));

/** COUNT and one page of a query built from WHERE fragments. */
function listOf(db, { select, from, where = [], args = [], order, limit, offset }) {
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) n ${from} ${w}`).get(...args).n;
  const rows = db.prepare(`SELECT ${select} ${from} ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset);
  return { rows, total };
}

/** Sessions that used at least one learned memory or skill. */
const HITS_SQL = `
  SELECT e.session_id, MIN(e.ts) ts FROM events e
  JOIN learnings l ON l.status = 'active' AND l.origin_session IS NOT 'native' AND (
    (e.kind = 'skill_used' AND l.kind = 'skill' AND (e.target = l.name OR e.target LIKE '%:' || l.name)) OR
    (e.kind = 'memory_read' AND lower(e.target) = lower(l.path)))
  WHERE e.ts >= ? GROUP BY e.session_id`;

const GROUP_LABEL = { 'new:memory': 'New memories', 'new:skill': 'New skills', 'new:preference': 'New preferences', fixes: 'Suggested fixes' };

export function createApi(db) {
  // ---------- projects ----------
  // A project is a repository (its main checkout, so worktrees and subfolders count as one)
  // or, outside git, the session's folder. Claude Code keys sessions by folder, so one
  // project gathers every key that resolves to it.
  const repoOf = new Map();
  const repoOfDir = (dir) => {
    if (!repoOf.has(dir)) repoOf.set(dir, repoRoot(dir));
    return repoOf.get(dir);
  };
  let projectCache = null;

  function projects() {
    const sig = db.prepare(`SELECT (SELECT COUNT(*) FROM sessions) || ':' || (SELECT COALESCE(MAX(id), 0) FROM candidates) || ':'
      || (SELECT COALESCE(MAX(id), 0) FROM changesets) || ':' || (SELECT COALESCE(MAX(id), 0) FROM writes) s`).get().s;
    if (projectCache?.sig === sig) return projectCache;
    const list = new Map();
    const byKey = new Map();
    const register = (dir, { key = null, repo = false, sessions = 0, last = 0 } = {}) => {
      const id = dir ? projectKey(dir) : key;
      let p = list.get(id);
      if (!p) { p = { id, dir: dir || null, repo, sessions: 0, last: 0 }; list.set(id, p); }
      if (key) byKey.set(key, id);
      byKey.set(id, id);
      p.sessions += sessions;
      p.last = Math.max(p.last, last || 0);
      return id;
    };
    const fromCwd = (cwd, opts) => {
      const root = cwd ? repoOfDir(cwd) : null;
      return register(root || cwd, { ...opts, repo: !!root });
    };
    for (const r of db.prepare('SELECT project, cwd, COUNT(*) n, MAX(started_at) last FROM sessions WHERE project IS NOT NULL GROUP BY project, cwd').all()) {
      fromCwd(r.cwd, { key: r.project, sessions: r.n, last: r.last });
    }
    for (const r of db.prepare('SELECT DISTINCT project, cwd FROM candidates WHERE project IS NOT NULL UNION SELECT DISTINCT project, cwd FROM changesets WHERE project IS NOT NULL').all()) {
      if (!byKey.has(r.project)) fromCwd(r.cwd, { key: r.project });
    }
    const personal = [normalize(claudeDir()), normalize(ouroborosDir())];
    const fileProject = (file) => {
      if (!file) return null;
      const f = String(file).replace(/\\/g, '/');
      const mem = /\/projects\/([^/]+)\/memory\/[^/]+$/.exec(f);
      if (mem && normalize(f).startsWith(`${personal[0]}/`)) return byKey.get(mem[1]) || register(null, { key: mem[1] });
      if (personal.some((p) => normalize(f).startsWith(`${p}/`))) return null;
      const root = repoOfDir(path.dirname(file));
      return root ? register(root, { repo: true }) : null;
    };
    for (const r of db.prepare('SELECT DISTINCT file FROM writes').all()) fileProject(r.file);

    // Display names: the repository's folder, `~` for the home folder, else the folder
    // name; names that collide fall back to the path.
    const name = (p) => {
      if (!p.dir) return String(p.id).split('-').filter(Boolean).pop() || p.id;
      if (normalize(p.dir) === normalize(home)) return '~';
      return path.basename(p.dir) || p.dir;
    };
    const named = [...list.values()].map((p) => ({ ...p, name: name(p), path: p.dir ? tilde(p.dir) : null }));
    const seen = new Map();
    for (const p of named) seen.set(p.name, (seen.get(p.name) || 0) + 1);
    for (const p of named) if (seen.get(p.name) > 1 && p.path) p.name = p.path;
    const byId = new Map(named.map((p) => [p.id, p]));
    projectCache = {
      sig, byId, byKey, fileProject,
      idOf: (key) => (key ? byKey.get(key) || key : null),
      nameOf: (key, cwd) => byId.get(byKey.get(key) || key)?.name || (cwd ? path.basename(cwd) : key ? String(key).split('-').filter(Boolean).pop() : null),
      /** Project keys of one project id, for `project IN (...)`. */
      keysOf: (id) => [id, ...[...byKey].filter(([, v]) => v === id).map(([k]) => k)].filter((v, i, a) => a.indexOf(v) === i),
    };
    return projectCache;
  }

  /** Adds `project_id` and `project_name` to rows that carry a session project key. */
  function annotate(rows, keyField = 'project') {
    const idx = projects();
    return rows.map((r) => ({ ...r, project_id: idx.idOf(r[keyField]), project_name: idx.nameOf(r[keyField], r.cwd) }));
  }

  function whereProject(column, id, where, args) {
    if (!id) return;
    const keys = projects().keysOf(id);
    where.push(`${column} IN (${keys.map(() => '?').join(',')})`);
    args.push(...keys);
  }

  function whereSince(column, params, where, args) {
    const since = sinceOf(params);
    if (since === null) return;
    where.push(`${column} >= ?`);
    args.push(since);
  }

  function whereText(columns, q, where, args) {
    if (!q) return;
    where.push(`(${columns.map((c) => `${c} ${LIKE}`).join(' OR ')})`);
    args.push(...columns.map(() => likeArg(q)));
  }

  // ---------- learned (ledger batches) ----------

  /** Every batch, light (no file contents), with its project and the text the filter searches. */
  function learnedIndex() {
    const idx = projects();
    const sessions = new Map(db.prepare('SELECT id, project, cwd, started_at FROM sessions').all().map((s) => [s.id, s]));
    const titles = new Map(db.prepare('SELECT id, title FROM learnings').all().map((l) => [l.id, l.title]));
    return db.prepare(`
      SELECT w.batch, MIN(w.id) first_id, MIN(w.ts) ts, MAX(w.op) op, MAX(w.actor) actor, MAX(w.session_id) session_id,
             MAX(w.reverted_at) reverted_at, MAX(w.title) title, MAX(w.why) why, MAX(w.learning_id) learning_id,
             GROUP_CONCAT(w.file, char(10)) files
      FROM writes w WHERE w.op IN ('create', 'patch', 'consolidate')
      GROUP BY w.batch ORDER BY first_id DESC`).all().map((b) => {
      const files = String(b.files || '').split('\n').filter(Boolean);
      const s = b.session_id ? sessions.get(b.session_id) : null;
      const project = files.map(idx.fileProject).find(Boolean) || (s ? idx.idOf(s.project) : null);
      return { ...b, files, session: s, project, text: [b.title, titles.get(b.learning_id), b.why, ...files.map(tilde)] };
    });
  }

  function learnedRow(b) {
    const idx = projects();
    const settings = loadSettings();
    const days = settings.archiveAfterDaysUnused || 60;
    const l = b.learning_id ? db.prepare('SELECT * FROM learnings WHERE id = ?').get(b.learning_id) : null;
    const files = db.prepare('SELECT * FROM writes WHERE batch = ? ORDER BY id').all(b.batch).map(writeView).filter(Boolean);
    const s = b.session;
    const own = l && l.origin_session !== 'native';
    // Only what Ouroboros created can be archived automatically: say when, or that it is kept.
    let lifecycle = null;
    if (l && own && l.status === 'active' && ['memory', 'skill'].includes(l.kind) && b.op === 'create') {
      if (l.pinned) lifecycle = { state: 'kept' };
      else if (actsThroughIndex(l)) lifecycle = { state: 'index' };
      else if ((l.confidence ?? 0.5) >= KEEP_CONFIDENCE) lifecycle = { state: 'confident' };
      else lifecycle = { state: 'decays', at: Math.max(l.created_at || 0, l.last_used_at || 0) + days * DAY };
    }
    return {
      batch: b.batch, ts: b.ts, op: b.op, actor: b.actor, undone: !!b.reverted_at,
      // Batches recorded as "SKILL.md: 2 updates" are named by their skill (or "<skill>/<file>").
      title: (b.title && files[0] && b.title.startsWith(`${path.basename(files[0].file)}:`)
        ? `${fileDisplayName(files[0].file)}${b.title.slice(path.basename(files[0].file).length)}` : b.title)
        || (b.op === 'create' && l ? l.title : fallbackTitle(files, l)),
      why: b.why, files,
      project_id: b.project, project_name: b.project ? idx.byId.get(b.project)?.name || null : null,
      session: s ? { id: s.id, started_at: s.started_at, project: s.project, cwd: s.cwd } : null,
      changeset: db.prepare('SELECT id FROM changesets WHERE batch = ?').get(b.batch)?.id || null,
      learning: l ? {
        id: l.id, kind: l.kind, memory_type: l.memory_type, block: l.block, name: l.name, path: l.path, status: l.status,
        own, pinned: !!l.pinned, uses: l.uses, last_used_at: l.last_used_at,
      } : null,
      canArchive: !!(l && own && l.status === 'active' && b.op === 'create' && !b.reverted_at),
      lifecycle,
      misses: l?.misses || 0,
    };
  }

  // ---------- inventory (files on disk) ----------
  let inventoryCache = null;

  function inventoryData() {
    if (inventoryCache && Date.now() - inventoryCache.at < INVENTORY_TTL_MS) return inventoryCache.data;
    const idx = projects();
    const cwds = knownCwds(db);
    const reads = new Map();
    for (const r of db.prepare("SELECT target, COUNT(*) n, MAX(ts) last FROM events WHERE kind = 'memory_read' GROUP BY target").all()) {
      reads.set(normalize(r.target), r);
    }
    const uses = new Map();
    for (const r of db.prepare("SELECT target, COUNT(*) n, MAX(ts) last FROM events WHERE kind = 'skill_used' GROUP BY target").all()) {
      for (const name of new Set([String(r.target), String(r.target).split(':').pop()])) {
        const prev = uses.get(name);
        uses.set(name, { n: (prev?.n || 0) + r.n, last: Math.max(prev?.last || 0, r.last) });
      }
    }
    const project = (key) => ({ project_id: idx.idOf(key), project_name: key ? idx.nameOf(key) : null });
    const skills = [...listSkills(cwds), ...listPluginSkills()].map((s) => {
      const u = uses.get(s.name) || uses.get(s.name.split(':').pop());
      const group = s.scope === 'personal' ? 'personal' : s.scope === 'plugin' ? 'plugin' : 'project';
      return { ...s, ...project(s.project), path: tilde(s.file), group, uses: u?.n || 0, lastUsed: u?.last || null };
    });
    const memories = listMemories().filter((m) => !m.index).map((m) => {
      const r = reads.get(normalize(m.file));
      const p = project(m.project);
      return { ...m, ...p, path: tilde(m.file), group: `project:${p.project_id}`, groupLabel: p.project_name, reads: r?.n || 0, lastRead: r?.last || null };
    });
    const instructions = listInstructionFiles(cwds).map((f) => ({
      ...f, ...project(f.project), name: tilde(f.file), path: tilde(f.file), group: f.scope === 'global' ? 'personal' : 'project',
    }));
    // The same file can be reached from two folders of one project.
    const unique = (rows) => [...new Map(rows.map((r) => [normalize(r.file), r])).values()];
    const data = { skills: unique(skills), memories: unique(memories), instructions: unique(instructions) };
    inventoryCache = { at: Date.now(), data };
    return data;
  }

  const INVENTORY_GROUPS = {
    skills: [['personal', 'Personal'], ['project', 'Project'], ['plugin', 'Plugins']],
    instructions: [['personal', 'Personal'], ['project', 'Project']],
  };
  const INVENTORY_SORT = {
    name: (r) => String(r.name).toLowerCase(),
    uses: (r) => r.uses ?? 0,
    last: (r) => r.lastUsed ?? r.lastRead ?? 0,
    reads: (r) => r.reads ?? 0,
    updated: (r) => r.mtime ?? 0,
    lines: (r) => r.lines ?? 0,
  };

  function inventoryRows(kind, params) {
    const p = paging(params);
    const rows = (inventoryData()[kind] || []).filter((r) =>
      (!p.project || r.project_id === p.project) && contains(p.q, r.name, r.description, r.path, r.project_name, r.type));
    const sort = INVENTORY_SORT[params.get('sort')] ? params.get('sort') : 'name';
    const dir = dirOf(params, sort === 'name' ? 'asc' : 'desc') === 'ASC' ? 1 : -1;
    const key = INVENTORY_SORT[sort];
    return [...rows].sort((a, b) => {
      const x = key(a);
      const y = key(b);
      return (x < y ? -1 : x > y ? 1 : 0) * dir || String(a.name).localeCompare(String(b.name));
    });
  }

  // ---------- graph ----------
  let graphCache = null;

  /**
   * Every knowledge file of the known projects (no sources of truth), every memory and the
   * plugin skills, with the inventory's project and usage, as one graph (scripts/graph.mjs).
   */
  function graphData(plugins) {
    if (graphCache && graphCache.plugins === plugins && Date.now() - graphCache.at < INVENTORY_TTL_MS) return graphCache.data;
    const idx = projects();
    const inv = inventoryData();
    const meta = new Map();
    for (const s of inv.skills) meta.set(normalize(s.file), { name: s.name, scope: s.scope, project_id: s.project_id, project_name: s.project_name, uses: s.uses, lastUsed: s.lastUsed, description: s.description });
    for (const m of inv.memories) meta.set(normalize(m.file), { name: m.name, scope: 'project', project_id: m.project_id, project_name: m.project_name, uses: m.reads, lastUsed: m.lastRead, memoryType: m.type });
    for (const f of inv.instructions) meta.set(normalize(f.file), { label: f.path, scope: f.scope, project_id: f.project_id, project_name: f.project_name });

    const files = new Map();
    const roots = [...new Set(knownCwds(db).map((c) => repoRoot(c) || c))];
    for (const root of roots) for (const f of knowledgeFiles(root)) files.set(normalize(f), f);
    for (const m of inv.memories) files.set(normalize(m.file), m.file);
    for (const s of inv.skills) if (s.scope === 'plugin') files.set(normalize(s.file), s.file);

    const learned = new Set(db.prepare('SELECT DISTINCT file FROM writes WHERE reverted_at IS NULL').all().map((r) => normalize(r.file)));
    const items = [];
    for (const [id, file] of files) {
      let kind = knowledgeKind(file);
      if (kind === 'source') continue;
      if (kind === 'skill' && !/^skill\.md$/i.test(path.basename(file))) kind = 'reference';
      const m = meta.get(id) || {};
      const project_id = 'project_id' in m ? m.project_id : idx.fileProject(file);
      // A repository first seen here (a child repo's rule file) has no display name yet: its folder.
      const project_name = 'project_name' in m ? m.project_name
        : project_id ? idx.byId.get(project_id)?.name || path.basename(repoRoot(path.dirname(file)) || '') || project_id : null;
      const label = m.label || (kind === 'instructions' ? tilde(file) : kind === 'rules' ? `rules/${path.basename(file)}` : undefined);
      items.push({ ...m, file, kind, label, project_id, project_name, learned: learned.has(id) });
    }

    // Usage per session: skills by name (with or without the plugin prefix), memories by file.
    const skillIds = new Map();
    for (const it of items) if (it.kind === 'skill' && it.name) skillIds.set(String(it.name).toLowerCase(), normalize(it.file));
    for (const it of items) if (it.kind === 'skill' && it.name && !skillIds.has(String(it.name).split(':').pop().toLowerCase())) skillIds.set(String(it.name).split(':').pop().toLowerCase(), normalize(it.file));
    const usage = [];
    for (const e of db.prepare("SELECT DISTINCT session_id, kind, target FROM events WHERE kind IN ('skill_used','memory_read') AND target IS NOT NULL").all()) {
      const t = String(e.target);
      const id = e.kind === 'memory_read' ? normalize(t) : skillIds.get(t.toLowerCase()) || skillIds.get(t.split(':').pop().toLowerCase());
      if (id) usage.push({ session: e.session_id, id });
    }
    const data = buildGraph(items, { usage, plugins });
    for (const n of data.nodes) {
      if (n.file) n.path = tilde(n.file);
      delete n.file;
    }
    graphCache = { at: Date.now(), plugins, data };
    return data;
  }

  // ---------- inbox ----------

  /** The inbox entries (inbox.mjs decides which and in what order), with project and group. */
  function inboxList({ project = null, group = null } = {}) {
    const idx = projects();
    return inboxEntries(db).map((e) => {
      const pid = idx.idOf(e.project) || '';
      const gkey = e.type === 'suggestion' ? 'fixes' : e.file ? `file:${normalize(e.file)}` : `new:${e.kind}`;
      return { ...e, pid, gkey, gid: `${pid}|${gkey}` };
    }).filter((e) => (!project || e.pid === project) && (!group || e.gid === group));
  }

  const approvable = (e) => e.type === 'item' || (e.type === 'change' && !e.stale);
  const rejectable = (e) => e.type === 'item' || e.type === 'change';

  /** Full card data for a page of entries, in their order. */
  function hydrate(entries) {
    const ids = (type) => entries.filter((e) => e.type === type).map((e) => Number(e.key.split(':')[1]));
    const byId = (type, sql) => {
      const list = ids(type);
      if (!list.length) return new Map();
      return new Map(db.prepare(sql.replace('$IDS', list.map(() => '?').join(','))).all(...list).map((r) => [r.id, r]));
    };
    const conflicts = byId('conflict', `
      SELECT c.id, c.title, c.claim, c.summary, c.note, c.evidence, c.target, c.cwd, c.project, s.started_at session_started_at
      FROM candidates c LEFT JOIN sessions s ON s.id = c.session_id WHERE c.id IN ($IDS)`);
    const items = byId('item', `
      SELECT c.id, c.kind, c.scope, c.memory_type, c.title, c.summary, c.evidence, c.confidence, c.ts, c.cwd, c.project, c.payload, c.note, c.triaged_at,
             s.started_at session_started_at
      FROM candidates c LEFT JOIN sessions s ON s.id = c.session_id WHERE c.id IN ($IDS)`);
    const fixes = byId('suggestion', `
      SELECT c.id, c.title, c.summary, c.note, c.cwd, c.project, s.started_at session_started_at
      FROM candidates c LEFT JOIN sessions s ON s.id = c.session_id WHERE c.id IN ($IDS)`);
    const idx = projects();
    return entries.map((e) => {
      const id = Number(e.key.split(':')[1]);
      let row = null;
      if (e.type === 'conflict') row = conflicts.get(id);
      else if (e.type === 'suggestion') row = fixes.get(id);
      else if (e.type === 'change') {
        const cs = getChangeset(db, id);
        row = cs ? { ...changesetView(db, cs), project: cs.project, cwd: cs.cwd } : null;
      } else {
        const r = items.get(id);
        if (r) {
          let item = {};
          try { item = JSON.parse(r.payload || '{}').item || {}; } catch { /* ignore */ }
          const { payload, ...rest } = r;
          row = { ...rest, op: item.op || 'create', target: item.target || null, block: item.block || null, description: item.description || null };
        }
      }
      if (!row) return null;
      return { ...row, key: e.key, type: e.type, group: e.gid, project_id: e.pid || null, project_name: e.pid ? idx.byId.get(e.pid)?.name || idx.nameOf(e.project, e.cwd) : null };
    }).filter(Boolean);
  }

  const routes = {
    ping: () => ({ app: 'ouroboros' }),

    /** What waits for the user, for the navigation badge; plus the plugin version. */
    counts() {
      let version = null;
      try { version = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.claude-plugin', 'plugin.json'), 'utf8')).version; } catch { /* unknown */ }
      const inbox = inboxCounts(db);
      return {
        version,
        home: home.replace(/\\/g, '/'),
        options: readOptions(),
        conflicts: inbox.conflicts,
        items: inbox.items,
        changes: inbox.changes,
        fixes: inbox.fixes,
        total: inbox.total,
      };
    },

    /** Projects seen in sessions and learnings: id, display name, folder, sessions. */
    projects() {
      const idx = projects();
      return { rows: [...idx.byId.values()].map((p) => ({ id: p.id, name: p.name, path: p.path, repo: p.repo, sessions: p.sessions, last: p.last }))
        .sort((a, b) => b.last - a.last || a.name.localeCompare(b.name)) };
    },

    value(params) {
      const { days, since } = rangeStart(params, 90);
      const enabledAt = Number(getMeta(db, 'learning_enabled_at')) || null;
      const split = db.prepare(`
        SELECT CASE WHEN ? IS NOT NULL AND COALESCE(session_started_at, ts) >= ? THEN 'after' ELSE 'before' END phase,
               COUNT(DISTINCT session_id) sessions, COALESCE(SUM(turns_reviewed), 0) turns, COALESCE(SUM(corrections), 0) corrections
        FROM reviews WHERE status = 'ok' AND instrument = 'corrections' GROUP BY phase`).all(enabledAt, enabledAt ?? 0);
      // What the learning reviews counted on their own (in session: Claude about itself;
      // end of session: tails only). Shown apart, never mixed into the rate.
      const other = db.prepare(`
        SELECT COALESCE(SUM(turns_reviewed), 0) turns, COALESCE(SUM(corrections), 0) corrections
        FROM reviews WHERE status = 'ok' AND instrument IS NULL AND mode IN ('inloop', 'background') AND turns_reviewed > 0`).get();
      const phase = (p) => {
        const r = split.find((x) => x.phase === p) || { sessions: 0, turns: 0, corrections: 0 };
        return { ...r, rate: r.turns ? (r.corrections / r.turns) * 100 : null };
      };
      const series = emptySeries(since, () => ({ reviewedTurns: 0, corrections: 0, misses: 0, sessions: 0, hits: 0 }));
      for (const r of db.prepare("SELECT COALESCE(session_started_at, ts) t, turns_reviewed, corrections FROM reviews WHERE status = 'ok' AND instrument = 'corrections' AND COALESCE(session_started_at, ts) >= ?").all(since)) {
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
      return { days, enabledAt, before: phase('before'), after: phase('after'), selfReported: { ...other, rate: other.turns ? (other.corrections / other.turns) * 100 : null }, series: [...series.values()], hits: hits.length, sessions, top };
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
        FROM reviews WHERE status = 'ok' AND instrument = 'corrections' AND COALESCE(session_started_at, ts) >= ?`).get(since);
      const candidates = db.prepare(`
        SELECT kind, COUNT(*) n FROM candidates c JOIN sessions s ON s.id = c.session_id
        WHERE s.started_at >= ? GROUP BY kind`).all(since);
      // Misses in the period: proposals that repeat something already learned.
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
      for (const r of db.prepare("SELECT COALESCE(session_started_at, ts) t, turns_reviewed, corrections FROM reviews WHERE status = 'ok' AND instrument = 'corrections' AND COALESCE(session_started_at, ts) >= ?").all(since)) {
        const d = series.get(dayKey(r.t));
        if (d) { d.reviewedTurns += r.turns_reviewed; d.corrections += r.corrections; }
      }
      for (const r of db.prepare('SELECT ts, cost_usd FROM reviews WHERE ts >= ?').all(since)) {
        const d = series.get(dayKey(r.ts));
        if (d) d.cost += r.cost_usd;
      }

      return {
        days,
        totals: { ...totals, recoveries },
        reviewed,
        correctionRate: reviewed.turns ? (reviewed.corrections / reviewed.turns) * 100 : null,
        candidates: Object.fromEntries(candidates.map((c) => [c.kind, c.n])),
        misses,
        learned: { ...learned, patchedNative, enabledAt },
        maintenance: db.prepare('SELECT ts, archived, merged, cost_usd FROM maintenance ORDER BY id DESC LIMIT 1').get() || null,
        cost: { month: monthSpend(db), budget: opts?.monthlyBudgetUsd ?? null, monthStart: monthStart() },
        options: opts,
        series: [...series.values()],
      };
    },

    /** The last writes, light, for the Overview feed. */
    recent(params) {
      const limit = Math.min(Math.max(Number(params.get('limit')) || 8, 1), 50);
      const rows = db.prepare(`
        SELECT w.batch, MIN(w.ts) ts, MAX(w.op) op, MAX(w.reverted_at) reverted_at, COALESCE(MAX(w.title), MAX(l.title)) title, MIN(w.file) file
        FROM writes w LEFT JOIN learnings l ON l.id = w.learning_id
        GROUP BY w.batch ORDER BY MIN(w.id) DESC LIMIT ?`).all(limit);
      return { rows: rows.map((r) => ({ ...r, path: tilde(r.file) })) };
    },

    /**
     * The inbox, grouped by project and then by target file (new items without one by
     * kind; suggested fixes together), in inbox.mjs's order. Each group carries its first
     * entries; `group` with `offset`/`limit` pages through one group.
     */
    inbox(params) {
      const project = params.get('project') || null;
      const group = params.get('group');
      if (group) {
        const p = paging(params);
        const list = inboxList({ project, group });
        return { rows: hydrate(list.slice(p.offset, p.offset + p.limit)), total: list.length };
      }
      const per = Math.min(Math.max(Number(params.get('per')) || INBOX_GROUP_SIZE, 1), MAX_LIMIT);
      const list = inboxList({ project });
      const idx = projects();
      const out = new Map();
      for (const e of list) {
        if (!out.has(e.pid)) {
          const p = idx.byId.get(e.pid);
          out.set(e.pid, { id: e.pid || null, name: p?.name || idx.nameOf(e.project, e.cwd) || 'No project', path: p?.path || null, total: 0, groups: new Map() });
        }
        const pr = out.get(e.pid);
        pr.total++;
        if (!pr.groups.has(e.gid)) {
          pr.groups.set(e.gid, {
            id: e.gid, label: GROUP_LABEL[e.gkey] || null, file: e.gkey.startsWith('file:') ? e.file : null, path: e.gkey.startsWith('file:') ? tilde(e.file) : null,
            total: 0, approvable: 0, rejectable: 0, types: {}, list: [],
          });
        }
        const g = pr.groups.get(e.gid);
        g.total++;
        g.types[e.type] = (g.types[e.type] || 0) + 1;
        if (approvable(e)) g.approvable++;
        if (rejectable(e)) g.rejectable++;
        g.list.push(e);
      }
      const count = (t) => list.filter((e) => e.type === t).length;
      return {
        total: list.length,
        counts: { conflicts: count('conflict'), changes: count('change'), items: count('item'), fixes: count('suggestion') },
        approvable: list.filter(approvable).length,
        rejectable: list.filter(rejectable).length,
        unchecked: list.filter((e) => (e.type === 'item' && !e.evaluated) || (e.type === 'change' && e.stale)).length,
        per,
        projects: [...out.values()].map((pr) => ({
          ...pr,
          groups: [...pr.groups.values()].map(({ list: entries, ...g }) => ({ ...g, entries: hydrate(entries.slice(0, per)) })),
        })),
      };
    },

    sessions(params) {
      const p = paging(params);
      const where = [];
      const args = [];
      whereProject('s.project', p.project, where, args);
      whereSince('s.started_at', params, where, args);
      whereText(['s.cwd'], p.q, where, args);
      const r = listOf(db, {
        select: `s.id, s.project, s.cwd, s.started_at, s.turns, s.tool_calls, s.tool_fails, s.queue_state,
          (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.kind = 'recovery') recoveries,
          (SELECT COALESCE(SUM(corrections),0) FROM reviews r WHERE r.session_id = s.id AND r.status = 'ok' AND r.instrument = 'corrections') corrections,
          (SELECT COUNT(*) FROM candidates c WHERE c.session_id = s.id) candidates,
          (SELECT COALESCE(SUM(cost_usd),0) FROM reviews r WHERE r.session_id = s.id) cost`,
        from: 'FROM sessions s', where, args, order: `s.started_at ${dirOf(params)}, s.id`, ...p,
      });
      return { rows: annotate(r.rows), total: r.total };
    },

    reviews(params) {
      const p = paging(params);
      const where = ["r.trigger IS NOT 'triage-summary'"];
      const args = [];
      whereProject('s.project', p.project, where, args);
      whereSince('r.ts', params, where, args);
      whereText(['r.detail', 'r.trigger', 'r.mode'], p.q, where, args);
      const r = listOf(db, {
        select: `r.ts, r.mode, r.trigger, r.status, r.detail, r.turns_reviewed, r.corrections, r.learned, r.patched,
          r.input_tokens + r.cache_write_tokens input, r.cache_read_tokens cache_read, r.output_tokens output, r.cost_usd, s.cwd, s.project`,
        from: 'FROM reviews r LEFT JOIN sessions s ON s.id = r.session_id', where, args, order: `r.ts ${dirOf(params)}, r.id`, ...p,
      });
      return { rows: annotate(r.rows), total: r.total };
    },

    /** Everything reviews proposed to learn, and what happened to each. */
    proposals(params) {
      const p = paging(params);
      const where = [];
      const args = [];
      const kind = params.get('kind');
      const outcome = params.get('outcome');
      if (kind && kind !== 'all') { where.push('c.kind = ?'); args.push(kind); }
      if (outcome === 'measured') where.push('c.outcome IS NULL');
      else if (outcome && outcome !== 'all') { where.push('c.outcome = ?'); args.push(outcome); }
      whereProject('COALESCE(c.project, s.project)', p.project, where, args);
      whereSince('s.started_at', params, where, args);
      whereText(['c.title', 'c.summary', 'c.claim'], p.q, where, args);
      const from = 'FROM candidates c JOIN sessions s ON s.id = c.session_id LEFT JOIN changesets cs ON cs.id = c.changeset_id';
      const r = listOf(db, {
        select: `c.id, c.kind, c.memory_type, c.title, c.summary, c.outcome, c.changeset_id, COALESCE(c.project, s.project) project,
          COALESCE(c.cwd, s.cwd) cwd, s.started_at session_started_at, cs.status cs_status, cs.batch cs_batch`,
        from, where, args, order: `s.started_at ${dirOf(params)}, c.id`, ...p,
      });
      return {
        rows: annotate(r.rows), total: r.total,
        kinds: db.prepare(`SELECT DISTINCT c.kind k ${from} WHERE c.kind IS NOT NULL ORDER BY k`).all().map((x) => x.k),
        outcomes: db.prepare(`SELECT DISTINCT COALESCE(c.outcome, 'measured') o ${from} ORDER BY o`).all().map((x) => x.o),
      };
    },

    dropped(params) {
      const p = paging(params);
      const where = ["c.outcome IN ('dropped', 'merged')"];
      const args = [];
      whereProject('c.project', p.project, where, args);
      whereSince('COALESCE(c.decided_at, c.ts)', params, where, args);
      whereText(['c.title', 'c.summary', 'c.note'], p.q, where, args);
      const r = listOf(db, {
        select: 'c.id, c.kind, c.title, c.summary, c.outcome, c.note, c.decided_at, s.started_at session_started_at, c.cwd, c.project',
        from: 'FROM candidates c LEFT JOIN sessions s ON s.id = c.session_id', where, args, order: `c.decided_at ${dirOf(params)}, c.id DESC`, ...p,
      });
      return { rows: annotate(r.rows), total: r.total };
    },

    corrections(params) {
      const p = paging(params);
      const where = [];
      const args = [];
      whereProject('s.project', p.project, where, args);
      whereSince('s.started_at', params, where, args);
      whereText(['c.quote'], p.q, where, args);
      const r = listOf(db, {
        select: 'c.id, c.quote, c.kind, c.session_id, s.started_at session_started_at, s.project, s.cwd',
        from: 'FROM corrections c JOIN sessions s ON s.id = c.session_id', where, args, order: `s.started_at ${dirOf(params)}, c.id`, ...p,
      });
      return { rows: annotate(r.rows), total: r.total };
    },

    /** Totals of every Activity list for the same project and period (the segment counts). */
    activity_counts(params) {
      const base = new URLSearchParams();
      for (const k of ['project', 'days']) if (params.get(k)) base.set(k, params.get(k));
      base.set('limit', '1');
      const total = (name) => routes[name](base).total;
      return { sessions: total('sessions'), reviews: total('reviews'), proposals: total('proposals'), dropped: total('dropped'), corrections: total('corrections') };
    },

    /**
     * Everything Ouroboros learned, one entry per write (ledger batch): what it says, why,
     * where, from which session, what it changed, and what can be done with it. Undone
     * batches only with `undone=1`; the diffs are built for the requested page only.
     */
    changes(params) {
      const p = paging(params);
      const withUndone = params.get('undone') === '1';
      const matching = learnedIndex().filter((b) => (!p.project || b.project === p.project) && contains(p.q, ...b.text));
      const shown = withUndone ? matching : matching.filter((b) => !b.reverted_at);
      return {
        rows: shown.slice(p.offset, p.offset + p.limit).map(learnedRow),
        total: shown.length,
        undone: matching.filter((b) => b.reverted_at).length,
      };
    },

    /**
     * Skills, memories or instruction files (`kind`), in groups: by scope (personal,
     * project, plugin), memories by project. Each group carries its total and first rows;
     * `group` with `offset`/`limit` pages through one group. `sort`: name, uses, last,
     * reads, updated, lines.
     */
    inventory(params) {
      const kind = ['skills', 'memories', 'instructions'].includes(params.get('kind')) ? params.get('kind') : 'skills';
      const rows = inventoryRows(kind, params);
      const group = params.get('group');
      if (group) {
        const p = paging(params);
        const list = rows.filter((r) => r.group === group);
        return { rows: list.slice(p.offset, p.offset + p.limit), total: list.length };
      }
      const per = Math.min(Math.max(Number(params.get('per')) || INVENTORY_GROUP_SIZE, 1), MAX_LIMIT);
      const order = INVENTORY_GROUPS[kind] || [];
      const groups = new Map(order.map(([id, label]) => [id, { id, label, list: [] }]));
      for (const r of rows) {
        if (!groups.has(r.group)) groups.set(r.group, { id: r.group, label: r.groupLabel || r.group, list: [] });
        groups.get(r.group).list.push(r);
      }
      const list = [...groups.values()].filter((g) => g.list.length);
      if (!order.length) list.sort((a, b) => b.list.length - a.list.length || a.label.localeCompare(b.label));
      return {
        kind, total: rows.length,
        groups: list.map(({ list: l, ...g }) => ({ ...g, total: l.length, rows: l.slice(0, per) })),
      };
    },

    /**
     * The knowledge graph: { nodes, edges, stats }. `project` keeps that project's items and
     * what they relate to; `plugins=all` adds plugin skills nothing here uses or names.
     */
    graph(params) {
      const plugins = params.get('plugins') === 'all' ? 'all' : 'used';
      return focusGraph(graphData(plugins), params.get('project') || null);
    },

    /** How many learned entries, skills, memories and instruction files (for the Knowledge tabs). */
    knowledge_counts(params) {
      const project = params.get('project') || null;
      const inv = inventoryData();
      const mine = (r) => !project || r.project_id === project;
      const learned = learnedIndex().filter((b) => !project || b.project === project);
      return {
        learned: learned.filter((b) => !b.reverted_at).length,
        undone: learned.filter((b) => b.reverted_at).length,
        skills: inv.skills.filter(mine).length,
        memories: inv.memories.filter(mine).length,
        instructions: inv.instructions.filter(mine).length,
      };
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
        dropped: count('dropped'),
        merged: count('merged'),
        rejectedByUser: count('rejected_by_user'),
        suggested: count('suggested') + count('dismissed') + count('fixed'),
        duplicates: count('duplicate'),
        // What waits now, with the inbox's own rule (the same number as its badge).
        inbox: inboxCounts(db).total,
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
        project: m.project, project_name: projects().nameOf(m.project), lines: m.lines, chars: m.chars,
        lineLimit: MEMORY_INDEX_LINE_LIMIT, byteLimit: MEMORY_INDEX_BYTE_LIMIT,
      }));
      const skills = listSkills(cwds).filter((s) => !s.userOnly);
      const listingChars = skills.reduce((n, s) => n + Math.min(s.descriptionChars, 1536) + s.name.length + 4, 0);
      const queue = db.prepare('SELECT COALESCE(queue_state, \'none\') state, COUNT(*) n FROM sessions GROUP BY queue_state').all();
      const capture = db.prepare("SELECT MAX(ts) last, SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) day FROM events").get(Date.now() - DAY);
      const settings = loadSettings();
      const learnedSkills = db.prepare("SELECT COUNT(*) n FROM learnings WHERE kind = 'skill' AND status = 'active' AND origin_session IS NOT 'native'").get().n;
      return {
        budgets: {
          learnedSkills: { used: learnedSkills, limit: settings.limits.learnedSkills },
          memoryIndexLines: settings.limits.memoryIndexLines,
        },
        indexes,
        skillListing: { skills: skills.length, chars: listingChars, tokens: Math.round(listingChars / 4) },
        queue,
        capture: { lastEventAt: capture.last, eventsLast24h: capture.day || 0 },
        options: readOptions(),
      };
    },

    /** Failed reviews (`type=failed`) or recorded errors (`type=errors`), newest first. */
    problems(params) {
      const p = paging(params);
      if (params.get('type') === 'errors') {
        return listOf(db, { select: 'ts, source, substr(message, 1, 400) message', from: 'FROM errors', order: 'ts DESC, id DESC', ...p });
      }
      return listOf(db, { select: 'session_id, detail, ts', from: "FROM reviews WHERE status = 'failed'", order: 'ts DESC, id DESC', ...p });
    },
  };

  const api = (name, params) => (Object.hasOwn(routes, name) ? routes[name](toParams(params)) : undefined);
  /**
   * Inbox keys a bulk decision applies to, by filter (never a list from the client):
   * `project` and/or `group` as the inbox route returns them. `approve` keeps what can be
   * approved as it is (new items, changes that are not stale); `reject`, items and changes.
   */
  api.inboxKeys = ({ project = null, group = null } = {}, mode = 'approve') =>
    inboxList({ project, group }).filter(mode === 'approve' ? approvable : rejectable).map((e) => e.key);
  return api;
}
