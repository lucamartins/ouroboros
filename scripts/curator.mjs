// The only writer of Ouroboros learnings. Deterministic: validates, filters secrets,
// routes, deduplicates, enforces budgets, writes atomically and records every file
// change in the ledger so it can be undone.
//
//   node curator.mjs apply   [--file proposals.json]   (JSON on stdin otherwise)
//   node curator.mjs undo    [--id lrn_x | --last]
//   node curator.mjs forget  --match <id | name | text>
//   node curator.mjs inventory --cwd <dir> [--memory-dir <dir>]
//   (all accept --data <dir>)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { options } from './config.mjs';
import { getMeta, logError, openDb, setMetaOnce } from './db.mjs';
import { listMemories, listSkills, parseFrontmatter } from './inventory.mjs';
import { knowledgeKind, PATCHABLE } from './knowledge.mjs';
import { claudeDir, classifyPath, normalize, ouroborosDir, projectKey } from './paths.mjs';
import { BLOCKS, blockChars, parseProfile, profileFile, renderProfile } from './profile.mjs';
import { ensureSettingsFile, expandHome, loadSettings, routeFor } from './settings.mjs';

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

const DUPLICATE_THRESHOLD = 0.6;

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

function autoMemoryDirectory() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(claudeDir(), 'settings.json'), 'utf8'));
    return s.autoMemoryDirectory ? expandHome(s.autoMemoryDirectory) : null;
  } catch {
    return null;
  }
}

/** The auto-memory directory of the session's project (as Claude Code derives it). */
export function memoryDirFor({ memoryDir, cwd }) {
  if (memoryDir) return path.resolve(expandHome(memoryDir));
  const configured = autoMemoryDirectory();
  if (configured) return configured;
  const root = gitRoot(cwd) || cwd || process.cwd();
  return path.join(claudeDir(), 'projects', projectKey(root), 'memory');
}

// ---------- ledger: transactional file writes ----------

class Batch {
  constructor(db, { actor, sessionId }) {
    this.db = db;
    this.id = crypto.randomBytes(6).toString('hex');
    this.actor = actor;
    this.sessionId = sessionId || null;
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
      INSERT INTO writes (batch, learning_id, ts, op, actor, session_id, file, before, after)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const w of this.writes) stmt.run(this.id, w.learningId ?? null, ts, w.op, this.actor, this.sessionId, w.file, w.before, w.after);
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

function setDescription(text, description) {
  return text.replace(/^(---\r?\n[\s\S]*?^description:).*$/m, `$1 ${yamlStr(description)}`);
}

// ---------- apply ----------

function normalizeItem(raw, payload) {
  const item = { ...raw };
  item.op = item.op === 'patch' ? 'patch' : 'create';
  item.kind = ['memory', 'skill', 'profile'].includes(item.kind) ? item.kind : 'memory';
  item.scope = item.scope === 'global' ? 'global' : 'project';
  item.confidence = Math.min(0.9, Math.max(0.3, Number(item.confidence) || 0.6));
  item.trigger = payload.trigger || 'manual';
  item.projectDir = item.project_dir || payload.cwd || process.cwd();
  // A global fact lives in the profile; user/feedback facts go to the User block.
  if (item.kind === 'memory' && item.scope === 'global') {
    item.kind = 'profile';
    item.block = item.block || (['user', 'feedback'].includes(item.memory_type) ? 'user' : 'environment');
  }
  if (item.kind === 'profile') {
    item.scope = 'global';
    item.block = item.block === 'user' ? 'user' : 'environment';
  }
  return item;
}

function skillsInScope(item, settings) {
  const cwds = [item.projectDir];
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

function createProfile(db, batch, item, settings) {
  const text = String(item.text || item.body || item.title || '').replace(/\s+/g, ' ').trim();
  if (!text) return { status: 'rejected', reason: 'empty profile fact' };
  const file = profileFile();
  const blocks = parseProfile(readOrNull(file) ?? '');
  const dup = findSimilar([...blocks.user, ...blocks.environment].map((b) => ({ ...b, text: b.text })), text);
  if (dup) return { status: 'duplicate', target: dup.id || dup.text, existing: dup.text, reason: 'a similar fact is already in the profile; patch it instead' };
  const limit = item.block === 'user' ? settings.limits.userBlockChars : settings.limits.environmentBlockChars;
  const used = blockChars(blocks[item.block]) + text.length + 3;
  if (used > limit) {
    return {
      status: 'over_budget',
      reason: `profile block "${BLOCKS[item.block]}" would use ${used}/${limit} chars; merge or shorten bullets (patch) or forget one, then retry`,
      items: blocks[item.block],
    };
  }
  const id = newId();
  blocks[item.block].push({ id, text });
  batch.write(file, renderProfile(blocks), { learningId: id, op: 'create' });
  upsertLearning(db, { id, kind: 'profile', scope: 'global', block: item.block, name: slug(text, 40), title: text.slice(0, 120), path: file, confidence: item.confidence, trigger: item.trigger });
  return { status: 'created', id, kind: 'profile', path: file, title: text, warning: budgetWarning(used, limit, settings, `profile block "${BLOCKS[item.block]}"`) };
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

  const all = listMemories().filter((m) => !m.index);
  const existing = all.filter((m) => normalize(path.dirname(m.file)) === normalize(dir));
  if (fs.existsSync(file)) return { status: 'duplicate', target: file, reason: `a memory named "${name}" already exists; patch it instead` };
  const probe = `${name} ${title} ${description}`;
  const dup = findSimilar(existing.map((m) => ({ text: `${m.name} ${m.description}`, file: m.file, name: m.name })), probe);
  if (dup) return { status: 'duplicate', target: dup.file, existing: dup.text, reason: 'a similar memory exists; patch it instead' };

  // The same way-of-working rule in another project is really a global preference:
  // promote it to the profile instead of copying it project by project.
  if (['feedback', 'user'].includes(type)) {
    const elsewhere = findSimilar(all.filter((m) => !existing.includes(m)).map((m) => ({ text: `${m.name} ${m.description}`, file: m.file, project: m.project })), probe);
    if (elsewhere) {
      const promoted = createProfile(db, batch, { ...item, kind: 'profile', block: 'user', text: description }, settings);
      return promoted.status === 'created'
        ? { ...promoted, note: `promoted to the profile: project ${elsewhere.project} already has a similar memory` }
        : promoted;
    }
  }

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
    dir = path.join(gitRoot(item.projectDir) || item.projectDir, '.claude', 'skills', base);
  }
  const file = path.join(dir, 'SKILL.md');
  if (fs.existsSync(file) || (link && fs.existsSync(link))) return { status: 'duplicate', target: file, reason: `a skill named "${base}" already exists; patch it instead` };
  const dup = findSimilar(skillsInScope(item, settings).map((s) => ({ text: `${s.name} ${s.description}`, file: s.file, name: s.name })), `${base} ${title} ${description}`);
  if (dup) return { status: 'duplicate', target: dup.file, existing: dup.name, reason: `skill "${dup.name}" covers this; patch it instead` };

  const id = newId();
  batch.write(file, renderSkill({ name: base, description, title, id, confidence: item.confidence, trigger: item.trigger, body: item.body }), { learningId: id, op: 'create' });
  if (link) batch.write(link, { link: dir }, { learningId: id, op: 'create' });
  upsertLearning(db, { id, kind: 'skill', scope: item.scope, project: item.scope === 'project' ? projectKey(item.projectDir) : null, name: base, title, path: file, confidence: item.confidence, trigger: item.trigger });
  return { status: 'created', id, kind: 'skill', path: file, title, warning: budgetWarning(active + 1, settings.limits.learnedSkills, settings, 'learned skills') };
}

/** Resolve the file a patch targets: learning id, a memory/skill/profile path, or a name. */
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
    if (!PATCHABLE.has(kind)) return { error: 'only memory, skill, profile, rule and CLAUDE.md files can be patched' };
    return { file, kind };
  }
  if (item.kind === 'profile') return { file: profileFile(), kind: 'profile' };
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
  const insert = start < 0 && lines[lines.length - 1] !== '' ? ['', block] : [block];
  lines.splice(end, 0, ...insert);
  return lines.join(eol);
}

function patchItem(db, batch, item, settings, payload) {
  const t = resolvePatchTarget(db, item, settings, payload);
  if (!t) return { status: 'rejected', reason: `patch target not found: ${item.target || '(none)'}` };
  if (t.error) return { status: 'rejected', reason: t.error };
  const before = readOrNull(t.file);
  if (before === null) return { status: 'rejected', reason: `file not found: ${t.file}` };

  if (t.kind === 'profile') {
    const blocks = parseProfile(before);
    const all = [...blocks.user.map((b) => ['user', b]), ...blocks.environment.map((b) => ['environment', b])];
    const hit = all.find(([, b]) => (t.learning && b.id === t.learning.id) || b.id === item.target || (item.old && b.text.includes(item.old)));
    if (!hit) return { status: 'rejected', reason: 'profile bullet not found (give its id or an exact "old" fragment)' };
    const [blockKey, bullet] = hit;
    const nextText = item.old && bullet.text.includes(item.old) ? bullet.text.replace(item.old, item.new ?? '') : String(item.new ?? item.text ?? '').trim();
    if (!nextText) return { status: 'rejected', reason: 'patch would leave an empty bullet; use forget instead' };
    const limit = blockKey === 'user' ? settings.limits.userBlockChars : settings.limits.environmentBlockChars;
    const used = blockChars(blocks[blockKey]) - bullet.text.length + nextText.length;
    if (used > limit) return { status: 'over_budget', reason: `profile block would use ${used}/${limit} chars` };
    const id = bullet.id || newId();
    bullet.text = nextText;
    bullet.id = id;
    batch.write(t.file, renderProfile(blocks), { learningId: id, op: 'patch' });
    upsertLearning(db, { id, kind: 'profile', scope: 'global', block: blockKey, name: slug(nextText, 40), title: nextText.slice(0, 120), path: t.file, confidence: item.confidence, trigger: item.trigger });
    return { status: 'patched', id, kind: 'profile', path: t.file, title: nextText };
  }

  let after = before;
  if (item.append !== undefined) {
    after = appendToSection(before, item.section, item.append);
  } else if (item.old !== undefined) {
    const count = before.split(item.old).length - 1;
    if (count !== 1) return { status: 'rejected', reason: `"old" must appear exactly once in ${t.file} (found ${count})` };
    after = before.replace(item.old, () => item.new ?? '');
  }
  if (item.description) {
    if (t.kind === 'skill' && item.description.length > settings.limits.skillDescriptionChars) {
      return { status: 'rejected', reason: `description has ${item.description.length} chars; the limit is ${settings.limits.skillDescriptionChars}` };
    }
    after = setDescription(after, item.description);
  }
  if (after === before) return { status: 'rejected', reason: 'patch changes nothing (give "old"/"new" or "description")' };
  if (containsSecret(after) && !containsSecret(before)) return { status: 'rejected', reason: 'patch would add something that looks like a secret' };

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
 * Whether an item proposed by Claude or the reviewer must wait for approval.
 * Explicit user requests (actor `manual`) are always written.
 */
export function needsApproval(item, actor, autonomy) {
  if (actor === 'manual') return false;
  // Corrections of existing knowledge, and changes to rule files or CLAUDE.md (written
  // by people, versioned with the project), always wait for the user.
  if (item.corrects) return true;
  if (item.op === 'patch' && item.target && path.isAbsolute(String(item.target)) && ['rules', 'instructions'].includes(knowledgeKind(item.target))) return true;
  if (autonomy === 'auto') return false;
  if (autonomy === 'queue') return true;
  // hybrid: confident facts go in; skills and tentative items wait.
  return item.kind === 'skill' || item.confidence < 0.7;
}

/** Run one normalized item in its own transaction; a dry run undoes files and rows. */
function runItem(db, item, settings, payload, actor, { dryRun = false } = {}) {
  const batch = new Batch(db, { actor, sessionId: payload.session_id });
  try {
    db.exec('BEGIN IMMEDIATE');
    let result;
    if (item.op === 'patch') result = patchItem(db, batch, item, settings, payload);
    else if (item.kind === 'profile') result = createProfile(db, batch, item, settings);
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
 * the newer one (newer sessions know better), keeping the higher confidence.
 */
function enqueue(db, item, payload, actor) {
  const keyText = (i) => [i.title, i.description, i.text].filter(Boolean).join(' ');
  const waiting = db.prepare("SELECT id, payload FROM candidates WHERE outcome = 'queued' AND kind = ?").all(item.kind).map((w) => {
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
      String(item.evidence || '').slice(0, 800), item.confidence,
      JSON.stringify({ item: { ...item, projectDir: undefined, project_dir: item.projectDir }, cwd: payload.cwd, memory_dir: payload.memory_dir, trigger: payload.trigger, actor }),
      payload.cwd || null, payload.session_id || actor, Date.now(), dup.id);
    return { id: dup.id, replaced: true };
  }
  const r = db.prepare(`
    INSERT INTO candidates (review_id, session_id, project, kind, scope, memory_type, title, summary, evidence, confidence, outcome, payload, cwd, ts)
    VALUES (0, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
  `).run(payload.session_id || actor, projectKey(item.projectDir), item.kind, item.scope, item.memory_type ?? null,
    String(item.title || item.text || item.target || '').slice(0, 200), String(item.text || item.body || item.new || item.description || '').slice(0, 1500),
    String(item.evidence || '').slice(0, 800), item.confidence,
    JSON.stringify({ item: { ...item, projectDir: undefined, project_dir: item.projectDir }, cwd: payload.cwd, memory_dir: payload.memory_dir, trigger: payload.trigger, actor }),
    payload.cwd || null, Date.now());
  return { id: Number(r.lastInsertRowid), replaced: false };
}

/** Apply a batch of proposals. Each item succeeds or fails on its own. */
export function apply(db, payload, { actor = 'manual', autonomy = 'auto' } = {}) {
  ensureSettingsFile();
  const settings = loadSettings();
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const results = [];
  for (const raw of items) {
    const item = normalizeItem(raw, payload || {});
    if (containsSecret(item.title, item.description, item.body, item.text, item.new)) {
      results.push({ status: 'rejected', title: item.title, reason: 'looks like it contains a secret (token, key or password); never store secrets' });
      continue;
    }
    if (needsApproval(item, actor, autonomy)) {
      // Dry run first: only proposals that would actually be written are queued
      // (duplicates of saved items, rejections and over-budget answers come back as is).
      const pre = runItem(db, item, settings, payload || {}, actor, { dryRun: true });
      if (pre.status !== 'created' && pre.status !== 'patched') {
        results.push({ title: item.title, ...pre });
        continue;
      }
      const q = enqueue(db, item, payload || {}, actor);
      results.push({
        status: 'queued', title: item.title || item.text, candidateId: q.id, replaced: q.replaced,
        reason: q.replaced ? 'merged with a similar proposal already waiting for approval' : `waiting for approval in the dashboard (autonomy: ${autonomy})`,
      });
      continue;
    }
    results.push({ title: item.title, ...runItem(db, item, settings, payload || {}, actor) });
  }
  if (results.some((r) => r.status === 'created' || r.status === 'patched')) setMetaOnce(db, 'learning_enabled_at', Date.now());
  return results;
}

// ---------- consolidation ----------

/**
 * Replace a profile block with consolidated bullets. Each new bullet lists the ids it
 * merges; it keeps the first id, the other sources are marked archived (merged).
 * One ledger batch, so `undo` restores the previous block.
 */
export function rewriteProfileBlock(db, block, bullets, { actor = 'background' } = {}) {
  const file = profileFile();
  const blocks = parseProfile(readOrNull(file) ?? '');
  const before = blocks[block];
  const known = new Set(before.map((b) => b.id).filter(Boolean));
  const next = [];
  const kept = new Set();
  for (const b of bullets) {
    const text = String(b.text || '').replace(/\s+/g, ' ').trim();
    if (!text || containsSecret(text)) continue;
    const ids = (b.sources || []).filter((id) => known.has(id) && !kept.has(id));
    const id = ids[0] || newId();
    kept.add(id);
    next.push({ id, text });
  }
  if (!next.length) return { status: 'rejected', reason: 'consolidation produced no bullets' };
  const batch = new Batch(db, { actor });
  try {
    db.exec('BEGIN IMMEDIATE');
    blocks[block] = next;
    batch.write(file, renderProfile(blocks), { learningId: next[0].id, op: 'consolidate' });
    batch.commit();
    const now = Date.now();
    for (const b of next) {
      upsertLearning(db, { id: b.id, kind: 'profile', scope: 'global', block, name: slug(b.text, 40), title: b.text.slice(0, 120), path: file, confidence: 0.6, trigger: 'consolidate' });
      db.prepare('UPDATE learnings SET title = ?, updated_at = ? WHERE id = ?').run(b.text.slice(0, 120), now, b.id);
    }
    const merged = [...known].filter((id) => !kept.has(id));
    for (const id of merged) db.prepare("UPDATE learnings SET status = 'archived', updated_at = ? WHERE id = ?").run(now, id);
    db.exec('COMMIT');
    return { status: 'consolidated', before: before.length, after: next.length, merged: merged.length };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    batch.rollback();
    return { status: 'error', reason: String(err.message) };
  }
}

// ---------- approval queue and confirmation ----------

export function decideQueued(db, candidateId, approve) {
  const c = db.prepare("SELECT * FROM candidates WHERE id = ? AND outcome = 'queued'").get(candidateId);
  if (!c) return { status: 'not_found', reason: 'no queued proposal with that id' };
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

/** The user vouches for a learning: +0.2 confidence (max 0.9). */
export function confirm(db, id) {
  const r = db.prepare("UPDATE learnings SET confidence = MIN(0.9, COALESCE(confidence, 0.5) + 0.2), updated_at = ? WHERE id = ? AND status = 'active'")
    .run(Date.now(), id);
  return r.changes ? { status: 'confirmed', id } : { status: 'not_found', id };
}

// ---------- undo / forget ----------

export function undo(db, { id, last } = {}) {
  const batchRow = id
    ? db.prepare('SELECT batch FROM writes WHERE learning_id = ? AND reverted_at IS NULL ORDER BY id DESC LIMIT 1').get(id)
    : last ? db.prepare('SELECT batch FROM writes WHERE reverted_at IS NULL ORDER BY id DESC LIMIT 1').get() : null;
  if (!batchRow) return { status: 'nothing', reason: id ? `no write to undo for ${id}` : 'nothing to undo' };
  const writes = db.prepare('SELECT * FROM writes WHERE batch = ? ORDER BY id').all(batchRow.batch);

  for (const w of writes) {
    const current = readLinkOrFile(w.file);
    if (current !== w.after) {
      return { status: 'conflict', file: w.file, reason: 'the file changed after this write; edit it by hand or forget the learning instead' };
    }
  }
  for (const w of [...writes].reverse()) restore(w.file, w.before);
  const now = Date.now();
  db.prepare('UPDATE writes SET reverted_at = ? WHERE batch = ?').run(now, batchRow.batch);
  const ops = new Set(writes.map((w) => w.op));
  const learningId = writes.find((w) => w.learning_id)?.learning_id;
  if (learningId) {
    if (ops.has('consolidate')) {
      // Bullets merged away come back with the previous block.
      const restored = parseProfile(writes[0].before ?? '');
      for (const b of [...restored.user, ...restored.environment]) {
        if (b.id) db.prepare("UPDATE learnings SET status = 'active', updated_at = ? WHERE id = ?").run(now, b.id);
      }
    }
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
  const batch = new Batch(db, { actor: 'manual' });
  const archiveDir = path.join(ouroborosDir(), 'archive');
  try {
    db.exec('BEGIN IMMEDIATE');
    if (l.kind === 'profile') {
      const before = readOrNull(l.path) ?? '';
      const blocks = parseProfile(before);
      const bullet = [...blocks.user, ...blocks.environment].find((b) => b.id === l.id);
      if (!bullet) throw new Error('bullet not found in user.md');
      for (const k of Object.keys(blocks)) blocks[k] = blocks[k].filter((b) => b.id !== l.id);
      batch.write(path.join(archiveDir, `${today()}-${l.id}.md`), `${bullet.text}\n`, { learningId: l.id, op: 'archive' });
      batch.write(l.path, renderProfile(blocks), { learningId: l.id, op: 'archive' });
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
  const profileText = readOrNull(profileFile());
  const blocks = parseProfile(profileText ?? '');
  for (const [k, title] of Object.entries(BLOCKS)) {
    const limit = k === 'user' ? settings.limits.userBlockChars : settings.limits.environmentBlockChars;
    out.push(`## Profile — ${title} (${blockChars(blocks[k])}/${limit} chars)`);
    out.push(...(blocks[k].length ? blocks[k].map((b) => `- ${b.text}${b.id ? `  [${b.id}]` : ''}`) : ['(empty)']));
  }
  const dir = memoryDirFor({ memoryDir, cwd });
  const mems = listMemories().filter((m) => normalize(path.dirname(m.file)) === normalize(dir));
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
  const icon = { created: '📝 learned', patched: '📝 updated', queued: '⏳ queued', duplicate: '↺ duplicate', rejected: '✗ rejected', over_budget: '⚠ over budget', error: '✗ error' };
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
      const results = apply(db, payload, { actor: payload.actor || 'manual', autonomy: options().autonomy });
      console.log(summarize(results));
      console.log(JSON.stringify(results.map(({ items, ...r }) => r)));
    } else if (cmd === 'undo') {
      console.log(JSON.stringify(undo(db, { id: args.id, last: args.last || !args.id }), null, 2));
    } else if (cmd === 'forget') {
      console.log(JSON.stringify(forget(db, { match: args.match || args._[1] }), null, 2));
    } else if (cmd === 'inventory') {
      console.log(inventoryText(db, { cwd: args.cwd || process.cwd(), memoryDir: args['memory-dir'] }));
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
