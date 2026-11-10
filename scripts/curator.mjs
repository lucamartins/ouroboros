// The only writer of Ouroboros learnings. Deterministic: validates, filters secrets,
// routes, deduplicates, enforces budgets, writes atomically and records every file
// change in the ledger so it can be undone.
//
//   node curator.mjs apply   [--file proposals.json]   (JSON on stdin otherwise)
//   node curator.mjs undo    [--id lrn_x | --last]
//   node curator.mjs forget  --match <id | name | text>
//   node curator.mjs inventory --cwd <dir> [--memory-dir <dir>] [--session <id>]
//   (all accept --data <dir>)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { options } from './config.mjs';
import { applyChangeset, applyEdits, claimsOf, pendingChangeset, queueEdit, rejectChangeset } from './changesets.mjs';
import { getMeta, logError, openDb, setMetaOnce } from './db.mjs';
import { listMemories, listMemoriesIn, listSkills, parseFrontmatter } from './inventory.mjs';
import { knowledgeKind, PATCHABLE } from './knowledge.mjs';
import { claudeDir, classifyPath, ensureGlobalInstructions, gitRoot, memoryDirFor, normalize, ouroborosDir, projectIdFor, repoRoot } from './paths.mjs';
import { cleanPaths, findOwners, preferenceHome } from './router.mjs';
import { addObservations, closeObservations, sessionStateText } from './session-state.mjs';
import { ensureSettingsFile, expandHome, loadSettings, routeFor } from './settings.mjs';
import { addedText, isInsertion, revertChange } from './textdiff.mjs';

// ---------- small helpers ----------

export function newId() {
  return `lrn_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

export function slug(s, max = 48) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, max).replace(/-+$/, '');
}

function trigrams(s) {
  const t = ` ${String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const set = new Set();
  for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
  return set;
}

export function similarity(a, b) {
  const A = trigrams(a);
  const B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export const DUPLICATE_THRESHOLD = 0.6;

const SECRET_RE = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\bgh[opusr]_[A-Za-z0-9]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bre_[A-Za-z0-9]{20,}/,
  /\bwhsec_[A-Za-z0-9]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"]?[^\s'"]{8,}/i,
];

export function containsSecret(...texts) {
  return texts.some((t) => t && SECRET_RE.some((re) => re.test(String(t))));
}

function yamlStr(s) {
  const v = String(s ?? '').replace(/\r?\n/g, ' ').trim();
  return /^[\s\-?:,[\]{}#&*!|>'"%@`]|[:#]\s|\s$/.test(v) || v === '' ? JSON.stringify(v) : v;
}

function readOrNull(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export { gitRoot, memoryDirFor };

// ---------- ledger: transactional file writes ----------

class Batch {
  /** One ledger batch: the files of one operation, with what it learned (title) and why. */
  constructor(db, { actor, sessionId, title = null, why = null }) {
    this.db = db;
    this.id = crypto.randomBytes(6).toString('hex');
    this.actor = actor;
    this.sessionId = sessionId || null;
    this.title = title ? String(title).replace(/\s+/g, ' ').trim().slice(0, 300) : null;
    this.why = why ? String(why).trim().slice(0, 2000) : null;
    this.writes = [];
  }

  /** content === null removes the file; { link: target } creates a directory link. */
  write(file, content, { learningId, op }) {
    const before = readLinkOrFile(file);
    if (content && typeof content === 'object' && content.link) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.symlinkSync(content.link, file, process.platform === 'win32' ? 'junction' : 'dir');
      this.writes.push({ file, before, after: `@link:${content.link}`, learningId, op });
      return;
    }
    if (content === null) {
      if (before !== null) fs.rmSync(file, { force: true });
      // An archived skill leaves no empty folder behind (Claude Code would still list it).
      if (classifyPath(file) === 'skill') {
        try { if (!fs.readdirSync(path.dirname(file)).length) fs.rmdirSync(path.dirname(file)); } catch { /* keep */ }
      }
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, file);
    }
    this.writes.push({ file, before, after: content, learningId, op });
  }

  rollback() {
    for (const w of [...this.writes].reverse()) restore(w.file, w.before);
    this.writes = [];
  }

  commit() {
    const ts = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO writes (batch, learning_id, ts, op, actor, session_id, file, before, after, title, why)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const w of this.writes) stmt.run(this.id, w.learningId ?? null, ts, w.op, this.actor, this.sessionId, w.file, w.before, w.after, this.title, this.why);
  }
}

function readLinkOrFile(file) {
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink()) return `@link:${fs.readlinkSync(file)}`;
  } catch {
    return null;
  }
  return readOrNull(file);
}

function restore(file, content) {
  const current = readLinkOrFile(file);
  if (current !== null && String(current).startsWith('@link:')) fs.unlinkSync(file);
  else if (current !== null && content === null) fs.rmSync(file, { force: true });
  if (content === null) {
    // Remove directories the write created, when empty (e.g. a skill folder).
    const dir = path.dirname(file);
    try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch { /* keep */ }
    return;
  }
  if (String(content).startsWith('@link:')) {
    fs.symlinkSync(content.slice(6), file, process.platform === 'win32' ? 'junction' : 'dir');
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// ---------- rendering ----------

function renderMemory({ name, description, type, id, confidence, trigger, body }) {
  return [
    '---',
    `name: ${yamlStr(name)}`,
    `description: ${yamlStr(description)}`,
    'metadata:',
    `  type: ${type}`,
    '  origin: ouroboros',
    `  id: ${id}`,
    `  confidence: ${confidence}`,
    `  created: ${today()}`,
    `  trigger: ${trigger}`,
    '---',
    '',
    String(body || description).trim(),
    '',
  ].join('\n');
}

function renderSkill({ name, description, title, id, confidence, trigger, body }) {
  return [
    '---',
    `name: ${yamlStr(name)}`,
    `description: ${yamlStr(description)}`,
    'metadata:',
    '  origin: ouroboros',
    `  id: ${id}`,
    `  confidence: ${confidence}`,
    `  created: ${today()}`,
    `  trigger: ${trigger}`,
    '---',
    '',
    `# ${title}`,
    '',
    String(body || '').trim(),
    '',
  ].join('\n');
}

function indexLine(title, fileName, description) {
  return `- [${String(title).replace(/[[\]]/g, '')}](${fileName}) — ${String(description).replace(/\r?\n/g, ' ').trim()}`;
}

function withIndexLine(indexText, line, fileName) {
  const lines = (indexText ?? '').split(/\r?\n/).filter((l, i, a) => !(i === a.length - 1 && l === ''));
  const at = lines.findIndex((l) => l.includes(`](${fileName})`));
  if (at >= 0) lines[at] = line;
  else lines.push(line);
  return `${lines.join('\n')}\n`;
}

function withoutIndexLine(indexText, fileName) {
  if (indexText === null) return null;
  return `${indexText.split(/\r?\n/).filter((l) => l && !l.includes(`](${fileName})`)).join('\n')}\n`;
}

function countIndexEntries(indexText) {
  return (indexText ?? '').split(/\r?\n/).filter((l) => l.trim()).length;
}

/** Entries in the MEMORY.md index of a memory directory. */
export function indexEntriesIn(dir) {
  return countIndexEntries(readOrNull(path.join(dir, 'MEMORY.md')));
}

/** Replaces the top-level `description:` value, including any continuation lines (block or folded scalars). */
export function setDescription(text, description) {
  const fm = /^(﻿?---[ \t]*\r?\n)([\s\S]*?\r?\n)(---[ \t]*(?:\r?\n|$))/.exec(text);
  if (!fm) return text;
  const lines = fm[2].split(/(?<=\n)/);
  const at = lines.findIndex((l) => /^description[ \t]*:/.test(l));
  if (at < 0) return text;
  let end = at + 1;
  while (end < lines.length && (/^[ \t]/.test(lines[end]) || !lines[end].trim())) end++;
  while (end > at + 1 && !lines[end - 1].trim()) end--; // keep blank lines that follow the value
  const eol = /\r\n$/.test(lines[at]) ? '\r\n' : '\n';
  lines.splice(at, end - at, `description: ${yamlStr(description)}${eol}`);
  return fm[1] + lines.join('') + fm[3] + text.slice(fm[0].length);
}

// ---------- apply ----------

function normalizeItem(raw, payload) {
  const item = { ...raw };
  delete item.ownFile; // set by code only (a file Ouroboros created), never by a proposal
  delete item.ownUntouched;
  item.op = item.op === 'patch' ? 'patch' : 'create';
  // "profile" is the kind used before global facts moved to the global CLAUDE.md.
  item.kind = ['memory', 'skill', 'global', 'preference'].includes(item.kind) ? item.kind : item.kind === 'profile' ? 'global' : 'memory';
  item.scope = item.scope === 'global' || item.kind === 'preference' ? 'global' : 'project';
  item.confidence = Math.min(0.9, Math.max(0.3, Number(item.confidence) || 0.6));
  item.trigger = payload.trigger || 'manual';
  item.projectDir = item.project_dir || payload.cwd || process.cwd();
  if (item.kind === 'memory' && item.scope === 'global') item.kind = 'global';
  if (item.kind === 'global') return item.op === 'create' ? globalFact(item) : { ...item, kind: 'instructions', scope: 'global' };
  if (item.kind === 'preference' && item.op === 'create') return preference(item);
  return item;
}

/** The one sentence a preference or global fact states. */
function factText(item) {
  return String(item.text || item.append || item.body || item.description || item.title || '').replace(/\s+/g, ' ').trim();
}

/**
 * A preference valid on every project that matters for one topic or one kind of file
 * (router.mjs): a line in that topic's home. When the home exists, the item becomes an
 * addition to it; when it does not, it is created with this first line.
 */
function preference(item) {
  const text = factText(item);
  const topic = slug(item.topic || '', 32);
  if (!topic || !text) return { ...item, invalid: 'a preference needs a "topic" (one or two words) and a "text"' };
  const paths = cleanPaths(item.paths);
  const { home, file, name } = preferenceHome(topic, paths);
  const base = { ...item, scope: 'global', topicSlug: topic, paths, prefHome: home, prefFile: file, prefName: name, prefText: text, title: item.title || text.slice(0, 120) };
  if (!fs.existsSync(file)) return base;
  return { ...base, op: 'patch', kind: home === 'skill' ? 'skill' : 'rules', target: file, append: /^[-*]\s/.test(text) ? text : `- ${text}`, section: '', ownFile: true };
}

/**
 * A fact valid on every project is an addition to the user's global CLAUDE.md, which
 * Claude Code loads in every session: at the end of `section` when given, else at the
 * end of the file. Like any change to a CLAUDE.md it waits for the user, unless the
 * user asked for it.
 */
function globalFact(item) {
  const text = String(item.text || item.append || item.body || item.description || item.title || '').replace(/\s+/g, ' ').trim();
  const file = ensureGlobalInstructions();
  return {
    ...item, op: 'patch', kind: 'instructions', scope: 'global', target: file, section: item.section || '',
    append: text && !/^[-*]\s/.test(text) ? `- ${text}` : text, title: item.title || text.slice(0, 120), globalFact: text,
  };
}

/** The lines of a markdown file that state something (bullets and prose), for duplicate checks. */
function statements(text) {
  return String(text || '').split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim())
    .filter((l) => l.length > 15 && !/^(#|<!--|```|\|)/.test(l))
    .map((l) => ({ text: l }));
}

/**
 * The same way-of-working rule already saved in another project is really a global
 * preference: it becomes a global fact instead of a copy project by project.
 */
function promoteToGlobal(item, payload) {
  if (item.op !== 'create' || item.kind !== 'memory' || !['feedback', 'user'].includes(item.memory_type)) return item;
  const title = String(item.title || '').trim();
  const description = String(item.description || title).replace(/\s+/g, ' ').trim();
  const dir = memoryDirFor({ memoryDir: payload.memory_dir, cwd: item.projectDir });
  const probe = `${slug(item.name || title)} ${title} ${description}`;
  const here = listMemoriesIn(dir).filter((m) => !m.index);
  if (findSimilar(here.map((m) => ({ text: `${m.name} ${m.description}` })), probe)) return item;
  const elsewhere = findSimilar(listMemories().filter((m) => !m.index && normalize(path.dirname(m.file)) !== normalize(dir))
    .map((m) => ({ text: `${m.name} ${m.description}`, project: m.project })), probe);
  if (!elsewhere) return item;
  return { ...globalFact({ ...item, kind: 'global', text: description }), promoted: elsewhere.project };
}

/** Where a project's own skills live: the repository's main checkout (a worktree is temporary), else the folder. */
function projectRootOf(dir) {
  return repoRoot(dir) || gitRoot(dir) || dir;
}

function skillsInScope(item, settings) {
  const cwds = [projectRootOf(item.projectDir)];
  const out = listSkills(cwds);
  const route = routeFor(settings, item.projectDir);
  if (route) {
    const dir = path.resolve(expandHome(route.skillsDir));
    for (const d of safeList(dir)) {
      const file = path.join(dir, d, 'SKILL.md');
      const text = readOrNull(file);
      if (text === null) continue;
      const { data } = parseFrontmatter(text);
      out.push({ name: data.name || d, description: data.description || '', file });
    }
  }
  return out;
}

function safeList(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function findSimilar(candidates, text) {
  let best = null;
  for (const c of candidates) {
    const score = similarity(text, c.text);
    if (score >= DUPLICATE_THRESHOLD && (!best || score > best.score)) best = { ...c, score };
  }
  return best;
}

function budgetWarning(used, limit, settings, label) {
  return limit && used / limit >= settings.limits.consolidateAt
    ? `${label} at ${Math.round((used / limit) * 100)}% of its budget — consolidate soon`
    : undefined;
}

function upsertLearning(db, row) {
  db.prepare(`
    INSERT INTO learnings (id, kind, scope, memory_type, block, project, name, title, path, confidence, status, trigger, origin_session, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, confidence = MAX(learnings.confidence, excluded.confidence),
      status = 'active', updated_at = excluded.updated_at
  `).run(row.id, row.kind, row.scope, row.memory_type ?? null, row.block ?? null, row.project ?? null, row.name, row.title,
    row.path, row.confidence, row.trigger ?? null, row.session ?? null, Date.now(), Date.now());
}

function learningForPath(db, file) {
  return db.prepare("SELECT * FROM learnings WHERE lower(path) = lower(?) AND status = 'active' ORDER BY updated_at DESC").get(file);
}

function createMemory(db, batch, item, settings, payload) {
  const title = String(item.title || '').trim();
  const description = String(item.description || title).replace(/\s+/g, ' ').trim();
  if (!title || !String(item.body || description).trim()) return { status: 'rejected', reason: 'memory needs a title and a body or description' };
  const type = ['user', 'feedback', 'project', 'reference'].includes(item.memory_type) ? item.memory_type : 'project';
  const dir = memoryDirFor({ memoryDir: payload.memory_dir, cwd: item.projectDir });
  const name = slug(item.name || title);
  const fileName = `${name}.md`;
  const file = path.join(dir, fileName);
  const indexFile = path.join(dir, 'MEMORY.md');

  const existing = listMemoriesIn(dir).filter((m) => !m.index);
  if (fs.existsSync(file)) return { status: 'duplicate', target: file, reason: `a memory named "${name}" already exists; patch it instead` };
  const probe = `${name} ${title} ${description}`;
  const dup = findSimilar(existing.map((m) => ({ text: `${m.name} ${m.description}`, file: m.file, name: m.name })), probe);
  if (dup) return { status: 'duplicate', target: dup.file, existing: dup.text, reason: 'a similar memory exists; patch it instead' };

  const indexText = readOrNull(indexFile);
  const entries = countIndexEntries(indexText) + 1;
  if (entries > settings.limits.memoryIndexLines) {
    return { status: 'over_budget', reason: `MEMORY.md would have ${entries}/${settings.limits.memoryIndexLines} entries; merge or forget memories first` };
  }
  const id = newId();
  batch.write(file, renderMemory({ name, description, type, id, confidence: item.confidence, trigger: item.trigger, body: item.body }), { learningId: id, op: 'create' });
  batch.write(indexFile, withIndexLine(indexText, indexLine(title, fileName, description), fileName), { learningId: id, op: 'create' });
  upsertLearning(db, { id, kind: 'memory', scope: 'project', memory_type: type, project: path.basename(path.dirname(dir)), name, title, path: file, confidence: item.confidence, trigger: item.trigger });
  return { status: 'created', id, kind: 'memory', path: file, title, warning: budgetWarning(entries, settings.limits.memoryIndexLines, settings, 'MEMORY.md') };
}

function createSkill(db, batch, item, settings) {
  const title = String(item.title || '').trim();
  const description = String(item.description || '').replace(/\s+/g, ' ').trim();
  if (!title || !description || !String(item.body || '').trim()) return { status: 'rejected', reason: 'skill needs a title, a description and a body' };
  if (description.length > settings.limits.skillDescriptionChars) {
    return { status: 'rejected', reason: `description has ${description.length} chars; the limit is ${settings.limits.skillDescriptionChars}` };
  }
  const active = db.prepare("SELECT COUNT(*) n FROM learnings WHERE kind = 'skill' AND status = 'active' AND origin_session IS NOT 'native'").get().n;
  if (active + 1 > settings.limits.learnedSkills) {
    return { status: 'over_budget', reason: `${active}/${settings.limits.learnedSkills} learned skills; merge or forget one first` };
  }

  const route = item.scope === 'project' ? routeFor(settings, item.projectDir) : null;
  let base = slug(item.name || title);
  let dir;
  let link = null;
  if (item.scope === 'global') {
    if (!base.startsWith('learned-')) base = `learned-${base}`.slice(0, 56);
    dir = path.join(claudeDir(), 'skills', base);
  } else if (route) {
    dir = path.join(path.resolve(expandHome(route.skillsDir)), base);
    if (route.linkInto) link = path.join(path.resolve(expandHome(route.linkInto)), base);
  } else {
    dir = path.join(projectRootOf(item.projectDir), '.claude', 'skills', base);
  }
  const file = path.join(dir, 'SKILL.md');
  if (fs.existsSync(file) || (link && fs.existsSync(link))) return { status: 'duplicate', target: file, reason: `a skill named "${base}" already exists; patch it instead` };
  const dup = findSimilar(skillsInScope(item, settings).map((s) => ({ text: `${s.name} ${s.description}`, file: s.file, name: s.name })), `${base} ${title} ${description}`);
  if (dup) return { status: 'duplicate', target: dup.file, existing: dup.name, reason: `skill "${dup.name}" covers this; patch it instead` };

  const id = newId();
  batch.write(file, renderSkill({ name: base, description, title, id, confidence: item.confidence, trigger: item.trigger, body: item.body }), { learningId: id, op: 'create' });
  if (link) batch.write(link, { link: dir }, { learningId: id, op: 'create' });
  upsertLearning(db, { id, kind: 'skill', scope: item.scope, project: item.scope === 'project' ? projectIdFor(item.projectDir) : null, name: base, title, path: file, confidence: item.confidence, trigger: item.trigger });
  return { status: 'created', id, kind: 'skill', path: file, title, warning: budgetWarning(active + 1, settings.limits.learnedSkills, settings, 'learned skills') };
}

function createPreference(db, batch, item, settings) {
  if (item.invalid) return { status: 'rejected', reason: item.invalid };
  const topicTitle = String(item.topic).replace(/\s+/g, ' ').trim();
  const id = newId();
  const line = /^[-*]\s/.test(item.prefText) ? item.prefText : `- ${item.prefText}`;
  if (item.prefHome === 'rules') {
    const content = ['---', 'paths:', ...item.paths.map((p) => `  - ${JSON.stringify(p)}`), '---', '', `# ${topicTitle} (learned preferences)`, '', line, ''].join('\n');
    batch.write(item.prefFile, content, { learningId: id, op: 'create' });
    upsertLearning(db, { id, kind: 'rules', scope: 'global', name: path.basename(item.prefFile, '.md'), title: item.title, path: item.prefFile, confidence: item.confidence, trigger: item.trigger });
    return { status: 'created', id, kind: 'rules', path: item.prefFile, title: item.title };
  }
  const description = String(item.description || `The user's preferences about ${topicTitle}. Use whenever the task involves ${topicTitle}.`).replace(/\s+/g, ' ').trim();
  if (description.length > settings.limits.skillDescriptionChars) {
    return { status: 'rejected', reason: `description has ${description.length} chars; the limit is ${settings.limits.skillDescriptionChars}` };
  }
  const active = db.prepare("SELECT COUNT(*) n FROM learnings WHERE kind = 'skill' AND status = 'active' AND origin_session IS NOT 'native'").get().n;
  if (active + 1 > settings.limits.learnedSkills) {
    return { status: 'over_budget', reason: `${active}/${settings.limits.learnedSkills} learned skills; merge or forget one first` };
  }
  const content = [
    '---', `name: ${item.prefName}`, `description: ${yamlStr(description)}`, 'user-invocable: false',
    'metadata:', '  origin: ouroboros', `  id: ${id}`, `  confidence: ${item.confidence}`, `  created: ${today()}`, `  trigger: ${item.trigger}`,
    '---', '', `# Preferences: ${topicTitle}`, '', line, '',
  ].join('\n');
  batch.write(item.prefFile, content, { learningId: id, op: 'create' });
  upsertLearning(db, { id, kind: 'skill', scope: 'global', name: item.prefName, title: item.title, path: item.prefFile, confidence: item.confidence, trigger: item.trigger });
  return { status: 'created', id, kind: 'skill', path: item.prefFile, title: item.title, warning: budgetWarning(active + 1, settings.limits.learnedSkills, settings, 'learned skills') };
}

/** Whether Ouroboros created this file (so adding to it is not a change to something a person wrote). */
export function createdByOuroboros(db, file) {
  return !!db.prepare("SELECT 1 FROM learnings WHERE lower(path) = lower(?) AND status = 'active' AND origin_session IS NOT 'native'").get(path.resolve(String(file)));
}

/**
 * Whether a memory is still exactly what Ouroboros wrote: it created the file, and the
 * file's text is the result of its own last write (the user never edited it by hand).
 * Refining such a memory is Ouroboros rewriting its own words, not the user's, so in
 * `auto` it needs no approval; one hand edit and the file is the user's again.
 */
export function ownUntouched(db, file) {
  const target = path.resolve(String(file));
  if (knowledgeKind(target) !== 'memory' || !createdByOuroboros(db, target)) return false;
  const last = db.prepare('SELECT after FROM writes WHERE lower(file) = lower(?) AND reverted_at IS NULL ORDER BY id DESC LIMIT 1').get(target);
  return !!last && last.after !== null && last.after === readOrNull(target);
}

/** Resolve the file a patch targets: learning id, a knowledge file path, or a name. */
function resolvePatchTarget(db, item, settings, payload) {
  const target = String(item.target || '').trim();
  if (!target) return null;
  if (/^lrn_/.test(target)) {
    const l = db.prepare('SELECT * FROM learnings WHERE id = ?').get(target);
    if (l) return { file: l.path, kind: l.kind, learning: l };
  }
  if (path.isAbsolute(expandHome(target))) {
    const file = path.resolve(expandHome(target));
    const kind = knowledgeKind(file);
    if (!PATCHABLE.has(kind)) return { error: 'only memory, skill, rule and CLAUDE.md files can be patched' };
    return { file, kind };
  }
  if (item.kind === 'skill') {
    const s = skillsInScope(item, settings).find((x) => x.name === target || x.name === `learned-${target}`);
    return s ? { file: s.file, kind: 'skill' } : null;
  }
  const dir = memoryDirFor({ memoryDir: payload.memory_dir, cwd: item.projectDir });
  const file = path.join(dir, target.endsWith('.md') ? target : `${slug(target)}.md`);
  return fs.existsSync(file) ? { file, kind: 'memory' } : null;
}

/**
 * Add text at the end of a section: a markdown heading (until the next heading of the
 * same or higher level) or a bold bullet ("- **Topic**", until the next sibling bullet).
 * Without a matching section, append at the end of the file.
 */
export function appendToSection(text, section, addition) {
  const add = String(addition || '').trim();
  if (!add) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const want = String(section || '').toLowerCase().replace(/[*`#]/g, '').trim();
  const norm = (l) => l.toLowerCase().replace(/[*`#]/g, '').replace(/^\s*[-*]\s+/, '').trim();
  let start = -1;
  let level = 0;
  let bullet = null;
  if (want) {
    for (let i = 0; i < lines.length; i++) {
      const h = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
      if (h && norm(h[2]).startsWith(want)) { start = i; level = h[1].length; break; }
      const b = /^(\s*)[-*]\s+\*\*(.+?)\*\*/.exec(lines[i]);
      if (b && norm(b[2]).startsWith(want)) { start = i; bullet = b[1]; break; }
    }
  }
  let end = lines.length;
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      const h = /^(#{1,6})\s/.exec(lines[i]);
      if (h && (bullet !== null || h[1].length <= level)) { end = i; break; }
      if (bullet !== null && lines[i].startsWith(bullet) && /^[-*]\s/.test(lines[i].slice(bullet.length))) { end = i; break; }
    }
  }
  while (end > start + 1 && end > 0 && !lines[end - 1].trim()) end--;
  const block = bullet !== null && !/^\s*[-*]\s/.test(add) ? `${bullet}- ${add}` : add;
  // A blank line after a heading (and before text added at the end of a file without a final newline).
  const prev = end > 0 ? lines[end - 1] : '';
  const insert = /^#{1,6}\s/.test(prev) || (start < 0 && lines[lines.length - 1] !== '') ? ['', block] : [block];
  lines.splice(end, 0, ...insert);
  return lines.join(eol);
}

function patchItem(db, batch, item, settings, payload) {
  const t = resolvePatchTarget(db, item, settings, payload);
  if (!t) return { status: 'rejected', reason: `patch target not found: ${item.target || '(none)'}` };
  if (t.error) return { status: 'rejected', reason: t.error };
  const before = readOrNull(t.file);
  if (before === null) return { status: 'rejected', reason: `file not found: ${t.file}` };

  if (item.prefText) {
    const dup = findSimilar(statements(before), item.prefText);
    if (dup) return { status: 'duplicate', target: t.file, existing: dup.text, reason: 'that preference is already saved there; patch that line instead' };
  }
  if (item.globalFact) {
    const dup = findSimilar(statements(before), item.globalFact);
    if (dup) return { status: 'duplicate', target: t.file, existing: dup.text, reason: 'your global CLAUDE.md already says this; patch that line instead' };
  }

  let after = before;
  const edit = editOf(item);
  if (edit) {
    // The same rules as changes composed by the editor (changesets.applyEdits).
    const r = applyEdits(before, [edit]);
    if (r.rejected.length) return { status: 'rejected', reason: `${r.rejected[0].reason} (${t.file})` };
    after = r.after;
  }
  if (item.description) {
    if (t.kind === 'skill' && item.description.length > settings.limits.skillDescriptionChars) {
      return { status: 'rejected', reason: `description has ${item.description.length} chars; the limit is ${settings.limits.skillDescriptionChars}` };
    }
    after = setDescription(after, item.description);
  }
  if (after === before) return { status: 'rejected', reason: 'patch changes nothing (give "old"/"new" or "description")' };
  if (containsSecret(addedText(before, after))) return { status: 'rejected', reason: 'patch would add something that looks like a secret' };
  return commitText(db, batch, t, after, item);
}

/** The text edit a patch item makes ({ append, section } or { old, new }), if any. */
function editOf(item) {
  if (item.append !== undefined) return { append: item.append, section: item.section || '', corrects: !!item.corrects };
  if (item.old !== undefined) return { old: item.old, new: item.new ?? '', corrects: !!item.corrects };
  return null;
}

/**
 * Whether a patch rewrites what its target says (rather than only adding to it): a
 * changed description, or an edit that is not a pure
 * insertion. Such a patch is a correction and waits for the user like any other.
 */
function rewritesText(db, item, settings, payload) {
  if (item.op !== 'patch') return false;
  const t = resolvePatchTarget(db, item, settings, payload);
  if (!t || t.error) return false;
  const before = readOrNull(t.file);
  if (before === null) return false;
  if (item.description) {
    const { data } = parseFrontmatter(before);
    if (data.description && !isInsertion(String(data.description), item.description)) return true;
  }
  const edit = editOf(item);
  if (!edit) return false;
  const r = applyEdits(before, [edit]);
  return r.applied.some((e) => e.rewrites);
}

/** Write new content to a patchable file through the ledger and record it as a learning. */
function commitText(db, batch, t, after, item) {
  const existing = learningForPath(db, t.file);
  const id = existing?.id || newId();
  batch.write(t.file, after, { learningId: id, op: 'patch' });
  if (t.kind === 'memory' && item.description) {
    const indexFile = path.join(path.dirname(t.file), 'MEMORY.md');
    const indexText = readOrNull(indexFile);
    const fileName = path.basename(t.file);
    if (indexText && indexText.includes(`](${fileName})`)) {
      const title = /\[([^\]]*)\]\(/.exec(indexText.split(/\r?\n/).find((l) => l.includes(`](${fileName})`)) || '')?.[1] || fileName;
      batch.write(indexFile, withIndexLine(indexText, indexLine(title, fileName, item.description), fileName), { learningId: id, op: 'patch' });
    }
  }
  const { data } = parseFrontmatter(after);
  upsertLearning(db, {
    id, kind: t.kind, scope: existing?.scope || (t.kind === 'memory' ? 'project' : 'global'), memory_type: data.metadata?.type,
    name: data.name || path.basename(t.kind === 'skill' ? path.dirname(t.file) : t.file, '.md'),
    title: existing?.title || item.title || data.name || path.basename(t.file), path: t.file,
    confidence: item.confidence, trigger: item.trigger, session: existing ? existing.origin_session : 'native',
  });
  return { status: 'patched', id, kind: t.kind, path: t.file, title: existing?.title || data.name || path.basename(t.file) };
}

/**
 * Whether an item must wait for approval. Actors:
 *   manual     the user decided on this very item (inbox, dashboard): always written
 *   requested  Claude says the user asked for it in the session: skips the autonomy
 *              setting, never the rules below (the label is Claude's own, so it cannot
 *              be what lets a change to a CLAUDE.md, a rule file or existing text through)
 *   inloop | background  proposed by Claude or the reviewer
 */
export function needsApproval(item, actor, autonomy) {
  if (actor === 'manual') return false;
  // Corrections of existing knowledge, and changes to rule files or CLAUDE.md (written
  // by people, versioned with the project), always wait for the user. One exception, in
  // `auto` only: a memory Ouroboros created and nobody edited since (`ownUntouched`, set
  // by code) may be refined without asking; the ledger undoes it.
  if (item.corrects && !(item.ownUntouched && autonomy === 'auto')) return true;
  // (a rule file Ouroboros created for learned preferences is its own: `ownFile`)
  if (!item.ownFile && item.op === 'patch' && item.target && path.isAbsolute(String(item.target)) && ['rules', 'instructions'].includes(knowledgeKind(item.target))) return true;
  if (actor === 'requested') return false;
  if (autonomy === 'auto') return false;
  if (autonomy === 'queue') return true;
  // hybrid: confident facts go in; skills and tentative items wait.
  return item.kind === 'skill' || item.confidence < 0.7;
}

/** Why a proposal waits, for the line the session shows. */
function waitReason(item, actor, autonomy) {
  if (item.corrects) return 'waiting for approval: it rewrites existing text (/ouroboros:inbox or the dashboard)';
  if (needsApproval(item, 'requested', 'auto')) return 'waiting for approval: changes to CLAUDE.md and rule files are always confirmed (/ouroboros:inbox or the dashboard)';
  return `waiting for approval (autonomy: ${autonomy}; /ouroboros:inbox or the dashboard)`;
}

/**
 * Write a validated changeset result (the whole new text of one knowledge file) in
 * its own transaction, through the ledger so it can be undone.
 */
export function writeText(db, { file, after, title, why = null, confidence = 0.6, trigger = 'session_end', actor = 'background', sessionId = null, expectBefore, description = undefined }) {
  const kind = knowledgeKind(file);
  if (!PATCHABLE.has(kind)) return { status: 'rejected', reason: 'only memory, skill, rule and CLAUDE.md files can be changed' };
  const batch = new Batch(db, { actor, sessionId, title, why });
  try {
    db.exec('BEGIN IMMEDIATE');
    // Read under the write lock: another writer may have changed the file meanwhile.
    const before = readOrNull(file);
    const refuse = (status, reason) => { db.exec('ROLLBACK'); return { status, reason }; };
    if (before === null) return refuse('rejected', `file not found: ${file}`);
    if (expectBefore !== undefined && before !== expectBefore) return refuse('stale', 'the file changed while the change was being prepared');
    if (after === before) return refuse('rejected', 'changes nothing');
    if (containsSecret(addedText(before, after))) return refuse('rejected', 'would add something that looks like a secret');
    // A new description also replaces the memory's line in MEMORY.md, in the same batch.
    const result = commitText(db, batch, { file, kind }, after, { title, confidence, trigger, description });
    batch.commit();
    db.exec('COMMIT');
    return { ...result, batch: batch.id };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
    batch.rollback();
    logError(db, 'curator:writeText', err);
    return { status: 'error', reason: String(err.message) };
  }
}

/** Run one normalized item in its own transaction; a dry run undoes files and rows. */
function runItem(db, item, settings, payload, actor, { dryRun = false } = {}) {
  const batch = new Batch(db, { actor, sessionId: payload.session_id, title: item.title || item.text || item.description, why: item.why || item.evidence });
  try {
    db.exec('BEGIN IMMEDIATE');
    let result;
    if (item.op === 'patch') result = patchItem(db, batch, item, settings, payload);
    else if (item.kind === 'preference') result = createPreference(db, batch, item, settings);
    else if (item.kind === 'skill') result = createSkill(db, batch, item, settings);
    else result = createMemory(db, batch, item, settings, payload);
    if (dryRun) {
      db.exec('ROLLBACK');
      batch.rollback();
    } else {
      batch.commit();
      db.exec('COMMIT');
    }
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
    batch.rollback();
    logError(db, 'curator', err);
    return { status: 'error', reason: String(err.message) };
  }
}

/**
 * Queue a proposal for approval. A similar proposal already waiting is replaced by
 * the newer one (newer sessions know better), keeping the higher confidence. When the
 * proposal already has a candidate row (`candidateId`, from the evaluation), that row
 * becomes the queued one.
 */
function enqueue(db, rawItem, payload, actor) {
  const { candidateId, ...item } = rawItem;
  const keyText = (i) => [i.title, i.description, i.text].filter(Boolean).join(' ');
  const stored = JSON.stringify({ item: { ...item, projectDir: undefined, project_dir: item.projectDir }, cwd: payload.cwd, memory_dir: payload.memory_dir, trigger: payload.trigger, actor });
  const waiting = db.prepare("SELECT id, payload FROM candidates WHERE outcome = 'queued' AND changeset_id IS NULL AND kind = ? AND id != ?").all(item.kind, candidateId ?? -1).map((w) => {
    let queuedItem = {};
    try { queuedItem = JSON.parse(w.payload || '{}').item || {}; } catch { /* ignore */ }
    return { id: w.id, op: queuedItem.op, text: keyText(queuedItem) };
  });
  const dup = item.op === 'create' ? findSimilar(waiting.filter((w) => w.op !== 'patch'), keyText(item)) : null;
  if (dup) {
    db.prepare(`
      UPDATE candidates SET title = ?, summary = ?, evidence = ?, confidence = MAX(COALESCE(confidence, 0), ?), payload = ?, cwd = ?, session_id = ?, ts = ?
      WHERE id = ?`).run(
      String(item.title || item.text || '').slice(0, 200), String(item.text || item.body || item.description || '').slice(0, 1500),
      String(item.evidence || '').slice(0, 800), item.confidence, stored, payload.cwd || null, payload.session_id || actor, Date.now(), dup.id);
    if (candidateId) db.prepare("UPDATE candidates SET outcome = 'merged', note = ?, decided_at = ? WHERE id = ?").run(`merged into #${dup.id}: a similar proposal was already waiting`, Date.now(), candidateId);
    return { id: dup.id, replaced: true };
  }
  if (candidateId) {
    db.prepare(`
      UPDATE candidates SET kind = ?, scope = ?, memory_type = ?, title = ?, summary = ?, confidence = ?, outcome = 'queued', payload = ?, cwd = COALESCE(cwd, ?)
      WHERE id = ?`).run(item.kind, item.scope, item.memory_type ?? null,
      String(item.title || item.text || '').slice(0, 200), String(item.text || item.body || item.description || '').slice(0, 1500),
      item.confidence, stored, payload.cwd || null, candidateId);
    return { id: candidateId, replaced: false };
  }
  const r = db.prepare(`
    INSERT INTO candidates (review_id, session_id, project, kind, scope, memory_type, title, summary, evidence, confidence, outcome, payload, cwd, ts)
    VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
  `).run(payload.session_id || actor, projectIdFor(item.projectDir), item.kind, item.scope, item.memory_type ?? null,
    String(item.title || item.text || item.target || '').slice(0, 200), String(item.text || item.body || item.new || item.description || '').slice(0, 1500),
    String(item.evidence || '').slice(0, 800), item.confidence, stored, payload.cwd || null, Date.now());
  return { id: Number(r.lastInsertRowid), replaced: false };
}

/** Apply a batch of proposals. Each item succeeds or fails on its own. */
export function apply(db, payload, { actor = 'manual', autonomy = 'auto', ownerCheck = false } = {}) {
  ensureSettingsFile();
  const settings = loadSettings();
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const results = [];
  for (const raw of items) {
    const item = promoteToGlobal(normalizeItem(raw, payload || {}), payload || {});
    if (containsSecret(item.title, item.description, item.body, item.text, item.new)) {
      results.push({ status: 'rejected', title: item.title, reason: 'looks like it contains a secret (token, key or password); never store secrets' });
      continue;
    }
    // Only code says a rule file is Ouroboros's own (one it created for learned preferences).
    if (item.op === 'patch' && item.target && path.isAbsolute(String(item.target))) {
      item.ownFile = knowledgeKind(item.target) === 'rules' && createdByOuroboros(db, item.target);
      item.ownUntouched = ownUntouched(db, item.target);
    }
    // In session nothing screens a new item against the files that own its topic, so the
    // curator looks: when one speaks about the same thing, Claude reads it and patches it
    // (or says it checked). The end-of-session path has the screen for this.
    if (ownerCheck && !raw.owner_checked && item.kind !== 'skill' && (item.op === 'create' || item.globalFact || item.prefText)) {
      // The statement itself, without the body: a long body would ask for more shared words than any passage has.
      const said = [...new Set([item.title, item.prefText || item.globalFact || item.description].filter(Boolean))].join(' ');
      const owners = findOwners(said, item.projectDir, { exclude: [item.target, item.prefFile], topic: item.kind === 'preference' || item.prefText ? item.topic : '' });
      if (owners.length) {
        results.push({
          status: 'has_owner', title: item.title, owners: owners.map((o) => ({ file: o.file, kind: o.kind, heading: o.heading, excerpt: o.excerpt })),
          reason: `${owners.map((o) => o.file).join(', ')} already ${owners.length > 1 ? 'speak' : 'speaks'} about this; read it and patch it instead, or resubmit with "owner_checked": true if it belongs elsewhere`,
        });
        continue;
      }
    }
    // A patch that rewrites existing text is a correction, whatever the proposer said.
    if (!item.corrects && rewritesText(db, item, settings, payload || {})) item.corrects = true;
    if (item.corrects && item.op === 'patch' && !item.ownUntouched) {
      const t = resolvePatchTarget(db, item, settings, payload || {});
      if (t?.file) item.ownUntouched = ownUntouched(db, t.file);
    }
    if (needsApproval(item, actor, autonomy)) {
      // Dry run first: only proposals that would actually be written are queued
      // (duplicates of saved items, rejections and over-budget answers come back as is).
      const pre = runItem(db, item, settings, payload || {}, actor, { dryRun: true });
      if (pre.status !== 'created' && pre.status !== 'patched') {
        results.push({ title: item.title, ...pre });
        continue;
      }
      if (item.op === 'patch' && !item.description && path.isAbsolute(String(item.target || ''))) {
        // The same global fact already waiting (another session proposed it): keep one.
        const pending = item.globalFact ? pendingChangeset(db, item.target) : null;
        const same = pending && findSimilar(claimsOf(db, pending.id).map((c) => ({ id: c.id, text: String(c.claim || c.summary || '').replace(/^[-*]s+/, '') })), item.globalFact);
        if (same) {
          db.prepare('UPDATE candidates SET confidence = MAX(COALESCE(confidence, 0), ?), session_id = ?, ts = ? WHERE id = ?').run(item.confidence, payload?.session_id || actor, Date.now(), same.id);
          results.push({ status: 'queued', title: item.title, candidateId: same.id, changesetId: pending.id, replaced: true, reason: 'merged with a similar proposal already waiting for approval' });
          continue;
        }
        // A change to an existing file joins that file's pending changeset.
        const q = queueEdit(db, item, payload || {}, actor);
        results.push({
          status: 'queued', title: item.title || path.basename(item.target), candidateId: q.id, changesetId: q.changesetId, recompose: q.recompose || undefined,
          reason: q.recompose ? 'waiting for approval; composed together with the change already waiting for this file' : waitReason(item, actor, autonomy),
        });
        continue;
      }
      const q = enqueue(db, item, payload || {}, actor);
      results.push({
        status: 'queued', title: item.title || item.text, candidateId: q.id, replaced: q.replaced,
        reason: q.replaced ? 'merged with a similar proposal already waiting for approval' : waitReason(item, actor, autonomy),
      });
      continue;
    }
    results.push({ title: item.title, ...runItem(db, item, settings, payload || {}, actor), ...(item.promoted ? { note: `saved as a global fact: project ${item.promoted} already has a similar memory` } : {}) });
  }
  if (results.some((r) => r.status === 'created' || r.status === 'patched')) setMetaOnce(db, 'learning_enabled_at', Date.now());
  return results;
}

// ---------- approval queue and confirmation ----------

export function decideQueued(db, candidateId, approve) {
  const c = db.prepare("SELECT * FROM candidates WHERE id = ? AND outcome = 'queued'").get(candidateId);
  if (!c) return { status: 'not_found', reason: 'no queued proposal with that id' };
  if (c.changeset_id) {
    // Part of a change to a file: approving approves the whole change; rejecting removes
    // this learning, and the rest of the change is composed again without it.
    if (approve) return applyChangeset(db, c.changeset_id, { actor: 'manual' });
    db.prepare("UPDATE candidates SET outcome = 'rejected_by_user', decided_at = ? WHERE id = ?").run(Date.now(), candidateId);
    const left = claimsOf(db, c.changeset_id).length;
    if (!left) rejectChangeset(db, c.changeset_id);
    else db.prepare("UPDATE changesets SET status = 'stale', note = ? WHERE id = ? AND status = 'pending'").run('a learning was removed; composing again', c.changeset_id);
    return { status: 'rejected_by_user', title: c.title, recompose: left > 0 };
  }
  if (!approve) {
    db.prepare("UPDATE candidates SET outcome = 'rejected_by_user', decided_at = ? WHERE id = ?").run(Date.now(), candidateId);
    return { status: 'rejected_by_user', title: c.title };
  }
  const p = JSON.parse(c.payload || '{}');
  const [result] = apply(db, { cwd: p.cwd, memory_dir: p.memory_dir, trigger: p.trigger, session_id: c.session_id, items: [p.item] }, { actor: 'manual' });
  db.prepare('UPDATE candidates SET outcome = ?, learning_id = ?, decided_at = ? WHERE id = ?')
    .run(result.status === 'created' || result.status === 'patched' ? result.status : `approved_${result.status}`, result.id || null, Date.now(), candidateId);
  return result;
}

/**
 * Keep a learning (or stop keeping it): a kept learning is never archived automatically
 * (unused for a long time, or trimmed when a budget is full).
 */
export function pin(db, id, on = true) {
  const r = db.prepare("UPDATE learnings SET pinned = ?, updated_at = ? WHERE id = ? AND status = 'active'").run(on ? 1 : 0, Date.now(), id);
  return r.changes ? { status: on ? 'kept' : 'unkept', id } : { status: 'not_found', id };
}

/** The user vouches for a learning: +0.2 confidence (max 0.9). */
export function confirm(db, id) {
  const r = db.prepare("UPDATE learnings SET confidence = MIN(0.9, COALESCE(confidence, 0.5) + 0.2), updated_at = ? WHERE id = ? AND status = 'active'")
    .run(Date.now(), id);
  return r.changes ? { status: 'confirmed', id } : { status: 'not_found', id };
}

// ---------- undo / forget ----------

/**
 * Undo one ledger batch: the latest write of a learning (`id`), a given `batch`, or the
 * latest write overall (`last`). When the file changed after the write, only the lines
 * that write changed are reverted (if they are still there, unchanged), so later edits by
 * the user or other learnings survive.
 */
export function undo(db, { id, last, batch } = {}) {
  const batchRow = batch
    ? db.prepare('SELECT batch FROM writes WHERE batch = ? AND reverted_at IS NULL LIMIT 1').get(batch)
    : id
      ? db.prepare('SELECT batch FROM writes WHERE learning_id = ? AND reverted_at IS NULL ORDER BY id DESC LIMIT 1').get(id)
      : last ? db.prepare('SELECT batch FROM writes WHERE reverted_at IS NULL ORDER BY id DESC LIMIT 1').get() : null;
  if (!batchRow) return { status: 'nothing', reason: batch ? 'that change was already undone' : id ? `no write to undo for ${id}` : 'nothing to undo' };
  const writes = db.prepare('SELECT * FROM writes WHERE batch = ? ORDER BY id').all(batchRow.batch);

  const plan = [];
  for (const w of writes) {
    const current = readLinkOrFile(w.file);
    if (current === w.after) { plan.push({ file: w.file, content: w.before }); continue; }
    const linkish = [current, w.before, w.after].some((x) => x !== null && String(x).startsWith('@link:'));
    const reverted = current !== null && w.before !== null && w.after !== null && !linkish ? revertChange(current, w.before, w.after) : null;
    if (reverted === null) {
      return { status: 'conflict', file: w.file, reason: 'the lines this write changed were edited since; edit the file by hand or forget the learning instead' };
    }
    plan.push({ file: w.file, content: reverted });
  }
  for (const p of [...plan].reverse()) restore(p.file, p.content);
  const now = Date.now();
  db.prepare('UPDATE writes SET reverted_at = ? WHERE batch = ?').run(now, batchRow.batch);
  db.prepare("UPDATE changesets SET status = 'reverted', decided_at = ? WHERE batch = ?").run(now, batchRow.batch);
  // What the user undid is a signal for later evaluations (past rejections).
  db.prepare(`UPDATE candidates SET outcome = 'undone', decided_at = ? WHERE outcome = 'patched'
    AND changeset_id IN (SELECT id FROM changesets WHERE batch = ?)`).run(now, batchRow.batch);
  const ops = new Set(writes.map((w) => w.op));
  const learningId = writes.find((w) => w.learning_id)?.learning_id;
  if (learningId) {
    const status = ops.has('create') ? 'reverted' : ops.has('archive') ? 'active' : null;
    if (status) db.prepare('UPDATE learnings SET status = ?, updated_at = ? WHERE id = ?').run(status, now, learningId);
  }
  const l = learningId ? db.prepare('SELECT title, kind FROM learnings WHERE id = ?').get(learningId) : null;
  return { status: 'undone', id: learningId, title: l?.title, kind: l?.kind, op: [...ops].join(','), files: writes.map((w) => w.file) };
}

export function findLearnings(db, match) {
  const m = String(match || '').trim();
  if (!m) return [];
  const exact = db.prepare("SELECT * FROM learnings WHERE status = 'active' AND (id = ? OR name = ? OR lower(path) = lower(?))").all(m, m, m);
  if (exact.length) return exact;
  return db.prepare("SELECT * FROM learnings WHERE status = 'active' AND (lower(title) LIKE ? OR lower(name) LIKE ?) ORDER BY updated_at DESC LIMIT 10")
    .all(`%${m.toLowerCase()}%`, `%${m.toLowerCase()}%`);
}

export function forget(db, { match }) {
  const found = findLearnings(db, match);
  if (found.length !== 1) {
    return found.length
      ? { status: 'ambiguous', matches: found.map((l) => ({ id: l.id, kind: l.kind, title: l.title, path: l.path })) }
      : { status: 'not_found', reason: `no active learning matches "${match}"` };
  }
  const l = found[0];
  // A file Ouroboros did not create (a skill, rule or CLAUDE.md it only added to) is the
  // user's: archiving would remove all of it. Its changes are undone one by one instead.
  if (l.kind === 'profile') {
    return { status: 'refused', id: l.id, title: l.title, reason: 'profile facts were retired (global facts now live in ~/.claude/CLAUDE.md); edit that file instead' };
  }
  if (l.origin_session === 'native') {
    return { status: 'refused', id: l.id, title: l.title, reason: `Ouroboros did not create ${l.path}; it only changed it. Undo those changes instead (dashboard: Knowledge, Learned).` };
  }
  const batch = new Batch(db, { actor: 'manual', title: `Archived: ${l.title}` });
  const archiveDir = path.join(ouroborosDir(), 'archive');
  try {
    db.exec('BEGIN IMMEDIATE');
    if (l.kind === 'rules') {
      const content = readOrNull(l.path);
      if (content === null) throw new Error(`file not found: ${l.path}`);
      batch.write(path.join(archiveDir, `${today()}-${path.basename(l.path)}`), content, { learningId: l.id, op: 'archive' });
      batch.write(l.path, null, { learningId: l.id, op: 'archive' });
    } else if (l.kind === 'memory') {
      const content = readOrNull(l.path);
      if (content === null) throw new Error(`file not found: ${l.path}`);
      batch.write(path.join(archiveDir, `${today()}-${path.basename(l.path)}`), content, { learningId: l.id, op: 'archive' });
      batch.write(l.path, null, { learningId: l.id, op: 'archive' });
      const indexFile = path.join(path.dirname(l.path), 'MEMORY.md');
      const idx = readOrNull(indexFile);
      if (idx !== null) batch.write(indexFile, withoutIndexLine(idx, path.basename(l.path)), { learningId: l.id, op: 'archive' });
    } else {
      const dir = path.dirname(l.path);
      const others = safeList(dir).filter((f) => f !== 'SKILL.md');
      if (others.length) throw new Error(`skill folder has other files (${others.join(', ')}); remove it by hand`);
      const content = readOrNull(l.path);
      batch.write(path.join(archiveDir, `${today()}-${path.basename(dir)}-SKILL.md`), content, { learningId: l.id, op: 'archive' });
      batch.write(l.path, null, { learningId: l.id, op: 'archive' });
      const link = db.prepare("SELECT file FROM writes WHERE learning_id = ? AND after LIKE '@link:%' AND reverted_at IS NULL").get(l.id);
      if (link && readLinkOrFile(link.file)) batch.write(link.file, null, { learningId: l.id, op: 'archive' });
    }
    batch.commit();
    db.prepare("UPDATE learnings SET status = 'archived', updated_at = ? WHERE id = ?").run(Date.now(), l.id);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    batch.rollback();
    return { status: 'error', reason: String(err.message) };
  }
  return { status: 'archived', id: l.id, kind: l.kind, title: l.title };
}

// ---------- inventory for the learn skill ----------

export function inventoryText(db, { cwd, memoryDir }) {
  const settings = loadSettings();
  const out = [];
  const globalFile = path.join(claudeDir(), 'CLAUDE.md');
  const globalText = readOrNull(globalFile);
  const headings = String(globalText || '').split(/\r?\n/).filter((l) => /^#{1,6}\s/.test(l));
  out.push(`## Global instructions in ${globalFile} (a fact valid on every project is an addition here, with "section")`);
  out.push(...(globalText === null ? ['(no file yet)'] : headings.length ? headings.map((h) => `- ${h}`) : ['(no sections)']));
  const dir = memoryDirFor({ memoryDir, cwd });
  const mems = listMemoriesIn(dir);
  const index = mems.find((m) => m.index);
  const entries = index ? countIndexEntries(readOrNull(index.file)) : 0;
  out.push('', `## Project memories in ${dir} (${entries}/${settings.limits.memoryIndexLines} index entries)`);
  const list = mems.filter((m) => !m.index);
  out.push(...(list.length ? list.map((m) => `- ${path.basename(m.file)} [${m.type || '?'}${m.origin === 'ouroboros' ? ', learned' : ''}]: ${m.description}`) : ['(none)']));
  const learnedSkills = db.prepare("SELECT COUNT(*) n FROM learnings WHERE kind = 'skill' AND status = 'active' AND origin_session IS NOT 'native'").get().n;
  const route = routeFor(settings, cwd);
  const skills = skillsInScope({ projectDir: cwd }, settings);
  out.push('', `## Skills (${learnedSkills}/${settings.limits.learnedSkills} learned)${route ? ` — project skills route to ${route.skillsDir}` : ''}`);
  out.push(...(skills.length ? skills.map((s) => `- ${s.name}${s.origin === 'ouroboros' ? ' [learned]' : ''}: ${String(s.description).slice(0, 160)}`) : ['(none)']));
  return out.join('\n');
}

export function summarize(results) {
  const icon = { created: '📝 learned', patched: '📝 updated', queued: '⏳ queued', duplicate: '↺ duplicate', has_owner: '↪ has an owner', rejected: '✗ rejected', over_budget: '⚠ over budget', error: '✗ error' };
  return results.map((r) => `${icon[r.status] || r.status}: ${r.title || ''}${r.reason ? ` — ${r.reason}` : ''}${r.warning ? ` (${r.warning})` : ''}${r.path ? ` → ${r.path}` : ''}`).join('\n');
}

// ---------- CLI ----------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { args._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.data) process.env.CLAUDE_PLUGIN_DATA = args.data;
  const db = openDb();
  try {
    const cmd = args._[0];
    if (cmd === 'apply') {
      const raw = args.file ? fs.readFileSync(args.file, 'utf8') : await readStdin();
      let payload;
      try { payload = JSON.parse(raw.replace(/^﻿/, '')); } catch (err) {
        console.log(`✗ invalid JSON: ${err.message}`);
        process.exitCode = 1;
        return;
      }
      // The actor in the payload is Claude's own label. "manual" (the user asked for this
      // in the session) is a request, not a decision: only the inbox and the dashboard,
      // which call `apply` in-process, act as the user.
      const actor = ['inloop', 'background'].includes(payload.actor) ? payload.actor : 'requested';
      const results = apply(db, payload, { actor, autonomy: options().autonomy, ownerCheck: true });
      // What the review noticed but could not settle yet waits for the session's next
      // review; what it settled (saved now, or shown to be a one-off) is closed.
      const sid = /^[\w-]{8,}$/.test(String(payload.session_id || '')) ? payload.session_id : null;
      const closed = closeObservations(db, sid, Array.isArray(payload.resolve) ? payload.resolve : []);
      const opened = addObservations(db, sid, payload.open);
      if (opened || closed) console.log(`◌ left open for the next review: ${opened}${closed ? `; settled: ${closed}` : ''}`);
      // A queued edit that did not fit with the change already waiting for its file sends
      // both back to the editor: start the evaluation queue in the background.
      if (results.some((r) => r.recompose)) {
        const { spawnWorker } = await import('./hook.mjs');
        spawnWorker(['--drain']);
      }
      console.log(summarize(results));
      console.log(JSON.stringify(results.map(({ items, ...r }) => r)));
    } else if (cmd === 'undo') {
      console.log(JSON.stringify(undo(db, { id: args.id, last: args.last || !args.id }), null, 2));
    } else if (cmd === 'forget') {
      console.log(JSON.stringify(forget(db, { match: args.match || args._[1] }), null, 2));
    } else if (cmd === 'inventory') {
      console.log(inventoryText(db, { cwd: args.cwd || process.cwd(), memoryDir: args['memory-dir'] }));
      const state = typeof args.session === 'string' ? sessionStateText(db, args.session, { audience: 'claude' }) : '';
      if (state) console.log(`\n## This session so far\n${state}`);
    } else if (cmd === 'confirm') {
      console.log(JSON.stringify(confirm(db, args.id), null, 2));
    } else if (cmd === 'approve' || cmd === 'reject') {
      console.log(JSON.stringify(decideQueued(db, Number(args.id), cmd === 'approve'), null, 2));
    } else if (cmd === 'enabled-at') {
      console.log(getMeta(db, 'learning_enabled_at') ?? '');
    } else {
      console.log('usage: curator.mjs apply|undo|forget|inventory [options]');
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
