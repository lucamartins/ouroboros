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
 * Build the digest of entries [fromLine, end). Returns `chunks` (the digest, in one or
 * more parts of at most ~maxChars each; `text` is the first), `omitted` (parts dropped
 * past `maxParts`), the number of human turns it covers and the line index where the
 * next review should start.
 */
export function buildDigest(entries, { fromLine = 0, maxChars = 80_000, maxParts = 8 } = {}) {
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

  // Shrink in steps (tool calls first, then long assistant text); what still does not
  // fit is split into parts at user turns, each reviewed on its own, so nothing in the
  // middle of a long session is lost.
  let kept = lines;
  if (render(kept).length > maxChars) kept = kept.filter((l) => l.kind !== 'tool');
  if (render(kept).length > maxChars) kept = kept.map((l) => (l.kind === 'assistant' ? { ...l, text: clip(l.text, 200) } : l));
  const parts = [];
  let cur = [];
  let size = 0;
  for (const l of kept) {
    const len = l.text.length + 1;
    if (cur.length && size + len > maxChars && (l.kind === 'user' || size + len > maxChars * 1.25)) {
      parts.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(l.text.length > maxChars ? { ...l, text: clip(l.text, maxChars - 1) } : l);
    size += len;
  }
  if (cur.length || !parts.length) parts.push(cur);
  let omitted = 0;
  if (parts.length > maxParts) {
    // Beyond the cap, keep the first part and the most recent ones.
    omitted = parts.length - maxParts;
    parts.splice(1, omitted);
  }
  const chunks = parts.map((p) => render(p));
  return { text: chunks[0], chunks, omitted, humanTurns, nextLine: entries.length };
}

/** Number of lines in a transcript (the cursor unit), or null if unreadable. */
export function countLines(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    let n = 0;
    for (const line of text.split('\n')) if (line.trim()) n++;
    return n;
  } catch {
    return null;
  }
}

/** Token usage of the assistant messages from `fromLine` on. */
export function usageSince(entries, fromLine = 0) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: null };
  const seen = new Set();
  for (let i = fromLine; i < entries.length; i++) {
    const e = entries[i];
    if (!e || e.type !== 'assistant' || !e.message?.usage) continue;
    // A message streamed in several entries repeats the same id and usage.
    const id = e.message.id || `line-${i}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const u = e.message.usage;
    total.input += u.input_tokens || 0;
    total.output += u.output_tokens || 0;
    total.cacheRead += u.cache_read_input_tokens || 0;
    total.cacheWrite += u.cache_creation_input_tokens || 0;
    total.model = e.message.model || total.model;
  }
  return total;
}

function render(lines) {
  return lines.map((l) => l.text).join('\n');
}
