// What Claude already knows for a project, as searchable chunks: memories, the global
// profile, CLAUDE.md files, .claude/rules and skill bodies. Used to check proposals
// against existing knowledge before anything is queued or written.
import fs from 'node:fs';
import path from 'node:path';
import { classifyPath, claudeDir, projectKey } from './paths.mjs';
import { profileFile } from './profile.mjs';

const MAX_CHILD_REPOS = 40;
const CHUNK_TARGET = 900;

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

/** Project roots to scan: the session's root plus its direct child repos (not worktrees). */
function projectRoots(cwd) {
  if (!cwd) return [];
  const root = gitRoot(cwd) || path.resolve(cwd);
  const roots = [root];
  for (const d of safeList(root)) {
    if (roots.length > MAX_CHILD_REPOS) break;
    if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'node_modules') continue;
    const child = path.join(root, d.name);
    const git = path.join(child, '.git');
    // A worktree has a .git *file*; its docs duplicate the main checkout's.
    if (isDir(git) || (!fs.existsSync(git) && isFile(path.join(child, 'CLAUDE.md')))) roots.push(child);
  }
  return roots;
}

export function knowledgeFiles(cwd) {
  const files = [];
  const add = (file) => { if (isFile(file) && !files.includes(file)) files.push(file); };
  add(path.join(claudeDir(), 'CLAUDE.md'));
  add(profileFile());
  const memDir = path.join(claudeDir(), 'projects', projectKey(gitRoot(cwd) || cwd || ''), 'memory');
  for (const f of safeList(memDir)) if (f.name.endsWith('.md') && f.name !== 'MEMORY.md') add(path.join(memDir, f.name));
  for (const root of projectRoots(cwd)) {
    add(path.join(root, 'CLAUDE.md'));
    add(path.join(root, 'AGENTS.md'));
    add(path.join(root, '.claude', 'CLAUDE.md'));
    for (const f of safeList(path.join(root, '.claude', 'rules'))) if (f.name.endsWith('.md')) add(path.join(root, '.claude', 'rules', f.name));
    for (const d of safeList(path.join(root, '.claude', 'skills'))) add(path.join(root, '.claude', 'skills', d.name, 'SKILL.md'));
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
  + 'should must only also each other more less into onto about after before over under while where there their them they its '
  + 'para com que uma por nao não dos das nos nas como mais sem ser sua seu são ele ela isso esse essa este esta ao aos quando '
  + 'luca nisus claude repo repos file files session sessao sessão').split(/\s+/));

export function tokenize(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9_.\-/]+/)
    .map((t) => t.replace(/^[.\-/]+|[.\-/]+$/g, ''))
    .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));
}

/** Keyword index (BM25) over the knowledge chunks of a project. */
export function buildIndex(cwd) {
  const docs = [];
  for (const file of knowledgeFiles(cwd)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const cls = classifyPath(file);
    for (const c of chunkMarkdown(text)) {
      const terms = tokenize(`${c.heading} ${c.text}`);
      if (!terms.length) continue;
      const tf = new Map();
      for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
      docs.push({ file, heading: c.heading, text: c.text, tf, len: terms.length, patchable: ['memory', 'skill', 'profile'].includes(cls) });
    }
  }
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avg = docs.reduce((n, d) => n + d.len, 0) / Math.max(1, docs.length);
  const N = docs.length;
  return {
    size: N,
    search(query, k = 3) {
      const q = [...new Set(tokenize(query))];
      const scored = [];
      for (const d of docs) {
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
      return scored.slice(0, k).map((x) => ({ file: x.doc.file, heading: x.doc.heading, text: x.doc.text, patchable: x.doc.patchable, score: x.score }));
    },
  };
}
