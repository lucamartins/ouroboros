// What Claude already knows for a project, as searchable chunks:
//   - knowledge: memories, CLAUDE.md files (the global one included), .claude/rules, skill bodies
//   - sources of truth: CI workflows, package manifests and deploy/runtime config
//   - past rejections: proposals the user rejected or undid
// Used to check proposals before anything is queued or written, and to find the
// skill or rule file that owns a topic.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { classifyPath, claudeDir, gitRoot, home, memoryDirFor, stableDir } from './paths.mjs';

export { gitRoot };
import { parseFrontmatter } from './inventory.mjs';

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
  cwd = stableDir(cwd);
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

/** Kind of a knowledge file: memory | skill | rules | instructions | source. */
export function knowledgeKind(file) {
  const cls = classifyPath(file);
  if (cls) return cls;
  // Reference files a skill points to (skills/<name>/reference/x.md) belong to the skill.
  if (/[\\/]skills[\\/][^\\/]+[\\/].+\.md$/i.test(file)) return 'skill';
  if (/[\\/]\.claude[\\/]rules[\\/][^\\/]+\.md$/i.test(file)) return 'rules';
  // The user's own rules live in the config folder, wherever it is.
  return path.resolve(path.dirname(file)).toLowerCase() === path.join(claudeDir(), 'rules').toLowerCase() && /\.md$/i.test(file) ? 'rules' : 'source';
}

/** SKILL.md plus the markdown reference files next to it (one folder deep). */
function skillFiles(skillDir) {
  const out = [path.join(skillDir, 'SKILL.md')];
  for (const e of safeList(skillDir)) {
    if (e.isFile() && /\.md$/i.test(e.name) && e.name.toLowerCase() !== 'skill.md') out.push(path.join(skillDir, e.name));
    if (e.isDirectory() && !e.name.startsWith('.')) {
      for (const f of safeList(path.join(skillDir, e.name))) if (f.isFile() && /\.md$/i.test(f.name)) out.push(path.join(skillDir, e.name, f.name));
    }
  }
  return out;
}

/** Display name of a skill file: the skill's name, or "<skill>/<relative path>" for a reference file. */
function skillFileName(file, data) {
  const parts = file.split(/[\\/]/);
  const i = parts.map((p) => p.toLowerCase()).lastIndexOf('skills');
  const skill = i >= 0 ? parts[i + 1] : path.basename(path.dirname(file));
  if (/^skill\.md$/i.test(path.basename(file))) return data.name || skill;
  return `${skill}/${parts.slice(i + 2).join('/')}`;
}

/** Kinds Ouroboros may add to or correct (rules and instructions only with approval). */
export const PATCHABLE = new Set(['memory', 'skill', 'rules', 'instructions']);

export function knowledgeFiles(cwd) {
  // A session in a worktree reads the main checkout's knowledge files: changes land where they last.
  if (cwd) cwd = stableDir(cwd);
  const files = [];
  const add = (file) => { if (isFile(file) && !files.includes(file)) files.push(file); };
  add(path.join(claudeDir(), 'CLAUDE.md'));
  // Claude Code loads CLAUDE.md files from the working directory and every directory above it.
  for (let d = cwd ? path.resolve(cwd) : null; d; ) {
    add(path.join(d, 'CLAUDE.md'));
    add(path.join(d, 'CLAUDE.local.md'));
    // ~/.claude/CLAUDE.md is the user's global file, already added from the config dir.
    if (path.resolve(d).toLowerCase() !== path.resolve(home).toLowerCase()) add(path.join(d, '.claude', 'CLAUDE.md'));
    const up = path.dirname(d);
    d = up === d ? null : up;
  }
  const memDir = memoryDirFor({ cwd });
  for (const f of safeList(memDir)) if (f.name.endsWith('.md') && f.name !== 'MEMORY.md') add(path.join(memDir, f.name));
  for (const root of projectRoots(cwd)) {
    add(path.join(root, 'CLAUDE.md'));
    add(path.join(root, 'CLAUDE.local.md'));
    add(path.join(root, '.claude', 'CLAUDE.md'));
    for (const f of safeList(path.join(root, '.claude', 'rules'))) if (f.name.endsWith('.md')) add(path.join(root, '.claude', 'rules', f.name));
    for (const d of safeList(path.join(root, '.claude', 'skills'))) if (d.isDirectory()) skillFiles(path.join(root, '.claude', 'skills', d.name)).forEach(add);
    // Sources of truth.
    for (const f of safeList(path.join(root, '.github', 'workflows'))) if (/\.ya?ml$/i.test(f.name)) add(path.join(root, '.github', 'workflows', f.name));
    for (const name of SOURCE_FILES) add(path.join(root, name));
  }
  // The user's own rules (loaded in every project, or with the files their `paths` name).
  for (const f of safeList(path.join(claudeDir(), 'rules'))) if (f.isFile() && f.name.endsWith('.md')) add(path.join(claudeDir(), 'rules', f.name));
  const personal = path.join(claudeDir(), 'skills');
  for (const d of safeList(personal)) {
    // Skills installed as junctions/symlinks report as links, not directories.
    if (d.isDirectory() || d.isSymbolicLink()) skillFiles(path.join(personal, d.name)).forEach(add);
  }
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
    /** `exclude`: files (paths) whose chunks are left out, e.g. the stand-in memory of the claim searched for. */
    search(query, k = 3, { kinds, exclude } = {}) {
      const q = [...new Set(tokenize(query))];
      const skip = exclude?.length ? new Set(exclude.map((f) => path.resolve(f).toLowerCase())) : null;
      const scored = [];
      for (const d of docs) {
        if (kinds && !kinds.includes(d.kind)) continue;
        if (skip && skip.has(path.resolve(d.file).toLowerCase())) continue;
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
  const files = knowledgeFiles(cwd);
  // Reference files are listed by name under their skill, not as owners of their own:
  // a skill like a design system can ship dozens of them.
  const refsBySkillDir = new Map();
  for (const file of files) {
    if (knowledgeKind(file) !== 'skill' || /^skill\.md$/i.test(path.basename(file))) continue;
    const parts = file.split(/[\\/]/);
    const i = parts.map((p) => p.toLowerCase()).lastIndexOf('skills');
    const dir = parts.slice(0, i + 2).join(path.sep);
    if (!refsBySkillDir.has(dir)) refsBySkillDir.set(dir, []);
    refsBySkillDir.get(dir).push(parts.slice(i + 2).join('/'));
  }
  for (const file of files) {
    const kind = knowledgeKind(file);
    if (kind !== 'skill' && kind !== 'rules') continue;
    if (kind === 'skill' && !/^skill\.md$/i.test(path.basename(file))) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const { data, body } = parseFrontmatter(text);
    // Sections: markdown headings, or bold lead-ins of bullet lists ("- **Topic**: ...").
    let headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map((m) => m[1].trim());
    if (headings.length < 3) headings = headings.concat([...body.matchAll(/^\s*[-*]\s+\*\*([^*]{3,80})\*\*/gm)].map((m) => m[1].trim()));
    headings = headings.slice(0, 14);
    const name = kind === 'skill' ? skillFileName(file, data) : path.basename(file, '.md');
    const paths = [...text.matchAll(/^\s+-\s+"?([^"\n]+)"?\s*$/gm)].slice(0, 3).map((m) => m[1]);
    const firstLine = body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) || '';
    const description = (typeof data.description === 'string' ? data.description : `${firstLine}${paths.length ? ` (applies to ${paths.join(', ')})` : ''}`)
      .replace(/\s+/g, ' ').slice(0, 220);
    const references = (refsBySkillDir.get(path.dirname(file)) || []).slice(0, 16);
    owners.push({ kind, name, file, description, headings, references });
  }
  return owners;
}

/**
 * Resolve an owner path a model wrote to a real knowledge file: the exact path, or the
 * one knowledge file whose path ends with it (models shorten or re-slash paths).
 */
export function resolveOwner(owner, cwd) {
  const raw = String(owner || '').trim();
  if (!raw) return null;
  if (path.isAbsolute(raw) && isFile(raw)) return path.resolve(raw);
  const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
  const want = norm(raw).replace(/^\.?\//, '');
  const hits = knowledgeFiles(cwd).filter((f) => norm(f).endsWith(`/${want}`) || norm(f) === want);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Resolve the owner a screen's `route` verdict names, for a proposal from project `cwd`.
 * Returns { file } or { reason } (the learning then waits for the user, nothing is created).
 *  - Only a file of that project's knowledge set (`knowledgeFiles(cwd)`: its CLAUDE.md files,
 *    rules, skills, memory directory, plus the user's own global files) can be an owner,
 *    whatever its path looks like: another project's memory, a vendored `skills/` folder or a
 *    CLAUDE.md elsewhere on disk are refused, written as an absolute path or not.
 *  - A name that matches several files ("CLAUDE.md" with a global and a project file) is
 *    resolved by one rule: the files inside the project's own root win over the others, and
 *    if several of those remain, the one directly at the root. Anything still ambiguous is not
 *    guessed.
 */
export function resolveRouteOwner(owner, cwd) {
  const raw = String(owner || '').trim();
  if (!raw) return { reason: 'the screen named no owner file' };
  const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
  const files = knowledgeFiles(cwd);
  let hits;
  if (path.isAbsolute(raw)) {
    const want = norm(path.resolve(raw));
    hits = files.filter((f) => norm(path.resolve(f)) === want);
    if (!hits.length) return { reason: `${raw} is not one of this project's knowledge files or yours` };
    return { file: hits[0] };
  }
  const want = norm(raw).replace(/^\.?\//, '');
  hits = files.filter((f) => norm(f).endsWith(`/${want}`) || norm(f) === want);
  if (!hits.length) return { reason: `no knowledge file of this project or yours is named ${raw}` };
  if (hits.length === 1) return { file: hits[0] };
  const root = projectRoots(cwd)[0];
  if (root) {
    const inside = hits.filter((f) => norm(path.resolve(f)).startsWith(`${norm(path.resolve(root))}/`));
    if (inside.length === 1) return { file: inside[0] };
    const top = inside.filter((f) => norm(path.dirname(path.resolve(f))) === norm(path.resolve(root)));
    if (top.length === 1) return { file: top[0] };
  }
  return { reason: `${raw} matches ${hits.length} files (${hits.slice(0, 3).map((f) => path.resolve(f)).join(', ')}${hits.length > 3 ? ', …' : ''}) and no rule picks one` };
}

// ---------- grounding: what the project itself says about a claim ----------

const MAX_IDENTIFIERS = 10;
const HITS_PER_IDENTIFIER = 3;
const GREP_TIMEOUT_MS = 8000;

/**
 * Concrete things a claim names that the project can confirm or refute: code spans,
 * file paths, dotted identifiers, CONSTANT_NAMES, --flags and env-style variables.
 */
export function identifiersIn(text) {
  const s = String(text || '');
  const found = [];
  const push = (x) => {
    const v = String(x).trim().replace(/[.,;:)]+$/, '');
    if (v.length < 4 || v.length > 80 || /\s{2,}/.test(v) || found.includes(v)) return;
    found.push(v);
  };
  for (const m of s.matchAll(/`([^`\n]{4,80})`/g)) {
    const span = m[1].trim();
    // Long commands: keep their most specific word (a flag, path or identifier).
    if (/\s/.test(span)) {
      for (const w of span.split(/\s+/)) if (/[./_-]/.test(w) && w.length >= 7 && !/^<.*>$/.test(w)) push(w.replace(/^["']|["']$/g, ''));
    } else {
      push(span);
    }
  }
  for (const m of s.matchAll(/(?:^|[\s(])((?:[\w.-]+[\\/])+[\w.-]+\.\w{1,6})(?![\w\\/])/g)) push(m[1]);
  for (const m of s.matchAll(/\b([A-Z][A-Za-z0-9]+\.[A-Z][A-Za-z0-9]+(?:\.[A-Z][A-Za-z0-9]+)*)\b/g)) push(m[1]);
  for (const m of s.matchAll(/\b([A-Z][A-Z0-9]+(?:_[A-Z0-9]+){1,})\b/g)) push(m[1]);
  for (const m of s.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g)) if (m[1].length >= 6) push(m[1]);
  for (const m of s.matchAll(/\b([a-z]+[A-Z][A-Za-z0-9]{3,})\b/g)) push(m[1]);
  for (const m of s.matchAll(/\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+){2,})\b/g)) push(m[1]);
  for (const m of s.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]{4,})/g)) push(m[1]);
  return found.slice(0, MAX_IDENTIFIERS);
}

/**
 * Look the identifiers up in the project's git repos (tracked files, respecting
 * .gitignore). Returns [{ id, hits: [{ file, line, text }], exists, checked }]. A name
 * that was looked up and found nowhere is evidence against the claim (`checked` true, no
 * hit); when the lookup could not be made (the project is not a git repository, git is
 * missing, the search timed out or overflowed) `checked` is false: that says nothing about
 * the claim either way.
 */
export function groundIdentifiers(ids, cwd) {
  const out = ids.map((id) => ({ id, hits: [], exists: false, checked: false }));
  if (!ids.length || !cwd) return out;
  const roots = projectRoots(cwd).filter((r) => fs.existsSync(path.join(r, '.git')));
  const failed = new Set();
  // A file that is on disk exists, tracked by git or not.
  for (const root of projectRoots(cwd)) {
    for (const o of out) if (/[\\/]/.test(o.id) && !path.isAbsolute(o.id) && isFile(path.join(root, o.id))) o.exists = true;
  }
  for (const root of roots) {
    const pending = out.filter((o) => o.hits.length < HITS_PER_IDENTIFIER);
    if (!pending.length) break;
    for (const o of pending) {
      if (/[\\/]/.test(o.id) && !path.isAbsolute(o.id) && isFile(path.join(root, o.id))) o.exists = true;
    }
    const args = ['-C', root, 'grep', '-n', '-I', '-F', '--max-count=2', ...pending.flatMap((o) => ['-e', o.id]), '--', '.', ':!*.lock', ':!*lock.json', ':!*lock.yaml', ':!*.min.*', ':!*.md'];
    const r = spawnSync('git', args, { encoding: 'utf8', timeout: GREP_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    // git grep exits 0 with matches and 1 without any: both are a completed search. Anything
    // else (git missing, a timeout, an overflowed buffer, a broken repository) is not.
    if (r.error || (r.status !== 0 && r.status !== 1)) {
      for (const o of pending) failed.add(o.id);
      continue;
    }
    for (const o of pending) o.checked = true;
    if (r.status !== 0 || !r.stdout) continue;
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = /^([^:]+):(\d+):(.*)$/.exec(line);
      if (!m) continue;
      for (const o of pending) {
        if (o.hits.length >= HITS_PER_IDENTIFIER || !m[3].includes(o.id)) continue;
        o.exists = true;
        o.hits.push({ file: path.join(root, m[1]), line: Number(m[2]), text: m[3].trim().slice(0, 220) });
      }
    }
  }
  // A search that failed in any repository leaves "found nowhere" unproven.
  for (const o of out) if (failed.has(o.id) && !o.exists) o.checked = false;
  return out;
}
