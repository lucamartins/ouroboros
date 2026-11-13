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
  // The summary Claude Code writes after a compaction is a user entry without `isMeta`
  // or `origin`: model-written text that restates turns already counted and reviewed.
  if (e.isCompactSummary || e.isVisibleInTranscriptOnly) return false;
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

/** The start and the end of a long text: a message that ends with a question keeps it. */
function clipEnds(s, head, tail) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > head + tail + 5 ? `${s.slice(0, head)} […] ${s.slice(-tail)}` : s;
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
 *
 * A tail that starts mid-session (`fromLine` > 0) does not stand on its own: its first
 * user turn often answers something said before the cursor. `contextTurns` prepends the
 * last user turns before the cursor, with the assistant's text between them, marked
 * EARLIER: context only, never counted or learned from by themselves.
 */
export function buildDigest(entries, { fromLine = 0, maxChars = 80_000, maxParts = 8, contextTurns = 0 } = {}) {
  const lines = earlierLines(entries, fromLine, contextTurns);
  const userTurns = [];
  let humanTurns = 0;
  // The assistant text right before a user turn is what that turn answers: it keeps its
  // end (where the question or the proposal usually is), not only its start.
  let lastAssistant = -1;

  for (let i = fromLine; i < entries.length; i++) {
    const e = entries[i];
    if (!e || e.isSidechain) continue;

    if (isHumanPrompt(e)) {
      if (lastAssistant >= 0) lines[lastAssistant] = { ...lines[lastAssistant], asked: true, text: `[ASSISTANT] ${clipEnds(lines[lastAssistant].raw, 250, 700)}` };
      lastAssistant = -1;
      humanTurns++;
      userTurns.push({ n: humanTurns, text: clip(textOf(e.message.content), QUOTE_CHARS), ts: e.timestamp || null });
      lines.push({ kind: 'user', at: i, text: `[USER #${humanTurns}] ${clip(textOf(e.message.content), 2000)}` });
      continue;
    }
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c.type === 'text' && c.text?.trim()) {
          lines.push({ kind: 'assistant', at: i, raw: c.text, text: `[ASSISTANT] ${clip(c.text, 600)}` });
          lastAssistant = lines.length - 1;
        }
        else if (c.type === 'tool_use') lines.push({ kind: 'tool', at: i, text: `[TOOL] ${describeToolUse(c)}` });
      }
      continue;
    }
    if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c?.type === 'tool_result' && c.is_error) {
          const t = typeof c.content === 'string' ? c.content : textOf(c.content);
          lines.push({ kind: 'error', at: i, text: `[ERROR] ${clip(t, 300)}` });
        }
      }
    }
  }

  // Shrink in steps (tool calls first, then long assistant text); what still does not
  // fit is split into parts at user turns, each reviewed on its own, so nothing in the
  // middle of a long session is lost.
  let kept = lines;
  if (render(kept).length > maxChars) kept = kept.filter((l) => l.kind !== 'tool');
  if (render(kept).length > maxChars) kept = kept.map((l) => (l.kind !== 'assistant' ? l : { ...l, text: l.asked ? `[ASSISTANT] ${clipEnds(l.raw, 80, 300)}` : clip(l.text, 200) }));
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
  // `partStarts[k]` is the transcript line part k starts at
  // (where a review that stopped before it resumes), `partTurns[k]` its user turns.
  const partStarts = parts.map((p, k) => (k === 0 ? fromLine : p.find((l) => l.at !== undefined)?.at ?? null));
  for (let k = partStarts.length - 1; k > 0; k--) if (partStarts[k] === null) partStarts[k] = partStarts[k + 1] ?? entries.length;
  const partTurns = parts.map((p) => p.filter((l) => l.kind === 'user').length);
  return { text: chunks[0], chunks, omitted, humanTurns, userTurns, nextLine: entries.length, partStarts, partTurns };
}

const EARLIER_CHARS = 5000;

/** The context lines of a tail: the last `turns` user turns before `fromLine` and what the assistant said between them. */
function earlierLines(entries, fromLine, turns) {
  if (!turns || fromLine <= 0) return [];
  let start = -1;
  let found = 0;
  for (let i = Math.min(fromLine, entries.length) - 1; i >= 0 && found < turns; i--) {
    if (isHumanPrompt(entries[i])) { start = i; found++; }
  }
  if (start < 0) return [];
  let out = [];
  for (let i = start; i < fromLine; i++) {
    const e = entries[i];
    if (!e || e.isSidechain) continue;
    if (isHumanPrompt(e)) out.push({ kind: 'context', text: `[EARLIER USER] ${clip(textOf(e.message.content), 500)}` });
    else if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      const text = e.message.content.filter((c) => c.type === 'text' && c.text?.trim()).map((c) => c.text).join('\n');
      if (text) out.push({ kind: 'context', text: `[EARLIER ASSISTANT] ${clipEnds(text, 200, 600)}` });
    }
  }
  // Several assistant messages in a row: the last one before each user turn is enough.
  out = out.filter((l, i) => !(l.text.startsWith('[EARLIER ASSISTANT]') && out[i + 1]?.text.startsWith('[EARLIER ASSISTANT]')));
  while (out.length > 1 && out.reduce((n, l) => n + l.text.length, 0) > EARLIER_CHARS) out.shift();
  return [
    { kind: 'context', text: '[CONTEXT] The EARLIER lines were reviewed before; they are here only so what follows makes sense. Do not count corrections in them or propose items from them alone.' },
    ...out,
    { kind: 'context', text: '[CONTEXT] The part to review starts here.' },
  ];
}

const QUOTE_CHARS = 500;
const MAX_QUOTES = 4;

/** The user turns an evidence string cites ("USER #3", "USER #12, #13"), in order. */
export function citedTurns(evidence) {
  const s = String(evidence || '');
  if (!/USER\s*#/i.test(s)) return [];
  return [...new Set([...s.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))];
}

/**
 * What the user actually said in the turns an evidence string cites, so whoever decides
 * on a learning reads the user's own words instead of "USER #12".
 */
export function quotesFor(evidence, userTurns) {
  const byN = new Map((userTurns || []).map((t) => [t.n, t]));
  return citedTurns(evidence).map((n) => byN.get(n)).filter(Boolean).slice(0, MAX_QUOTES).map((t) => ({ n: t.n, text: t.text }));
}

/**
 * The user turns of a transcript as a review numbered them, for a review that ran
 * before quotes were stored: it covered the last `turnsReviewed` human turns up to its
 * time (`fromStart`: a backfill that read the session from the start).
 */
export function userTurnsOfReview(entries, { reviewedAt, turnsReviewed, fromStart = false }) {
  const human = entries.filter((e) => isHumanPrompt(e) && (!reviewedAt || !e.timestamp || Date.parse(e.timestamp) <= reviewedAt));
  const offset = fromStart ? 0 : Math.max(0, human.length - (turnsReviewed || 0));
  return human.slice(offset).map((e, i) => ({ n: i + 1, text: clip(textOf(e.message.content), QUOTE_CHARS) }));
}

/**
 * Where the entries a forked session copied from its parent end: the line after the last
 * entry timestamped before the fork started, up to the fork's first own prompt. A fork
 * (`--fork-session`) gets a new id and a transcript that repeats the parent's entries
 * with their uuids and timestamps but the fork's `sessionId`, so the session id cannot
 * tell them apart and the time can. Entries without a timestamp (metadata) do not count.
 * A copied entry may also carry `forkedFrom.sessionId` (the parent's id): the marked
 * entries before the first human prompt that is not marked end the copy too, and need
 * no start time, so they also serve a session Ouroboros never saw start (a backfill
 * passes `startedAt` null). Like the time, the marker can only skip a marked prefix: if
 * the fork's own entries were ever marked too, its first unmarked prompt still stops it.
 */
export function inheritedLines(entries, startedAt) {
  let end = 0;
  let marked = true;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (marked) {
      if (typeof e?.forkedFrom?.sessionId === 'string') end = i + 1;
      else if (isHumanPrompt(e)) marked = false;
    }
    if (!startedAt) {
      if (!marked) break;
      continue;
    }
    const t = e?.timestamp ? Date.parse(e.timestamp) : NaN;
    if (t < startedAt) end = i + 1;
    else if (t >= startedAt && isHumanPrompt(e)) break;
  }
  return end;
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

/**
 * Size of the conversation's context, in tokens, as the last model call of the main
 * conversation saw it (what it read fresh, from the cache and wrote to the cache).
 * An in-session review reads all of it again, at least twice.
 */
export function contextTokens(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    const u = e && e.type === 'assistant' && !e.isSidechain ? e.message?.usage : null;
    if (u) return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  }
  return 0;
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
