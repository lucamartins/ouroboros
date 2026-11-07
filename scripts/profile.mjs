// ~/.ouroboros/user.md: the global profile injected into every session.
// Two blocks of bullets; each learned bullet carries its id in an HTML comment.
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

export function parseProfile(text) {
  const blocks = { user: [], environment: [] };
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = Object.keys(BLOCKS).find((k) => BLOCKS[k].toLowerCase() === heading[1].toLowerCase()) || null;
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (current && bullet) {
      const m = ID_RE.exec(bullet[1]);
      blocks[current].push({ id: m ? m[1] : null, text: bullet[1].replace(ID_RE, '').trim() });
    }
  }
  return blocks;
}

export function renderProfile(blocks) {
  const out = [
    '# Ouroboros profile',
    '',
    '<!-- Injected into every Claude Code session by the Ouroboros plugin. Edit freely; keep one fact per bullet. -->',
  ];
  for (const [key, title] of Object.entries(BLOCKS)) {
    out.push('', `## ${title}`, '');
    for (const b of blocks[key]) out.push(`- ${b.text}${b.id ? ` <!-- ${b.id} -->` : ''}`);
  }
  return `${out.join('\n')}\n`;
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
