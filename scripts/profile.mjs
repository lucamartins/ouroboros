// ~/.ouroboros/user.md: the global profile injected into every session.
// Two blocks of bullets; each learned bullet carries its id in an HTML comment.
// The file is the user's too ("edit freely"), so writes are surgical: they touch only
// the bullet lines they change and keep every other line (prose, other sections,
// multi-line bullets) as the user left it.
import fs from 'node:fs';
import path from 'node:path';
import { ouroborosDir } from './paths.mjs';

export const BLOCKS = {
  user: 'User',
  environment: 'Environment & lessons',
};

export function profileFile() {
  return path.join(ouroborosDir(), 'user.md');
}

const ID_RE = /\s*<!--\s*(lrn_[A-Za-z0-9]+)\s*-->\s*$/;
const BULLET_RE = /^[-*]\s+(.*)$/;

/**
 * The file as lines, with each block's section (heading line .. next `## ` heading) and
 * its bullets: { id, text, start, end } where [start, end) are the bullet's lines (a
 * bullet continues on indented lines below it).
 */
function layout(text) {
  const src = String(text || '');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  const sections = {};
  const blocks = { user: [], environment: [] };
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const heading = /^##\s+(.+?)\s*$/.exec(lines[i]);
    if (heading) {
      if (current) sections[current].end = i;
      current = Object.keys(BLOCKS).find((k) => BLOCKS[k].toLowerCase() === heading[1].toLowerCase()) || null;
      if (current && sections[current]) current = null; // a second section with the same title is the user's own
      if (current) sections[current] = { heading: i, end: lines.length };
      continue;
    }
    if (!current) continue;
    const bullet = BULLET_RE.exec(lines[i]);
    if (!bullet) continue;
    let end = i + 1;
    while (end < lines.length && /^\s+\S/.test(lines[end]) && !/^##\s/.test(lines[end])) end++;
    const m = ID_RE.exec(bullet[1]);
    const first = bullet[1].replace(ID_RE, '').trim();
    const more = lines.slice(i + 1, end).map((l) => l.trim());
    blocks[current].push({ id: m ? m[1] : null, text: [first, ...more].join(' ').trim(), start: i, end });
    i = end - 1;
  }
  if (current) sections[current].end = lines.length;
  return { lines, eol, sections, blocks };
}

export function parseProfile(text) {
  return layout(text).blocks;
}

function bulletLine(b) {
  return `- ${String(b.text).replace(/\s+/g, ' ').trim()}${b.id ? ` <!-- ${b.id} -->` : ''}`;
}

/** A new profile file with the given bullets (used when user.md does not exist yet). */
export function renderProfile(blocks) {
  const out = [
    '# Ouroboros profile',
    '',
    '<!-- Injected into every Claude Code session by the Ouroboros plugin. Edit freely; keep one fact per bullet. -->',
  ];
  for (const [key, title] of Object.entries(BLOCKS)) {
    out.push('', `## ${title}`, '');
    for (const b of blocks[key] || []) out.push(bulletLine(b));
  }
  return `${out.join('\n')}\n`;
}

/** Where new bullets of a block go: after its last bullet, or under its heading. */
function insertionPoint(l, block) {
  const s = l.sections[block];
  const items = l.blocks[block];
  if (items.length) return items[items.length - 1].end;
  let at = s.heading + 1;
  if (at < s.end && !l.lines[at].trim()) at++;
  return at;
}

function join(l) {
  return l.lines.join(l.eol);
}

/** The text with a section for `block` (added at the end when missing). */
function withSection(text, block) {
  if (!String(text || '').trim()) return renderProfile({ user: [], environment: [] });
  const l = layout(text);
  if (l.sections[block]) return text;
  const body = String(text).replace(/(\r?\n)*$/, '');
  return `${body}${l.eol}${l.eol}## ${BLOCKS[block]}${l.eol}${l.eol}`;
}

/** Add one bullet ({ id, text }) at the end of a block. */
export function profileWithBullet(text, block, bullet) {
  const l = layout(withSection(text, block));
  const at = insertionPoint(l, block);
  l.lines.splice(at, 0, bulletLine(bullet));
  return join(l);
}

/** Replace the bullet with `id` (or the given parsed bullet) by `bullet`. */
export function profileReplaceBullet(text, target, bullet) {
  const l = layout(text);
  const all = [...l.blocks.user, ...l.blocks.environment];
  const hit = typeof target === 'string' ? all.find((b) => b.id === target) : all.find((b) => b.start === target.start);
  if (!hit) return null;
  l.lines.splice(hit.start, hit.end - hit.start, bulletLine(bullet));
  return join(l);
}

/** Remove the bullet with `id`. */
export function profileWithoutBullet(text, id) {
  const l = layout(text);
  const hit = [...l.blocks.user, ...l.blocks.environment].find((b) => b.id === id);
  if (!hit) return null;
  l.lines.splice(hit.start, hit.end - hit.start);
  return join(l);
}

/**
 * Replace every bullet of a block by `bullets` (consolidation). Lines between bullets
 * that are not bullets (the user's prose) stay where they are; the new bullets take
 * the place of the first old one.
 */
export function profileWithBlock(text, block, bullets) {
  const l = layout(withSection(text, block));
  const items = l.blocks[block];
  const at = items.length ? items[0].start : insertionPoint(l, block);
  for (const b of [...items].reverse()) l.lines.splice(b.start, b.end - b.start);
  l.lines.splice(at, 0, ...bullets.map(bulletLine));
  return join(l);
}

export function blockChars(items) {
  return items.reduce((n, b) => n + b.text.length + 3, 0);
}

export function readProfileText() {
  try {
    return fs.readFileSync(profileFile(), 'utf8');
  } catch {
    return null;
  }
}

/** Compact form for session context: headings and bullets, no ids or comments. */
export function profileForContext(text) {
  const blocks = parseProfile(text);
  const parts = [];
  for (const [key, title] of Object.entries(BLOCKS)) {
    if (!blocks[key].length) continue;
    parts.push(`## ${title}`, ...blocks[key].map((b) => `- ${b.text}`));
  }
  return parts.join('\n');
}
