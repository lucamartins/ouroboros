// The knowledge graph: what Claude knows as nodes (skills and their reference files,
// memories, CLAUDE.md and rule files, projects) and how they relate.
// Derived on demand from the files and the usage events; nothing new is stored.
//
// Edge types, from the strongest evidence to the weakest:
//   link      an explicit [[name]] or markdown link from one file to another
//   mention   a file names a skill (`nisus-back`, /ouroboros:learn, "skill `nisus`")
//   contains  a skill and one of its reference files
//   used      both were used in the same sessions (at least USED_MIN_SESSIONS of them)
//   similar   their text is lexically close (TF-IDF cosine): a hint, not a relation
//   belongs   an item and its project
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './inventory.mjs';
import { tokenize } from './knowledge.mjs';
import { normalize } from './paths.mjs';

const MAX_BYTES = 60_000;
/** Text of a node used for similarity (name, description and the start of the body). */
const SIMILAR_TEXT_CHARS = 4000;
export const SIMILAR_MIN = 0.3;
const SIMILAR_PER_NODE = 2;
export const USED_MIN_SESSIONS = 2;

export const EDGE_TYPES = ['link', 'mention', 'contains', 'used', 'similar', 'belongs'];
/** Edges that are real relations between two items (the rest are hints or grouping). */
const EXPLICIT = new Set(['link', 'mention', 'contains', 'used']);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function readText(file) {
  try {
    if (fs.statSync(file).size > MAX_BYTES) return '';
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** The skill directory a file belongs to (`…/skills/<name>`), or null. */
function skillDirOf(file) {
  const parts = String(file).split(/[\\/]/);
  const i = parts.map((p) => p.toLowerCase()).lastIndexOf('skills');
  return i >= 0 && parts.length > i + 2 ? parts.slice(0, i + 2).join('/') : null;
}

/**
 * Matchers for skill names in free text. A distinctive name (with a hyphen or a colon,
 * like `nisus-back` or `ouroboros:learn`) counts wherever it appears as a whole token;
 * a plain word (`nisus`, `run`) only in code (`nisus`), as a command (/run) or next to
 * the word "skill", since as a word it usually means something else.
 */
function skillMatchers(skills) {
  const distinct = skills.filter((s) => /[-:]/.test(s.name) && s.name.length >= 5).map((s) => s.name);
  const plain = skills.filter((s) => !distinct.includes(s.name) && s.name.length >= 3).map((s) => s.name);
  const alt = (names) => names.sort((a, b) => b.length - a.length).map(escapeRe).join('|');
  const out = [];
  if (distinct.length) out.push(new RegExp(`(?<![\\w-])(${alt(distinct)})(?![\\w-]|:\\w)`, 'gi'));
  if (plain.length) {
    const a = alt(plain);
    out.push(new RegExp(`\`/?(${a})\`|(?<![\\w-])/(${a})(?![\\w-])|\\bskills?\\s+\`?(${a})\\b|\\b(${a})\`?\\s+skills?\\b`, 'gi'));
  }
  return (text) => {
    const found = new Set();
    for (const re of out) for (const m of text.matchAll(re)) found.add((m[1] || m[2] || m[3] || m[4]).toLowerCase());
    return found;
  };
}

/** Sparse TF-IDF vectors (unit length) for a list of texts. */
function tfidf(texts) {
  const tfs = texts.map((t) => {
    const tf = new Map();
    for (const w of tokenize(t)) tf.set(w, (tf.get(w) || 0) + 1);
    return tf;
  });
  const df = new Map();
  for (const tf of tfs) for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1);
  const n = texts.length;
  return tfs.map((tf) => {
    const v = new Map();
    let norm = 0;
    for (const [w, f] of tf) {
      const d = df.get(w);
      if (d < 2) continue; // a word only one item has cannot relate it to another
      const x = (1 + Math.log(f)) * Math.log(n / d);
      if (x <= 0) continue;
      v.set(w, x);
      norm += x * x;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [w, x] of v) v.set(w, x / norm);
    return v;
  });
}

function cosine(a, b) {
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let s = 0;
  for (const [w, x] of small) {
    const y = large.get(w);
    if (y) s += x * y;
  }
  return s;
}

/**
 * Build the graph.
 *
 * `items`: [{ file, kind: skill|reference|memory|instructions|rules, name?, label?,
 *   description?, scope?, project_id?, project_name?, uses?, lastUsed?, learned? }]
 * `usage`: [{ session, id }] — node ids used in each session (skills used, memories read)
 * `plugins`: 'used' keeps a plugin skill only when it was used or a non-plugin file
 *   points to it; 'all' keeps every one.
 *
 * Returns { nodes, edges, stats }. Node ids are normalized file paths; project hubs are
 * `project:<id>`.
 */
export function buildGraph(items, { usage = [], plugins = 'used' } = {}) {
  const nodes = new Map();
  for (const it of items) {
    const id = normalize(it.file);
    if (nodes.has(id)) continue;
    const text = it.text ?? readText(it.file);
    const { data } = parseFrontmatter(text);
    let name = it.name || data.name || path.basename(it.file, '.md');
    let label = it.label || name;
    if (it.kind === 'reference') {
      const dir = skillDirOf(it.file);
      const skill = dir ? dir.split('/').pop() : '';
      const rel = dir ? normalize(it.file).slice(normalize(dir).length + 1) : path.basename(it.file);
      name = `${skill}/${rel}`;
      label = it.label || name;
    }
    nodes.set(id, {
      id, kind: it.kind, name, label,
      description: String(it.description ?? (typeof data.description === 'string' ? data.description : '')).replace(/\s+/g, ' ').trim().slice(0, 400),
      file: it.file, scope: it.scope || null,
      project_id: it.project_id || null, project_name: it.project_name || null,
      uses: it.uses || 0, lastUsed: it.lastUsed || null, learned: !!it.learned,
      memoryType: it.memoryType || (it.kind === 'memory' ? data.metadata?.type || data.type || null : null),
      dangling: [], text,
    });
  }

  const edges = new Map();
  const edgeKey = (a, b, type) => (a < b ? `${a}|${b}|${type}` : `${b}|${a}|${type}`);
  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const explicitPairs = new Set();
  const addEdge = (source, target, type, extra = {}) => {
    if (source === target || !nodes.has(source) || !nodes.has(target)) return;
    const key = edgeKey(source, target, type);
    if (edges.has(key)) return;
    edges.set(key, { source, target, type, ...extra });
    if (EXPLICIT.has(type)) explicitPairs.add(pairKey(source, target));
  };

  // Lookups for links: a memory by name in its own folder first, then any item by name.
  const byDirName = new Map();
  const byName = new Map();
  const remember = (key, id) => { if (!byName.has(key)) byName.set(key, id); };
  for (const n of nodes.values()) {
    const base = path.basename(n.file, '.md').toLowerCase();
    if (n.kind === 'memory') {
      const dir = normalize(path.dirname(n.file));
      byDirName.set(`${dir}|${n.name.toLowerCase()}`, n.id);
      byDirName.set(`${dir}|${base}`, n.id);
    }
    if (n.kind === 'memory' || n.kind === 'skill') remember(n.name.toLowerCase(), n.id);
    if (n.kind === 'memory') remember(base, n.id);
  }

  // Skill → reference files.
  const skillByDir = new Map();
  for (const n of nodes.values()) if (n.kind === 'skill') skillByDir.set(normalize(path.dirname(n.file)), n.id);
  for (const n of nodes.values()) {
    if (n.kind !== 'reference') continue;
    const parent = skillByDir.get(normalize(skillDirOf(n.file) || ''));
    if (parent) { n.parent = parent; addEdge(parent, n.id, 'contains'); }
  }
  const family = (n) => (n.kind === 'reference' ? n.parent : n.kind === 'skill' ? n.id : null);

  // Explicit links and mentions.
  const skills = [...nodes.values()].filter((n) => n.kind === 'skill');
  const skillByName = new Map(skills.map((s) => [s.name.toLowerCase(), s.id]));
  const mentions = skillMatchers(skills);
  for (const n of nodes.values()) {
    if (!n.text) continue;
    const dir = path.dirname(n.file);
    for (const m of n.text.matchAll(/\[\[([^\]|#\n]+)(?:[|#][^\]\n]*)?\]\]/g)) {
      const want = m[1].trim().toLowerCase();
      const hit = byDirName.get(`${normalize(dir)}|${want}`) || byName.get(want) || byName.get(want.replace(/\.md$/, ''));
      if (hit) addEdge(n.id, hit, 'link', { from: n.id });
      else if (!n.dangling.includes(m[1].trim())) n.dangling.push(m[1].trim());
    }
    for (const m of n.text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
      const raw = m[1].split('#')[0];
      if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
      let target;
      try { target = path.resolve(dir, decodeURIComponent(raw)); } catch { continue; }
      const hit = normalize(target);
      if (nodes.has(hit)) addEdge(n.id, hit, 'link', { from: n.id });
    }
    for (const name of mentions(n.text)) {
      const hit = skillByName.get(name);
      if (!hit || hit === family(n)) continue;
      if (!explicitPairs.has(pairKey(n.id, hit))) addEdge(n.id, hit, 'mention', { from: n.id });
    }
  }

  // Used in the same sessions.
  const bySession = new Map();
  for (const u of usage) {
    if (!nodes.has(u.id)) continue;
    if (!bySession.has(u.session)) bySession.set(u.session, new Set());
    bySession.get(u.session).add(u.id);
  }
  const together = new Map();
  for (const ids of bySession.values()) {
    const list = [...ids].sort();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const k = `${list[i]}|${list[j]}`;
        together.set(k, (together.get(k) || 0) + 1);
      }
    }
  }
  for (const [k, sessions] of together) {
    if (sessions < USED_MIN_SESSIONS) continue;
    const [a, b] = k.split('|');
    addEdge(a, b, 'used', { sessions });
  }

  // Plugin skills: only those that matter here.
  if (plugins !== 'all') {
    const keep = (n) => n.uses > 0 || [...edges.values()].some((e) => (e.type === 'link' || e.type === 'mention' || e.type === 'used')
      && (e.source === n.id || e.target === n.id) && nodes.get(e.source === n.id ? e.target : e.source)?.scope !== 'plugin');
    for (const n of [...nodes.values()]) {
      if (n.scope !== 'plugin' || keep(n)) continue;
      nodes.delete(n.id);
      for (const [k, e] of edges) if (e.source === n.id || e.target === n.id) edges.delete(k);
    }
  }

  // Lexical similarity, between items not already related.
  const list = [...nodes.values()];
  const vectors = tfidf(list.map((n) => `${n.name} ${n.description} ${n.text.replace(/^---[\s\S]*?---/, '').slice(0, SIMILAR_TEXT_CHARS)}`));
  for (let i = 0; i < list.length; i++) {
    const scores = [];
    for (let j = 0; j < list.length; j++) {
      if (i === j) continue;
      const a = list[i];
      const b = list[j];
      if (family(a) && family(a) === family(b)) continue;
      if (explicitPairs.has(pairKey(a.id, b.id))) continue;
      const score = cosine(vectors[i], vectors[j]);
      if (score >= SIMILAR_MIN) scores.push({ id: b.id, score });
    }
    scores.sort((x, y) => y.score - x.score);
    for (const s of scores.slice(0, SIMILAR_PER_NODE)) addEdge(list[i].id, s.id, 'similar', { score: Math.round(s.score * 100) / 100 });
  }

  // Projects.
  for (const n of list) {
    if (!n.project_id) continue;
    const hub = `project:${n.project_id}`;
    if (!nodes.has(hub)) {
      nodes.set(hub, { id: hub, kind: 'project', name: n.project_name || n.project_id, label: n.project_name || n.project_id, project_id: n.project_id, project_name: n.project_name, description: '', dangling: [] });
    }
    addEdge(n.id, hub, 'belongs');
  }

  const degree = new Map();
  for (const e of edges.values()) {
    if (!EXPLICIT.has(e.type)) continue;
    degree.set(e.source, (degree.get(e.source) || 0) + 1);
    degree.set(e.target, (degree.get(e.target) || 0) + 1);
  }
  const outNodes = [...nodes.values()].map(({ text, ...n }) => ({ ...n, degree: degree.get(n.id) || 0 }));
  const items_ = outNodes.filter((n) => n.kind !== 'project');
  const byType = Object.fromEntries(EDGE_TYPES.map((t) => [t, 0]));
  for (const e of edges.values()) byType[e.type]++;
  return {
    nodes: outNodes,
    edges: [...edges.values()],
    stats: {
      items: items_.length,
      projects: outNodes.length - items_.length,
      edges: byType,
      unconnected: items_.filter((n) => !n.degree).length,
      dangling: items_.reduce((s, n) => s + n.dangling.length, 0),
    },
  };
}

/**
 * Keep the part of a graph around one project: its items, the items they relate to
 * (one explicit edge away, so a global skill a project memory names stays) and the
 * project's hub.
 */
export function focusGraph(graph, projectId) {
  if (!projectId) return graph;
  const core = new Set(graph.nodes.filter((n) => n.project_id === projectId).map((n) => n.id));
  const keep = new Set(core);
  for (const e of graph.edges) {
    if (!EXPLICIT.has(e.type)) continue;
    if (core.has(e.source)) keep.add(e.target);
    if (core.has(e.target)) keep.add(e.source);
  }
  const nodes = graph.nodes.filter((n) => keep.has(n.id) && (n.kind !== 'project' || n.project_id === projectId));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  const items = nodes.filter((n) => n.kind !== 'project');
  const byType = Object.fromEntries(EDGE_TYPES.map((t) => [t, 0]));
  for (const e of edges) byType[e.type]++;
  return {
    nodes, edges,
    stats: { items: items.length, projects: nodes.length - items.length, edges: byType, unconnected: items.filter((n) => !n.degree).length, dangling: items.reduce((s, n) => s + n.dangling.length, 0) },
  };
}
