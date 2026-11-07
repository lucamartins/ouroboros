// Path resolution shared by hooks, the review worker and the dashboard.
import os from 'node:os';
import path from 'node:path';

export const home = os.homedir();

export function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
}

/** User-level Ouroboros directory (user.md, config.json, archive). */
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

/** Forward slashes, lowercase on Windows, for path matching. */
export function normalize(p) {
  const s = String(p || '').replace(/\\/g, '/');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

const MEMORY_RE = /\/projects\/[^/]+\/memory\/[^/]+\.md$/;
const SKILL_RE = /\/skills\/[^/]+\/skill\.md$/i;
const CLAUDE_MD_RE = /(^|\/)(claude|claude\.local)\.md$/i;

/** Classify a file path touched by a tool: memory, user profile, skill, instructions or null. */
export function classifyPath(filePath) {
  const p = normalize(filePath);
  if (!p) return null;
  if (p.startsWith(normalize(ouroborosDir()) + '/') && p.endsWith('.md')) return 'profile';
  if (MEMORY_RE.test(p)) return 'memory';
  if (SKILL_RE.test(p)) return 'skill';
  if (CLAUDE_MD_RE.test(p)) return 'instructions';
  return null;
}

/** Skill name from a .../skills/<name>/SKILL.md path. */
export function skillNameFromPath(filePath) {
  const m = normalize(filePath).match(/\/skills\/([^/]+)\/skill\.md$/i);
  return m ? m[1] : null;
}
