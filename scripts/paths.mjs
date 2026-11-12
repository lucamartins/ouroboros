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

/** What a global CLAUDE.md that does not exist yet (or is empty) reads as: edits anchor on text. */
export const GLOBAL_INSTRUCTIONS_SEED = '# Global instructions\n';

/**
 * The text of a knowledge file, or null when it does not exist. One file is read
 * differently: the user's global CLAUDE.md, when missing or empty, reads as its title.
 * A fact valid on every project is proposed as an addition to that file, and a proposal
 * must not create it: until v0.23 the file was written, outside the ledger, as soon as
 * such a fact was proposed (even by a dry run). Now a change is composed against the
 * title and the file comes into being when the user approves, through the ledger (its
 * "before" is "no file", so undo removes it).
 */
export function readKnowledgeFile(file) {
  const isGlobal = path.resolve(String(file)).toLowerCase() === path.resolve(globalInstructionsFile()).toLowerCase();
  try {
    const text = fs.readFileSync(file, 'utf8');
    return isGlobal && !text.trim() ? GLOBAL_INSTRUCTIONS_SEED : text;
  } catch {
    return isGlobal ? GLOBAL_INSTRUCTIONS_SEED : null;
  }
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

/**
 * The key of the project a directory belongs to: its repository's main checkout (so
 * worktrees and subfolders are one project, as for auto memory and the dashboard) or,
 * outside git, the directory itself. Sessions, proposals, changes and notices are all
 * keyed with this, so a notice from a session in a worktree reaches the next session
 * anywhere in that repository.
 */
export function projectIdFor(dir) {
  // The folder as given when it is not in a repository: the same input `memoryDirFor` keys.
  return projectKey(dir ? repoRoot(dir) || dir : '');
}

/**
 * The same directory in the repository's main checkout. A linked worktree is a
 * temporary copy: knowledge read from it or written into it (a project skill, a change
 * to its CLAUDE.md) would be lost with it, so the main checkout stands in for it.
 */
export function stableDir(dir) {
  if (!dir) return dir;
  const here = path.resolve(dir);
  const root = gitRoot(here);
  const main = repoRoot(here);
  if (!root || !main || path.resolve(root) === path.resolve(main)) return here;
  const mapped = path.join(main, path.relative(root, here));
  return fs.existsSync(mapped) ? mapped : main;
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
 * `<config, or CLAUDE_CODE_REMOTE_MEMORY_DIR when set>/projects/<project>/memory` where <project> is the repository's main
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
  // Cloud sessions: Claude Code keeps auto memory under that directory instead of the config dir.
  const base = process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR || claudeDir();
  return path.join(base, 'projects', name, 'memory');
}

const TRUTHY = ['1', 'true', 'yes', 'on'];
const FALSY = ['0', 'false', 'no', 'off'];

/**
 * Whether Claude Code loads auto memory (MEMORY.md and the files it points to) in a
 * session in `cwd`, and if not, why. The same order as Claude Code 2.1: the
 * `CLAUDE_CODE_DISABLE_AUTO_MEMORY` variable decides when set (a falsy value forces it
 * on); then `--bare` (`CLAUDE_CODE_SIMPLE`) and cloud sessions without a memory
 * directory (`CLAUDE_CODE_REMOTE`) turn it off; then the `autoMemoryEnabled` setting
 * (local, then project, then user settings). Hook processes inherit the session's
 * environment, so a hook sees what the session sees. Managed policy settings are not read.
 */
export function autoMemoryStatus(cwd, env = process.env) {
  const flag = String(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? '').trim().toLowerCase();
  if (TRUTHY.includes(flag)) return { on: false, reason: 'CLAUDE_CODE_DISABLE_AUTO_MEMORY is set' };
  if (FALSY.includes(flag)) return { on: true, reason: null };
  if (env.CLAUDE_CODE_SIMPLE) return { on: false, reason: 'the session runs with --bare' };
  if (env.CLAUDE_CODE_SAFE_MODE) return { on: false, reason: 'the session runs in safe mode' };
  if (env.CLAUDE_CODE_REMOTE && !env.CLAUDE_CODE_REMOTE_MEMORY_DIR && !env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE) {
    return { on: false, reason: 'a cloud session: CLAUDE_CODE_REMOTE is set without CLAUDE_CODE_REMOTE_MEMORY_DIR' };
  }
  const root = repoRoot(cwd) || cwd || process.cwd();
  for (const file of [
    path.join(root, '.claude', 'settings.local.json'),
    path.join(root, '.claude', 'settings.json'),
    path.join(claudeDir(), 'settings.json'),
  ]) {
    const v = settingsValue(file, 'autoMemoryEnabled');
    if (typeof v === 'boolean') return v ? { on: true, reason: null } : { on: false, reason: `autoMemoryEnabled is false in ${file}` };
  }
  return { on: true, reason: null };
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
