// Ouroboros dashboard. Build-free; data comes from the local API.
// Untrusted text (paths, quotes, descriptions, diffs) is always set via text nodes.
//
// Pages, one question each:
//   Inbox      what waits for your decision (conflicts, changes to files, new items, fixes)
//   Overview   is learning working? (corrections before/after, use, misses, cost)
//   Knowledge  what Claude knows (learned items, skills, memories, instruction files)
//   Activity   what happened (sessions, reviews, proposals, dropped, corrections)
//   System     health and cost (capture, reviewer, quality, budgets, problems)

const view = document.getElementById('view');
const tooltip = document.getElementById('tooltip');
const rangeSelect = document.getElementById('range');
const rangeWrap = document.getElementById('range-wrap');
const state = {
  tab: null,
  days: 30,
  counts: null,
  knowledge: { seg: 'learned', q: '' },
  activity: { seg: 'sessions', kind: 'all', outcome: 'all' },
};

// ---------- DOM helpers ----------
const SVG_NS = 'http://www.w3.org/2000/svg';

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM: allowed under the page's CSP
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, v);
  for (const c of children.flat()) if (c) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

// One stroke icon set, 16px grid, drawn here (no glyphs or emoji).
const ICONS = {
  inbox: 'M2 9.5h3.2l1 2h3.6l1-2H14 M3.6 3h8.8L14 9.5V13H2V9.5z',
  check: 'M3.5 8.5l3 3 6-7',
  x: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  undo: 'M6 3.5L3 6.5l3 3 M3 6.5h6.5a3.5 3.5 0 0 1 0 7H8',
  archive: 'M2.5 3.5h11v3h-11z M3.5 6.5v6h9v-6 M6.5 9h3',
  alert: 'M8 2.5l6 10.5H2z M8 6.5v3 M8 11.4v.1',
  info: 'M8 1.8a6.2 6.2 0 1 0 0 12.4a6.2 6.2 0 1 0 0-12.4z M8 7.2v3.8 M8 5v.1',
  sun: 'M8 5.3a2.7 2.7 0 1 0 0 5.4a2.7 2.7 0 1 0 0-5.4z M8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1',
  moon: 'M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z',
  refresh: 'M13 2.5v3.5H9.5 M12.6 6A5.2 5.2 0 1 0 13.2 9',
  wrench: 'M10.4 2.6a3 3 0 0 0-3.6 3.9L2.6 10.7l2.7 2.7 4.2-4.2a3 3 0 0 0 3.9-3.6l-1.9 1.9-1.8-.5-.5-1.8z',
  arrow: 'M3 8h10 M9 4l4 4-4 4',
  file: 'M4 1.8h5l3 3v9.4H4z M9 1.8v3h3',
};
function icon(name) {
  return s('svg', { class: 'i', viewBox: '0 0 16 16', 'aria-hidden': 'true' }, s('path', { d: ICONS[name] }));
}

const fmt = {
  int: (n) => (n ?? 0).toLocaleString('en-US'),
  compact: (n) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n ?? 0),
  usd: (n) => (n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : n > 0 ? `$${n.toFixed(4)}` : '$0'),
  pct: (n) => `${Math.round(n)}%`,
  rate: (n) => (n === null || n === undefined ? '—' : n.toFixed(1)),
  date: (ts) => (ts ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'),
  datetime: (ts) => (ts ? new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'),
  ago(ts) {
    if (!ts) return 'never';
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const hr = Math.round(m / 60);
    if (hr < 36) return `${hr} h ago`;
    return `${Math.round(hr / 24)} days ago`;
  },
  day: (key) => new Date(`${key}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  plural: (n, one, many = `${one}s`) => `${fmt.int(n)} ${n === 1 ? one : many}`,
};

function projectName(p, cwd) {
  if (cwd) return String(cwd).split(/[\\/]/).filter(Boolean).pop() || cwd;
  if (!p) return '—';
  // Claude Code project keys look like "C--Users-me-source-repos-app".
  return String(p).split('-').filter(Boolean).pop() || p;
}

/** "…/nisus-staging/SKILL.md" → { dir: "skills/nisus-staging/", name: "SKILL.md" }. */
function fileLabel(file) {
  const parts = String(file || '').split(/[\\/]/).filter(Boolean);
  const name = parts.pop() || file;
  return { dir: parts.slice(-2).join('/') + (parts.length ? '/' : ''), name };
}

const KIND_NAME = { skill: 'skill', rules: 'rule file', instructions: 'CLAUDE.md', memory: 'memory', profile: 'profile' };

/** Notes start with "adds to <path>: …" or "✎ corrects <path>: …"; keep the reason. */
function reasonOf(note) {
  return String(note || '')
    .replace(/^✎\s*/, '')
    .replace(/^(adds to|corrects|for)\s.+?\.md(\s›\s[^:]+)?:\s*/i, '')
    .replace(/^conflict(\s+with\s+#\d+)?:\s*/i, '')
    .replace(/^fix in the project(\s*\[[^\]]*\])?:\s*/i, '');
}

async function api(name, params = {}) {
  const q = new URLSearchParams(params).toString();
  const res = await fetch(`/api/${name}${q ? `?${q}` : ''}`);
  if (!res.ok) {
    let message = `${name}: HTTP ${res.status}`;
    try { message = (await res.json()).message || message; } catch { /* not JSON */ }
    throw new Error(message);
  }
  return res.json();
}

function showTip(target, ...lines) {
  tooltip.replaceChildren(...lines);
  tooltip.hidden = false;
  const r = target.getBoundingClientRect();
  const t = tooltip.getBoundingClientRect();
  let x = r.left + r.width / 2 - t.width / 2;
  x = Math.max(8, Math.min(x, window.innerWidth - t.width - 8));
  let y = r.top - t.height - 8;
  if (y < 64) y = r.bottom + 8;
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}
function hideTip() { tooltip.hidden = true; }

function table(columns, rows, { empty = 'Nothing yet.', note } = {}) {
  if (!rows.length) return h('div', { class: 'empty' }, h('p', {}, empty));
  return h('div', {},
    h('div', { class: 'table-wrap' },
      h('table', {},
        h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.num ? 'num' : c.cls || null, scope: 'col' }, c.label)))),
        h('tbody', {}, rows.map((r) => h('tr', {}, columns.map((c) => h('td', { class: c.num ? 'num' : c.cls || null }, c.render ? c.render(r) : r[c.key]))))))),
    note ? h('div', { class: 'table-note' }, note) : null);
}

function cellMain(primary, secondary, { clamp = false } = {}) {
  return h('div', {}, h('div', { class: 'primary' }, primary), secondary ? h('div', { class: `secondary${clamp ? ' clamp2' : ''}` }, secondary) : null);
}

/** Budget meter: warning at 80%, critical at 100%. `plain` for values that aren't budgets. */
function meter(value, limit, { plain = false, label } = {}) {
  const ratio = limit ? value / limit : 0;
  const cls = plain ? 'meter' : ratio >= 1 ? 'meter over' : ratio >= 0.8 ? 'meter warn' : 'meter';
  return h('div', { class: cls, role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': limit, 'aria-valuenow': value },
    h('span', { style: `width:${Math.min(100, ratio * 100).toFixed(1)}%` }));
}

function confidence(c) {
  return h('span', { class: 'conf', title: 'Confidence' }, meter(c || 0, 1, { plain: true, label: 'Confidence' }), fmt.pct((c || 0) * 100));
}

function pill(text, tone = '', dot = null) {
  return h('span', { class: `pill ${tone}` }, dot ? h('span', { class: `dot ${dot}` }) : null, text);
}

function emptyState(title, text, iconName = 'check') {
  return h('div', { class: 'empty' }, icon(iconName), h('h2', {}, title), text ? h('p', {}, text) : null);
}

/** Long text, clamped to a few lines with a toggle when it overflows. */
function clampText(text, tag = 'p') {
  const el = h(tag, { class: 'clamp' }, text);
  const more = h('button', { class: 'more', type: 'button', hidden: true }, 'Show more');
  more.addEventListener('click', () => {
    const open = el.classList.toggle('open');
    more.textContent = open ? 'Show less' : 'Show more';
  });
  requestAnimationFrame(() => { if (el.scrollHeight > el.clientHeight + 2) more.hidden = false; });
  return h('div', {}, el, more);
}

function disclose(label, ...content) {
  return h('details', { class: 'disclose' }, h('summary', {}, label), ...content);
}

// ---------- write actions ----------
let actionToken = null;

async function act(action, id) {
  if (!actionToken) actionToken = (await api('token')).token;
  const res = await fetch('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ouroboros-Token': actionToken },
    body: JSON.stringify({ action, id }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
  return body;
}

const toastEl = document.getElementById('toast');
function toast(text, bad = false) {
  toastEl.textContent = text;
  toastEl.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => { toastEl.className = 'toast'; }, 4500);
}

const why = (r) => `${r.status.replace(/_/g, ' ')}${r.reason ? `: ${r.reason}` : ''}`;
const ACTION_LABEL = {
  undo: (r) => (r.status === 'undone' ? `Undone: ${r.title || r.id}` : why(r)),
  undo_change: (r) => (r.status === 'undone' ? `Change undone: ${r.title || ''}` : why(r)),
  undo_batch: (r) => (r.status === 'undone' ? `Undone: ${r.title || 'the change'}` : why(r)),
  pin: (r) => (r.status === 'kept' ? 'Kept: it will not be archived automatically' : r.status === 'unkept' ? 'Maintenance may archive it if it goes unused' : why(r)),
  forget: (r) => (r.status === 'archived' ? `Archived: ${r.title}` : why(r)),
  confirm: (r) => (r.status === 'confirmed' ? 'Confidence raised' : why(r)),
  approve: (r) => (r.status === 'created' || r.status === 'patched' ? `Saved: ${r.title}${r.rebased ? ' (applied on top of the newer file)' : ''}` : why(r)),
  reject: (r) => (r.status === 'rejected_by_user' ? (r.recompose ? 'Removed; the rest of the change was composed again' : 'Rejected') : why(r)),
  triage_queue: (r) => (r.status !== 'done' ? why(r) : `Checked ${fmt.int(r.total)}${r.recomposed ? ` and recomposed ${r.recomposed}` : ''}: ${r.kept} new, ${r.routed} to files, ${r.dropped} dropped, ${r.merged} merged, ${r.suggested} fixes (${fmt.usd(r.cost)})`),
  dismiss: () => 'Dismissed',
  resolve_conflict: (r) => (r.status === 'composed' ? `Composed as a change to approve: ${r.title}` : r.status === 'rejected_by_user' ? 'The current rule stands' : why(r)),
  restore: () => 'Back in the inbox',
  approve_many: (r) => `Saved ${r.saved} of ${r.total}${r.other ? ` (${r.other} skipped: duplicate, stale or over budget)` : ''}`,
  reject_many: (r) => `Rejected ${r.rejected}`,
};
const BAD = ['conflict', 'error', 'not_found', 'nothing', 'ambiguous', 'stale', 'rejected', 'over_budget'];

/** A button that runs an action; `confirmText` asks for a second click first. */
function actionButton(label, action, id, { confirmText, title, variant = '', iconName, small = false, busyText } = {}) {
  const btn = h('button', { class: `btn ${variant}${small ? ' small' : ''}`, type: 'button', title });
  const paint = (text) => btn.replaceChildren(...(iconName ? [icon(iconName)] : []), text);
  paint(label);
  let armed = false;
  btn.addEventListener('click', async () => {
    if (confirmText && !armed) {
      armed = true;
      paint(confirmText);
      btn.classList.add('armed');
      setTimeout(() => { armed = false; paint(label); btn.classList.remove('armed'); }, 3500);
      return;
    }
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    if (busyText) paint(busyText);
    try {
      const r = await act(action, id);
      toast(ACTION_LABEL[action](r), BAD.includes(r.status));
      await render();
    } catch (err) {
      toast(String(err.message), true);
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      paint(label);
    }
  });
  return btn;
}

function pageHead(title, text, ...right) {
  return h('div', { class: 'page-head' },
    h('div', {}, h('h1', {}, title), text ? h('p', {}, text) : null),
    right.length ? h('div', { class: 'btn-row' }, ...right) : null);
}

function sectionHead(title, text, ...right) {
  return h('div', { class: 'section-head' },
    h('div', {}, h('h2', {}, title), text ? h('p', {}, text) : null),
    right.length ? h('div', { class: 'btn-row' }, ...right) : null);
}

function segmented(options, current, onPick) {
  return h('div', { class: 'segmented', role: 'group' }, options.map(([value, label, n]) =>
    h('button', { type: 'button', 'aria-pressed': String(current === value), onclick: () => onPick(value) },
      label, n !== undefined ? h('span', { class: 'n' }, fmt.int(n)) : null)));
}

// ---------- bar chart ----------
// Single series, vertical bars, 4px rounded data end, recessive grid, per-bar tooltip
// (hover and keyboard focus) and a table view so no value is hover-only.
function barChart({ title, sub, data, value, format, tip, emptyText = 'No data in this period', marker = null, height = 170, wide = false }) {
  const holder = h('div');
  const wrap = h('div', { class: `panel chart${wide ? ' wide' : ''}` },
    h('div', { class: 'chart-head' }, h('h3', {}, title), sub ? h('span', { class: 'sub' }, sub) : null), holder);

  const draw = () => {
    const width = Math.max(240, holder.clientWidth || 600);
    const pad = { top: 8, right: 4, bottom: 22, left: 36 };
    const values = data.map(value);
    const max = Math.max(0, ...values.filter((v) => v !== null));
    const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': title });
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    if (!max) {
      svg.append(s('line', { x1: pad.left, x2: width - pad.right, y1: pad.top + innerH, y2: pad.top + innerH, stroke: 'var(--grid)' }),
        s('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'empty-text' }, emptyText));
      holder.replaceChildren(svg);
      return;
    }
    const nice = niceMax(max);
    const integers = values.every((v) => v === null || Number.isInteger(v));
    const ticks = integers && nice <= 2 ? [0, nice] : [0, nice / 2, nice];
    const grid = s('g', { class: 'grid' });
    const axis = s('g', { class: 'axis' });
    for (const t of ticks) {
      const y = pad.top + innerH - (t / nice) * innerH;
      grid.append(s('line', { x1: pad.left, x2: width - pad.right, y1: y, y2: y }));
      axis.append(s('text', { x: pad.left - 6, y: y + 4, 'text-anchor': 'end' }, format(t)));
    }
    svg.append(grid, axis);
    const step = innerW / data.length;
    const gap = Math.min(2, step * 0.2);
    const bw = Math.max(1, Math.min(24, step - gap));
    const labelEvery = Math.ceil(data.length / Math.max(2, Math.floor(innerW / 64)));
    data.forEach((d, i) => {
      const v = values[i];
      const cx = pad.left + step * i + step / 2;
      if (i % labelEvery === 0) axis.append(s('text', { x: cx, y: height - 6, 'text-anchor': 'middle' }, fmt.day(d.day)));
      if (v === null) return;
      const bh = (v / nice) * innerH;
      const x = cx - bw / 2;
      const y0 = pad.top + innerH;
      const r = Math.min(4, bw / 2, bh);
      const bar = s('path', {
        class: 'bar', tabindex: 0,
        d: bh <= 0 ? '' : `M${x},${y0} V${y0 - bh + r} Q${x},${y0 - bh} ${x + r},${y0 - bh} H${x + bw - r} Q${x + bw},${y0 - bh} ${x + bw},${y0 - bh + r} V${y0} Z`,
      });
      const hit = s('rect', { class: 'hit', x: pad.left + step * i, y: pad.top, width: step, height: innerH });
      const show = () => showTip(bar, h('strong', {}, format(v)), ...tip(d).map((t) => h('div', { class: 'muted' }, t)));
      for (const el of [bar, hit]) {
        el.addEventListener('pointerenter', show);
        el.addEventListener('pointerleave', hideTip);
      }
      bar.addEventListener('focus', show);
      bar.addEventListener('blur', hideTip);
      svg.append(hit, bar);
    });
    const mi = marker ? data.findIndex((d) => d.day === marker.day) : -1;
    if (mi >= 0) {
      const mx = pad.left + step * mi;
      svg.append(
        s('line', { class: 'marker', x1: mx, x2: mx, y1: pad.top, y2: pad.top + innerH }),
        // Near the right edge the label sits to the left of the rule.
        mx > width - 90
          ? s('text', { class: 'marker-label', x: mx - 4, y: pad.top + 10, 'text-anchor': 'end' }, marker.label)
          : s('text', { class: 'marker-label', x: mx + 4, y: pad.top + 10 }, marker.label));
    }
    holder.replaceChildren(svg);
  };
  requestAnimationFrame(draw);
  new ResizeObserver(() => draw()).observe(holder);
  wrap.append(h('details', { class: 'table-view' }, h('summary', {}, 'Show as table'),
    table([{ label: 'Day', render: (d) => fmt.day(d.day) }, { label: title, num: true, render: (d) => (value(d) === null ? '—' : format(value(d))) }],
      data.filter((d) => value(d) !== null && value(d) !== 0))));
  return wrap;
}

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function dayOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- diffs ----------
/** Word-level diff of two texts: [{ op: '=', '-' or '+', text }]. */
function wordDiff(a, b) {
  const A = a.split(/(\s+)/);
  const B = b.split(/(\s+)/);
  if (A.length * B.length > 250_000) return [{ op: '-', text: a }, { op: '+', text: b }];
  const L = Array.from({ length: A.length + 1 }, () => new Uint16Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  const push = (op, text) => (out.length && out[out.length - 1].op === op ? (out[out.length - 1].text += text) : out.push({ op, text }));
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { push('=', A[i]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) { push('-', A[i++]); } else { push('+', B[j++]); }
  }
  while (i < A.length) push('-', A[i++]);
  while (j < B.length) push('+', B[j++]);
  return out;
}

/** One edit: unchanged context faint (trimmed), removed struck through, added highlighted. */
function editDiff(e) {
  if (e.append !== undefined) {
    return h('pre', { class: 'diff' }, h('span', { class: 'diff-label' }, `Added under "${e.section || 'end of file'}"`), h('ins', {}, e.append));
  }
  const parts = wordDiff(e.old || '', e.new || '');
  const trim = (t, end) => (t.length > 140 ? (end ? `…${t.slice(-140)}` : `${t.slice(0, 140)}…`) : t);
  return h('pre', { class: 'diff', 'aria-label': 'Proposed edit' }, parts.map((p, k) => (p.op === '+' ? h('ins', {}, p.text)
    : p.op === '-' ? h('del', {}, p.text)
      : h('span', { class: 'ctx' }, k === 0 ? trim(p.text, true) : k === parts.length - 1 ? trim(p.text, false) : p.text))));
}

// ---------- Inbox ----------
function conflictCard(c) {
  const target = c.target ? fileLabel(c.target) : null;
  return h('article', { class: 'item attention' },
    h('h3', { class: 'item-title' }, c.title),
    h('div', { class: 'item-meta' },
      pill('Conflict', 'warn', 'warn'),
      target ? h('span', { title: c.target }, 'with ', h('span', { class: 'mono' }, `${target.dir}${target.name}`)) : null,
      h('span', {}, `${projectName(c.project, c.cwd)} · ${fmt.datetime(c.session_started_at)}`)),
    h('div', { class: 'item-body' }, clampText(c.claim || c.summary)),
    c.note ? h('div', { class: 'item-reason' }, h('b', {}, 'Why it conflicts: '), reasonOf(c.note)) : null,
    c.evidence ? disclose('Evidence', h('div', { class: 'evidence' }, c.evidence)) : null,
    h('div', { class: 'item-foot' },
      h('div', { class: 'btn-row' },
        actionButton('It is a new rule', 'resolve_conflict', `${c.id}:new`, { variant: 'primary', busyText: 'Composing…', title: 'Write it, correcting what the file says now. It comes back as a change to approve.' }),
        actionButton('Keep the current rule', 'resolve_conflict', `${c.id}:keep`, { title: 'Reject this learning' })),
      h('span', { class: 'small faint' }, 'A new rule comes back as a change for you to approve.')));
}

function changeCard(c) {
  const f = fileLabel(c.file);
  const stale = c.status === 'stale';
  return h('article', { class: `item${stale || c.changed ? ' attention' : ''}` },
    h('h3', { class: 'item-title file-title' }, h('span', { class: 'dir' }, f.dir), f.name),
    h('div', { class: 'item-meta' },
      c.corrects ? pill('Correction', 'warn', 'warn') : pill('Addition', 'accent', 'info'),
      h('span', {}, KIND_NAME[c.kind] || c.kind),
      h('span', {}, fmt.plural(c.claims.length, 'learning')),
      h('span', {}, fmt.datetime(c.session_started_at || c.created_at))),
    h('div', { class: 'path', title: c.file }, c.file),
    stale ? h('div', { class: 'callout' }, icon('alert'), h('div', {}, h('b', {}, 'Needs a new check. '), c.note || 'The file changed since this was composed.'))
      : c.changed ? h('div', { class: 'callout' }, icon('alert'), 'The file changed since this was composed. Approving re-applies the edits if they still fit.') : null,
    h('div', { class: 'diffs' }, c.edits.map(editDiff)),
    h('ol', { class: 'claims', 'aria-label': 'Learnings behind this change' }, c.claims.map((l, i) => h('li', {},
      h('span', { class: 'n' }, `${i + 1}.`),
      h('div', { class: 'claim-text' }, l.claim || l.title, l.note ? h('div', { class: 'small muted' }, reasonOf(l.note)) : null),
      c.claims.length > 1
        ? actionButton('Remove', 'reject', String(l.id), { variant: 'quiet', small: true, confirmText: 'Remove it?', title: 'Reject this learning; the rest of the change is composed again without it' })
        : h('span'),
      l.evidence ? h('div', { class: 'claim-extra' }, disclose('Evidence', h('div', { class: 'evidence' }, l.evidence))) : null))),
    h('div', { class: 'item-foot' },
      h('div', { class: 'btn-row' },
        stale ? null : actionButton('Approve change', 'approve', c.key, { variant: 'primary', iconName: 'check' }),
        actionButton('Reject', 'reject', c.key, { confirmText: 'Reject the whole change?' })),
      c.note && !stale ? h('span', { class: 'small faint' }, c.note) : null));
}

function itemCard(q) {
  const kind = q.kind === 'profile' ? `profile · ${q.block || ''}` : q.memory_type ? `${q.kind} · ${q.memory_type}` : q.kind;
  return h('article', { class: 'item' },
    h('h3', { class: 'item-title' }, q.title || q.target || '(untitled)'),
    h('div', { class: 'item-meta' },
      pill(`New ${kind}`, 'accent', 'info'),
      h('span', {}, `${projectName(q.project, q.cwd)} · ${fmt.datetime(q.session_started_at || q.ts)}`),
      confidence(q.confidence),
      q.triaged_at ? null : pill('Not checked yet', '', 'warn')),
    q.description && q.description !== q.summary ? h('div', { class: 'item-reason' }, q.description) : null,
    h('div', { class: 'item-body' }, clampText(q.summary)),
    q.note ? h('div', { class: 'item-reason' }, reasonOf(q.note)) : null,
    q.evidence ? disclose('Evidence', h('div', { class: 'evidence' }, q.evidence)) : null,
    h('div', { class: 'item-foot' },
      h('div', { class: 'btn-row' },
        actionButton('Approve', 'approve', q.key, { variant: 'primary', iconName: 'check' }),
        actionButton('Reject', 'reject', q.key, { confirmText: 'Reject it?' }))));
}

function fixesList(fixes) {
  return h('div', { class: 'panel' }, h('ul', { class: 'rows' }, fixes.map((f) => h('li', {},
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, reasonOf(f.note) || f.title),
      h('div', { class: 'small faint' }, `Instead of learning “${f.title}” · ${projectName(f.project, f.cwd)}`)),
    h('div', { class: 'btn-row' },
      actionButton('Done or not needed', 'dismiss', f.id, { small: true, title: 'Remove it from the inbox' }),
      actionButton('Learn it instead', 'restore', f.id, { small: true, variant: 'quiet', title: 'Treat it as a learning after all' }))))));
}

async function renderInbox() {
  const [queue, conflicts, fixes] = await Promise.all([api('queue'), api('conflicts'), api('suggestions')]);
  const changes = queue.filter((q) => q.type === 'changeset');
  const items = queue.filter((q) => q.type === 'item');
  const unchecked = items.filter((q) => !q.triaged_at).length + changes.filter((q) => q.status === 'stale').length;
  const ready = queue.filter((q) => q.status !== 'stale');
  const total = queue.length + conflicts.length + fixes.length;

  const head = pageHead('Inbox', 'Learnings that wait for your decision, oldest session first. Nothing here is written until you approve it.',
    unchecked ? actionButton(`Check ${unchecked} against knowledge`, 'triage_queue', false, { iconName: 'refresh', busyText: 'Checking…', title: 'Screen new proposals with the rubric and compose the changes to each file' }) : null,
    ready.length > 1 ? actionButton(`Approve all ${ready.length}`, 'approve_many', ready.map((q) => q.key), { confirmText: `Save all ${ready.length}?` }) : null,
    queue.length > 1 ? actionButton('Reject all', 'reject_many', queue.map((q) => q.key), { variant: 'quiet', confirmText: `Reject all ${queue.length}?` }) : null);

  if (!total) {
    view.replaceChildren(head, h('div', { class: 'panel' }, emptyState('All caught up',
      'Learnings land here when your autonomy setting holds them for approval, when they would change a rule file or CLAUDE.md, or when they contradict a rule already written. Everything saved shows up in Knowledge.')));
    return;
  }

  const groups = [
    ['inbox-conflicts', 'Conflicts', conflicts.length, 'These contradict a rule already written, or another learning, and nothing in the project settles which is right. Nothing was written.', () => h('div', { class: 'items' }, conflicts.map(conflictCard))],
    ['inbox-changes', 'Changes to files', changes.length, 'Each change gathers every learning for one file into one edit, shown as a diff. Approving applies it to the current file; Undo in Knowledge reverts it.', () => h('div', { class: 'items' }, changes.map(changeCard))],
    ['inbox-items', 'New items', items.length, 'New memories, skills and profile facts. No existing file owned their topic.', () => h('div', { class: 'items' }, items.map(itemCard))],
    ['inbox-fixes', 'Suggested fixes', fixes.length, 'Workarounds the project could remove with one change. They are not learned; fix them, or learn them anyway.', () => fixesList(fixes)],
  ].filter((g) => g[2]);

  const strip = h('div', { class: 'summary-strip', role: 'navigation', 'aria-label': 'Inbox sections' }, groups.map(([id, label, n]) =>
    h('a', { href: `#inbox/${id}`, onclick: (e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } },
      h('b', {}, fmt.int(n)), label)));

  view.replaceChildren(head, strip, ...groups.map(([id, label, n, text, body]) =>
    h('section', { class: 'section', id, style: 'scroll-margin-top: 80px' }, sectionHead(`${label} (${n})`, text), body())));
}

// ---------- Overview ----------
async function renderOverview() {
  const [o, v, l] = await Promise.all([api('overview', { days: state.days }), api('value', { days: state.days }), api('learnings')]);
  const learnedTotal = (o.learned.memory || 0) + (o.learned.skill || 0) + (o.learned.profile || 0);
  const delta = v.before.rate !== null && v.after.rate !== null ? v.after.rate - v.before.rate : null;
  const waiting = inboxTotal();

  const banner = waiting ? h('div', { class: 'banner' },
    h('div', { class: 't' }, icon('inbox'), `${fmt.plural(waiting, 'item')} wait for your decision`),
    h('a', { class: 'btn primary small', href: '#inbox' }, 'Open inbox', icon('arrow'))) : null;

  let sentence;
  if (!v.enabledAt) sentence = 'Nothing has been learned yet, so this is the baseline: how often you corrected Claude before learning.';
  else if (v.after.rate === null) sentence = 'Learning is on, but no session after it has been reviewed yet.';
  else if (delta < 0) sentence = `You correct Claude ${fmt.rate(Math.abs(delta))} fewer times per 100 turns than before learning turned on.`;
  else sentence = 'Not lower yet. Give it more sessions, and check Misses: repeated corrections mean a learning is not being used.';

  const verdict = h('div', { class: 'panel verdict' },
    h('div', { class: 'verdict-main' },
      h('div', { class: 'label' }, 'Corrections per 100 turns'),
      h('div', { class: 'verdict-figures' },
        v.enabledAt ? h('div', { class: 'figure before' }, h('div', { class: 'v' }, fmt.rate(v.before.rate)), h('div', { class: 'k' }, `before · ${fmt.int(v.before.turns)} turns`)) : null,
        v.enabledAt ? h('div', { class: 'figure' }, h('div', { class: 'v' }, fmt.rate(v.after.rate)), h('div', { class: 'k' }, `since ${fmt.date(v.enabledAt)} · ${fmt.int(v.after.turns)} turns`))
          : h('div', { class: 'figure' }, h('div', { class: 'v' }, fmt.rate(o.correctionRate)), h('div', { class: 'k' }, `${fmt.int(o.reviewed.turns)} reviewed turns`)),
        delta !== null ? h('span', { class: 'delta' }, h('span', { class: `dot ${delta < 0 ? 'good' : 'warn'}` }), `${delta > 0 ? '+' : ''}${delta.toFixed(1)}`) : null),
      h('p', { class: 'sentence' }, sentence)),
    h('div', { class: 'stats' },
      stat('Learned', fmt.int(learnedTotal), `${o.learned.profile || 0} profile · ${o.learned.memory || 0} memories · ${o.learned.skill || 0} skills${o.learned.patchedNative ? ` · ${o.learned.patchedNative} refined` : ''}`),
      stat('Sessions using a learning', v.sessions ? fmt.pct((v.hits / v.sessions) * 100) : '—', `${v.hits} of ${v.sessions} sessions`),
      stat('Misses', fmt.int(v.misses.length), 'times you repeated something already saved'),
      h('div', { class: 'stat' },
        h('div', { class: 'k' }, 'Reviewer cost this month'),
        h('div', { class: 'v' }, fmt.usd(o.cost.month)),
        o.cost.budget ? meter(o.cost.month, o.cost.budget, { label: 'Monthly budget used' }) : null,
        h('div', { class: 'd' }, o.cost.budget ? `of ${fmt.usd(o.cost.budget)} monthly budget` : 'budget not reported yet'))));

  const marker = v.enabledAt ? { day: dayOf(v.enabledAt), label: 'learning on' } : null;
  const rate = (d) => (d.reviewedTurns ? (d.corrections / d.reviewedTurns) * 100 : null);
  const charts = h('div', { class: 'charts' },
    barChart({ title: 'Corrections per 100 turns', sub: 'by the day the session started; lower is better', data: o.series, value: rate, format: (x) => x.toFixed(x > 0 && x < 10 ? 1 : 0), marker, wide: true, height: 200,
      tip: (d) => [fmt.day(d.day), `${d.corrections} corrections · ${d.reviewedTurns} turns reviewed`], emptyText: 'No reviewed sessions in this period' }),
    barChart({ title: 'Sessions using a learning', data: v.series, value: (d) => d.hits, format: (x) => fmt.int(x), marker,
      tip: (d) => [fmt.day(d.day), `${d.hits} of ${d.sessions} sessions`] }),
    barChart({ title: 'User turns', data: o.series, value: (d) => d.turns, format: (x) => fmt.compact(x),
      tip: (d) => [fmt.day(d.day), fmt.plural(d.sessions, 'session')] }));

  const opLabel = { create: 'Learned', patch: 'Updated', archive: 'Archived', consolidate: 'Consolidated', revert: 'Reverted' };
  const feed = l.writes.slice(0, 8);
  const recent = h('div', { class: 'panel' }, feed.length
    ? h('ul', { class: 'feed' }, feed.map((w) => h('li', {},
        h('span', { class: 'when' }, fmt.ago(w.ts)),
        h('div', { class: 'what' },
          h('div', { class: w.reverted_at ? 'undone' : '' }, h('b', {}, `${opLabel[w.op] || w.op} `), w.title || '(untitled)'),
          h('div', { class: 'path' }, String(w.files || '').split('\n')[0], w.reverted_at ? ' · undone' : '')))))
    : emptyState('Nothing learned yet', 'When a review saves something, or you approve an item in the inbox, it shows up here.', 'info'));

  view.replaceChildren(
    banner,
    pageHead('Overview', 'Is learning paying off? Fewer corrections and few misses mean yes.'),
    verdict,
    h('section', { class: 'section' }, sectionHead('Trend'), charts),
    h('section', { class: 'section' }, sectionHead('Recently learned', null, h('a', { href: '#knowledge', class: 'btn quiet small' }, 'All learnings', icon('arrow'))), recent));
}

function stat(k, v, d) {
  return h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), d ? h('div', { class: 'd' }, d) : null);
}

// ---------- Knowledge ----------
/** What one write changed in one file: removed lines struck, added lines highlighted. */
function hunkDiff(hk) {
  return h('pre', { class: 'diff' },
    hk.before.map((l) => h('del', { class: 'line' }, l || ' ')),
    hk.after.map((l) => h('ins', { class: 'line' }, l || ' ')),
    hk.more ? h('span', { class: 'diff-label' }, `… ${hk.more} more line${hk.more > 1 ? 's' : ''}`) : null);
}

function changeKind(c) {
  const l = c.learning;
  const fixes = c.files.some((f) => (f.hunks || []).some((hk) => hk.before.length));
  if (c.op === 'consolidate') return 'Consolidation';
  if (c.op === 'create') return l?.kind === 'profile' ? `Profile fact · ${l.block}` : l?.kind === 'skill' ? 'New skill' : `New memory${l?.memory_type ? ` · ${l.memory_type}` : ''}`;
  return `${fixes ? 'Correction' : 'Addition'} to ${KIND_NAME[l?.kind] || 'a file'}`;
}

const ORIGIN = { inloop: 'in session', background: 'end-of-session review', manual: 'you asked' };

function lifecycleNote(c) {
  const lc = c.lifecycle;
  if (!lc) return null;
  if (lc.state === 'kept') return h('span', { title: 'Never archived automatically' }, 'Kept');
  if (lc.state === 'confident') return h('span', { title: 'Confident learnings are not archived when unused' }, 'Not archived when unused');
  return h('span', { title: 'Unused, low-confidence learnings are archived to ~/.ouroboros/archive (restorable). Keep it to stop that.' },
    lc.at > Date.now() ? `Archived ${fmt.date(lc.at)} if unused` : 'Archived at the next maintenance if unused');
}

function learnedRow(c) {
  const l = c.learning;
  const main = c.files[0];
  const f = main ? fileLabel(main.file) : null;
  const archived = l && l.status === 'archived' && c.op === 'create';
  const used = l && l.uses ? `used ${fmt.plural(l.uses, 'time')}${l.last_used_at ? `, last ${fmt.ago(l.last_used_at)}` : ''}` : null;
  const wrote = c.files.flatMap((x) => (x.created ? [h('pre', { class: 'diff' }, h('ins', { class: 'line' }, x.text || '(empty)'))]
    : x.removed ? [h('div', { class: 'small muted' }, `Removed ${x.file}`)]
      : x.hunks.map(hunkDiff)));
  return h('li', { class: `learned${c.undone || archived ? ' faded' : ''}` },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title' }, c.title),
      h('div', { class: 'item-meta' },
        c.undone ? pill('Undone', 'bad', 'bad') : archived ? pill('Archived', '') : pill(changeKind(c), c.op === 'patch' && /^Correction/.test(changeKind(c)) ? 'warn' : ''),
        f ? h('span', { class: 'mono', title: main.file }, `${f.dir}${f.name}`) : null,
        h('span', { title: fmt.datetime(c.ts) }, fmt.ago(c.ts)),
        h('span', {}, c.session ? `${ORIGIN[c.actor] || c.actor} · ${projectName(c.session.project, c.session.cwd)}` : ORIGIN[c.actor] || c.actor),
        used ? h('span', {}, used) : null,
        lifecycleNote(c)),
      c.why ? h('div', { class: 'item-reason' }, clampText(c.why, 'div')) : null,
      wrote.length ? disclose(c.op === 'create' ? 'What it saved' : 'What it changed', h('div', { class: 'diffs' }, wrote)) : null),
    h('div', { class: 'btn-row row-actions' },
      !c.undone ? actionButton('Undo', 'undo_batch', c.batch, { small: true, variant: 'quiet', iconName: 'undo', confirmText: 'Undo this change?', title: 'Revert only what this wrote; later edits to the file stay' }) : null,
      c.lifecycle && ['decays', 'kept'].includes(c.lifecycle.state)
        ? actionButton(c.lifecycle.state === 'kept' ? 'Stop keeping' : 'Keep', 'pin', `${l.id}:${c.lifecycle.state === 'kept' ? 'off' : 'on'}`, { small: true, variant: 'quiet', iconName: 'check', title: c.lifecycle.state === 'kept' ? 'Let maintenance archive it if it goes unused' : 'Never archive it automatically' })
        : null,
      c.canArchive ? actionButton('Archive', 'forget', l.id, { small: true, variant: 'quiet', iconName: 'archive', confirmText: 'Archive it?', title: 'Stop loading it; restorable with undo' }) : null));
}

async function renderKnowledge() {
  const [changes, inv] = await Promise.all([api('changes'), api('inventory')]);
  const ks = state.knowledge;
  const q = ks.q.toLowerCase();
  const match = (...xs) => !q || xs.some((x) => String(x || '').toLowerCase().includes(q));
  const memories = inv.memories.filter((m) => !m.index);
  const lists = {
    learned: changes.filter((c) => (ks.showUndone || !c.undone) && match(c.title, c.why, ...c.files.map((x) => x.file))),
    skills: inv.skills.filter((r) => match(r.name, r.description, r.scope)),
    memories: memories.filter((r) => match(r.name, r.description, r.project)),
    instructions: inv.instructions.filter((r) => match(r.file, r.scope)),
  };

  const search = h('input', { type: 'search', placeholder: 'Filter by name, text or path', value: ks.q, 'aria-label': 'Filter' });
  search.addEventListener('input', () => {
    ks.q = search.value;
    renderKnowledge().then(() => { const el = view.querySelector('input[type=search]'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
  });

  const tables = {
    learned: () => {
      const undone = changes.filter((c) => c.undone).length;
      const toggle = undone ? h('label', { class: 'small muted check' },
        h('input', { type: 'checkbox', checked: !!ks.showUndone, onchange: (e) => { ks.showUndone = e.target.checked; renderKnowledge(); } }),
        ` Show undone (${undone})`) : null;
      if (!lists.learned.length) {
        return h('div', {}, h('div', { class: 'empty' }, h('p', {}, q ? 'No learning matches the filter.' : 'Nothing learned yet. Ask Claude to remember something, or approve items in the inbox.')),
          toggle ? h('div', { class: 'table-note' }, toggle) : null);
      }
      return h('div', {},
        h('ul', { class: 'rows learned-list' }, lists.learned.map(learnedRow)),
        h('div', { class: 'table-note' },
          'One row per thing learned. Undo reverts only what that row wrote; Archive stops loading something Ouroboros created; Keep stops maintenance from archiving it when unused. All reversible.',
          toggle ? h('span', { style: 'margin-left:12px' }, toggle) : null));
    },
    skills: () => table([
      { label: 'Skill', render: (r) => cellMain(h('span', {}, r.name, r.origin ? h('span', { style: 'margin-left:8px' }, pill('learned', 'accent')) : null), r.description, { clamp: true }) },
      { label: 'Scope', render: (r) => (r.scope === 'project' ? `project · ${projectName(r.project)}` : r.scope) },
      { label: 'Uses', num: true, render: (r) => fmt.int(r.uses) },
      { label: 'Last used', render: (r) => (r.lastUsed ? fmt.ago(r.lastUsed) : h('span', { class: 'faint' }, 'not yet')) },
      { label: 'Description', num: true, render: (r) => `${fmt.int(r.descriptionChars)} chars` },
    ], lists.skills, { empty: 'No skill matches.' }),
    memories: () => table([
      { label: 'Memory', render: (r) => cellMain(r.name, r.description, { clamp: true }) },
      { label: 'Type', render: (r) => (r.type ? pill(r.type) : '—') },
      { label: 'Project', render: (r) => projectName(r.project) },
      { label: 'Reads', num: true, render: (r) => fmt.int(r.reads) },
      { label: 'Updated', render: (r) => fmt.date(r.mtime) },
    ], lists.memories, { empty: 'No memory matches.' }),
    instructions: () => table([
      { label: 'File', render: (r) => h('span', { class: 'mono' }, r.file) },
      { label: 'Scope', render: (r) => r.scope },
      { label: 'Lines', num: true, render: (r) => fmt.int(r.lines) },
      { label: 'Updated', render: (r) => fmt.date(r.mtime) },
    ], lists.instructions, { empty: 'No instruction file matches.' }),
  };

  view.replaceChildren(
    pageHead('Knowledge', 'What Claude knows on this machine: what Ouroboros learned, and every skill, memory and instruction file it reads.'),
    h('div', { class: 'toolbar' },
      segmented([['learned', 'Learned', lists.learned.length], ['skills', 'Skills', lists.skills.length], ['memories', 'Memories', lists.memories.length], ['instructions', 'Instruction files', lists.instructions.length]],
        ks.seg, (seg) => { ks.seg = seg; renderKnowledge(); }),
      search),
    h('div', { class: 'panel' }, tables[ks.seg]()));
}

// ---------- Activity ----------
const OUTCOME = {
  created: ['saved', 'good'], patched: ['saved into a file', 'good'], duplicate: ['already known', ''], dropped: ['dropped', ''],
  merged: ['merged', ''], suggested: ['fix suggested', 'info'], dismissed: ['fix dismissed', ''], fixed: ['fixed in the project', 'good'], queued: ['in the inbox', 'info'],
  conflict: ['conflict', 'warn'], rejected_by_user: ['rejected by you', 'bad'], undone: ['undone by you', 'bad'], pending: ['being checked', 'info'], rejected: ['rejected', 'bad'], over_budget: ['over budget', 'warn'], error: ['error', 'bad'],
};
function outcomePill(o) {
  const [label, tone] = OUTCOME[o] || [o ? o.replace(/_/g, ' ') : 'measured only', ''];
  return pill(label, '', tone || null);
}
function reviewState(st) {
  const map = { done: ['good', 'reviewed'], ok: ['good', 'done'], queued: ['warn', 'queued'], running: ['info', 'running'], skipped: ['', 'skipped'], failed: ['bad', 'failed'] };
  const [tone, label] = map[st] || ['', 'not reviewed'];
  return pill(label, '', tone || null);
}

async function renderActivity() {
  const as = state.activity;
  const [o, c, l, dropped] = await Promise.all([api('overview', { days: 90 }), api('cost', { days: 90 }), api('learnings'), api('dropped')]);
  const kinds = ['all', ...new Set(l.candidates.map((x) => x.kind))];
  const outcomes = ['all', ...new Set(l.candidates.map((x) => x.outcome || 'measured'))];
  const proposals = l.candidates.filter((x) => (as.kind === 'all' || x.kind === as.kind) && (as.outcome === 'all' || (x.outcome || 'measured') === as.outcome));

  const select = (value, options, label, onChange) => {
    const el = h('select', { 'aria-label': label }, options.map((x) => h('option', { value: x, selected: x === value }, x === 'all' ? `${label}: all` : (OUTCOME[x]?.[0] || x))));
    el.addEventListener('change', () => onChange(el.value));
    return el;
  };

  const panes = {
    sessions: () => table([
      { label: 'Started', render: (r) => fmt.datetime(r.started_at) },
      { label: 'Project', render: (r) => projectName(r.project, r.cwd) },
      { label: 'Turns', num: true, render: (r) => fmt.int(r.turns) },
      { label: 'Tool calls', num: true, render: (r) => h('span', {}, fmt.int(r.tool_calls), r.tool_fails ? h('span', { class: 'faint' }, ` · ${r.tool_fails} failed`) : null) },
      { label: 'Corrections', num: true, render: (r) => fmt.int(r.corrections) },
      { label: 'Proposed', num: true, render: (r) => fmt.int(r.candidates) },
      { label: 'Cost', num: true, render: (r) => fmt.usd(r.cost) },
      { label: 'Review', render: (r) => reviewState(r.queue_state) },
    ], o.sessions, { empty: 'No sessions recorded yet. Start a Claude Code session with the plugin enabled.', note: 'The 25 most recent sessions.' }),
    reviews: () => table([
      { label: 'When', render: (r) => fmt.datetime(r.ts) },
      { label: 'Kind', render: (r) => cellMain(r.mode === 'inloop' ? 'In-session' : r.mode === 'background' ? 'End of session' : r.mode === 'maintenance' ? 'Maintenance' : r.mode, r.trigger) },
      { label: 'Project', render: (r) => projectName(r.project, r.cwd) },
      { label: 'Status', render: (r) => h('span', { title: r.detail || '' }, reviewState(r.status)) },
      { label: 'Turns', num: true, render: (r) => fmt.int(r.turns_reviewed) },
      { label: 'Corrections', num: true, render: (r) => fmt.int(r.corrections) },
      { label: 'Learned', num: true, render: (r) => fmt.int(r.learned + r.patched) },
      { label: 'Tokens', num: true, render: (r) => fmt.compact(r.input + r.output) },
      { label: 'Cost', num: true, render: (r) => (r.mode === 'inloop' ? h('span', { class: 'faint', title: 'Runs inside your session, on your plan' }, 'plan') : fmt.usd(r.cost_usd)) },
    ], c.recent, { empty: 'No reviews yet.', note: 'In-session reviews run inside your session and use your plan; the others are isolated Haiku calls billed per use.' }),
    proposals: () => table([
      { label: 'Proposal', render: (r) => cellMain(r.title, r.summary, { clamp: true }) },
      { label: 'Kind', render: (r) => (r.kind === 'memory' && r.memory_type ? `memory · ${r.memory_type}` : r.kind) },
      { label: 'Project', render: (r) => projectName(r.project, r.cwd) },
      { label: 'Session', render: (r) => fmt.date(r.session_started_at) },
      { label: 'Outcome', render: (r) => outcomePill(r.outcome) },
      { label: '', render: (r) => (r.outcome === 'patched' && r.cs_status === 'applied' && r.cs_batch
        ? actionButton('Undo change', 'undo_change', r.changeset_id, { small: true, variant: 'quiet', iconName: 'undo', confirmText: 'Undo this change?', title: 'Revert only the lines this change wrote; later edits to the file stay' })
        : null) },
    ], proposals, { empty: 'No proposals match.', note: 'Everything reviews proposed to learn, and what happened to each. Undo change reverts only the lines that change wrote.' }),
    dropped: () => (dropped.length ? h('ul', { class: 'rows' }, dropped.map((d) => h('li', {},
      h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, d.title), h('div', { class: 'small muted' }, d.note || OUTCOME[d.outcome]?.[0] || d.outcome)),
      actionButton('Restore', 'restore', d.id, { small: true, variant: 'quiet', title: 'Put it back in the inbox to be checked again' }))))
      : emptyState('Nothing dropped', 'Proposals the knowledge check drops (already documented, one-off, stale, duplicate) appear here with the reason.', 'info')),
    corrections: () => (l.corrections.length ? h('ul', { class: 'rows' }, l.corrections.map((x) => h('li', {},
      h('div', { class: 'row-main' }, h('div', {}, `“${x.quote}”`), h('div', { class: 'small faint' }, `${x.kind} · ${projectName(x.project, x.cwd)} · ${fmt.date(x.session_started_at)}`)))))
      : emptyState('No corrections recorded', 'Reviews count the times you redirected Claude; they show up here.', 'info')),
  };

  view.replaceChildren(
    pageHead('Activity', 'What happened: sessions, the reviews that read them, what they proposed, and what the knowledge check dropped.'),
    h('div', { class: 'toolbar' },
      segmented([['sessions', 'Sessions'], ['reviews', 'Reviews'], ['proposals', 'Proposals', l.candidates.length], ['dropped', 'Dropped', dropped.length], ['corrections', 'Corrections', l.corrections.length]],
        as.seg, (seg) => { as.seg = seg; renderActivity(); }),
      as.seg === 'proposals' ? h('div', { class: 'btn-row' },
        select(as.kind, kinds, 'Kind', (x) => { as.kind = x; renderActivity(); }),
        select(as.outcome, outcomes, 'Outcome', (x) => { as.outcome = x; renderActivity(); })) : null),
    h('div', { class: 'panel' }, panes[as.seg]()));
}

// ---------- System ----------
async function renderSystem() {
  const [hl, q, c] = await Promise.all([api('health'), api('quality', { days: state.days }), api('cost', { days: state.days })]);
  const queue = Object.fromEntries(hl.queue.map((x) => [x.state, x.n]));
  const alive = hl.capture.lastEventAt && Date.now() - hl.capture.lastEventAt < 7 * 86_400_000;
  const mode = Object.fromEntries(c.byMode.map((m) => [m.mode, m]));
  const bgUsd = Object.values(mode).filter((m) => m.mode !== 'inloop').reduce((n, m) => n + m.usd, 0);
  const bgN = Object.values(mode).filter((m) => m.mode !== 'inloop').reduce((n, m) => n + m.n, 0);
  const opts = hl.options;
  const LISTING_REF = 2000; // ~1% of a 200K-token context

  const status = h('div', { class: 'grid-3' },
    h('div', { class: 'panel status-card' },
      h('div', { class: 'head' }, h('span', { class: `dot ${alive ? 'good' : 'warn'}` }), alive ? 'Recording sessions' : 'No recent activity'),
      h('div', { class: 'big' }, fmt.int(hl.capture.eventsLast24h)),
      h('p', {}, `events in the last 24 h · last ${fmt.ago(hl.capture.lastEventAt)}`)),
    h('div', { class: 'panel status-card' },
      h('div', { class: 'head' }, h('span', { class: `dot ${queue.failed ? 'bad' : 'good'}` }), 'Reviewer'),
      h('div', { class: 'big' }, fmt.int(queue.done || 0)),
      h('p', {}, `sessions reviewed · ${fmt.int(queue.skipped || 0)} skipped · ${fmt.int((queue.queued || 0) + (queue.running || 0))} pending · ${fmt.int(queue.failed || 0)} failed`),
      h('p', { class: 'small faint' }, opts ? `${opts.reviewerModel} · end-of-session ${(opts.backgroundReview ?? opts.measureReview) ? 'on' : 'off'} · in-session ${opts.inloopReview === false ? 'off' : `every ${opts.reviewEveryTurns ?? 10} turns`} · autonomy ${opts.autonomy || 'auto'}` : 'Options are reported at the next session start.')),
    h('div', { class: 'panel status-card' },
      h('div', { class: 'head' }, h('span', { class: `dot ${c.month.budget && c.month.usd >= c.month.budget ? 'bad' : 'good'}` }), 'Cost this month'),
      h('div', { class: 'big' }, fmt.usd(c.month.usd)),
      c.month.budget ? meter(c.month.usd, c.month.budget, { label: 'Monthly budget used' }) : null,
      h('p', {}, c.month.budget ? `of ${fmt.usd(c.month.budget)}; reviews pause for the month when it is reached` : 'budget not reported yet')));

  // Learning quality: what the knowledge check did, and how you judged it.
  const pct = (x) => (x === null || x === undefined ? '—' : fmt.pct(x * 100));
  const changes = Object.fromEntries((q.changes || []).map((x) => [x.status, x.n]));
  const reasons = Object.entries(q.dropReasons).sort((a, b) => b[1] - a[1]);
  const maxReason = Math.max(1, ...reasons.map((r) => r[1]));
  const signals = [];
  if (q.proposed >= 10 && q.dropped / q.proposed > 0.5) signals.push('Most proposals are dropped by the knowledge check: reviews keep proposing what is already documented or fails the rubric.');
  if (q.undoRate !== null && q.writes >= 5 && q.undoRate > 0.2) signals.push('More than 1 in 5 writes was undone: things are being saved that you do not want.');
  if (q.approvalRate !== null && q.approvalRate < 0.5) signals.push('You reject most of what reaches the inbox: consider a stricter autonomy, or look at why in Activity.');
  if ((changes.stale || 0) >= 3) signals.push(`${changes.stale} changes went stale because their files changed before approval: review the inbox more often.`);
  const quality = h('div', { class: 'panel' },
    h('dl', { class: 'facts' },
      ...[['Proposed', q.proposed], ['Saved', q.saved], ['In the inbox', (q.queued || 0) + (q.conflicts || 0)], ['Dropped', q.dropped],
        ['Merged or known', (q.merged || 0) + (q.duplicates || 0)], ['Fixes suggested', q.suggested || 0], ['Approval rate', pct(q.approvalRate)], ['Undo rate', pct(q.undoRate)]]
        .map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, typeof v === 'number' ? fmt.int(v) : v)))),
    reasons.length ? h('div', { class: 'bars' },
      h('h3', { style: 'margin-bottom:6px' }, 'Why proposals were dropped'),
      reasons.map(([r, n]) => h('div', { class: 'bar-row' }, h('span', {}, r), h('div', { class: 'track' }, h('span', { style: `width:${(n / maxReason) * 100}%` })), h('span', { class: 'num' }, fmt.int(n))))) : null,
    h('div', { class: 'table-note' }, `Changes to files: ${fmt.int(changes.applied || 0)} applied · ${fmt.int(changes.pending || 0)} waiting · ${fmt.int(changes.rejected || 0)} rejected · ${fmt.int(changes.superseded || 0)} recomposed · ${fmt.int(q.rejectedByUser)} learnings rejected by you`),
    signals.length ? signals.map((t) => h('div', { class: 'signal' }, icon('alert'), t))
      : h('div', { class: 'signal ok' }, icon('check'), 'No quality warnings.'));

  const costFacts = h('div', { class: 'panel' }, h('dl', { class: 'facts' },
    ...[['Reviews', fmt.int(bgN + (mode.inloop?.n || 0))], ['Billed reviews', fmt.usd(bgUsd)], ['Average per review', bgN ? fmt.usd(bgUsd / bgN) : '—'],
      ['Context per session', `${fmt.int(c.overhead.tokensPerSession)} tok`]].map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))));
  const costCharts = h('div', { class: 'charts' },
    barChart({ title: 'Billed review cost', data: c.series, value: (d) => d.usd, format: fmt.usd, tip: (d) => [fmt.day(d.day), fmt.plural(d.reviews, 'review')] }),
    barChart({ title: 'Reviews', data: c.series, value: (d) => d.reviews, format: (x) => fmt.int(x), tip: (d) => [fmt.day(d.day)] }));

  const budgetRow = (label, used, limit, unit) => h('div', { class: 'budget' },
    h('div', { class: 'line' }, h('span', {}, label), h('span', {}, `${fmt.int(used)} / ${fmt.int(limit)} ${unit}`)), meter(used, limit, { label }));
  const budgets = h('div', { class: 'grid-2' },
    h('div', { class: 'panel pad' },
      h('h3', {}, 'Always in context'),
      budgetRow('Skill listing', hl.skillListing.tokens, LISTING_REF, 'tokens'),
      budgetRow('Profile · User', hl.budgets.userBlock.used, hl.budgets.userBlock.limit, 'chars'),
      budgetRow('Profile · Environment & lessons', hl.budgets.environmentBlock.used, hl.budgets.environmentBlock.limit, 'chars'),
      budgetRow('Learned skills', hl.budgets.learnedSkills.used, hl.budgets.learnedSkills.limit, 'skills'),
      h('p', { class: 'small faint', style: 'margin:8px 0 0' }, `Skill listing: ${hl.skillListing.skills} skills Claude can invoke (plugin skills not counted); ~2,000 tokens is 1% of a 200K context. Limits live in ~/.ouroboros/config.json; past 80%, Ouroboros consolidates.`)),
    h('div', { class: 'panel pad' },
      h('h3', {}, 'MEMORY.md indexes'),
      hl.indexes.length ? hl.indexes.map((ix) => budgetRow(projectName(ix.project), ix.lines, hl.budgets.memoryIndexLines, 'lines'))
        : h('p', { class: 'muted small' }, 'No memory indexes found.'),
      h('p', { class: 'small faint', style: 'margin:8px 0 0' }, `Claude Code loads only the first 200 lines (25 KB) of each index; Ouroboros stops adding at ${hl.budgets.memoryIndexLines}.`)));

  const problemsList = (items, render, empty) => (items.length ? h('ul', { class: 'rows problems' }, items.map(render)) : h('p', { class: 'muted small', style: 'margin:0' }, empty));
  const problems = h('div', { class: 'grid-2' },
    h('div', { class: 'panel pad' }, h('h3', { style: 'margin-bottom:6px' }, 'Failed reviews'),
      problemsList(hl.failedReviews, (r) => h('li', { style: 'padding-left:0;padding-right:0;display:block' }, h('div', { class: 'small' }, r.detail), h('div', { class: 'small faint' }, `${fmt.datetime(r.ts)} · ${r.session_id}`)), 'None.')),
    h('div', { class: 'panel pad' }, h('h3', { style: 'margin-bottom:6px' }, 'Errors'),
      problemsList(hl.errors, (e) => h('li', { style: 'padding-left:0;padding-right:0;display:block' }, h('div', { class: 'mono' }, e.message.split('\n')[0]), h('div', { class: 'small faint' }, `${fmt.datetime(e.ts)} · ${e.source}`)), 'None.')));

  view.replaceChildren(
    pageHead('System', 'Is everything running, how good is what it learns, and what does it cost?'),
    status,
    h('section', { class: 'section' }, sectionHead('Learning quality', `What the knowledge check did with proposals in the last ${q.days} days, and how you judged what reached you.`), quality),
    h('section', { class: 'section' }, sectionHead('Cost', 'End-of-session and maintenance reviews are isolated Haiku calls billed per use; in-session reviews use your plan.'), costFacts, h('div', { style: 'height:16px' }), costCharts),
    h('section', { class: 'section' }, sectionHead('Context budgets', 'What Ouroboros keeps in every session’s context, against its limits.'), budgets),
    h('section', { class: 'section' }, sectionHead('Problems'), problems));
}

// ---------- shell ----------
const renderers = { inbox: renderInbox, overview: renderOverview, knowledge: renderKnowledge, activity: renderActivity, system: renderSystem };
const USES_RANGE = new Set(['overview', 'system']);

function inboxTotal() {
  const k = state.counts;
  return k ? k.conflicts + k.items + k.changes + k.fixes : 0;
}

async function refreshCounts() {
  try {
    state.counts = await api('counts');
  } catch { return; }
  const n = inboxTotal();
  const badge = document.getElementById('inbox-count');
  badge.hidden = !n;
  badge.textContent = fmt.int(n);
  badge.setAttribute('aria-label', `${n} waiting`);
  const o = state.counts.options;
  const parts = [state.counts.version ? `v${state.counts.version}` : null, o ? (o.learning === false ? 'measuring only' : `learning · ${o.autonomy || 'auto'}`) : null].filter(Boolean);
  document.getElementById('status').textContent = parts.join(' · ');
}

async function render() {
  hideTip();
  rangeWrap.hidden = !USES_RANGE.has(state.tab);
  for (const a of document.querySelectorAll('.tabs a')) {
    if (a.dataset.tab === state.tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  view.classList.toggle('narrow', state.tab === 'inbox');
  await refreshCounts();
  try {
    await renderers[state.tab]();
  } catch (err) {
    const gone = err instanceof TypeError; // fetch failed: the local server is not running
    view.replaceChildren(h('div', { class: 'panel' }, emptyState(gone ? 'The dashboard server stopped' : 'Could not load this page',
      gone ? 'It stops after 4 idle hours or when Ouroboros is updated. Run /ouroboros:dashboard in Claude Code to start it again.' : String(err.message), 'alert')));
  }
}

function route() {
  const tab = location.hash.slice(1).split('/')[0];
  const next = renderers[tab] ? tab : null;
  if (!next) {
    // No page asked for: start where there is something to do.
    state.tab = inboxTotal() ? 'inbox' : 'overview';
    history.replaceState(null, '', `#${state.tab}`);
  } else {
    if (next === state.tab && location.hash.includes('/')) return;
    state.tab = next;
  }
  render().then(() => view.focus({ preventScroll: true }));
}

rangeSelect.addEventListener('change', () => { state.days = Number(rangeSelect.value); render(); });
window.addEventListener('hashchange', route);

// Theme: follows the system unless chosen; the button shows what it switches to.
const themeBtn = document.getElementById('theme');
const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
function paintTheme() {
  const dark = isDark();
  themeBtn.replaceChildren(icon(dark ? 'sun' : 'moon'));
  themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
}
try {
  const saved = localStorage.getItem('ouroboros-theme');
  if (saved) document.documentElement.dataset.theme = saved;
} catch { /* storage unavailable */ }
themeBtn.addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('ouroboros-theme', next); } catch { /* ignore */ }
  paintTheme();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', paintTheme);
paintTheme();

refreshCounts().then(route);
setInterval(() => {
  if (document.hidden) return;
  if (state.tab === 'overview') render();
  else refreshCounts();
}, 60_000);
