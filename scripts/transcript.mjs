// Reads Claude Code session transcripts (JSONL) and reduces them to a compact digest
// for the reviewer: what the user said, what the assistant said and did, and errors.
import fs from 'node:fs';

export function readTranscript(file) {
  const entries = [];
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      entries.push(null); // keep line numbering stable for the cursor
    }
  }
  return entries;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
}

/** A prompt the human typed (not tool results, skill bodies, notifications or hook output). */
export function isHumanPrompt(e) {
  if (!e || e.type !== 'user' || e.isMeta || e.isSidechain) return false;
  if (e.origin && e.origin.kind && e.origin.kind !== 'human') return false;
  const c = e.message?.content;
  if (Array.isArray(c) && c.some((x) => x?.type === 'tool_result')) return false;
  const t = textOf(c).trim();
  if (!t) return false;
  // Older transcripts without `origin`: drop injected wrappers.
  return !/^<(task-notification|command-name|local-command|system-reminder)/.test(t);
}

function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function describeToolUse(c) {
  const i = c.input || {};
  const arg = i.command || i.file_path || i.pattern || i.skill || i.url || i.query || i.description || i.prompt || '';
  return `${c.name}${arg ? `: ${clip(String(arg), 160)}` : ''}`;
}

/**
 * Build the digest of entries [fromLine, end). Returns the text, the number of human
 * turns it covers and the line index where the next review should start.
 */
export function buildDigest(entries, { fromLine = 0, maxChars = 80_000 } = {}) {
  const lines = [];
  let humanTurns = 0;

  for (let i = fromLine; i < entries.length; i++) {
    const e = entries[i];
    if (!e || e.isSidechain) continue;

    if (isHumanPrompt(e)) {
      humanTurns++;
      lines.push({ kind: 'user', text: `[USER #${humanTurns}] ${clip(textOf(e.message.content), 2000)}` });
      continue;
    }
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c.type === 'text' && c.text?.trim()) lines.push({ kind: 'assistant', text: `[ASSISTANT] ${clip(c.text, 600)}` });
        else if (c.type === 'tool_use') lines.push({ kind: 'tool', text: `[TOOL] ${describeToolUse(c)}` });
      }
      continue;
    }
    if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c?.type === 'tool_result' && c.is_error) {
          const t = typeof c.content === 'string' ? c.content : textOf(c.content);
          lines.push({ kind: 'error', text: `[ERROR] ${clip(t, 300)}` });
        }
      }
    }
  }

  let text = render(lines);
  if (text.length > maxChars) text = render(lines.filter((l) => l.kind !== 'tool'));
  if (text.length > maxChars) {
    text = render(lines.filter((l) => l.kind !== 'tool').map((l) => (l.kind === 'assistant' ? { ...l, text: clip(l.text, 200) } : l)));
  }
  if (text.length > maxChars) {
    const half = Math.floor(maxChars / 2);
    text = `${text.slice(0, half)}\n[… middle of the session omitted …]\n${text.slice(-half)}`;
  }
  return { text, humanTurns, nextLine: entries.length };
}

function render(lines) {
  return lines.map((l) => l.text).join('\n');
}
