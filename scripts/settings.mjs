// User-level settings in ~/.ouroboros/config.json: routing and limits.
import fs from 'node:fs';
import path from 'node:path';
import { home, normalize, ouroborosDir } from './paths.mjs';

export const DEFAULT_SETTINGS = {
  routing: [],
  limits: {
    memoryIndexLines: 150,
    learnedSkills: 30,
    skillDescriptionChars: 250,
    consolidateAt: 0.8,
  },
  archiveAfterDaysUnused: 60,
  excludeProjects: [],
  // Projects (globs) where Ouroboros only measures: the control group of the correction rate.
  controlProjects: [],
};

export function settingsFile() {
  return path.join(ouroborosDir(), 'config.json');
}

export function loadSettings() {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    // missing or invalid: defaults
  }
  return {
    ...DEFAULT_SETTINGS,
    ...user,
    limits: { ...DEFAULT_SETTINGS.limits, ...(user.limits || {}) },
    routing: Array.isArray(user.routing) ? user.routing : [],
  };
}

/** Write the defaults once so users can discover and edit them. */
export function ensureSettingsFile() {
  if (fs.existsSync(settingsFile())) return;
  fs.mkdirSync(ouroborosDir(), { recursive: true });
  fs.writeFileSync(settingsFile(), `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`);
}

export function expandHome(p) {
  return typeof p === 'string' && /^~(?=$|[\\/])/.test(p) ? path.join(home, p.slice(1)) : p;
}

/** Minimal glob: `**` any path, `*` within a segment. Case-insensitive on Windows. */
export function globMatch(pattern, target) {
  const p = normalize(expandHome(pattern));
  const t = normalize(target).replace(/\/+$/, '');
  const re = p
    .replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${re}$`).test(t);
}

/** Routing rule for a project directory, if any. */
export function routeFor(settings, projectDir) {
  if (!projectDir) return null;
  return settings.routing.find((r) => r && r.match && r.skillsDir && globMatch(r.match, projectDir)) || null;
}
