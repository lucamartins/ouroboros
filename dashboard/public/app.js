// Ouroboros dashboard. Build-free; data comes from the local API.
// Untrusted text (paths, quotes, descriptions, diffs) is always set via text nodes.
//
// Pages, one question each:
//   Inbox      what waits for your decision (grouped by project, then by target file)
//   Overview   is learning working? (corrections before/after, use, misses, cost)
//   Knowledge  what Claude knows (learned items, skills, memories, instruction files,
//              and a graph of how they connect)
//   Activity   what happened (sessions, reviews, proposals, dropped, corrections)
//   System     health and cost (capture, reviewer, quality, budgets, problems)
//
// Page state lives in the URL hash: `#<tab>[/<segment or anchor>][?filters]`, e.g.
// `#knowledge/learned?q=nisus&project=…` or `#activity/proposals?kind=skill&days=90`.
// Lists are paged by the server ("Showing 50 of 1,240" and "Load more").

import { forceLayout } from './force.js';

const view = document.getElementById('view');
const tooltip = document.getElementById('tooltip');
const rangeSelect = document.getElementById('range');
const rangeWrap = document.getElementById('range-wrap');
const tabsEl = document.querySelector('.tabs');

/** Rows per page of a list, and per group of the inbox before "Load more". */
const PAGE = 50;
const INBOX_PER_GROUP = 20;
/** Below this many reviewed turns after learning turned on, the before/after delta is not judged. */
const MIN_SAMPLE_TURNS = 200;
/** Relative times ("3 h ago") up to this age; older ones show the date. */
const RELATIVE_FOR_MS = 7 * 86_400_000;
const SEARCH_DEBOUNCE_MS = 200;

const state = {
  tab: null,
  nav: { tab: null, sub: '', params: new URLSearchParams() },
  counts: null,
  home: null,
  projects: [],
  /** Rows loaded per list (by list key), so a re-render after an action keeps them. */
  loaded: {},
  overviewSig: null,
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
  sortDown: 'M8 3.5v9 M4.5 9l3.5 3.5L11.5 9',
  sortUp: 'M8 12.5v-9 M4.5 7L8 3.5 11.5 7',
  sortBoth: 'M5 6l3-3 3 3 M5 10l3 3 3-3',
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
  date(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const opts = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString('en-US', opts);
  },
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
  /** Relative for the last week, the date after that. */
  when: (ts) => (!ts ? 'never' : Date.now() - ts < RELATIVE_FOR_MS ? fmt.ago(ts) : fmt.date(ts)),
  day: (key) => new Date(`${key}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  plural: (n, one, many = `${one}s`) => `${fmt.int(n)} ${n === 1 ? one : many}`,
};

/** A path as the user reads it: the home folder as `~`, forward slashes. */
function tilde(file) {
  const f = String(file || '').replace(/\\/g, '/');
  const home = state.home;
  if (!home) return f;
  const lower = f.toLowerCase();
  const hl = home.toLowerCase();
  return lower === hl ? '~' : lower.startsWith(`${hl}/`) ? `~${f.slice(home.length)}` : f;
}

/** The project's display name: from the server when the row carries it. */
function projectName(row) {
  if (row?.project_name) return row.project_name;
  if (row?.cwd) return String(row.cwd).split(/[\\/]/).filter(Boolean).pop() || row.cwd;
  if (!row?.project) return '—';
  // Claude Code project keys look like "C--Users-me-source-repos-app".
  return String(row.project).split('-').filter(Boolean).pop() || row.project;
}

/** "…/nisus-staging/SKILL.md" → { dir: "skills/nisus-staging/", name: "SKILL.md" }. */
function fileLabel(file) {
  const parts = String(file || '').split(/[\\/]/).filter(Boolean);
  const name = parts.pop() || file;
  return { dir: parts.slice(-2).join('/') + (parts.length ? '/' : ''), name };
}

const KIND_NAME = { skill: 'skill', rules: 'rule file', instructions: 'CLAUDE.md', memory: 'memory', profile: 'profile (retired)' };

/** Notes start with "adds to <path>: …" or "✎ corrects <path>: …"; keep the reason. */
function reasonOf(note) {
  return String(note || '')
    .replace(/^✎\s*/, '')
    .replace(/^(adds to|corrects|for)\s.+?\.md(\s›\s[^:]+)?:\s*/i, '')
    .replace(/^conflict(\s+with\s+#\d+)?:\s*/i, '')
    .replace(/^fix in the project(\s*\[[^\]]*\])?:\s*/i, '');
}

async function api(name, params = {}) {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const q = new URLSearchParams(clean).toString();
  const res = await fetch(`/api/${name}${q ? `?${q}` : ''}`);
  if (!res.ok) {
    let message = `${name}: HTTP ${res.status}`;
    try { message = (await res.json()).message || message; } catch { /* not JSON */ }
    throw new Error(message);
  }
  return res.json();
}

/** Promise.allSettled as values or Error objects, so one failed request only empties its own section. */
async function settle(promises) {
  return (await Promise.allSettled(promises)).map((r) => (r.status === 'fulfilled' ? r.value : (r.reason instanceof Error ? r.reason : new Error(String(r.reason)))));
}
const failed = (x) => x instanceof Error;

function sectionError(err, what = 'this section') {
  return h('div', { class: 'panel section-error', role: 'alert' }, icon('alert'),
    h('div', {}, h('b', {}, `Could not load ${what}. `), String(err?.message || err), ' Reload the page to try again.'));
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
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

/** A small static table (chart fallbacks). */
function table(columns, rows, { empty = 'Nothing yet.' } = {}) {
  if (!rows.length) return h('div', { class: 'empty' }, h('p', {}, empty));
  return h('div', { class: 'table-wrap' },
    h('table', {},
      h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.num ? 'num' : null, scope: 'col' }, c.label)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, columns.map((c) => h('td', { class: c.num ? 'num' : null }, c.render(r))))))));
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

let clampSeq = 0;
/** Long text, clamped to a few lines with a toggle when it overflows. */
function clampText(text, tag = 'p') {
  const id = `clamp-${++clampSeq}`;
  const el = h(tag, { class: 'clamp', id }, text);
  const more = h('button', { class: 'more', type: 'button', hidden: true, 'aria-expanded': 'false', 'aria-controls': id }, 'Show more');
  more.addEventListener('click', () => {
    const open = el.classList.toggle('open');
    more.textContent = open ? 'Show less' : 'Show more';
    more.setAttribute('aria-expanded', String(open));
  });
  requestAnimationFrame(() => { if (el.scrollHeight > el.clientHeight + 2) more.hidden = false; });
  return h('div', {}, el, more);
}

function disclose(label, ...content) {
  return h('details', { class: 'disclose' }, h('summary', {}, label), ...content);
}

/** Name a <details> so a re-render keeps it open. */
function keyed(el, dk) {
  el.dataset.dk = dk;
  return el;
}

// ---------- URL state ----------
/** `#tab/sub?a=1` → { tab, sub, params }. */
function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#/, '');
  const [path, query = ''] = raw.split('?');
  const [tab = '', sub = ''] = path.split('/');
  return { tab, sub: decodeURIComponent(sub), params: new URLSearchParams(query) };
}

function hashOf(tab, sub, params) {
  const q = new URLSearchParams([...params].filter(([, v]) => v !== '' && v !== null && v !== undefined)).toString();
  return `#${tab}${sub ? `/${encodeURIComponent(sub)}` : ''}${q ? `?${q}` : ''}`;
}

/** Filters that follow the user from page to page. */
const SHARED = ['project'];

/**
 * Change the page state in the URL. `set` maps parameters to values (empty removes them);
 * `push` adds a history entry (back returns to it), otherwise the entry is replaced.
 */
function setNav({ tab = state.nav.tab, sub = state.nav.sub, set = {}, keep = true, push = true } = {}) {
  const params = new URLSearchParams(keep ? state.nav.params : [...state.nav.params].filter(([k]) => SHARED.includes(k)));
  for (const [k, v] of Object.entries(set)) {
    if (v === '' || v === null || v === undefined || v === false) params.delete(k);
    else params.set(k, String(v));
  }
  const hash = hashOf(tab, sub, params);
  state.nav = { tab, sub, params };
  if (hash !== location.hash) history[push ? 'pushState' : 'replaceState'](null, '', hash);
  paintNavLinks();
}

/** Navigate: new URL state, then a full render of the page. */
function go(opts, renderOpts = {}) {
  setNav(opts);
  state.tab = state.nav.tab;
  return render(renderOpts);
}

const param = (k, fallback = '') => state.nav.params.get(k) ?? fallback;

/** Navigation links carry the shared filters (the project), so the filter follows the user. */
function paintNavLinks() {
  const project = state.nav.params.get('project');
  for (const a of document.querySelectorAll('.tabs a')) {
    const keepsProject = ['inbox', 'knowledge', 'activity'].includes(a.dataset.tab);
    a.setAttribute('href', `#${a.dataset.tab}${project && keepsProject ? `?project=${encodeURIComponent(project)}` : ''}`);
  }
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
  toastEl._t = setTimeout(() => { toastEl.className = 'toast'; }, 5000);
}

/** Every status an action can end in, as a sentence (the reason, when there is one, follows). */
const STATUS_TEXT = {
  not_found: 'It is no longer there: someone or something already decided it.',
  nothing: 'Nothing to undo: that change was already undone.',
  ambiguous: 'More than one learning matches; nothing was archived.',
  refused: 'Not archived: Ouroboros only changed this file, it did not create it. Undo its changes instead.',
  stale: 'The file changed since this was composed. Check it against knowledge again, then decide.',
  over_budget: 'Not saved: it would go over a budget.',
  duplicate: 'Not saved: it is already known.',
  rejected: 'Not saved: it did not pass the checks.',
  invalid: 'This cannot be done here.',
  error: 'Something went wrong while saving.',
  conflict: 'Not saved: it contradicts something already written. It is in the inbox as a conflict.',
  queued: 'It waits in the inbox.',
  busy: 'Another session is checking the inbox right now; it will pick these up.',
  budget: 'Stopped: this month’s reviewer budget is spent.',
  waiting: 'Saved your choice; the change will be composed at the next check.',
  skipped: 'Skipped.',
  changed: 'The inbox changed since this page loaded, so nothing was decided.',
  unknown: 'Done, with an unexpected result.',
};
const sentence = (r) => {
  const base = STATUS_TEXT[r.status] || STATUS_TEXT.unknown;
  const reason = r.reason ? ` (${String(r.reason).replace(/\.$/, '')})` : '';
  return `${base.replace(/\.$/, '')}${reason}.`;
};
const ACTION_LABEL = {
  undo: (r) => (r.status === 'undone' ? `Undone: ${r.title || r.id}` : sentence(r)),
  undo_change: (r) => (r.status === 'undone' ? `Change undone: ${r.title || ''}` : sentence(r)),
  undo_batch: (r) => (r.status === 'undone' ? `Undone: ${r.title || 'the change'}` : sentence(r)),
  pin: (r) => (r.status === 'kept' ? 'Kept: it will not be archived automatically' : r.status === 'unkept' ? 'Maintenance may archive it if it goes unused' : sentence(r)),
  forget: (r) => (r.status === 'archived' ? `Archived: ${r.title}` : sentence(r)),
  confirm: (r) => (r.status === 'confirmed' ? 'Confidence raised' : sentence(r)),
  approve: (r) => (r.status === 'created' || r.status === 'patched' ? `Saved: ${r.title}${r.rebased ? ' (applied on top of the newer file)' : ''}` : sentence(r)),
  reject: (r) => (r.status === 'rejected_by_user' ? (r.recompose ? 'Removed; the rest of the change was composed again' : 'Rejected') : sentence(r)),
  triage_queue: (r) => (r.status !== 'done' ? sentence(r) : `Checked ${fmt.int(r.total)}${r.recomposed ? ` and recomposed ${r.recomposed}` : ''}: ${fmt.int(r.kept)} new, ${fmt.int(r.routed)} to files, ${fmt.int(r.dropped)} dropped, ${fmt.int(r.merged)} merged, ${fmt.int(r.suggested)} fixes (${fmt.usd(r.cost)})`),
  dismiss: (r) => (r.status === 'dismissed' ? 'Dismissed' : sentence(r)),
  resolve_conflict: (r) => (r.status === 'composed' ? `Composed as a change to approve: ${r.title}` : r.status === 'rejected_by_user' ? 'The current rule stands' : sentence(r)),
  restore: (r) => (r.status === 'restored' ? 'Back in the inbox' : sentence(r)),
  approve_many: (r) => (r.status === 'changed' ? `The inbox changed: ${fmt.plural(r.total, 'entry', 'entries')} match now. Nothing was decided; check and confirm again.`
    : `Saved ${fmt.int(r.saved)} of ${fmt.int(r.total)}${r.other ? `; ${fmt.int(r.other)} not saved (already known, stale, or over a budget)` : ''}`),
  reject_many: (r) => (r.status === 'changed' ? `The inbox changed: ${fmt.plural(r.total, 'entry', 'entries')} match now. Nothing was decided; check and confirm again.` : `Rejected ${fmt.int(r.rejected)}`),
};
const BAD = ['conflict', 'error', 'not_found', 'nothing', 'ambiguous', 'stale', 'rejected', 'over_budget', 'refused', 'invalid', 'changed', 'budget'];

/** The row or card a control belongs to, and the ones after it, for focus after an action. */
function focusCandidates(btn) {
  const own = btn.closest('[data-entry]');
  if (!own) return [];
  const all = [...view.querySelectorAll('[data-entry]')];
  const i = all.indexOf(own);
  return [own, ...all.slice(i + 1), ...all.slice(0, i).reverse()].map((e) => e.dataset.entry);
}

/**
 * A button that runs an action; `confirmText` asks for a second click first (it stays
 * armed until the user clicks elsewhere or presses Escape).
 */
function actionButton(label, action, id, { confirmText, title, variant = '', iconName, small = false, busyText, fk } = {}) {
  const btn = h('button', { class: `btn ${variant}${small ? ' small' : ''}`, type: 'button', title, 'data-fk': fk || `act:${action}:${typeof id === 'object' ? JSON.stringify(id) : id}` });
  const paint = (text) => btn.replaceChildren(...(iconName ? [icon(iconName)] : []), text);
  paint(label);
  let armed = false;
  const disarm = () => {
    if (!armed) return;
    armed = false;
    paint(label);
    btn.classList.remove('armed');
  };
  btn.addEventListener('blur', disarm);
  btn.addEventListener('keydown', (e) => { if (e.key === 'Escape' && armed) { e.preventDefault(); disarm(); } });
  btn.addEventListener('click', async () => {
    if (confirmText && !armed) {
      armed = true;
      paint(confirmText);
      btn.classList.add('armed');
      return;
    }
    armed = false;
    btn.classList.remove('armed');
    const candidates = focusCandidates(btn);
    const ownKey = btn.dataset.fk;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    if (busyText) paint(busyText);
    try {
      const r = await act(action, id);
      toast(ACTION_LABEL[action](r), BAD.includes(r.status));
      await render({ keepScroll: true, focus: { fk: ownKey, entries: candidates } });
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
    h('div', {}, h('h1', { tabindex: '-1' }, title), text ? h('p', {}, text) : null),
    right.filter(Boolean).length ? h('div', { class: 'btn-row' }, ...right) : null);
}

function sectionHead(title, text, ...right) {
  return h('div', { class: 'section-head' },
    h('div', {}, h('h2', {}, title), text ? h('p', {}, text) : null),
    right.filter(Boolean).length ? h('div', { class: 'btn-row' }, ...right) : null);
}

function segmented(options, current, onPick, label) {
  return h('div', { class: 'segmented', role: 'group', 'aria-label': label }, options.map(([value, text, n]) =>
    h('button', { type: 'button', 'aria-pressed': String(current === value), 'data-fk': `seg:${label}:${value}`, onclick: () => onPick(value) },
      text, n !== undefined && n !== null ? h('span', { class: 'n' }, fmt.int(n)) : null)));
}

function selectControl(value, options, label, onChange, { fk } = {}) {
  const el = h('select', { 'aria-label': label, 'data-fk': fk || `select:${label}` },
    options.map(([v, text]) => h('option', { value: v, selected: v === value }, text)));
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

/** The Project filter shared by Inbox, Knowledge and Activity (kept in the URL). */
function projectFilter() {
  if (state.projects.length < 2 && !param('project')) return null;
  return selectControl(param('project'), [['', 'All projects'], ...state.projects.map((p) => [p.id, p.name])], 'Project',
    (v) => go({ set: { project: v, offset: '' } }));
}

function searchBox(value, placeholder, onSearch, fk) {
  const input = h('input', { type: 'search', value, placeholder, 'aria-label': placeholder, 'data-fk': fk, autocomplete: 'off', spellcheck: 'false' });
  const run = debounce(() => onSearch(input.value.trim()), SEARCH_DEBOUNCE_MS);
  input.addEventListener('input', run);
  return input;
}

// ---------- paged lists ----------
/** Focus a row (or its own heading) after it appears. */
function focusRow(el) {
  if (!el) return;
  const target = el.querySelector('[data-row-focus]') || el;
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: 'nearest' });
}

/**
 * A list the server pages: the first page is given, "Load more" fetches the next one.
 * `list` is the element rows go into (a <ul>, a <tbody>, a grid); `key` remembers how many
 * rows were loaded so a re-render after an action keeps them.
 */
function paged({ key, first, load, list, row, size = PAGE, noun = ['item', 'items'] }) {
  let shown = 0;
  let total = first.total;
  const status = h('span', { class: 'list-status', role: 'status' });
  const more = h('button', { class: 'btn small', type: 'button', 'data-fk': `more:${key}` }, 'Load more');
  const foot = h('div', { class: 'list-foot' }, status, more);
  const add = (rows) => {
    const els = rows.map(row).filter(Boolean);
    list.append(...els);
    shown += rows.length;
    return els;
  };
  // A list that fits on its first page needs no footer; one that was paged keeps its count.
  let paged = false;
  const paint = () => {
    status.textContent = shown < total ? `Showing ${fmt.int(shown)} of ${fmt.int(total)}` : `All ${fmt.int(total)} ${total === 1 ? noun[0] : noun[1]} shown`;
    more.hidden = shown >= total;
    foot.hidden = !total || (!paged && shown >= total);
  };
  add(first.rows);
  paged = shown < total;
  paint();
  more.addEventListener('click', async () => {
    // Busy, not disabled: a disabled button would drop keyboard focus to the page.
    if (more.getAttribute('aria-busy') === 'true') return;
    more.setAttribute('aria-busy', 'true');
    more.textContent = 'Loading…';
    try {
      const r = await load(shown, size);
      total = r.total;
      const els = add(r.rows);
      state.loaded[key] = shown;
      paint();
      if (more.hidden) focusRow(els[0]);
    } catch (err) {
      toast(`Could not load more: ${err.message}`, true);
    } finally {
      more.removeAttribute('aria-busy');
      more.textContent = 'Load more';
    }
  });
  return foot;
}

/** How many rows to ask for first: a page, or what was loaded before a re-render. */
const firstLimit = (key, size = PAGE) => Math.min(500, Math.max(size, state.loaded[key] || 0));

/**
 * A table with optional server-side sorting: columns with `sort` get a button in the
 * header and `aria-sort`. Cells carry their column label for the stacked mobile layout.
 */
function dataTable(columns, { sort, dir, onSort, stack = false, fkPrefix = 'sort' } = {}) {
  const tbody = h('tbody');
  const head = h('tr', {}, columns.map((c) => {
    const cls = c.num ? 'num' : c.cls || null;
    if (!c.sort) return h('th', { class: cls, scope: 'col' }, c.label);
    const active = sort === c.sort;
    const nextDir = active ? (dir === 'asc' ? 'desc' : 'asc') : c.firstDir || 'desc';
    return h('th', { class: cls, scope: 'col', 'aria-sort': active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none' },
      h('button', { class: 'sort', type: 'button', 'data-fk': `${fkPrefix}:${c.sort}`, onclick: () => onSort(c.sort, nextDir) },
        c.label, icon(active ? (dir === 'asc' ? 'sortUp' : 'sortDown') : 'sortBoth')));
  }));
  const row = (r) => h('tr', { 'data-entry': r._key || null },
    columns.map((c, i) => h('td', { class: [c.num ? 'num' : c.cls || '', i === 0 ? 'lead' : ''].join(' ').trim() || null, 'data-label': c.label || null }, c.render(r))));
  const el = h('div', { class: 'table-wrap' }, h('table', { class: stack ? 'stack' : null }, h('thead', {}, head), tbody));
  return { el, tbody, row };
}

// ---------- bar chart ----------
// Single series, vertical bars, 4px rounded data end, recessive grid, per-bar tooltip
// (hover and keyboard focus) and a table view so no value is hover-only. The bars are one
// tab stop: arrow keys move between days, each bar names its day and value.
function barChart({ title, sub, data, value, format, tip, emptyText = 'No data in this period', marker = null, height = 170, wide = false }) {
  const holder = h('div');
  const wrap = h('div', { class: `panel chart${wide ? ' wide' : ''}` },
    h('div', { class: 'chart-head' }, h('h3', {}, title), sub ? h('span', { class: 'sub' }, sub) : null), holder);
  let focusedDay = null;

  const draw = () => {
    const width = Math.max(240, holder.clientWidth || 600);
    const pad = { top: 8, right: 4, bottom: 22, left: 36 };
    const values = data.map(value);
    const max = Math.max(0, ...values.filter((v) => v !== null));
    const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, height, role: max ? 'group' : 'img', 'aria-label': max ? `${title}, by day. Arrow keys move between days.` : `${title}: ${emptyText}` });
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    if (!max) {
      svg.append(s('line', { x1: pad.left, x2: width - pad.right, y1: pad.top + innerH, y2: pad.top + innerH, stroke: 'var(--grid)' }),
        s('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'empty-text', 'aria-hidden': 'true' }, emptyText));
      holder.replaceChildren(svg);
      return;
    }
    const nice = niceMax(max);
    const integers = values.every((v) => v === null || Number.isInteger(v));
    const ticks = integers && nice <= 2 ? [0, nice] : [0, nice / 2, nice];
    const grid = s('g', { class: 'grid', 'aria-hidden': 'true' });
    const axis = s('g', { class: 'axis', 'aria-hidden': 'true' });
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
    const bars = [];
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
        class: 'bar', tabindex: -1, role: 'img', 'data-fk': `bar:${title}:${d.day}`,
        'aria-label': `${fmt.day(d.day)}: ${format(v)}. ${tip(d).slice(1).join('. ')}`,
        d: bh <= 0 ? `M${x},${y0} H${x + bw}` : `M${x},${y0} V${y0 - bh + r} Q${x},${y0 - bh} ${x + r},${y0 - bh} H${x + bw - r} Q${x + bw},${y0 - bh} ${x + bw},${y0 - bh + r} V${y0} Z`,
      });
      bar.dataset.day = d.day;
      const hit = s('rect', { class: 'hit', x: pad.left + step * i, y: pad.top, width: step, height: innerH, 'aria-hidden': 'true' });
      const show = () => showTip(bar, h('strong', {}, format(v)), ...tip(d).map((t) => h('div', { class: 'muted' }, t)));
      for (const el of [bar, hit]) {
        el.addEventListener('pointerenter', show);
        el.addEventListener('pointerleave', hideTip);
      }
      bar.addEventListener('focus', () => { focusedDay = d.day; show(); });
      bar.addEventListener('blur', hideTip);
      svg.append(hit, bar);
      bars.push(bar);
    });
    // Roving tab stop: the last day with data (or the one last focused) is the one Tab reaches.
    const current = bars.find((b) => b.dataset.day === focusedDay) || bars[bars.length - 1];
    if (current) current.setAttribute('tabindex', '0');
    svg.addEventListener('keydown', (e) => {
      const i = bars.indexOf(document.activeElement);
      if (i < 0) return;
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: bars.length - 1 }[e.key];
      if (next === undefined || !bars[next]) return;
      e.preventDefault();
      bars[i].setAttribute('tabindex', '-1');
      bars[next].setAttribute('tabindex', '0');
      bars[next].focus();
    });
    const mi = marker ? data.findIndex((d) => d.day === marker.day) : -1;
    if (mi >= 0) {
      const mx = pad.left + step * mi;
      svg.append(
        s('line', { class: 'marker', x1: mx, x2: mx, y1: pad.top, y2: pad.top + innerH, 'aria-hidden': 'true' }),
        // Near the right edge the label sits to the left of the rule.
        mx > width - 90
          ? s('text', { class: 'marker-label', x: mx - 4, y: pad.top + 10, 'text-anchor': 'end', 'aria-hidden': 'true' }, marker.label)
          : s('text', { class: 'marker-label', x: mx + 4, y: pad.top + 10, 'aria-hidden': 'true' }, marker.label));
    }
    const hadFocus = holder.contains(document.activeElement);
    holder.replaceChildren(svg);
    if (hadFocus) current?.focus();
  };
  requestAnimationFrame(draw);
  let lastWidth = 0;
  new ResizeObserver(() => { if (holder.clientWidth !== lastWidth) { lastWidth = holder.clientWidth; draw(); } }).observe(holder);
  wrap.append(h('details', { class: 'table-view', 'data-dk': `table:${title}` }, h('summary', {}, 'Show as table'),
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
function itemTitle(text, cls = 'item-title') {
  return h('h4', { class: cls, tabindex: '-1', 'data-row-focus': '' }, text);
}

function conflictCard(c) {
  const target = c.target ? fileLabel(c.target) : null;
  return h('article', { class: 'item attention', 'data-entry': c.key },
    itemTitle(c.title),
    h('div', { class: 'item-meta' },
      pill('Conflict', 'warn', 'warn'),
      target ? h('span', { title: tilde(c.target) }, 'with ', h('span', { class: 'mono' }, `${target.dir}${target.name}`)) : null,
      h('span', {}, `${projectName(c)} · ${fmt.datetime(c.session_started_at)}`)),
    h('div', { class: 'item-body' }, clampText(c.claim || c.summary)),
    c.note ? h('div', { class: 'item-reason' }, h('b', {}, 'Why it conflicts: '), reasonOf(c.note)) : null,
    c.evidence ? keyed(disclose('Evidence', h('div', { class: 'evidence' }, c.evidence)), `ev:${c.key}`) : null,
    h('div', { class: 'item-foot' },
      h('div', { class: 'btn-row' },
        actionButton('It is a new rule', 'resolve_conflict', `${c.id}:new`, { variant: 'primary', busyText: 'Composing…', title: 'Write it, correcting what the file says now. It comes back as a change to approve.' }),
        actionButton('Keep the current rule', 'resolve_conflict', `${c.id}:keep`, { title: 'Reject this learning' })),
      h('span', { class: 'small faint' }, 'A new rule comes back as a change for you to approve.')));
}

function changeCard(c) {
  const f = fileLabel(c.file);
  const stale = c.status === 'stale';
  return h('article', { class: `item${stale || c.changed ? ' attention' : ''}`, 'data-entry': c.key },
    h('h4', { class: 'item-title file-title', tabindex: '-1', 'data-row-focus': '' }, h('span', { class: 'dir' }, f.dir), f.name),
    h('div', { class: 'item-meta' },
      c.corrects ? pill('Correction', 'warn', 'warn') : pill('Addition', 'accent', 'info'),
      h('span', {}, KIND_NAME[c.kind] || c.kind),
      h('span', {}, fmt.plural(c.claims.length, 'learning')),
      h('span', {}, fmt.datetime(c.session_started_at || c.created_at))),
    h('div', { class: 'path', title: c.file }, tilde(c.file)),
    stale ? h('div', { class: 'callout' }, icon('alert'), h('div', {}, h('b', {}, 'Needs a new check. '), c.note || 'The file changed since this was composed.'))
      : c.changed ? h('div', { class: 'callout' }, icon('alert'), 'The file changed since this was composed. Approving re-applies the edits if they still fit.') : null,
    h('div', { class: 'diffs' }, c.edits.map(editDiff)),
    h('ol', { class: 'claims', 'aria-label': 'Learnings behind this change' }, c.claims.map((l, i) => h('li', {},
      h('span', { class: 'n' }, `${i + 1}.`),
      h('div', { class: 'claim-text' }, l.claim || l.title, l.note ? h('div', { class: 'small muted' }, reasonOf(l.note)) : null),
      c.claims.length > 1
        ? actionButton('Remove', 'reject', String(l.id), { variant: 'quiet', small: true, confirmText: 'Remove it?', title: 'Reject this learning; the rest of the change is composed again without it' })
        : h('span'),
      l.evidence ? h('div', { class: 'claim-extra' }, keyed(disclose('Evidence', h('div', { class: 'evidence' }, l.evidence)), `ev:${c.key}:${l.id}`)) : null))),
    h('div', { class: 'item-foot' },
      h('div', { class: 'btn-row' },
        stale ? null : actionButton('Approve change', 'approve', c.key, { variant: 'primary', iconName: 'check' }),
        actionButton('Reject', 'reject', c.key, { confirmText: 'Reject the whole change?' })),
      c.note && !stale ? h('span', { class: 'small faint' }, c.note) : null));
}

function itemCard(q) {
  const kind = q.memory_type ? `${q.kind} · ${q.memory_type}` : q.kind;
  return h('article', { class: 'item', 'data-entry': q.key },
    itemTitle(q.title || q.target || '(untitled)'),
    h('div', { class: 'item-meta' },
      pill(`New ${kind}`, 'accent', 'info'),
      h('span', {}, `${projectName(q)} · ${fmt.datetime(q.session_started_at || q.ts)}`),
      confidence(q.confidence),
      q.triaged_at ? null : pill('Not checked yet', '', 'warn')),
    q.target ? h('div', { class: 'path', title: q.target }, tilde(q.target)) : null,
    q.description && q.description !== q.summary ? h('div', { class: 'item-reason' }, q.description) : null,
    h('div', { class: 'item-body' }, clampText(q.summary)),
    q.note ? h('div', { class: 'item-reason' }, reasonOf(q.note)) : null,
    q.evidence ? keyed(disclose('Evidence', h('div', { class: 'evidence' }, q.evidence)), `ev:${q.key}`) : null,
    h('div', { class: 'item-foot' },
      h('div', { class: 'btn-row' },
        actionButton('Approve', 'approve', q.key, { variant: 'primary', iconName: 'check' }),
        actionButton('Reject', 'reject', q.key, { confirmText: 'Reject it?' }))));
}

function fixRow(f) {
  return h('li', { 'data-entry': f.key },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title', tabindex: '-1', 'data-row-focus': '' }, reasonOf(f.note) || f.title),
      h('div', { class: 'small faint' }, `Instead of learning “${f.title}” · ${projectName(f)}`)),
    h('div', { class: 'btn-row' },
      actionButton('Done or not needed', 'dismiss', f.id, { small: true, title: 'Remove it from the inbox' }),
      actionButton('Learn it instead', 'restore', f.id, { small: true, variant: 'quiet', title: 'Treat it as a learning after all' })));
}

const CARD = { conflict: conflictCard, change: changeCard, item: itemCard };

function inboxGroup(g) {
  const fixes = g.id.endsWith('|fixes');
  const list = fixes ? h('ul', { class: 'rows' }) : h('div', { class: 'items' });
  const key = `inbox:${g.id}`;
  const foot = paged({
    key, first: { rows: g.entries, total: g.total }, list, size: PAGE, noun: ['entry', 'entries'],
    row: (e) => (fixes ? fixRow(e) : CARD[e.type]?.(e)),
    load: (offset, limit) => api('inbox', { group: g.id, offset, limit }),
  });
  // A group of one change needs no heading: the card names its file.
  const lone = g.total === 1 && g.types.change === 1;
  const label = g.file
    ? h('span', { class: 'group-file', title: g.path }, h('span', { class: 'dir' }, fileLabel(g.file).dir), fileLabel(g.file).name)
    : g.label;
  const head = lone ? null : h('div', { class: 'group-head' },
    h('h3', {}, label, h('span', { class: 'group-n' }, fmt.int(g.total))),
    h('div', { class: 'btn-row' },
      g.approvable > 1 ? actionButton(`Approve ${fmt.int(g.approvable)}`, 'approve_many', { group: g.id, expect: g.approvable }, { small: true, confirmText: `Save all ${fmt.int(g.approvable)}?`, title: 'Approve every new item and ready change in this group' }) : null,
      g.rejectable > 1 ? actionButton(`Reject ${fmt.int(g.rejectable)}`, 'reject_many', { group: g.id, expect: g.rejectable }, { small: true, variant: 'quiet', confirmText: `Reject all ${fmt.int(g.rejectable)}?` }) : null));
  const body = fixes ? h('div', { class: 'panel' }, list) : list;
  return h('div', { class: 'group', 'data-entry': `g:${g.id}` }, head, body, foot);
}

async function renderInbox() {
  const project = param('project');
  const data = await api('inbox', { project, per: INBOX_PER_GROUP });
  // Groups the user expanded with "Load more" stay expanded after an action.
  await Promise.all(data.projects.flatMap((p) => p.groups).map(async (g) => {
    const want = state.loaded[`inbox:${g.id}`] || 0;
    if (want > g.entries.length && g.entries.length < g.total) {
      const more = await api('inbox', { group: g.id, offset: g.entries.length, limit: Math.min(500, want - g.entries.length) });
      g.entries.push(...more.rows);
    }
  }));
  const scope = project ? { project, expect: data.approvable } : { expect: data.approvable };
  const head = pageHead('Inbox', 'Learnings that wait for your decision, by project and then by file, oldest session first. Nothing here is written until you approve it.',
    data.unchecked ? actionButton(`Check ${fmt.int(data.unchecked)} against knowledge`, 'triage_queue', false, { iconName: 'refresh', busyText: 'Checking…', title: 'Screen new proposals with the rubric and compose the changes to each file' }) : null,
    data.approvable > 1 ? actionButton(`Approve all ${fmt.int(data.approvable)}`, 'approve_many', scope, { confirmText: `Save all ${fmt.int(data.approvable)}?`, title: project ? 'Every new item and ready change of this project' : 'Every new item and ready change' }) : null,
    data.rejectable > 1 ? actionButton(`Reject all ${fmt.int(data.rejectable)}`, 'reject_many', { ...scope, expect: data.rejectable }, { variant: 'quiet', confirmText: `Reject all ${fmt.int(data.rejectable)}?` }) : null);

  const filter = projectFilter();
  const c = data.counts;
  const summary = h('p', { class: 'toolbar-note' }, [[c.conflicts, 'conflict'], [c.changes, 'change to a file', 'changes to files'], [c.items, 'new item'], [c.fixes, 'suggested fix', 'suggested fixes']]
    .filter(([n]) => n).map(([n, one, many]) => fmt.plural(n, one, many)).join(' · '));
  const toolbar = h('div', { class: 'toolbar' }, data.total ? summary : h('span'), filter);

  if (!data.total) {
    return [head, filter ? toolbar : null, h('div', { class: 'panel' }, emptyState(project ? 'Nothing waits in this project' : 'All caught up',
      'Learnings land here when your autonomy setting holds them for approval, when they would change a rule file or CLAUDE.md, or when they contradict a rule already written. Everything saved shows up in Knowledge.'))];
  }

  const legend = keyed(disclose('What each kind of entry means', h('dl', { class: 'legend' },
    h('dt', {}, 'Conflict'), h('dd', {}, 'Contradicts a rule already written, or another learning, and nothing in the project settles which is right. Nothing was written.'),
    h('dt', {}, 'Change to a file'), h('dd', {}, 'Every learning for one file gathered into one edit, shown as a diff. Approving applies it to the current file; Undo in Knowledge reverts it.'),
    h('dt', {}, 'New item'), h('dd', {}, 'A new memory or skill. No existing file owned its topic.'),
    h('dt', {}, 'Suggested fix'), h('dd', {}, 'A workaround the project could remove with one change. It is not learned; fix it, or learn it anyway.'))), 'inbox:legend');

  const strip = data.projects.length > 1 ? h('nav', { class: 'summary-strip', 'aria-label': 'Projects in the inbox' }, data.projects.map((p) =>
    h('a', { href: hashOf('inbox', `p-${p.id || 'none'}`, state.nav.params), onclick: (e) => { e.preventDefault(); jumpTo(`p-${p.id || 'none'}`); } },
      h('b', {}, fmt.int(p.total)), p.name))) : null;

  const sections = data.projects.map((p) => h('section', { class: 'section project-section', id: `p-${p.id || 'none'}` },
    sectionHead(p.name, p.path && p.path !== p.name ? p.path : null),
    p.groups.map(inboxGroup)));
  return [head, toolbar, legend, strip, ...sections];
}

/** Scroll to an anchor inside the page (the Inbox's projects) and move focus to its heading. */
function jumpTo(id) {
  const el = document.getElementById(id);
  if (!el) return;
  history.replaceState(null, '', hashOf(state.nav.tab, id, state.nav.params));
  state.nav.sub = id;
  el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  const heading = el.querySelector('h2');
  if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
}

// ---------- Overview ----------
async function overviewData() {
  return settle([api('overview', { days: state.days }), api('value', { days: state.days }), api('recent', { limit: 8 })]);
}

async function renderOverview() {
  const [o, v, recentData] = await overviewData();
  state.overviewSig = JSON.stringify([o, v, recentData].map((x) => (failed(x) ? String(x) : x)));
  if (failed(o)) throw o;
  const learnedTotal = (o.learned.memory || 0) + (o.learned.skill || 0);
  const waiting = inboxTotal();

  const banner = waiting ? h('div', { class: 'banner' },
    h('div', { class: 't' }, icon('inbox'), `${fmt.plural(waiting, 'item')} wait for your decision`),
    h('a', { class: 'btn primary small', href: '#inbox' }, 'Open inbox', icon('arrow'))) : null;

  let verdict;
  if (failed(v)) verdict = sectionError(v, 'the before/after comparison');
  else {
    const delta = v.before.rate !== null && v.after.rate !== null ? v.after.rate - v.before.rate : null;
    // A delta on a few dozen turns is noise: it stays neutral until the sample is big enough.
    const enough = v.after.turns >= MIN_SAMPLE_TURNS;
    let text;
    if (!v.enabledAt) text = 'Nothing has been learned yet, so this is the baseline: how often you corrected Claude before learning.';
    else if (v.after.rate === null) text = 'Learning is on, but no session after it has been reviewed yet.';
    else if (!enough) text = `Too early to tell: ${fmt.plural(v.after.turns, 'turn')} reviewed since learning turned on; the comparison needs at least ${fmt.int(MIN_SAMPLE_TURNS)}.`;
    else if (delta < 0) text = `You correct Claude ${fmt.rate(Math.abs(delta))} fewer times per 100 turns than before learning turned on.`;
    else text = 'Not lower yet. Give it more sessions, and check Misses: repeated corrections mean a learning is not being used.';
    const tone = !enough || delta === null ? '' : delta < 0 ? 'good' : 'warn';
    verdict = h('div', { class: 'panel verdict' },
      h('div', { class: 'verdict-main' },
        h('div', { class: 'label' }, 'Corrections per 100 turns'),
        h('div', { class: 'verdict-figures' },
          v.enabledAt ? h('div', { class: 'figure before' }, h('div', { class: 'v' }, fmt.rate(v.before.rate)), h('div', { class: 'k' }, `before · n = ${fmt.int(v.before.turns)} turns`)) : null,
          v.enabledAt ? h('div', { class: 'figure' }, h('div', { class: 'v' }, fmt.rate(v.after.rate)), h('div', { class: 'k' }, `since ${fmt.date(v.enabledAt)} · n = ${fmt.int(v.after.turns)} turns`))
            : h('div', { class: 'figure' }, h('div', { class: 'v' }, fmt.rate(o.correctionRate)), h('div', { class: 'k' }, `n = ${fmt.int(o.reviewed.turns)} reviewed turns`)),
          delta !== null ? h('span', { class: `delta${tone ? '' : ' neutral'}`, title: enough ? null : `Not judged below ${MIN_SAMPLE_TURNS} turns after learning` },
            h('span', { class: `dot ${tone}` }), `${delta > 0 ? '+' : ''}${delta.toFixed(1)}`, enough ? null : h('span', { class: 'delta-note' }, 'small sample')) : null),
        h('p', { class: 'sentence' }, text)),
      h('div', { class: 'stats' },
        stat('Learned', fmt.int(learnedTotal), `${o.learned.memory || 0} memories · ${o.learned.skill || 0} skills${o.learned.patchedNative ? ` · ${o.learned.patchedNative} refined` : ''}`),
        stat('Sessions using a learning', v.sessions ? fmt.pct((v.hits / v.sessions) * 100) : '—', `${fmt.int(v.hits)} of ${fmt.plural(v.sessions, 'session')}`),
        stat('Misses', fmt.int(o.misses), `times you repeated something already saved, in the last ${o.days} days`),
        h('div', { class: 'stat' },
          h('div', { class: 'k' }, 'Reviewer cost this month'),
          h('div', { class: 'v' }, fmt.usd(o.cost.month)),
          o.cost.budget ? meter(o.cost.month, o.cost.budget, { label: 'Monthly budget used' }) : null,
          h('div', { class: 'd' }, o.cost.budget ? `of ${fmt.usd(o.cost.budget)} monthly budget` : 'budget not reported yet'))));
  }

  const marker = !failed(v) && v.enabledAt ? { day: dayOf(v.enabledAt), label: 'learning on' } : null;
  const rate = (d) => (d.reviewedTurns ? (d.corrections / d.reviewedTurns) * 100 : null);
  const charts = h('div', { class: 'charts' },
    barChart({ title: 'Corrections per 100 turns', sub: 'by the day the session started; lower is better', data: o.series, value: rate, format: (x) => x.toFixed(x > 0 && x < 10 ? 1 : 0), marker, wide: true, height: 200,
      tip: (d) => [fmt.day(d.day), `${d.corrections} corrections · ${d.reviewedTurns} turns reviewed`], emptyText: 'No reviewed sessions in this period' }),
    failed(v) ? sectionError(v, 'this chart') : barChart({ title: 'Sessions using a learning', data: v.series, value: (d) => d.hits, format: (x) => fmt.int(x), marker,
      tip: (d) => [fmt.day(d.day), `${d.hits} of ${d.sessions} sessions`] }),
    barChart({ title: 'User turns', data: o.series, value: (d) => d.turns, format: (x) => fmt.compact(x),
      tip: (d) => [fmt.day(d.day), fmt.plural(d.sessions, 'session')] }));

  const opLabel = { create: 'Learned', patch: 'Updated', archive: 'Archived', consolidate: 'Consolidated', revert: 'Reverted' };
  let recent;
  if (failed(recentData)) recent = sectionError(recentData, 'what was learned recently');
  else {
    const feed = recentData.rows;
    recent = h('div', { class: 'panel' }, feed.length
      ? h('ul', { class: 'feed' }, feed.map((w) => h('li', {},
          h('span', { class: 'when', title: fmt.datetime(w.ts) }, fmt.when(w.ts)),
          h('div', { class: 'what' },
            h('div', { class: w.reverted_at ? 'undone' : '' }, h('b', {}, `${opLabel[w.op] || w.op} `), w.title || '(untitled)'),
            h('div', { class: 'path' }, w.path, w.reverted_at ? ' · undone' : '')))))
      : emptyState('Nothing learned yet', 'When a review saves something, or you approve an item in the inbox, it shows up here.', 'info'));
  }

  return [
    banner,
    pageHead('Overview', 'Is learning paying off? Fewer corrections and few misses mean yes.'),
    verdict,
    h('section', { class: 'section' }, sectionHead('Trend'), charts),
    h('section', { class: 'section' }, sectionHead('Recently learned', null, h('a', { href: '#knowledge', class: 'btn quiet small' }, 'All learnings', icon('arrow'))), recent),
  ];
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
  if (c.op === 'create') return l?.kind === 'profile' ? 'Profile fact (retired)' : l?.kind === 'skill' ? 'New skill' : `New memory${l?.memory_type ? ` · ${l.memory_type}` : ''}`;
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
  const used = l && l.uses ? `used ${fmt.plural(l.uses, 'time')}${l.last_used_at ? `, last ${fmt.when(l.last_used_at)}` : ''}` : null;
  const wrote = c.files.flatMap((x) => (x.created ? [h('pre', { class: 'diff' }, h('ins', { class: 'line' }, x.text || '(empty)'))]
    : x.removed ? [h('div', { class: 'small muted' }, `Removed ${tilde(x.file)}`)]
      : x.hunks.map(hunkDiff)));
  const origin = ORIGIN[c.actor] || c.actor;
  return h('li', { class: `learned${c.undone || archived ? ' faded' : ''}`, 'data-entry': `b:${c.batch}` },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-title', tabindex: '-1', 'data-row-focus': '' }, c.title),
      h('div', { class: 'item-meta' },
        c.undone ? pill('Undone', 'bad', 'bad') : archived ? pill('Archived', '') : pill(changeKind(c), c.op === 'patch' && /^Correction/.test(changeKind(c)) ? 'warn' : ''),
        f ? h('span', { class: 'mono', title: tilde(main.file) }, `${f.dir}${f.name}`) : null,
        h('span', { title: fmt.datetime(c.ts) }, fmt.when(c.ts)),
        h('span', {}, c.project_name ? `${origin} · ${c.project_name}` : origin),
        used ? h('span', {}, used) : null,
        lifecycleNote(c)),
      c.why ? h('div', { class: 'item-reason' }, clampText(c.why, 'div')) : null,
      wrote.length ? keyed(disclose(c.op === 'create' ? 'What it saved' : 'What it changed', h('div', { class: 'diffs' }, wrote)), `wrote:${c.batch}`) : null),
    h('div', { class: 'btn-row row-actions' },
      !c.undone ? actionButton('Undo', 'undo_batch', c.batch, { small: true, variant: 'quiet', iconName: 'undo', confirmText: 'Undo this change?', title: 'Revert only what this wrote; later edits to the file stay' }) : null,
      c.lifecycle && ['decays', 'kept'].includes(c.lifecycle.state)
        ? actionButton(c.lifecycle.state === 'kept' ? 'Stop keeping' : 'Keep', 'pin', `${l.id}:${c.lifecycle.state === 'kept' ? 'off' : 'on'}`, { small: true, variant: 'quiet', iconName: 'check', fk: `pin:${l.id}`, title: c.lifecycle.state === 'kept' ? 'Let maintenance archive it if it goes unused' : 'Never archive it automatically' })
        : null,
      c.canArchive ? actionButton('Archive', 'forget', l.id, { small: true, variant: 'quiet', iconName: 'archive', confirmText: 'Archive it?', title: 'Stop loading it; restorable with undo' }) : null));
}

const KNOWLEDGE_SEGS = ['learned', 'skills', 'memories', 'instructions', 'graph'];

/** Columns of each inventory list; `sort` names the server-side sort key. */
const INVENTORY_COLUMNS = {
  skills: [
    { label: 'Skill', sort: 'name', firstDir: 'asc', render: (r) => cellMain(h('span', {}, r.name, r.origin ? h('span', { class: 'gap-left' }, pill('learned', 'accent')) : null), r.description, { clamp: true }) },
    { label: 'Project', render: (r) => (r.project_name || h('span', { class: 'faint' }, r.scope === 'plugin' ? 'plugin' : 'everywhere')) },
    { label: 'Uses', num: true, sort: 'uses', render: (r) => fmt.int(r.uses) },
    { label: 'Last used', sort: 'last', render: (r) => (r.lastUsed ? h('span', { title: fmt.datetime(r.lastUsed) }, fmt.when(r.lastUsed)) : h('span', { class: 'faint' }, 'not yet')) },
    { label: 'Description', num: true, render: (r) => `${fmt.int(r.descriptionChars)} chars` },
  ],
  memories: [
    { label: 'Memory', sort: 'name', firstDir: 'asc', render: (r) => cellMain(r.name, r.description, { clamp: true }) },
    { label: 'Type', render: (r) => (r.type ? pill(r.type) : '—') },
    { label: 'Reads', num: true, sort: 'reads', render: (r) => fmt.int(r.reads) },
    { label: 'Updated', sort: 'updated', render: (r) => fmt.date(r.mtime) },
  ],
  instructions: [
    { label: 'File', sort: 'name', firstDir: 'asc', render: (r) => h('span', { class: 'mono', title: r.file }, r.path) },
    { label: 'Project', render: (r) => r.project_name || h('span', { class: 'faint' }, 'everywhere') },
    { label: 'Lines', num: true, sort: 'lines', render: (r) => fmt.int(r.lines) },
    { label: 'Updated', sort: 'updated', render: (r) => fmt.date(r.mtime) },
  ],
};

let knowledgeSeq = 0;

async function renderKnowledge() {
  const seg = KNOWLEDGE_SEGS.includes(state.nav.sub) ? state.nav.sub : 'learned';
  const project = param('project');
  const [counts] = await settle([api('knowledge_counts', { project })]);
  const n = failed(counts) ? {} : counts;

  const results = h('div', { class: 'results' });
  const undoneToggle = seg === 'learned' && n.undone ? h('label', { class: 'check small muted' },
    h('input', { type: 'checkbox', checked: param('undone') === '1', 'data-fk': 'undone', onchange: (e) => { setNav({ set: { undone: e.target.checked ? '1' : '' }, push: false }); fillKnowledge(results, seg); } }),
    h('span', { class: 'undone-label' }, `Show undone (${fmt.int(n.undone)})`)) : null;
  const search = searchBox(param('q'), seg === 'learned' ? 'Filter by title, reason or file' : seg === 'graph' ? 'Find an item' : 'Filter by name, text or path',
    (q) => { setNav({ set: { q }, push: false }); if (seg === 'graph') state.graph?.search(q); else fillKnowledge(results, seg); }, 'search:knowledge');

  const toolbar = h('div', { class: 'toolbar' },
    segmented([['learned', 'Learned', n.learned], ['skills', 'Skills', n.skills], ['memories', 'Memories', n.memories], ['instructions', 'Instruction files', n.instructions], ['graph', 'Graph']],
      seg, (next) => go({ sub: next, keep: false, set: { project } }), 'Knowledge lists'),
    h('div', { class: 'filters' }, projectFilter(), search, undoneToggle));
  await fillKnowledge(results, seg);
  return [
    pageHead('Knowledge', 'What Claude knows on this machine: what Ouroboros learned, and every skill, memory and instruction file it reads.'),
    toolbar,
    results,
  ];
}

/** Fill the results of the current Knowledge list; a newer request wins over a slower older one. */
async function fillKnowledge(results, seg) {
  const seq = ++knowledgeSeq;
  const q = param('q');
  const project = param('project');
  let content;
  try {
    state.graph?.stop();
    state.graph = null;
    content = seg === 'learned' ? await learnedList(q, project) : seg === 'graph' ? await graphList(project) : await inventoryList(seg, q, project);
  } catch (err) {
    content = sectionError(err, 'this list');
  }
  if (seq !== knowledgeSeq) return;
  const focusKey = results.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
  results.replaceChildren(content);
  if (focusKey) results.querySelector(`[data-fk="${CSS.escape(focusKey)}"]`)?.focus();
}

async function learnedList(q, project) {
  const undone = param('undone') === '1' ? '1' : '';
  const key = `learned:${q}:${project}:${undone}`;
  const first = await api('changes', { q, project, undone, limit: firstLimit(key) });
  const label = document.querySelector('.undone-label');
  if (label && !q) label.textContent = `Show undone (${fmt.int(first.undone)})`;
  if (!first.total) {
    return h('div', { class: 'panel' }, h('div', { class: 'empty' }, h('p', {}, q || project ? 'No learning matches the filter.' : 'Nothing learned yet. Ask Claude to remember something, or approve items in the inbox.')));
  }
  const list = h('ul', { class: 'rows learned-list' });
  const foot = paged({ key, first, list, row: learnedRow, noun: ['learning', 'learnings'], load: (offset, limit) => api('changes', { q, project, undone, offset, limit }) });
  return h('div', { class: 'panel' }, list, foot,
    h('div', { class: 'table-note' }, 'One row per thing learned. Undo reverts only what that row wrote; Archive stops loading something Ouroboros created; Keep stops maintenance from archiving it when unused. All reversible.'));
}

async function inventoryList(kind, q, project) {
  const sort = param('sort') || 'name';
  const dir = param('dir') || (sort === 'name' ? 'asc' : 'desc');
  const data = await api('inventory', { kind, q, project, sort, dir, per: 20 });
  if (!data.total) {
    const noun = { skills: 'skill', memories: 'memory', instructions: 'instruction file' }[kind];
    return h('div', { class: 'panel' }, h('div', { class: 'empty' }, h('p', {}, q || project ? `No ${noun} matches the filter.` : `No ${noun} found.`)));
  }
  const onSort = (key, d) => { setNav({ set: { sort: key, dir: d }, push: false }); fillKnowledge(document.querySelector('.results'), kind); };
  return h('div', { class: 'groups' }, data.groups.map((g) => {
    const t = dataTable(INVENTORY_COLUMNS[kind], { sort, dir, onSort, fkPrefix: `sort:${g.id}` });
    const key = `inv:${kind}:${g.id}:${q}:${project}:${sort}:${dir}`;
    const foot = paged({
      key, first: g, list: t.tbody, row: t.row, size: PAGE, noun: [{ skills: 'skill', memories: 'memory', instructions: 'file' }[kind], { skills: 'skills', memories: 'memories', instructions: 'files' }[kind]],
      load: (offset, limit) => api('inventory', { kind, q, project, sort, dir, group: g.id, offset, limit }),
    });
    return h('details', { class: 'panel group-panel', open: true, 'data-dk': `inv:${kind}:${g.id}` },
      h('summary', {}, h('span', { class: 'group-label' }, g.label), h('span', { class: 'group-n' }, fmt.int(g.total))),
      t.el, foot);
  }));
}

// ---------- Knowledge › Graph ----------
const GRAPH_KINDS = [
  ['skill', 'Skills'], ['reference', 'Reference files'], ['memory', 'Memories'],
  ['instructions', 'CLAUDE.md'], ['rules', 'Rule files'], ['project', 'Projects'],
];
const GRAPH_KIND_ONE = { skill: 'skill', reference: 'reference file', memory: 'memory', instructions: 'CLAUDE.md', rules: 'rule file', project: 'project' };
const GRAPH_EDGES = [
  ['link', 'Links', 'An explicit [[link]] or markdown link between two files'],
  ['mention', 'Mentions', 'A file names a skill'],
  ['contains', 'Contains', 'A skill and its reference files'],
  ['used', 'Used together', 'Used in the same sessions, at least twice'],
  ['similar', 'Similar', 'Close wording: a hint, not a relation'],
  ['belongs', 'Project', 'The project an item belongs to'],
];
/** How an edge reads from the selected item's side: [outgoing, incoming]. */
const EDGE_READS = {
  link: ['Links to', 'Linked from'], mention: ['Names', 'Named by'], contains: ['Contains', 'Part of'],
  used: ['Used together with', 'Used together with'], similar: ['Similar wording', 'Similar wording'], belongs: ['Project', 'In this project'],
};
const GRAPH_HEIGHT = { wide: 640, narrow: 440 };
const ZOOM_MIN = 0.2;
const ZOOM_MAX = 4;
/** Above this zoom every skill and memory shows its name, not only hubs and the focused ones. */
const ZOOM_LABELS = 1.5;
/** Layout work per animation frame, and before the first paint. */
const FRAME_BUDGET_MS = 6;
const WARMUP_MS = 60;

const listParam = (k) => new Set(param(k).split(',').filter(Boolean));

function nodeRadius(n) {
  if (n.kind === 'project') return 11;
  const base = { skill: 6.5, reference: 3.5, memory: 5.5, instructions: 6, rules: 4.5 }[n.kind] || 5;
  return Math.min(base + Math.sqrt(n.uses || 0) * 0.9 + Math.min(n.degree || 0, 12) * 0.15, 15);
}

/** Where an item lives in the Knowledge lists, to see it there. */
function knowledgeLink(n) {
  const seg = { skill: 'skills', memory: 'memories', instructions: 'instructions' }[n.kind];
  if (!seg) return null;
  return hashOf('knowledge', seg, new URLSearchParams({ q: n.kind === 'instructions' ? n.path : n.name }));
}

async function graphList(project) {
  const plugins = param('plugins') === 'all' ? 'all' : '';
  const data = await api('graph', { project, plugins });
  if (!data.stats.items) {
    return h('div', { class: 'panel' }, h('div', { class: 'empty' }, h('p', {}, project ? 'Nothing Claude knows belongs to this project yet.' : 'Nothing to draw yet: no skill, memory or instruction file was found.')));
  }
  return graphView(data);
}

/**
 * The graph page: filters, the drawing and a side panel with the selected item (or a
 * summary). Everything the drawing shows is also reachable from the panel's lists, so the
 * page works with a keyboard and a screen reader.
 */
function graphView(data) {
  const hideKinds = listParam('hide');
  const hideEdges = listParam('off');
  const wrap = h('div', { class: 'graph-page' });

  const kindChips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Kinds of items' }, GRAPH_KINDS
    .filter(([k]) => data.nodes.some((n) => n.kind === k))
    .map(([k, label]) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(!hideKinds.has(k)), 'data-fk': `kind:${k}`,
      onclick: () => { toggleIn('hide', k); paint(); },
    }, h('span', { class: `swatch k-${k}` }), label, h('span', { class: 'n' }, fmt.int(data.nodes.filter((n) => n.kind === k).length)))));
  const edgeChips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Kinds of connections' }, GRAPH_EDGES
    .filter(([t]) => data.stats.edges[t])
    .map(([t, label, tip]) => h('button', {
      type: 'button', class: 'chip', title: tip, 'aria-pressed': String(!hideEdges.has(t)), 'data-fk': `edge:${t}`,
      onclick: () => { toggleIn('off', t); paint(); },
    }, s('svg', { class: 'edge-sample', viewBox: '0 0 18 6', 'aria-hidden': 'true' }, s('line', { x1: 1, y1: 3, x2: 17, y2: 3, class: `e-${t}` })), label, h('span', { class: 'n' }, fmt.int(data.stats.edges[t])))));
  const pluginsToggle = h('label', { class: 'check small muted', title: 'Plugin skills nothing here uses or names are left out by default' },
    h('input', { type: 'checkbox', checked: param('plugins') === 'all', 'data-fk': 'plugins', onchange: (e) => { setNav({ set: { plugins: e.target.checked ? 'all' : '' }, push: false }); fillKnowledge(document.querySelector('.results'), 'graph'); } }),
    'All plugin skills');

  function toggleIn(key, value) {
    const set = listParam(key);
    if (set.has(value)) set.delete(value); else set.add(value);
    setNav({ set: { [key]: [...set].join(',') }, push: false });
  }

  const holder = h('div', { class: 'graph-holder' });
  const side = h('aside', { class: 'panel graph-side', 'aria-live': 'polite' });
  wrap.append(h('div', { class: 'graph-filters' }, kindChips, edgeChips, pluginsToggle), h('div', { class: 'graph-body' }, holder, side));

  let drawing = null;
  function paint() {
    const hk = listParam('hide');
    const he = listParam('off');
    for (const b of kindChips.children) b.setAttribute('aria-pressed', String(!hk.has(b.dataset.fk.slice(5))));
    for (const b of edgeChips.children) b.setAttribute('aria-pressed', String(!he.has(b.dataset.fk.slice(5))));
    drawing?.stop();
    const nodes = data.nodes.filter((n) => !hk.has(n.kind));
    const ids = new Set(nodes.map((n) => n.id));
    const edges = data.edges.filter((e) => !he.has(e.type) && ids.has(e.source) && ids.has(e.target));
    drawing = drawGraph({ nodes, edges, all: data, holder, side });
    state.graph = drawing;
  }
  paint();
  return wrap;
}

function drawGraph({ nodes, edges, all, holder, side }) {
  const saved = (state.graphPos ||= new Map());
  const sim = nodes.map((n) => {
    const p = saved.get(n.id);
    return { ...n, x: p?.x, y: p?.y, r: nodeRadius(n), charge: n.kind === 'project' ? -420 : -(55 + Math.min(n.degree || 0, 12) * 12) };
  });
  const byId = new Map(sim.map((n) => [n.id, n]));
  const allById = new Map(all.nodes.map((n) => [n.id, n]));
  const neighbors = new Map(sim.map((n) => [n.id, new Set()]));
  for (const e of edges) { neighbors.get(e.source)?.add(e.target); neighbors.get(e.target)?.add(e.source); }
  const layout = forceLayout(sim, edges);
  if (sim.every((n) => saved.has(n.id))) layout.reheat(0.05);

  const view = { k: 1, x: 0, y: 0 };
  const svg = s('svg', { class: 'graph', role: 'img', 'aria-label': `Knowledge graph: ${fmt.plural(sim.filter((n) => n.kind !== 'project').length, 'item')} and ${fmt.plural(edges.length, 'connection')}. Use the panel to browse them.` });
  const viewport = s('g', {});
  const edgeLayer = s('g', { class: 'edges' });
  const nodeLayer = s('g', { class: 'nodes' });
  viewport.append(edgeLayer, nodeLayer);
  svg.append(viewport);

  const lineEls = edges.map((e) => {
    const el = s('line', { class: `e-${e.type}` });
    edgeLayer.append(el);
    return { e, el, a: byId.get(e.source), b: byId.get(e.target) };
  });
  const nodeEls = new Map();
  for (const n of sim) {
    const g = s('g', { class: `node k-${n.kind}${n.learned ? ' learned' : ''}${n.degree || n.kind === 'project' ? '' : ' lonely'}`, 'data-id': n.id });
    g.append(s('circle', { r: n.r }), s('text', { y: n.r + 2 }, n.kind === 'project' ? n.label : shortLabel(n)));
    nodeLayer.append(g);
    nodeEls.set(n.id, g);
  }

  const controls = h('div', { class: 'graph-controls' },
    h('button', { type: 'button', class: 'btn icon small', 'aria-label': 'Zoom in', title: 'Zoom in', onclick: () => zoomBy(1.4) }, '+'),
    h('button', { type: 'button', class: 'btn icon small', 'aria-label': 'Zoom out', title: 'Zoom out', onclick: () => zoomBy(1 / 1.4) }, '−'),
    h('button', { type: 'button', class: 'btn small', title: 'Fit everything in view', onclick: () => fit(true) }, 'Fit'));
  const hint = h('p', { class: 'graph-hint' }, 'Drag to move · scroll to zoom · click an item');
  holder.replaceChildren(svg, controls, hint);

  let size = { w: holder.clientWidth || 800, h: holder.clientHeight || GRAPH_HEIGHT.wide };
  const setBox = () => svg.setAttribute('viewBox', `${-size.w / 2} ${-size.h / 2} ${size.w} ${size.h}`);
  setBox();
  let observed = false;
  const ro = new ResizeObserver(() => {
    if (!svg.isConnected) { ro.disconnect(); return; }
    size = { w: holder.clientWidth || size.w, h: holder.clientHeight || size.h };
    setBox();
    // The drawing is built before it is on the page: fit it once its real size is known.
    if (!observed) { observed = true; if (!userMoved) fit(); }
  });
  ro.observe(holder);

  function applyView() {
    viewport.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
    // Labels keep a readable size on screen whatever the zoom.
    svg.style.setProperty('--zoom', String(view.k));
    svg.classList.toggle('zoomed', view.k >= ZOOM_LABELS);
  }
  function paintPositions() {
    for (const l of lineEls) {
      l.el.setAttribute('x1', l.a.x.toFixed(1)); l.el.setAttribute('y1', l.a.y.toFixed(1));
      l.el.setAttribute('x2', l.b.x.toFixed(1)); l.el.setAttribute('y2', l.b.y.toFixed(1));
    }
    for (const n of sim) nodeEls.get(n.id).setAttribute('transform', `translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})`);
  }
  function fit(animate = false) {
    if (!sim.length) return;
    const xs = sim.map((n) => n.x);
    const ys = sim.map((n) => n.y);
    const [x0, x1, y0, y1] = [Math.min(...xs) - 30, Math.max(...xs) + 30, Math.min(...ys) - 30, Math.max(...ys) + 40];
    const k = Math.min(Math.max(Math.min(size.w / (x1 - x0), size.h / (y1 - y0)), ZOOM_MIN), 1.6);
    Object.assign(view, { k, x: -((x0 + x1) / 2) * k, y: -((y0 + y1) / 2) * k });
    svg.classList.toggle('animate', animate && !reducedMotion());
    applyView();
  }
  /** Client point → drawing coordinates (the viewBox is centered and 1:1 with pixels). */
  function toGraph(clientX, clientY) {
    const r = svg.getBoundingClientRect();
    const sx = clientX - r.left - r.width / 2;
    const sy = clientY - r.top - r.height / 2;
    return { x: (sx - view.x) / view.k, y: (sy - view.y) / view.k, sx, sy };
  }
  function zoomAt(factor, sx = 0, sy = 0) {
    const k = Math.min(Math.max(view.k * factor, ZOOM_MIN), ZOOM_MAX);
    view.x = sx - ((sx - view.x) * k) / view.k;
    view.y = sy - ((sy - view.y) * k) / view.k;
    view.k = k;
    svg.classList.remove('animate');
    applyView();
  }
  const zoomBy = (f) => { userMoved = true; zoomAt(f); };
  function centerOn(n) {
    view.x = -n.x * view.k;
    view.y = -n.y * view.k;
    svg.classList.toggle('animate', !reducedMotion());
    applyView();
  }

  // Simulation loop: animated, or computed at once when the user prefers less motion.
  let running = true;
  /** Once the user pans, zooms or drags, the view is theirs: no automatic fitting. */
  let userMoved = false;
  let fitted = sim.every((n) => saved.has(n.id));
  const save = () => { for (const n of sim) saved.set(n.id, { x: n.x, y: n.y }); };
  let seen = false;
  let waited = 0;
  function frame() {
    if (svg.isConnected) seen = true;
    // Stop once the drawing left the page (or never reached it).
    if (!running || (seen && !svg.isConnected) || (!seen && ++waited > 120)) { running = false; ro.disconnect(); return; }
    const until = performance.now() + FRAME_BUDGET_MS;
    while (!layout.done() && performance.now() < until) layout.tick();
    paintPositions();
    if (!fitted && layout.alpha() < 0.08) { fitted = true; if (!userMoved) fit(true); }
    if (layout.done()) { save(); return; }
    requestAnimationFrame(frame);
  }
  const kick = () => { if (!svg.isConnected) return; const was = !layout.done(); layout.reheat(0.25); if (!was) requestAnimationFrame(frame); };
  if (reducedMotion()) {
    for (let i = 0; i < 500 && !layout.done(); i++) layout.tick();
    paintPositions();
    fit();
    save();
  } else {
    // Most of the settling happens before the first paint; the rest is animated.
    const until = performance.now() + WARMUP_MS;
    while (!fitted && layout.alpha() > 0.3 && performance.now() < until) layout.tick();
    paintPositions();
    fit();
    requestAnimationFrame(frame);
  }

  // Pointer: drag a node to move it, drag the background to pan, click to select.
  let drag = null;
  svg.addEventListener('pointerdown', (ev) => {
    const g = ev.target.closest('.node');
    const p = toGraph(ev.clientX, ev.clientY);
    drag = { node: g ? byId.get(g.dataset.id) : null, start: { x: ev.clientX, y: ev.clientY }, view: { ...view }, moved: false };
    svg.setPointerCapture(ev.pointerId);
    if (drag.node) { drag.node.fx = p.x; drag.node.fy = p.y; }
    hideTip();
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.start.x;
    const dy = ev.clientY - drag.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; userMoved = true; }
    if (!drag.moved) return;
    if (drag.node) {
      const p = toGraph(ev.clientX, ev.clientY);
      drag.node.fx = p.x; drag.node.fy = p.y;
      kick();
    } else {
      view.x = drag.view.x + dx;
      view.y = drag.view.y + dy;
      svg.classList.remove('animate');
      applyView();
    }
  });
  const endDrag = (ev) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.node) { d.node.fx = null; d.node.fy = null; }
    if (!d.moved && ev.type === 'pointerup') select(d.node ? d.node.id : null);
    else if (d.node) save();
  };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const p = toGraph(ev.clientX, ev.clientY);
    userMoved = true;
    zoomAt(Math.exp(-ev.deltaY * 0.0015), p.sx, p.sy);
  }, { passive: false });
  svg.addEventListener('pointerover', (ev) => {
    const g = ev.target.closest?.('.node');
    if (!g || drag) return;
    const n = byId.get(g.dataset.id);
    hover(n.id);
    showTip(g, h('b', {}, n.label), h('div', { class: 'faint' }, [GRAPH_KIND_ONE[n.kind], n.project_name].filter(Boolean).join(' · ')));
  });
  svg.addEventListener('pointerout', (ev) => {
    if (ev.target.closest?.('.node')) { hover(null); hideTip(); }
  });

  function hover(id) {
    svg.classList.toggle('hovering', !!id);
    for (const g of nodeLayer.querySelectorAll('.hot')) g.classList.remove('hot');
    for (const l of lineEls) l.el.classList.remove('hot');
    if (!id) return;
    nodeEls.get(id)?.classList.add('hot');
    for (const m of neighbors.get(id) || []) nodeEls.get(m)?.classList.add('hot');
    for (const l of lineEls) if (l.e.source === id || l.e.target === id) l.el.classList.add('hot');
  }

  let selected = null;
  let matches = new Set();
  function select(id, { center = false } = {}) {
    selected = id && byId.has(id) ? id : null;
    setNav({ set: { sel: selected || '' }, push: false });
    svg.classList.toggle('focusing', !!selected);
    for (const g of nodeEls.values()) g.classList.remove('on', 'sel');
    for (const l of lineEls) l.el.classList.toggle('on', !!selected && (l.e.source === selected || l.e.target === selected));
    if (selected) {
      nodeEls.get(selected).classList.add('on', 'sel');
      for (const m of neighbors.get(selected)) nodeEls.get(m)?.classList.add('on');
      if (center) centerOn(byId.get(selected));
    }
    side.replaceChildren(...(selected ? detailPanel(byId.get(selected)) : summaryPanel()).filter(Boolean));
  }

  function search(q) {
    const text = String(q || '').toLowerCase();
    matches = new Set(text ? sim.filter((n) => [n.label, n.name, n.description, n.path, n.project_name].some((x) => String(x || '').toLowerCase().includes(text))).map((n) => n.id) : []);
    svg.classList.toggle('searching', !!text);
    for (const [id, g] of nodeEls) g.classList.toggle('match', matches.has(id));
    return matches;
  }

  function itemButton(n, extra) {
    return h('button', { type: 'button', class: 'graph-item', 'data-fk': `item:${n.id}`, onclick: () => select(n.id, { center: true }) },
      h('span', { class: `swatch k-${n.kind}` }), h('span', { class: 'graph-item-label' }, n.label), extra ? h('span', { class: 'faint' }, extra) : null);
  }

  function detailPanel(n) {
    const full = allById.get(n.id) || n;
    const groups = new Map();
    for (const e of all.edges) {
      if (e.source !== n.id && e.target !== n.id) continue;
      const other = allById.get(e.source === n.id ? e.target : e.source);
      if (!other) continue;
      const outgoing = e.type === 'contains' || e.type === 'belongs' ? e.source === n.id : (e.from ? e.from === n.id : e.source === n.id);
      const label = EDGE_READS[e.type][outgoing ? 0 : 1];
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push({ other, e });
    }
    const usage = n.kind === 'project' ? null
      : n.uses ? `${n.kind === 'skill' ? 'Used' : 'Read'} ${fmt.plural(n.uses, 'time')}${n.lastUsed ? `, last ${fmt.when(n.lastUsed)}` : ''}`
        : n.kind === 'skill' || n.kind === 'memory' ? `Not ${n.kind === 'skill' ? 'used' : 'read'} since Ouroboros started measuring` : null;
    const link = knowledgeLink(n);
    return [
      h('div', { class: 'graph-side-head' },
        h('h2', {}, n.label),
        h('button', { type: 'button', class: 'btn icon quiet small', 'aria-label': 'Close details', title: 'Close', 'data-fk': 'graph-close', onclick: () => select(null) }, icon('x'))),
      h('div', { class: 'graph-tags' }, pill(GRAPH_KIND_ONE[n.kind]), n.memoryType ? pill(n.memoryType) : null, n.learned ? pill('changed by Ouroboros', 'accent') : null,
        n.kind !== 'project' ? h('span', { class: 'faint' }, n.project_name || 'everywhere') : null),
      n.path ? h('p', { class: 'mono graph-path' }, n.path) : null,
      full.description ? clampText(full.description) : null,
      usage ? h('p', { class: 'muted small-text' }, usage) : null,
      full.dangling?.length ? h('div', { class: 'graph-warn' }, icon('alert'), h('div', {}, h('b', {}, 'Broken links: '), full.dangling.map((d) => `[[${d}]]`).join(', '), '. Nothing with that name exists.')) : null,
      groups.size ? h('div', { class: 'graph-conns' }, [...groups].map(([label, list]) => h('section', {},
        h('h3', {}, label, h('span', { class: 'n' }, fmt.int(list.length))),
        h('ul', { class: 'graph-list' }, list.sort((a, b) => a.other.label.localeCompare(b.other.label)).slice(0, 60).map(({ other, e }) => h('li', {},
          byId.has(other.id) ? itemButton(other, e.type === 'used' ? `${e.sessions} sessions` : e.type === 'similar' ? `${Math.round(e.score * 100)}%` : null)
            : h('span', { class: 'graph-item hidden-item' }, h('span', { class: `swatch k-${other.kind}` }), other.label, h('span', { class: 'faint' }, 'hidden by a filter'))))))))
        : h('p', { class: 'faint' }, 'No connections: nothing links to it, names it or was used with it.'),
      link ? h('p', {}, h('a', { href: link }, 'Show in the Knowledge list')) : null,
    ];
  }

  function summaryPanel() {
    const st = all.stats;
    const lonely = all.nodes.filter((n) => n.kind !== 'project' && !n.degree);
    const dangling = all.nodes.filter((n) => n.dangling?.length);
    const byKind = GRAPH_KINDS.filter(([k]) => k !== 'project').map(([k, label]) => [k, label, sim.filter((n) => n.kind === k).sort((a, b) => (b.degree || 0) - (a.degree || 0) || a.label.localeCompare(b.label))]).filter(([, , l]) => l.length);
    return [
      h('h2', {}, 'What connects to what'),
      h('p', { class: 'muted' }, `${fmt.plural(st.items, 'item')} and ${fmt.plural(Object.entries(st.edges).filter(([t]) => t !== 'belongs').reduce((s, [, v]) => s + v, 0), 'connection')}. Bigger circles are used more; a ring marks what Ouroboros wrote or changed.`),
      lonely.length ? disclose(`Unconnected (${fmt.int(lonely.length)})`,
        h('p', { class: 'faint small-text' }, 'Nothing links to these, names them or used them with something else. Candidates to link, merge or retire.'),
        h('ul', { class: 'graph-list' }, lonely.map((n) => h('li', {}, byId.has(n.id) ? itemButton(n) : h('span', { class: 'graph-item hidden-item' }, n.label))))) : null,
      dangling.length ? disclose(`Broken links (${fmt.int(st.dangling)})`,
        h('ul', { class: 'graph-list' }, dangling.map((n) => h('li', {}, byId.has(n.id) ? itemButton(n, n.dangling.map((d) => `[[${d}]]`).join(', ')) : n.label)))) : null,
      disclose('Browse every item', ...byKind.map(([k, label, list]) => h('section', { class: 'graph-browse' },
        h('h3', {}, label, h('span', { class: 'n' }, fmt.int(list.length))),
        h('ul', { class: 'graph-list' }, list.map((n) => h('li', {}, itemButton(n, n.degree ? fmt.plural(n.degree, 'link') : null))))))),
    ];
  }

  const initial = param('sel');
  if (initial && byId.has(initial)) select(initial); else side.replaceChildren(...summaryPanel().filter(Boolean));
  if (param('q')) search(param('q'));

  return {
    stop() { running = false; ro.disconnect(); },
    search(q) {
      // A search replaces the selection: one highlight at a time.
      if (selected && q) select(null);
      const found = search(q);
      if (found.size === 1) select([...found][0], { center: true });
    },
  };
}

function shortLabel(n) {
  const text = n.kind === 'reference' ? n.label.split('/').pop() : n.kind === 'instructions' ? n.label.split('/').slice(-2).join('/') : n.label;
  return text.length > 28 ? `${text.slice(0, 27)}…` : text;
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- Activity ----------
const OUTCOME = {
  created: ['saved', 'good'], patched: ['saved into a file', 'good'], duplicate: ['already known', ''], dropped: ['dropped', ''],
  merged: ['merged', ''], suggested: ['fix suggested', 'info'], dismissed: ['fix dismissed', ''], fixed: ['fixed in the project', 'good'], queued: ['in the inbox', 'info'],
  conflict: ['conflict', 'warn'], rejected_by_user: ['rejected by you', 'bad'], undone: ['undone by you', 'bad'], pending: ['being checked', 'info'], rejected: ['rejected', 'bad'], over_budget: ['over budget', 'warn'], error: ['error', 'bad'],
  measured: ['measured only', ''],
};
function outcomePill(o) {
  const [label, tone] = OUTCOME[o || 'measured'] || [o.replace(/_/g, ' '), ''];
  return pill(label, '', tone || null);
}
function reviewState(st) {
  const map = { done: ['good', 'reviewed'], ok: ['good', 'done'], queued: ['warn', 'queued'], running: ['info', 'running'], skipped: ['', 'skipped'], failed: ['bad', 'failed'] };
  const [tone, label] = map[st] || ['', 'not reviewed'];
  return pill(label, '', tone || null);
}

const ACTIVITY_SEGS = ['sessions', 'reviews', 'proposals', 'dropped', 'corrections'];
const PERIODS = [['', 'All time'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last year']];

const ACTIVITY_LISTS = {
  sessions: {
    noun: ['session', 'sessions'], search: 'Filter by folder', empty: 'No sessions recorded yet. Start a Claude Code session with the plugin enabled.',
    columns: [
      { label: 'Started', sort: 'date', render: (r) => fmt.datetime(r.started_at) },
      { label: 'Project', render: (r) => h('span', { title: r.cwd ? tilde(r.cwd) : null }, projectName(r)) },
      { label: 'Turns', num: true, render: (r) => fmt.int(r.turns) },
      { label: 'Tool calls', num: true, render: (r) => h('span', {}, fmt.int(r.tool_calls), r.tool_fails ? h('span', { class: 'faint' }, ` · ${r.tool_fails} failed`) : null) },
      { label: 'Corrections', num: true, render: (r) => fmt.int(r.corrections) },
      { label: 'Proposed', num: true, render: (r) => fmt.int(r.candidates) },
      { label: 'Cost', num: true, render: (r) => fmt.usd(r.cost) },
      { label: 'Review', render: (r) => reviewState(r.queue_state) },
    ],
  },
  reviews: {
    noun: ['review', 'reviews'], search: 'Filter by trigger or detail', empty: 'No reviews yet.',
    note: 'In-session reviews run inside your session and use your plan; the others are isolated Haiku calls billed per use.',
    columns: [
      { label: 'When', sort: 'date', render: (r) => fmt.datetime(r.ts) },
      { label: 'Kind', render: (r) => cellMain(r.mode === 'inloop' ? 'In-session' : r.mode === 'background' ? 'End of session' : r.mode === 'maintenance' ? 'Maintenance' : r.mode, r.trigger) },
      { label: 'Project', render: (r) => projectName(r) },
      { label: 'Status', render: (r) => h('span', { title: r.detail || '' }, reviewState(r.status)) },
      { label: 'Turns', num: true, render: (r) => fmt.int(r.turns_reviewed) },
      { label: 'Corrections', num: true, render: (r) => fmt.int(r.corrections) },
      { label: 'Learned', num: true, render: (r) => fmt.int(r.learned + r.patched) },
      { label: 'Tokens', num: true, render: (r) => fmt.compact(r.input + r.output) },
      { label: 'Cost', num: true, render: (r) => (r.mode === 'inloop' ? h('span', { class: 'faint', title: 'Runs inside your session, on your plan' }, 'plan') : fmt.usd(r.cost_usd)) },
    ],
  },
  proposals: {
    noun: ['proposal', 'proposals'], search: 'Filter by title or text', empty: 'No proposals match.',
    note: 'Everything reviews proposed to learn, and what happened to each. Undo change reverts only the lines that change wrote.',
    columns: [
      { label: 'Proposal', render: (r) => cellMain(r.title, r.summary, { clamp: true }) },
      { label: 'Kind', render: (r) => (r.kind === 'memory' && r.memory_type ? `memory · ${r.memory_type}` : r.kind) },
      { label: 'Project', render: (r) => projectName(r) },
      { label: 'Session', sort: 'date', render: (r) => fmt.date(r.session_started_at) },
      { label: 'Outcome', render: (r) => outcomePill(r.outcome) },
      { label: '', cls: 'actions-cell', render: (r) => (r.outcome === 'patched' && r.cs_status === 'applied' && r.cs_batch
        ? actionButton('Undo change', 'undo_change', r.changeset_id, { small: true, variant: 'quiet', iconName: 'undo', confirmText: 'Undo this change?', title: 'Revert only the lines this change wrote; later edits to the file stay' })
        : null) },
    ],
  },
  dropped: {
    noun: ['dropped proposal', 'dropped proposals'], search: 'Filter by title or reason',
    list: true,
    row: (d) => h('li', { 'data-entry': `d:${d.id}` },
      h('div', { class: 'row-main' }, h('div', { class: 'row-title', tabindex: '-1', 'data-row-focus': '' }, d.title),
        h('div', { class: 'small muted' }, d.note || OUTCOME[d.outcome]?.[0] || d.outcome),
        h('div', { class: 'small faint' }, `${projectName(d)} · ${fmt.date(d.decided_at || d.session_started_at)}`)),
      actionButton('Restore', 'restore', d.id, { small: true, variant: 'quiet', title: 'Put it back in the inbox to be checked again' })),
    empty: () => emptyState('Nothing dropped', 'Proposals the knowledge check drops (already documented, one-off, stale, duplicate) appear here with the reason.', 'info'),
  },
  corrections: {
    noun: ['correction', 'corrections'], search: 'Filter by what you said',
    list: true,
    row: (x) => h('li', { 'data-entry': `x:${x.id}` },
      h('div', { class: 'row-main' }, h('div', {}, `“${x.quote}”`), h('div', { class: 'small faint' }, `${x.kind} · ${projectName(x)} · ${fmt.date(x.session_started_at)}`))),
    empty: () => emptyState('No corrections recorded', 'Reviews count the times you redirected Claude; they show up here.', 'info'),
  },
};

let activitySeq = 0;

async function renderActivity() {
  const seg = ACTIVITY_SEGS.includes(state.nav.sub) ? state.nav.sub : 'sessions';
  const project = param('project');
  const days = param('days');
  const [counts, facets] = await settle([api('activity_counts', { project, days }), seg === 'proposals' ? api('proposals', { limit: 1 }) : null]);
  const n = failed(counts) ? {} : counts;
  const results = h('div', { class: 'results' });
  const refill = () => fillActivity(results, seg);

  const filters = [
    projectFilter(),
    selectControl(days, PERIODS, 'Period', (v) => go({ set: { days: v } })),
  ];
  if (seg === 'proposals' && facets && !failed(facets)) {
    filters.push(
      selectControl(param('kind'), [['', 'Kind: all'], ...facets.kinds.map((k) => [k, k])], 'Kind', (v) => { setNav({ set: { kind: v }, push: true }); refill(); }),
      selectControl(param('outcome'), [['', 'Outcome: all'], ...facets.outcomes.map((o) => [o, OUTCOME[o]?.[0] || o])], 'Outcome', (v) => { setNav({ set: { outcome: v }, push: true }); refill(); }));
  }
  filters.push(searchBox(param('q'), ACTIVITY_LISTS[seg].search, (q) => { setNav({ set: { q }, push: false }); refill(); }, `search:activity:${seg}`));

  const toolbar = h('div', { class: 'toolbar' },
    segmented(ACTIVITY_SEGS.map((x) => [x, x[0].toUpperCase() + x.slice(1), n[x]]), seg,
      (next) => go({ sub: next, keep: false, set: { project, days } }), 'Activity lists'),
    h('div', { class: 'filters' }, ...filters));
  await fillActivity(results, seg);
  return [
    pageHead('Activity', 'What happened: sessions, the reviews that read them, what they proposed, and what the knowledge check dropped.'),
    toolbar,
    results,
  ];
}

async function fillActivity(results, seg) {
  const seq = ++activitySeq;
  const spec = ACTIVITY_LISTS[seg];
  const filters = { project: param('project'), days: param('days'), q: param('q'), kind: param('kind'), outcome: param('outcome'), dir: param('dir') };
  const key = `activity:${seg}:${JSON.stringify(filters)}`;
  let content;
  try {
    const first = await api(seg, { ...filters, limit: firstLimit(key) });
    const load = (offset, limit) => api(seg, { ...filters, offset, limit });
    if (!first.total) {
      content = h('div', { class: 'panel' }, typeof spec.empty === 'function' && !Object.values(filters).some(Boolean) ? spec.empty()
        : h('div', { class: 'empty' }, h('p', {}, Object.values(filters).some(Boolean) ? `No ${spec.noun[1]} match the filters.` : spec.empty)));
    } else if (spec.list) {
      const list = h('ul', { class: 'rows' });
      content = h('div', { class: 'panel' }, list, paged({ key, first, list, row: spec.row, noun: spec.noun, load }));
    } else {
      const dir = param('dir') || 'desc';
      const t = dataTable(spec.columns, {
        sort: 'date', dir, stack: true,
        onSort: (_, d) => { setNav({ set: { dir: d === 'desc' ? '' : d }, push: false }); fillActivity(results, seg); },
      });
      const row = (r) => t.row({ ...r, _key: r.id ? `r:${r.id}` : null });
      content = h('div', { class: 'panel' }, t.el, paged({ key, first, list: t.tbody, row, noun: spec.noun, load }),
        spec.note ? h('div', { class: 'table-note' }, spec.note) : null);
    }
  } catch (err) {
    content = sectionError(err, 'this list');
  }
  if (seq !== activitySeq) return;
  const focusKey = results.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
  results.replaceChildren(content);
  if (focusKey) results.querySelector(`[data-fk="${CSS.escape(focusKey)}"]`)?.focus();
}

// ---------- System ----------
async function renderSystem() {
  const [hl, q, c, failedFirst, errorsFirst] = await settle([
    api('health'), api('quality', { days: state.days }), api('cost', { days: state.days }),
    api('problems', { type: 'failed', limit: 10 }), api('problems', { type: 'errors', limit: 10 }),
  ]);
  const opts = failed(hl) ? null : hl.options;
  const LISTING_REF = 2000; // ~1% of a 200K-token context

  let status;
  if (failed(hl) || failed(c)) status = sectionError(failed(hl) ? hl : c, 'the status');
  else {
    const queue = Object.fromEntries(hl.queue.map((x) => [x.state, x.n]));
    const alive = hl.capture.lastEventAt && Date.now() - hl.capture.lastEventAt < 7 * 86_400_000;
    status = h('div', { class: 'grid-3' },
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
  }

  // Learning quality: what the knowledge check did, and how you judged it.
  let quality;
  if (failed(q)) quality = sectionError(q, 'learning quality');
  else {
    const pct = (x) => (x === null || x === undefined ? '—' : fmt.pct(x * 100));
    const changes = Object.fromEntries((q.changes || []).map((x) => [x.status, x.n]));
    const reasons = Object.entries(q.dropReasons).sort((a, b) => b[1] - a[1]);
    const maxReason = Math.max(1, ...reasons.map((r) => r[1]));
    const signals = [];
    if (q.proposed >= 10 && q.dropped / q.proposed > 0.5) signals.push('Most proposals are dropped by the knowledge check: reviews keep proposing what is already documented or fails the rubric.');
    if (q.undoRate !== null && q.writes >= 5 && q.undoRate > 0.2) signals.push('More than 1 in 5 writes was undone: things are being saved that you do not want.');
    if (q.approvalRate !== null && q.approvalRate < 0.5) signals.push('You reject most of what reaches the inbox: consider a stricter autonomy, or look at why in Activity.');
    if ((changes.stale || 0) >= 3) signals.push(`${changes.stale} changes went stale because their files changed before approval: review the inbox more often.`);
    quality = h('div', { class: 'panel' },
      h('dl', { class: 'facts' },
        ...[['Proposed', q.proposed], ['Saved', q.saved], ['In the inbox now', q.inbox], ['Dropped', q.dropped],
          ['Merged or known', (q.merged || 0) + (q.duplicates || 0)], ['Fixes suggested', q.suggested || 0], ['Approval rate', pct(q.approvalRate)], ['Undo rate', pct(q.undoRate)]]
          .map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, typeof v === 'number' ? fmt.int(v) : v)))),
      reasons.length ? h('div', { class: 'bars' },
        h('h3', { class: 'bars-title' }, 'Why proposals were dropped'),
        reasons.map(([r, n]) => h('div', { class: 'bar-row' }, h('span', {}, r), h('div', { class: 'track' }, h('span', { style: `width:${(n / maxReason) * 100}%` })), h('span', { class: 'num' }, fmt.int(n))))) : null,
      h('div', { class: 'table-note' }, `Changes to files: ${fmt.int(changes.applied || 0)} applied · ${fmt.int(changes.pending || 0)} waiting · ${fmt.int(changes.rejected || 0)} rejected · ${fmt.int(changes.superseded || 0)} recomposed · ${fmt.int(q.rejectedByUser)} learnings rejected by you`),
      signals.length ? signals.map((t) => h('div', { class: 'signal' }, icon('alert'), t))
        : h('div', { class: 'signal ok' }, icon('check'), 'No quality warnings.'));
  }

  let costSection;
  if (failed(c)) costSection = [sectionError(c, 'the cost')];
  else {
    const mode = Object.fromEntries(c.byMode.map((m) => [m.mode, m]));
    const bgUsd = Object.values(mode).filter((m) => m.mode !== 'inloop').reduce((n, m) => n + m.usd, 0);
    const bgN = Object.values(mode).filter((m) => m.mode !== 'inloop').reduce((n, m) => n + m.n, 0);
    costSection = [
      h('div', { class: 'panel' }, h('dl', { class: 'facts' },
        ...[['Reviews', fmt.int(bgN + (mode.inloop?.n || 0))], ['Billed reviews', fmt.usd(bgUsd)], ['Average per review', bgN ? fmt.usd(bgUsd / bgN) : '—'],
          ['Context per session', `${fmt.int(c.overhead.tokensPerSession)} tok`]].map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))))),
      h('div', { class: 'charts spaced' },
        barChart({ title: 'Billed review cost', data: c.series, value: (d) => d.usd, format: fmt.usd, tip: (d) => [fmt.day(d.day), fmt.plural(d.reviews, 'review')] }),
        barChart({ title: 'Reviews', data: c.series, value: (d) => d.reviews, format: (x) => fmt.int(x), tip: (d) => [fmt.day(d.day)] })),
    ];
  }

  let budgets;
  if (failed(hl)) budgets = sectionError(hl, 'the context budgets');
  else {
    const budgetRow = (label, used, limit, unit) => h('div', { class: 'budget' },
      h('div', { class: 'line' }, h('span', {}, label), h('span', {}, `${fmt.int(used)} / ${fmt.int(limit)} ${unit}`)), meter(used, limit, { label }));
    budgets = h('div', { class: 'grid-2' },
      h('div', { class: 'panel pad' },
        h('h3', {}, 'Always in context'),
        budgetRow('Skill listing', hl.skillListing.tokens, LISTING_REF, 'tokens'),
        budgetRow('Learned skills', hl.budgets.learnedSkills.used, hl.budgets.learnedSkills.limit, 'skills'),
        h('p', { class: 'small faint panel-note' }, `Skill listing: ${hl.skillListing.skills} skills Claude can invoke (plugin skills not counted); ~2,000 tokens is 1% of a 200K context. Limits live in ~/.ouroboros/config.json; past 80%, Ouroboros consolidates.`)),
      h('div', { class: 'panel pad' },
        h('h3', {}, 'MEMORY.md indexes'),
        hl.indexes.length ? hl.indexes.map((ix) => budgetRow(ix.project_name || ix.project, ix.lines, hl.budgets.memoryIndexLines, 'lines'))
          : h('p', { class: 'muted small' }, 'No memory indexes found.'),
        h('p', { class: 'small faint panel-note' }, `Claude Code loads only the first 200 lines (25 KB) of each index; Ouroboros stops adding at ${hl.budgets.memoryIndexLines}.`)));
  }

  const problemList = (title, first, type, row) => {
    if (failed(first)) return h('div', { class: 'panel pad' }, h('h3', { class: 'bars-title' }, title), sectionError(first, title.toLowerCase()));
    const list = h('ul', { class: 'rows problems' });
    const key = `problems:${type}`;
    const foot = first.total ? paged({ key, first, list, row, size: 20, noun: [title === 'Errors' ? 'error' : 'failed review', title === 'Errors' ? 'errors' : 'failed reviews'], load: (offset, limit) => api('problems', { type, offset, limit }) }) : null;
    return h('div', { class: 'panel pad' }, h('h3', { class: 'bars-title' }, title),
      first.total ? [list, foot] : h('p', { class: 'muted small flush' }, 'None.'));
  };
  const problems = h('div', { class: 'grid-2' },
    problemList('Failed reviews', failedFirst, 'failed', (r) => h('li', {}, h('div', { class: 'small' }, r.detail), h('div', { class: 'small faint' }, `${fmt.datetime(r.ts)} · ${r.session_id}`))),
    problemList('Errors', errorsFirst, 'errors', (e) => h('li', {}, h('div', { class: 'mono' }, String(e.message || '').split('\n')[0]), h('div', { class: 'small faint' }, `${fmt.datetime(e.ts)} · ${e.source}`))));

  return [
    pageHead('System', 'Is everything running, how good is what it learns, and what does it cost?'),
    status,
    h('section', { class: 'section' }, sectionHead('Learning quality', `What the knowledge check did with proposals in the last ${failed(q) ? state.days : q.days} days, and how you judged what reached you.`), quality),
    h('section', { class: 'section' }, sectionHead('Cost', 'End-of-session and maintenance reviews are isolated Haiku calls billed per use; in-session reviews use your plan.'), ...costSection),
    h('section', { class: 'section' }, sectionHead('Context budgets', 'What Ouroboros keeps in every session’s context, against its limits.'), budgets),
    h('section', { class: 'section' }, sectionHead('Problems'), problems),
  ];
}

// ---------- shell ----------
const renderers = { inbox: renderInbox, overview: renderOverview, knowledge: renderKnowledge, activity: renderActivity, system: renderSystem };
const USES_RANGE = new Set(['overview', 'system']);

function inboxTotal() {
  return state.counts?.total || 0;
}

async function refreshCounts() {
  const [counts, projects] = await settle([api('counts'), api('projects')]);
  if (!failed(projects)) state.projects = projects.rows;
  if (failed(counts)) return;
  state.counts = counts;
  state.home = counts.home;
  const n = inboxTotal();
  const badge = document.getElementById('inbox-count');
  badge.hidden = !n;
  badge.textContent = fmt.int(n);
  badge.setAttribute('aria-label', `${n} waiting`);
  const o = counts.options;
  const parts = [counts.version ? `v${counts.version}` : null, o ? (o.learning === false ? 'measuring only' : `learning · ${o.autonomy || 'auto'}`) : null].filter(Boolean);
  document.getElementById('status').textContent = parts.join(' · ');
}

/** Open <details> and scroll position, so a re-render does not reset what the user opened. */
function snapshot() {
  return {
    y: window.scrollY,
    details: Object.fromEntries([...view.querySelectorAll('details[data-dk]')].map((d) => [d.dataset.dk, d.open])),
  };
}
function restore(snap) {
  if (!snap) return;
  for (const d of view.querySelectorAll('details[data-dk]')) if (d.dataset.dk in snap.details) d.open = snap.details[d.dataset.dk];
  window.scrollTo(0, snap.y);
}

/** Move focus where the user expects it after a re-render. */
function placeFocus(focus, fk) {
  const byFk = (k) => (k ? view.querySelector(`[data-fk="${CSS.escape(k)}"]`) : null);
  if (focus?.fk && byFk(focus.fk) && !byFk(focus.fk).disabled) { byFk(focus.fk).focus({ preventScroll: true }); return true; }
  for (const key of focus?.entries || []) {
    const el = view.querySelector(`[data-entry="${CSS.escape(key)}"]`);
    if (el) { focusRow(el); return true; }
  }
  if (focus) { view.querySelector('h1')?.focus({ preventScroll: true }); return true; }
  const el = byFk(fk);
  if (el) { el.focus({ preventScroll: true }); return true; }
  return false;
}

let renderSeq = 0;

/**
 * Render the current page. `keepScroll` keeps the scroll position and open sections (after
 * an action or an automatic refresh); `focus` says where focus goes afterwards (the
 * control that was used, else the next entry). Otherwise focus returns to the control that
 * had it, if the new page has it, or to the page.
 */
async function render({ keepScroll = false, focus = null } = {}) {
  hideTip();
  const seq = ++renderSeq;
  const tab = state.tab;
  rangeWrap.hidden = !USES_RANGE.has(tab);
  rangeSelect.value = String(state.days);
  for (const a of document.querySelectorAll('.tabs a')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  paintNavLinks();
  const current = document.querySelector('.tabs a[aria-current]');
  if (current && tabsEl.scrollWidth > tabsEl.clientWidth) tabsEl.scrollLeft = current.offsetLeft - tabsEl.offsetLeft - (tabsEl.clientWidth - current.offsetWidth) / 2;
  paintTabFade();
  view.classList.toggle('narrow', tab === 'inbox');
  const activeFk = view.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
  const snap = keepScroll ? snapshot() : null;
  await refreshCounts();
  let nodes;
  try {
    nodes = await renderers[tab]();
  } catch (err) {
    const gone = err instanceof TypeError; // fetch failed: the local server is not running
    nodes = [h('div', { class: 'panel' }, emptyState(gone ? 'The dashboard server stopped' : 'Could not load this page',
      gone ? 'It stops after 4 idle hours or when Ouroboros is updated. Run /ouroboros:dashboard in Claude Code to start it again.' : String(err.message), 'alert'))];
  }
  if (seq !== renderSeq) return false;
  view.replaceChildren(...nodes.filter(Boolean));
  restore(snap);
  return placeFocus(focus, activeFk);
}

/** Apply the URL to the page: a new tab or filter renders; an anchor in the same page scrolls. */
function route() {
  const next = parseHash();
  const prev = state.nav;
  if (!renderers[next.tab]) {
    // No page asked for: start where there is something to do.
    const tab = inboxTotal() ? 'inbox' : 'overview';
    state.nav = { tab, sub: '', params: new URLSearchParams() };
    history.replaceState(null, '', `#${tab}`);
  } else {
    // Inbox anchors (#inbox/p-<project>) move within the page.
    const sameQuery = next.params.toString() === prev.params.toString();
    if (next.tab === 'inbox' && prev.tab === 'inbox' && sameQuery && state.tab === 'inbox') {
      state.nav = next;
      if (next.sub) jumpTo(next.sub);
      return;
    }
    state.nav = next;
  }
  state.tab = state.nav.tab;
  if (USES_RANGE.has(state.tab)) state.days = Number(param('days')) || 30;
  const changedTab = prev.tab !== state.tab;
  render().then((focused) => {
    if (state.nav.tab === 'inbox' && state.nav.sub) jumpTo(state.nav.sub);
    else if (!focused || changedTab) view.focus({ preventScroll: true });
  });
}

rangeSelect.addEventListener('change', () => {
  state.days = Number(rangeSelect.value);
  setNav({ set: { days: state.days === 30 ? '' : state.days }, push: false });
  render();
});
window.addEventListener('popstate', route);
window.addEventListener('hashchange', () => { if (location.hash !== hashOf(state.nav.tab, state.nav.sub, state.nav.params)) route(); });

// Narrow screens: the tabs scroll sideways; fade the edge that has more tabs behind it.
function paintTabFade() {
  const more = tabsEl.scrollWidth - tabsEl.clientWidth;
  tabsEl.classList.toggle('fade-start', more > 1 && tabsEl.scrollLeft > 1);
  tabsEl.classList.toggle('fade-end', more > 1 && tabsEl.scrollLeft < more - 1);
}
tabsEl.addEventListener('scroll', paintTabFade, { passive: true });
window.addEventListener('resize', paintTabFade);

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

state.days = Number(parseHash().params.get('days')) || 30;
refreshCounts().then(route);

// Every minute: the inbox badge; the Overview only when its data changed, keeping the
// scroll position, open tables and focus.
setInterval(async () => {
  if (document.hidden) return;
  if (state.tab !== 'overview') { refreshCounts(); return; }
  const sig = JSON.stringify((await overviewData()).map((x) => (failed(x) ? String(x) : x)));
  if (sig !== state.overviewSig && state.tab === 'overview') render({ keepScroll: true });
  else refreshCounts();
}, 60_000);
