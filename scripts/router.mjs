// Where a learning belongs: one order of destinations for every path that saves
// anything (the `learn` skill, the end-of-session reviewer, the screen), and the code
// that backs it: the owners a topic already has, and the home of a preference that is
// valid on every project but only matters for one topic or one kind of file.
import path from 'node:path';
import { buildIndex, ownersMap, tokenize } from './knowledge.mjs';
import { claudeDir } from './paths.mjs';

/**
 * The destinations, most specific first. Injected verbatim into the reviewer and the
 * screen; the `learn` skill carries the same list (test/router.test.mjs keeps them in step).
 */
export const DESTINATIONS = [
  { id: 'owner', text: 'A skill, rule file or CLAUDE.md that already owns the topic: add to it or correct it (a patch). Never a second copy next to an owner.' },
  { id: 'memory', text: 'A fact that only holds in one project: a project memory (kind "memory").' },
  { id: 'preference-paths', text: 'A preference or fact valid on every project that only matters when working on certain files (a language, a file type): kind "preference" with "topic" and "paths" (globs such as "**/*.py"). It loads only with those files.' },
  { id: 'preference-topic', text: 'A preference or fact valid on every project that only matters for one topic (commits, code review, testing, a tool): kind "preference" with "topic". It loads only when the topic comes up.' },
  { id: 'global', text: 'Who the user is or how they work, relevant in EVERY session whatever the task (language of answers, OS and shell, how much to ask before acting): kind "global", an addition to the global CLAUDE.md, which costs context in every session and always waits for the user\'s approval. Use it only when no narrower destination fits.' },
];

export function destinationsText() {
  return DESTINATIONS.map((d, i) => `${i + 1}. ${d.text}`).join('\n');
}

const OWNER_KINDS = ['skill', 'rules', 'instructions'];
const MIN_SHARED_TERMS = 3;

/** Singular form of a word, roughly: enough to see "commits" and "commit" as one topic. */
function stem(t) {
  return t.length > 3 ? t.replace(/(?:ies)$/, 'y').replace(/(?:es|s)$/, '') : t;
}

/**
 * Skills and rule files whose NAME is the topic ("commits" → skill `commit`, "code
 * review" → `code-review`): they own it even when the new item shares no word with
 * what they say today.
 */
function ownersByTopic(topic, cwd, skip) {
  const want = [...new Set(tokenize(String(topic || '').replace(/[-_/]+/g, ' ')).map(stem))];
  if (!want.length) return [];
  return ownersMap(cwd)
    .filter((o) => !skip.has(path.resolve(o.file).toLowerCase()))
    .filter((o) => {
      const name = new Set(tokenize(String(o.name).replace(/[-_/:]+/g, ' ')).map(stem));
      return want.every((t) => name.has(t));
    })
    .map((o) => ({ file: path.resolve(o.file), kind: o.kind, heading: '', excerpt: `${o.name}: ${o.description}`.slice(0, 240), shared: want, byTopic: true }));
}

/**
 * Files Claude already reads that own what `text` says: by topic (the name of a skill
 * or rule file is the item's `topic`), or by content (a passage shares at least half of
 * the item's distinct terms, three at least). The search engine only ranks: its score
 * depends on how much knowledge there is, so it is not a threshold (with three files
 * every score is low, and an owner was never found). Returns [{ file, kind, heading, excerpt, shared }].
 */
export function findOwners(text, cwd, { exclude = [], limit = 3, topic = '' } = {}) {
  const skip = new Set(exclude.filter(Boolean).map((f) => path.resolve(f).toLowerCase()));
  const seen = new Set();
  const out = [];
  for (const o of ownersByTopic(topic, cwd, skip)) {
    if (seen.has(o.file)) continue;
    seen.add(o.file);
    out.push(o);
  }
  const terms = [...new Set(tokenize(text))];
  if (terms.length < MIN_SHARED_TERMS) return out.slice(0, limit);
  const need = Math.max(MIN_SHARED_TERMS, Math.ceil(terms.length * 0.5));
  for (const hit of buildIndex(cwd).search(text, 12, { kinds: OWNER_KINDS })) {
    const file = path.resolve(hit.file);
    if (out.length >= limit || skip.has(file.toLowerCase()) || seen.has(file)) continue;
    const have = new Set(tokenize(`${hit.heading} ${hit.text}`));
    const shared = terms.filter((t) => have.has(t));
    if (shared.length < need) continue;
    seen.add(file);
    out.push({ file, kind: hit.kind, heading: hit.heading || '', excerpt: hit.text.replace(/\s+/g, ' ').trim().slice(0, 240), shared });
  }
  return out.slice(0, limit);
}

export function userRulesDir() {
  return path.join(claudeDir(), 'rules');
}

/** Globs a path-scoped preference loads with: non-empty strings without line breaks, at most 8. */
export function cleanPaths(paths) {
  return (Array.isArray(paths) ? paths : typeof paths === 'string' ? [paths] : [])
    .map((p) => String(p).trim()).filter((p) => p && p.length <= 120 && !/[\r\n"]/.test(p)).slice(0, 8);
}

/**
 * The file a preference lives in: a user rule scoped to `paths` when it has them
 * (loaded only with matching files), else a personal skill for its topic that only the
 * model invokes (loaded only when the topic comes up).
 */
export function preferenceHome(topicSlug, paths) {
  return cleanPaths(paths).length
    ? { home: 'rules', file: path.join(userRulesDir(), `learned-${topicSlug}.md`) }
    : { home: 'skill', name: `learned-prefs-${topicSlug}`, file: path.join(claudeDir(), 'skills', `learned-prefs-${topicSlug}`, 'SKILL.md') };
}
