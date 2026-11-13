// Small text utilities shared by the validators and the ledger: what an edit adds,
// whether an edit only inserts, and a line diff that can revert one write on top of
// later, unrelated changes to the same file.

/**
 * Whether changing `before` into `after` only adds whole lines: every line of `before`
 * is still there, in order and unchanged (trailing whitespace aside). Text added inside
 * an existing line rewrites that line even when its old words survive in it ("run the
 * tests" to "do not run the tests", or a clause appended to a rule), so it is not an
 * insertion. Meant for whole texts (a file before and after an edit): on a fragment it
 * cannot see that the fragment ends in the middle of a line.
 *
 * Whole new lines can still change what existing text says, through the markdown
 * structure they join; three such cases are not insertions either (`joinsExisting`).
 */
export function isInsertion(before, after) {
  const lines = (s) => {
    const l = String(s ?? '').split('\n').map((x) => x.trimEnd());
    while (l.length && !l[l.length - 1]) l.pop();
    return l;
  };
  const a = lines(before);
  const b = lines(after);
  const kept = new Array(b.length).fill(false);
  let j = 0;
  for (const line of a) {
    while (j < b.length && b[j] !== line) j++;
    if (j >= b.length) return false;
    kept[j] = true;
    j++;
  }
  return !joinsExisting(b, kept);
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const FENCE = /^\s*(?:```|~~~)/;
// Lines that start a block of their own: a list item, a heading, a fence, a table row, a quote, an HTML comment.
const OWN_BLOCK = /^\s*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|```|~~~|\||>|<!--)/;

/**
 * Whether lines added to a text (`kept[i]` false) change what lines it already had say:
 *   - an indented line glued under an existing rule or sentence, with no marker of its
 *     own (a continuation: "- Always deploy from main." + "  except on Fridays, when you
 *     must never deploy" is one item to every reader);
 *   - a line inside an existing fenced code block (a command run as part of those steps);
 *   - a list item added to a list an existing line introduces with a colon ("Never:"),
 *     which says what the new item means.
 * New sections, new items at the end of an ordinary list and sub-items with their own
 * marker remain additions. Other cases are not seen (stated limits, DESIGN §7.6): a
 * word on its own line above a sentence, a heading above an existing list, a new parent
 * item above existing sub-items, an unindented line right under a sentence or item
 * (a new line in a plain-text file; markdown reads it as a lazy continuation, which
 * `appendToSection` avoids by starting a paragraph), an indented continuation after a
 * blank line, a lead-in that does not end in a colon ("Rules to follow").
 */
function joinsExisting(b, kept) {
  const indent = (l) => /^\s*/.exec(l)[0].length;
  // Fenced blocks: one that holds both existing and added lines was changed from inside.
  let open = -1;
  for (let i = 0; i <= b.length; i++) {
    const end = i === b.length;
    if (!end && !FENCE.test(b[i])) continue;
    if (open < 0 && !end) { open = i; continue; }
    if (open >= 0) {
      const block = kept.slice(open, end ? b.length : i + 1);
      if (block.includes(true) && block.includes(false)) return true;
      open = -1;
    }
  }
  for (let i = 0; i < b.length; i++) {
    if (kept[i] || !b[i].trim()) continue;
    if (!OWN_BLOCK.test(b[i])) {
      // An indented continuation: the text block it joins starts at an existing line.
      // (An unindented line under a sentence or item reads as a new line in a plain-text
      // file and stays an addition: a stated limit. The append path does not produce one
      // under a list item: `appendToSection` starts a paragraph of its own there.)
      if (!/^\s/.test(b[i])) continue;
      for (let k = i - 1; k >= 0 && b[k].trim(); k--) {
        if (kept[k] && !/^\s*(?:#{1,6}\s|```|~~~|\||<!--)/.test(b[k])) return true;
        if (OWN_BLOCK.test(b[k])) break;
      }
    } else if (LIST_ITEM.test(b[i])) {
      // The line that introduces this item's list: its parent item, or the line above the list.
      const own = indent(b[i]);
      for (let k = i - 1; k >= 0; k--) {
        const l = b[k];
        if (!l.trim()) continue;
        if (LIST_ITEM.test(l) && indent(l) >= own) continue;
        if (!LIST_ITEM.test(l) && indent(l) > own) continue; // a continuation line of an item above
        // "Never:", "**Never:**", "_Never:_", "`Never:`": the colon may sit inside the emphasis.
        if (kept[k] && !/^\s*#{1,6}\s/.test(l) && l.replace(/[\s*_`]+$/, '').endsWith(':')) return true;
        break;
      }
    }
  }
  return false;
}

/** Lines of `after` that `before` does not have (multiset difference): what a change adds. */
export function addedText(before, after) {
  const count = new Map();
  for (const l of String(before ?? '').split(/\r?\n/)) count.set(l, (count.get(l) || 0) + 1);
  const added = [];
  for (const l of String(after ?? '').split(/\r?\n/)) {
    const c = count.get(l) || 0;
    if (c > 0) count.set(l, c - 1);
    else added.push(l);
  }
  return added.join('\n');
}

/**
 * Line diff of two texts as hunks: { at, before: [lines], after: [lines] } where `at` is
 * the index of the hunk in `a`. Longest-common-subsequence on lines after trimming the
 * common head and tail, which keeps the table small for the edits Ouroboros makes.
 */
export function lineDiff(a, b) {
  const A = String(a ?? '').split('\n');
  const B = String(b ?? '').split('\n');
  let head = 0;
  while (head < A.length && head < B.length && A[head] === B[head]) head++;
  let tail = 0;
  while (tail < A.length - head && tail < B.length - head && A[A.length - 1 - tail] === B[B.length - 1 - tail]) tail++;
  const a2 = A.slice(head, A.length - tail);
  const b2 = B.slice(head, B.length - tail);
  const n = a2.length;
  const m = b2.length;
  if (n * m > 4_000_000) return [{ at: head, before: a2, after: b2 }];
  // lcs[i][j] = LCS length of a2[i..] and b2[j..]
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a2[i] === b2[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const hunks = [];
  let cur = null;
  let i = 0;
  let j = 0;
  const flush = () => { if (cur) { hunks.push(cur); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && a2[i] === b2[j]) { flush(); i++; j++; continue; }
    if (!cur) cur = { at: head + i, before: [], after: [] };
    if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) cur.after.push(b2[j++]);
    else cur.before.push(a2[i++]);
  }
  flush();
  return hunks;
}

/**
 * Word diff of two lines as segments { type: 'same' | 'del' | 'add', text }, so a long
 * line that gains one sentence reads as that sentence instead of the line twice.
 * Words, runs of whitespace and runs of punctuation are separate tokens; a removal comes
 * before the addition that replaces it.
 */
export function wordDiff(a, b) {
  const tok = (s) => String(s ?? '').match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]+/gu) || [];
  const A = tok(a);
  const B = tok(b);
  const n = A.length;
  const m = B.length;
  if (n * m > 1_000_000) return [{ type: 'del', text: A.join('') }, { type: 'add', text: B.join('') }];
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out = [];
  const push = (type, text) => {
    const last = out[out.length - 1];
    if (last?.type === type) last.text += text;
    else out.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { push('same', A[i]); i++; j++; }
    else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) push('del', A[i++]);
    else push('add', B[j++]);
  }
  return out;
}

/** Start indexes where the line sequence `seq` occurs in `lines`. */
function findLines(lines, seq) {
  const hits = [];
  if (!seq.length) return hits;
  for (let i = 0; i + seq.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < seq.length && ok; j++) ok = lines[i + j] === seq[j];
    if (ok) hits.push(i);
  }
  return hits;
}

/**
 * Revert the change `before` → `after` inside `current`, a later version of the file
 * that may hold other changes. Each hunk is located by its `after` lines plus enough
 * surrounding context (from `after`) to be unique in `current`, and swapped back for
 * its `before` lines with the same context. Returns the reverted text, or null when a
 * hunk can no longer be found exactly once (the text it changed was edited since).
 */
export function revertChange(current, before, after) {
  if (current === after) return before;
  const lines = String(after ?? '').split('\n');
  const hunks = lineDiff(before, after);
  // Positions of each hunk in `after`: shift by the size changes of earlier hunks.
  let shift = 0;
  const located = hunks.map((h) => {
    const atAfter = h.at + shift;
    shift += h.after.length - h.before.length;
    return { ...h, atAfter };
  });
  const cur = String(current ?? '').split('\n');
  // Revert from the last hunk so earlier positions stay meaningful.
  for (const h of [...located].reverse()) {
    let done = false;
    for (let ctx = 0; ctx <= 6 && !done; ctx++) {
      const pre = lines.slice(Math.max(0, h.atAfter - ctx), h.atAfter);
      const post = lines.slice(h.atAfter + h.after.length, h.atAfter + h.after.length + ctx);
      const from = [...pre, ...h.after, ...post];
      if (!from.length || !from.some((l) => l.trim())) continue;
      const hits = findLines(cur, from);
      if (hits.length === 1) {
        cur.splice(hits[0], from.length, ...pre, ...h.before, ...post);
        done = true;
      } else if (!hits.length) {
        return null;
      }
    }
    if (!done) return null;
  }
  return cur.join('\n');
}
