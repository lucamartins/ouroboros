// Path resolution shared by hooks, the review worker and the dashboard.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const home = os.homedir();

export function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
}

/** The user's global instructions, loaded by Claude Code in every session. */
export function globalInstructionsFile() {
  return path.join(claudeDir(), 'CLAUDE.md');
}

/**
 * The global CLAUDE.md, created with a title when the user has none (or an empty one):
 * edits to a file are anchored on text it already holds.
 */
export function ensureGlobalInstructions() {
  const file = globalInstructionsFile();
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* missing */ }
  if (text === null || !text.trim()) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# Global instructions\n');
  }
  return file;
}

/** User-level Ouroboros directory (config.json, archive). */
export function ouroborosDir() {
  return process.env.OUROBOROS_HOME || path.join(home, '.ouroboros');
}

/**
 * Plugin state directory. Hooks receive CLAUDE_PLUGIN_DATA; tools started by hand
 * (dashboard, backfill) receive it as --data, and fall back to ~/.ouroboros/data.
 */
export function dataDir(explicit) {
  return explicit || process.env.CLAUDE_PLUGIN_DATA || path.join(ouroborosDir(), 'data');
}

/** Same sanitization Claude Code uses for ~/.claude/projects/<key>. */
export function projectKey(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

/** The nearest directory at or above `dir` with a `.git` entry (a folder, or a worktree's file). */
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

/**
 * The main checkout of the repository `dir` belongs to. A linked worktree has a `.git`
 * file pointing at `<main>/.git/worktrees/<name>`, whose `commondir` leads back to the
 * main `.git`. Claude Code keys auto memory by repository, so every worktree of a repo
 * shares the main checkout's memory directory.
 */
export function repoRoot(dir) {
  const root = gitRoot(dir);
  if (!root) return null;
  const dotGit = path.join(root, '.git');
  try {
    if (!fs.statSync(dotGit).isFile()) return root;
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!m) return root;
    const gitDir = path.resolve(root, m[1].trim());
    let common = gitDir;
    try { common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch { /* not a worktree */ }
    return path.basename(common).toLowerCase() === '.git' ? path.dirname(common) : root;
  } catch {
    return root;
  }
}

function settingsValue(file, key) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8'))[key] ?? null; } catch { return null; }
}

/** `~/x` → home/x; other values unchanged. */
function expandTilde(p) {
  return typeof p === 'string' && /^~(?=$|[\\/])/.test(p) ? path.join(home, p.slice(1)) : p;
}

/**
 * The auto-memory directory Claude Code uses for a working directory: the
 * `autoMemoryDirectory` setting (local, then project, then user settings), else
 * `<config>/projects/<project>/memory` where <project> is the repository's main
 * checkout (shared by its worktrees and subdirectories), `CLAUDE_CODE_PROJECT_DIR_NAME`
 * when set, or the working directory outside git.
 */
export function memoryDirFor({ memoryDir, cwd } = {}) {
  if (memoryDir) return path.resolve(expandTilde(memoryDir));
  const root = repoRoot(cwd) || cwd || process.cwd();
  for (const file of [
    path.join(root, '.claude', 'settings.local.json'),
    path.join(root, '.claude', 'settings.json'),
    path.join(claudeDir(), 'settings.json'),
  ]) {
    const v = settingsValue(file, 'autoMemoryDirectory');
    if (typeof v === 'string' && v.trim()) return path.resolve(expandTilde(v.trim()));
  }
  const name = process.env.CLAUDE_CODE_PROJECT_DIR_NAME || projectKey(root);
  return path.join(claudeDir(), 'projects', name, 'memory');
}

/** Forward slashes, lowercase on Windows, for path matching. */
export function normalize(p) {
  const s = String(p || '').replace(/\\/g, '/');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

const MEMORY_RE = /\/projects\/[^/]+\/memory\/[^/]+\.md$/;
const SKILL_RE = /\/skills\/[^/]+\/skill\.md$/i;
const CLAUDE_MD_RE = /(^|\/)(claude|claude\.local)\.md$/i;

/** Classify a file path touched by a tool: memory, skill, instructions or null. */
export function classifyPath(filePath) {
  const p = normalize(filePath);
  if (!p) return null;
  if (MEMORY_RE.test(p)) return 'memory';
  const custom = settingsValue(path.join(claudeDir(), 'settings.json'), 'autoMemoryDirectory');
  if (typeof custom === 'string' && custom.trim() && p.endsWith('.md') && p.startsWith(`${normalize(path.resolve(expandTilde(custom.trim())))}/`)) return 'memory';
  if (SKILL_RE.test(p)) return 'skill';
  if (CLAUDE_MD_RE.test(p)) return 'instructions';
  return null;
}

/** Skill name from a .../skills/<name>/SKILL.md path. */
export function skillNameFromPath(filePath) {
  const m = normalize(filePath).match(/\/skills\/([^/]+)\/skill\.md$/i);
  return m ? m[1] : null;
}
