// What Claude already knows for a project, as searchable chunks:
//   - knowledge: memories, the global profile, CLAUDE.md files, .claude/rules, skill bodies
//   - sources of truth: CI workflows, package manifests and deploy/runtime config
//   - past rejections: proposals the user rejected or undid
// Used to check proposals before anything is queued or written, and to find the
// skill or rule file that owns a topic.
import fs from 'node:fs';
import path from 'node:path';
import { classifyPath, claudeDir, projectKey } from './paths.mjs';
import { parseFrontmatter } from './inventory.mjs';
import { profileFile } from './profile.mjs';

const MAX_CHILD_REPOS = 40;
const CHUNK_TARGET = 900;
const MAX_SOURCE_BYTES = 60_000;
/** Files whose content is ground truth about how a project builds, runs and deploys. */
const SOURCE_FILES = ['package.json', 'vercel.json', 'netlify.toml', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'Makefile', 'justfile', 'pyproject.toml', 'Cargo.toml', 'global.json', 'Directory.Packages.props'];

function safeList(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

export function gitRoot(dir) {
  let d = dir && path.resolve(dir);
  while (d) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/** The origin remote URL of a repository directory, if any. */
function originUrl(dir) {
  try {
    const config = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8');
    const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(config);
    return m ? m[1].replace(/\.git$/, '').toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Project roots to scan: the session's root plus its direct child repos. Worktrees
 * (a .git file) and extra clones of a repo already present are skipped: their docs are
 * copies, often stale, of the main checkout's.
 */
export function projectRoots(cwd) {
  if (!cwd) return [];
  const root = gitRoot(cwd) || path.resolve(cwd);
  const roots = [root];
  const byOrigin = new Map();
  for (const d of safeList(root)) {
    if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'node_modules') continue;
    const child = path.join(root, d.name);
    const git = path.join(child, '.git');
    if (isDir(git)) {
      const origin = originUrl(child);
      if (!origin) { roots.push(child); continue; }
      // Keep the clone whose folder is named like the repository (the main checkout).
      const repoName = origin.split(/[/:]/).pop();
      const prev = byOrigin.get(origin);
      if (!prev || (d.name.toLowerCase() === repoName && path.basename(prev).toLowerCase() !== repoName)) byOrigin.set(origin, child);
    } else if (!fs.existsSync(git) && isFile(path.join(child, 'CLAUDE.md'))) {
      roots.push(child);
    }
  }
  roots.push(...byOrigin.values());
  // A folder without its own git named "<repo>-<suffix>" next to that repo is a leftover
  // copy (an old worktree or snapshot), not a project of its own.
  const repoNames = new Set([...byOrigin.values()].map((r) => path.basename(r).toLowerCase()));
  for (let i = roots.length - 1; i > 0; i--) {
    const name = path.basename(roots[i]).toLowerCase();
    if (!fs.existsSync(path.join(roots[i], '.git')) && [...repoNames].some((r) => name.startsWith(`${r}-`))) roots.splice(i, 1);
  }
  return roots.slice(0, MAX_CHILD_REPOS + 1);
}

/** Kind of a knowledge file: profile | memory | skill | rules | instructions | source. */
export function knowledgeKind(file) {
  const cls = classifyPath(file);
  if (cls) return cls;
  return /[\\/]\.claude[\\/]rules[\\/][^\\/]+\.md$/i.test(file) ? 'rules' : 'source';
}

/** Kinds Ouroboros may add to or correct (rules and instructions only with approval). */
export const PATCHABLE = new Set(['memory', 'skill', 'profile', 'rules', 'instructions']);

export function knowledgeFiles(cwd) {
  const files = [];
  const add = (file) => { if (isFile(file) && !files.includes(file)) files.push(file); };
  add(path.join(claudeDir(), 'CLAUDE.md'));
  add(profileFile());
  const memDir = path.join(claudeDir(), 'projects', projectKey(gitRoot(cwd) || cwd || ''), 'memory');
  for (const f of safeList(memDir)) if (f.name.endsWith('.md') && f.name !== 'MEMORY.md') add(path.join(memDir, f.name));
  for (const root of projectRoots(cwd)) {
    add(path.join(root, 'CLAUDE.md'));
    add(path.join(root, 'CLAUDE.local.md'));
    add(path.join(root, '.claude', 'CLAUDE.md'));
    for (const f of safeList(path.join(root, '.claude', 'rules'))) if (f.name.endsWith('.md')) add(path.join(root, '.claude', 'rules', f.name));
    for (const d of safeList(path.join(root, '.claude', 'skills'))) add(path.join(root, '.claude', 'skills', d.name, 'SKILL.md'));
    // Sources of truth.
    for (const f of safeList(path.join(root, '.github', 'workflows'))) if (/\.ya?ml$/i.test(f.name)) add(path.join(root, '.github', 'workflows', f.name));
    for (const name of SOURCE_FILES) add(path.join(root, name));
  }
  const personal = path.join(claudeDir(), 'skills');
  for (const d of safeList(personal)) add(path.join(personal, d.name, 'SKILL.md'));
  return files;
}

/** Split markdown by headings, then by paragraphs, into ~CHUNK_TARGET-char chunks. */
export function chunkMarkdown(text) {
  const body = String(text).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, (fm) => `${fm.replace(/^---|---$/g, '').trim()}\n\n`);
  const sections = [];
  let heading = '';
  let buf = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^#{1,4}\s/.test(line)) {
      if (buf.join('').trim()) sections.push({ heading, text: buf.join('\n').trim() });
      heading = line.replace(/^#+\s*/, '').trim();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  if (buf.join('').trim()) sections.push({ heading, text: buf.join('\n').trim() });
  return splitLong(sections);
}

/** Non-markdown sources: fixed-size chunks by lines. */
function chunkPlain(text) {
  const lines = String(text).split(/\r?\n/);
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length > CHUNK_TARGET && cur.length) { chunks.push({ heading: '', text: cur.join('\n') }); cur = []; size = 0; }
    cur.push(line);
    size += line.length + 1;
  }
  if (cur.join('').trim()) chunks.push({ heading: '', text: cur.join('\n') });
  return chunks;
}

function splitLong(sections) {
  const chunks = [];
  for (const s of sections) {
    if (s.text.length <= CHUNK_TARGET * 1.4) { chunks.push(s); continue; }
    let cur = '';
    for (const para of s.text.split(/\n\s*\n/)) {
      if (cur && cur.length + para.length > CHUNK_TARGET) { chunks.push({ heading: s.heading, text: cur.trim() }); cur = ''; }
      cur += `${para}\n\n`;
    }
    if (cur.trim()) chunks.push({ heading: s.heading, text: cur.trim() });
  }
  return chunks;
}

const STOP = new Set(('the and for with that this from into are was were not but you your use when what which then than have has had will can '
  + 'should must only also each other more less onto about after before over under while where there their them they its '
  + 'para com que uma por nao não dos das nos nas como mais sem ser sua seu são ele ela isso esse essa este esta ao aos quando').split(/\s+/));

export function tokenize(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9_.\-/]+/)
    .map((t) => t.replace(/^[.\-/]+|[.\-/]+$/g, ''))
    .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));
}

/**
 * Keyword index (BM25) over a project's knowledge, sources and extra documents
 * (e.g. past rejections: { file, heading, text, kind: 'rejected' }).
 */
export function buildIndex(cwd, { extra = [] } = {}) {
  const docs = [];
  const addDoc = (file, kind, c) => {
    const terms = tokenize(`${c.heading} ${c.text}`);
    if (!terms.length) return;
    const tf = new Map();
    for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
    docs.push({ file, kind, heading: c.heading, text: c.text, tf, len: terms.length });
  };
  for (const file of knowledgeFiles(cwd)) {
    let text;
    try {
      if (fs.statSync(file).size > MAX_SOURCE_BYTES) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch { continue; }
    const kind = knowledgeKind(file);
    for (const c of /\.md$/i.test(file) ? chunkMarkdown(text) : chunkPlain(text)) addDoc(file, kind, c);
  }
  for (const e of extra) addDoc(e.file, e.kind || 'note', { heading: e.heading || '', text: e.text });

  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avg = docs.reduce((n, d) => n + d.len, 0) / Math.max(1, docs.length);
  const N = docs.length;
  return {
    size: N,
    search(query, k = 3, { kinds } = {}) {
      const q = [...new Set(tokenize(query))];
      const scored = [];
      for (const d of docs) {
        if (kinds && !kinds.includes(d.kind)) continue;
        let s = 0;
        for (const t of q) {
          const f = d.tf.get(t);
          if (!f) continue;
          const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
          s += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.len / avg))));
        }
        if (s > 0) scored.push({ score: s, doc: d });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, k).map((x) => ({
        file: x.doc.file, kind: x.doc.kind, heading: x.doc.heading, text: x.doc.text,
        patchable: PATCHABLE.has(x.doc.kind), score: x.score,
      }));
    },
  };
}

/**
 * Map of who owns which topic: every skill and rule file with its description and
 * section headings. Lets triage route a learning to its owner even when no excerpt
 * shares its exact words.
 */
export function ownersMap(cwd) {
  const owners = [];
  for (const file of knowledgeFiles(cwd)) {
    const kind = knowledgeKind(file);
    if (kind !== 'skill' && kind !== 'rules') continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const { data, body } = parseFrontmatter(text);
    // Sections: markdown headings, or bold lead-ins of bullet lists ("- **Topic**: ...").
    let headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map((m) => m[1].trim());
    if (headings.length < 3) headings = headings.concat([...body.matchAll(/^\s*[-*]\s+\*\*([^*]{3,80})\*\*/gm)].map((m) => m[1].trim()));
    headings = headings.slice(0, 14);
    const name = kind === 'skill' ? (data.name || path.basename(path.dirname(file))) : path.basename(file, '.md');
    const paths = [...text.matchAll(/^\s+-\s+"?([^"\n]+)"?\s*$/gm)].slice(0, 3).map((m) => m[1]);
    const firstLine = body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) || '';
    const description = (typeof data.description === 'string' ? data.description : `${firstLine}${paths.length ? ` (applies to ${paths.join(', ')})` : ''}`)
      .replace(/\s+/g, ' ').slice(0, 220);
    owners.push({ kind, name, file, description, headings });
  }
  return owners;
}
