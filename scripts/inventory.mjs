// Scans what Claude already knows: native auto-memory files, skills and CLAUDE.md files.
// Used by the reviewer (to spot repeats) and by the dashboard.
import fs from 'node:fs';
import path from 'node:path';
import { claudeDir, memoryDirFor, ouroborosDir, projectKey, repoRoot } from './paths.mjs';

/**
 * Reads the YAML frontmatter of a memory or skill file. Not a full YAML parser, but it
 * covers what Claude Code accepts in practice: nested mappings, block sequences, block
 * scalars (`|`, `>`, with chomping/indent indicators), plain scalars continued on more
 * indented lines, and single/double-quoted scalars (escapes, spanning several lines).
 * Scalars stay strings; flow collections (`[a, b]`) are kept as their raw text.
 */
export function parseFrontmatter(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)??---[ \t]*(?=\r?\n|$)/.exec(src);
  if (!m) return { data: {}, body: src };
  const lines = (m[1] ?? '').split(/\r?\n/).map((l) => l.replace(/^\t+/, (t) => '  '.repeat(t.length)));
  const { value } = parseMapping(lines, 0, 0);
  return { data: value, body: src.slice(m[0].length) };
}

const indentOf = (line) => /^ */.exec(line)[0].length;
const isBlank = (line) => /^\s*(#.*)?$/.test(line);
const KEY_RE = /^( *)("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"-][^:]*?|-\S[^:]*?)[ \t]*:(?:[ \t]+(.*))?$/;

function unquoteKey(k) {
  if (k.startsWith('"')) return parseDoubleQuoted([k], 0).value;
  if (k.startsWith("'")) return k.slice(1, -1).replace(/''/g, "'");
  return k;
}

function nextContent(lines, i) {
  while (i < lines.length && isBlank(lines[i])) i++;
  return i;
}

function parseMapping(lines, start, indent) {
  const data = {};
  let i = start;
  while ((i = nextContent(lines, i)) < lines.length) {
    const line = lines[i];
    const ind = indentOf(line);
    if (ind < indent) break;
    const kv = ind === indent ? KEY_RE.exec(line) : null;
    if (!kv) { i++; continue; } // stray or malformed line: skip it
    const key = unquoteKey(kv[2].trim());
    const r = parseValue(lines, i, indent, (kv[3] ?? '').trim());
    data[key] = r.value;
    i = r.next;
  }
  return { value: data, next: i };
}

function parseSequence(lines, start, indent) {
  const out = [];
  let i = start;
  while ((i = nextContent(lines, i)) < lines.length) {
    const line = lines[i];
    if (indentOf(line) !== indent || !/^ *-(\s|$)/.test(line)) break;
    const r = parseValue(lines, i, indent, line.slice(indent + 1).trim());
    out.push(r.value);
    i = r.next;
  }
  return { value: out, next: i };
}

/** Value of the key or `-` item on line `i` (whose own indent is `indent`); `rest` is what follows it. */
function parseValue(lines, i, indent, rest) {
  if (rest === '' || rest.startsWith('#')) {
    const j = nextContent(lines, i + 1);
    if (j >= lines.length) return { value: '', next: j };
    const ind = indentOf(lines[j]);
    const t = lines[j].trim();
    // A sequence may sit at the same indent as its key.
    if (t === '-' || t.startsWith('- ')) {
      if (ind > indent || (ind === indent && lines[i].trimStart()[0] !== '-')) return parseSequence(lines, j, ind);
      return { value: '', next: j };
    }
    if (ind <= indent) return { value: '', next: j };
    if (KEY_RE.test(lines[j])) return parseMapping(lines, j, ind);
    return parsePlain(lines, j, indent, '');
  }
  if (/^[|>]/.test(rest)) return parseBlock(lines, i, indent, rest);
  if (rest.startsWith('"')) return parseDoubleQuoted(lines, i, rest);
  if (rest.startsWith("'")) return parseSingleQuoted(lines, i, rest);
  return parsePlain(lines, i + 1, indent, rest);
}

/** Joins the lines of a flow scalar: one line break becomes a space, n blank lines become n newlines. */
function fold(parts) {
  let out = '';
  let blanks = 0;
  parts.forEach((p, k) => {
    if (k === 0) { out = p; return; }
    if (p === '') { blanks++; return; }
    out += blanks ? '\n'.repeat(blanks) : (out === '' ? '' : ' ');
    out += p;
    blanks = 0;
  });
  return out + '\n'.repeat(blanks);
}

function parsePlain(lines, j, indent, first) {
  const parts = [first.replace(/\s+#.*$/, '')];
  let i = j;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { parts.push(''); i++; continue; }
    if (indentOf(line) <= indent || /^\s*#/.test(line)) break;
    parts.push(line.trim().replace(/\s+#.*$/, ''));
    i++;
  }
  while (parts.length > 1 && parts[parts.length - 1] === '') { parts.pop(); }
  const value = fold(parts[0] === '' ? parts.slice(1) : parts).trim();
  return { value, next: i };
}

function parseBlock(lines, i, indent, header) {
  const h = /^([|>])([1-9+-]*)/.exec(header);
  const literal = h[1] === '|';
  const chomp = h[2].includes('-') ? 'strip' : h[2].includes('+') ? 'keep' : 'clip';
  const explicit = Number(h[2].replace(/[+-]/g, '')) || 0;
  let j = i + 1;
  let blockIndent = explicit ? indent + explicit : 0;
  const raw = [];
  while (j < lines.length) {
    const line = lines[j];
    if (line.trim() === '') { raw.push(''); j++; continue; }
    const ind = indentOf(line);
    if (!blockIndent) blockIndent = ind;
    if (ind < blockIndent || ind <= indent) break;
    raw.push(line.slice(blockIndent));
    j++;
  }
  let trailing = 0;
  while (raw.length && raw[raw.length - 1] === '') { raw.pop(); trailing++; }
  let body;
  if (literal) {
    body = raw.join('\n');
  } else {
    // Folded: lines at the block indent join with a space; more indented lines keep their breaks.
    body = '';
    let blanks = 0;
    let prevMore = false;
    raw.forEach((l, k) => {
      if (l === '') { blanks++; return; }
      const more = /^\s/.test(l);
      if (k > 0 && body !== '') body += blanks ? '\n'.repeat(blanks + (more || prevMore ? 1 : 0)) : (more || prevMore ? '\n' : ' ');
      body += l;
      blanks = 0;
      prevMore = more;
    });
  }
  if (body === '') return { value: '', next: j };
  if (chomp === 'clip') body += '\n';
  else if (chomp === 'keep') body += '\n'.repeat(trailing + 1);
  return { value: body, next: j };
}

const ESCAPES = { 0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: ' ', P: ' ' };

function parseDoubleQuoted(lines, i, first = lines[i]) {
  const parts = [];
  let cur = '';
  let src = first.slice(1);
  let j = i;
  for (;;) {
    let k = 0;
    let closed = false;
    while (k < src.length) {
      const c = src[k];
      if (c === '"') { closed = true; break; }
      if (c === '\\') {
        const e = src[k + 1];
        if (e === undefined) { cur += '\u0000JOIN'; k++; break; } // escaped line break
        const hex = { x: 2, u: 4, U: 8 }[e];
        if (hex) { cur += String.fromCodePoint(parseInt(src.slice(k + 2, k + 2 + hex), 16) || 0xfffd); k += 2 + hex; continue; }
        cur += ESCAPES[e] ?? e;
        k += 2;
        continue;
      }
      cur += c;
      k++;
    }
    if (closed || j + 1 >= lines.length) { parts.push(parts.length ? cur.trimStart() : cur); break; }
    parts.push(parts.length ? cur.trim() : cur.trimEnd());
    cur = '';
    src = lines[++j];
  }
  // A trailing backslash joins the next line with no space.
  const joined = [];
  for (const p of parts) {
    const prev = joined.length - 1;
    if (prev >= 0 && joined[prev].endsWith('\u0000JOIN')) joined[prev] = joined[prev].slice(0, -5) + p;
    else joined.push(p);
  }
  return { value: fold(joined), next: j + 1 };
}

function parseSingleQuoted(lines, i, first) {
  const parts = [];
  let src = first.slice(1);
  let j = i;
  for (;;) {
    const end = /^((?:[^']|'')*)'(?!')/.exec(src);
    if (end || j + 1 >= lines.length) {
      const piece = (end ? end[1] : src).replace(/''/g, "'");
      parts.push(parts.length ? piece.trimStart() : piece);
      break;
    }
    const piece = src.replace(/''/g, "'");
    parts.push(parts.length ? piece.trim() : piece.trimEnd());
    src = lines[++j];
  }
  return { value: fold(parts), next: j + 1 };
}

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function safeList(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** Memory files in one memory directory (`project` labels them). */
export function listMemoriesIn(dir, project = path.basename(path.dirname(dir))) {
  const out = [];
  for (const f of safeList(dir)) {
    if (!f.isFile() || !f.name.endsWith('.md')) continue;
    const file = path.join(dir, f.name);
    const text = safeRead(file) ?? '';
    const st = safeStat(file);
    const { data } = parseFrontmatter(text);
    out.push({
      project,
      file,
      index: f.name === 'MEMORY.md',
      name: data.name || f.name.replace(/\.md$/, ''),
      description: data.description || '',
      type: data.metadata?.type || data.type || (f.name === 'MEMORY.md' ? 'index' : ''),
      origin: data.metadata?.origin || null,
      chars: text.length,
      lines: text.split('\n').length,
      mtime: st?.mtimeMs ?? null,
    });
  }
  return out;
}

/** Memory files of one project key (or all projects when key is omitted). */
export function listMemories(key) {
  const root = path.join(claudeDir(), 'projects');
  const keys = key ? [key] : safeList(root).filter((d) => d.isDirectory()).map((d) => d.name);
  return keys.flatMap((k) => listMemoriesIn(path.join(root, k, 'memory'), k));
}

/** Skill directories to scan: personal skills plus .claude/skills of known project dirs. */
export function skillRoots(cwds = []) {
  const roots = [{ scope: 'personal', dir: path.join(claudeDir(), 'skills') }];
  const seen = new Set([roots[0].dir.toLowerCase()]);
  for (const cwd of cwds) {
    if (!cwd) continue;
    const dir = path.join(cwd, '.claude', 'skills');
    if (seen.has(dir.toLowerCase())) continue;
    seen.add(dir.toLowerCase());
    if (safeStat(dir)?.isDirectory()) roots.push({ scope: 'project', project: projectKey(cwd), dir });
  }
  return roots;
}

export function listSkills(cwds = []) {
  const out = [];
  for (const root of skillRoots(cwds)) {
    for (const d of safeList(root.dir)) {
      // Junctions/symlinks (e.g. skills installed from a separate repo) count as directories.
      const dir = path.join(root.dir, d.name);
      if (!safeStat(dir)?.isDirectory()) continue;
      const file = path.join(dir, 'SKILL.md');
      const text = safeRead(file);
      if (text === null) continue;
      const { data } = parseFrontmatter(text);
      const description = [data.description, data.when_to_use].filter(Boolean).join(' ');
      out.push({
        scope: root.scope,
        project: root.project || null,
        name: data.name || d.name,
        file,
        description,
        descriptionChars: description.length,
        userOnly: String(data['disable-model-invocation']) === 'true',
        origin: data.metadata?.origin || null,
        chars: text.length,
        mtime: safeStat(file)?.mtimeMs ?? null,
      });
    }
  }
  return out;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Where Claude Code loads a plugin from. A plugin from a `directory` marketplace (a local
 * folder) is loaded from that folder, while `installed_plugins.json` keeps pointing at the
 * copy made when it was installed, which is never updated. Other plugins load from their
 * `installPath`.
 */
function pluginRoot(plugin, marketplace, install, marketplaces) {
  const mk = marketplaces?.[marketplace];
  if (mk?.source?.source === 'directory') {
    const dir = mk.installLocation || mk.source.path;
    const entry = readJson(path.join(dir, '.claude-plugin', 'marketplace.json'))?.plugins?.find((p) => p?.name === plugin);
    const source = typeof entry?.source === 'string' ? entry.source : entry?.source?.path;
    const root = source ? path.resolve(dir, source) : null;
    if (root && safeStat(root)?.isDirectory()) return root;
  }
  return install.installPath;
}

/**
 * Skills of installed plugins (from `plugins/installed_plugins.json`), skipping plugins
 * the user settings disable. Claude invokes them as `<plugin>:<skill>`.
 */
export function listPluginSkills() {
  let installed = {};
  try { installed = JSON.parse(fs.readFileSync(path.join(claudeDir(), 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {}; } catch { return []; }
  let enabled = {};
  try { enabled = JSON.parse(fs.readFileSync(path.join(claudeDir(), 'settings.json'), 'utf8')).enabledPlugins || {}; } catch { /* none */ }
  const marketplaces = readJson(path.join(claudeDir(), 'plugins', 'known_marketplaces.json'));
  const out = [];
  for (const [id, installs] of Object.entries(installed)) {
    if (enabled[id] === false) continue;
    const [plugin, marketplace] = id.split('@');
    const install = (Array.isArray(installs) ? installs : [installs]).find((x) => x?.installPath);
    if (!install) continue;
    const dir = path.join(pluginRoot(plugin, marketplace, install, marketplaces), 'skills');
    for (const d of safeList(dir)) {
      const file = path.join(dir, d.name, 'SKILL.md');
      const text = safeRead(file);
      if (text === null) continue;
      const { data } = parseFrontmatter(text);
      const description = [data.description, data.when_to_use].filter(Boolean).join(' ');
      out.push({
        scope: 'plugin', plugin, project: null, name: `${plugin}:${data.name || d.name}`, file, description,
        descriptionChars: description.length, userOnly: String(data['disable-model-invocation']) === 'true',
        origin: null, chars: text.length, mtime: safeStat(file)?.mtimeMs ?? null,
      });
    }
  }
  return out;
}

export function listInstructionFiles(cwds = []) {
  const files = [{ scope: 'global', file: path.join(claudeDir(), 'CLAUDE.md') }];
  for (const cwd of new Set(cwds.filter(Boolean))) {
    files.push({ scope: 'project', project: projectKey(cwd), file: path.join(cwd, 'CLAUDE.md') });
    files.push({ scope: 'project', project: projectKey(cwd), file: path.join(cwd, '.claude', 'CLAUDE.md') });
  }
  return files
    .map((f) => {
      const st = safeStat(f.file);
      if (!st?.isFile()) return null;
      const text = safeRead(f.file) ?? '';
      return { ...f, chars: text.length, lines: text.split('\n').length, mtime: st.mtimeMs };
    })
    .filter(Boolean);
}

/** Short text listing of what exists, for the reviewer prompt. */
export function inventoryForPrompt(cwd) {
  const lines = [];
  const mems = listMemoriesIn(memoryDirFor({ cwd })).filter((m) => !m.index);
  if (mems.length) {
    lines.push('Project memories:');
    for (const m of mems.slice(0, 80)) lines.push(`- ${m.name}: ${m.description.slice(0, 160)}`);
  }
  const skills = listSkills(cwd ? [repoRoot(cwd) || cwd] : []);
  if (skills.length) {
    lines.push('Skills:');
    for (const s of skills.slice(0, 80)) lines.push(`- ${s.name}: ${s.description.slice(0, 160)}`);
  }
  return lines.join('\n') || '(nothing saved yet)';
}
