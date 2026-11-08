// Small text utilities shared by the validators and the ledger: what an edit adds,
// whether an edit only inserts, and a line diff that can revert one write on top of
// later, unrelated changes to the same file.

/**
 * Whether replacing `old` with `next` only inserts text: `old` survives intact inside
 * `next` (trailing whitespace of `old` aside). Anything else rewrites existing text.
 */
export function isInsertion(old, next) {
  const o = String(old ?? '');
  const n = String(next ?? '');
  if (!o) return true;
  return n.includes(o) || (o.trimEnd() !== o && n.includes(o.trimEnd()));
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
