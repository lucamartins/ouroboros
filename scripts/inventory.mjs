// Scans what Claude already knows: native auto-memory files, skills and CLAUDE.md files.
// Used by the reviewer (to spot repeats) and by the dashboard.
import fs from 'node:fs';
import path from 'node:path';
import { claudeDir, memoryDirFor, ouroborosDir, projectKey } from './paths.mjs';

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const data = {};
  if (!m) return { data, body: text };
  let parent = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, indent, key, rawValue] = kv;
    const value = rawValue.replace(/^["']|["']$/g, '');
    if (indent.length === 0) {
      if (value === '') { data[key] = {}; parent = key; } else { data[key] = value; parent = null; }
    } else if (parent && typeof data[parent] === 'object') {
      data[parent][key] = value;
    }
  }
  return { data, body: text.slice(m[0].length) };
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
  const skills = listSkills(cwd ? [cwd] : []);
  if (skills.length) {
    lines.push('Skills:');
    for (const s of skills.slice(0, 80)) lines.push(`- ${s.name}: ${s.description.slice(0, 160)}`);
  }
  return lines.join('\n') || '(nothing saved yet)';
}
