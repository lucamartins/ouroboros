// Ouroboros dashboard. Build-free; all data comes from the local read-only API.
// Untrusted text (paths, quotes, skill descriptions) is always set via textContent.

const view = document.getElementById('view');
const tooltip = document.getElementById('tooltip');
const rangeSelect = document.getElementById('range');
const state = { tab: 'overview', days: 30, filters: { kind: 'all', scope: 'all', q: '' } };

// ---------- helpers ----------
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

const fmt = {
  int: (n) => (n ?? 0).toLocaleString('en-US'),
  compact: (n) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n ?? 0),
  usd: (n) => (n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : n > 0 ? `$${n.toFixed(4)}` : '$0'),
  pct: (n) => `${Math.round(n)}%`,
  rate: (n) => (n === null || n === undefined ? '—' : n.toFixed(1)),
  date: (ts) => (ts ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'),
  datetime: (ts) => (ts ? new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'),
  ago(ts) {
    if (!ts) return 'never';
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const hr = Math.round(m / 60);
    if (hr < 48) return `${hr} h ago`;
    return `${Math.round(hr / 24)} days ago`;
  },
  day: (key) => new Date(`${key}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
};

function projectName(p, cwd) {
  if (cwd) {
    const parts = String(cwd).split(/[\\/]/).filter(Boolean);
    return parts.slice(-1)[0] || cwd;
  }
  return p || '—';
}

async function api(name, params = {}) {
  const q = new URLSearchParams(params).toString();
  const res = await fetch(`/api/${name}${q ? `?${q}` : ''}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
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
  if (y < 8) y = r.bottom + 8;
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}
function hideTip() { tooltip.hidden = true; }

function table(columns, rows, { empty = 'Nothing yet.' } = {}) {
  if (!rows.length) return h('p', { class: 'muted small' }, empty);
  return h('div', { class: 'table-wrap' },
    h('table', {},
      h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.num ? 'num' : null }, c.label)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, columns.map((c) => h('td', { class: c.num ? 'num' : null }, c.render ? c.render(r) : r[c.key]))))),
    ));
}

/** Budget meter: turns warning at 80% and critical at 100%. `plain` for values that aren't budgets. */
function meter(value, limit, { plain = false } = {}) {
  const ratio = limit ? value / limit : 0;
  const cls = plain ? 'meter' : ratio >= 1 ? 'meter over' : ratio >= 0.8 ? 'meter warn' : 'meter';
  return h('div', { class: cls, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': limit, 'aria-valuenow': value },
    h('span', { style: `width:${Math.min(100, ratio * 100).toFixed(1)}%` }));
}

function emptyState(title, text) {
  return h('div', { class: 'card empty-state' }, h('strong', {}, title), text);
}

// ---------- bar chart ----------
// Single series, vertical bars, 4px rounded data end, recessive grid, per-bar tooltip
// (hover and keyboard focus) and a table view so no value is hover-only.
function barChart({ title, data, value, format, tip, emptyText = 'No data in this period' }) {
  const wrap = h('div', { class: 'card chart' }, h('h3', {}, title));
  const holder = h('div');
  wrap.append(holder);

  const draw = () => {
    const width = Math.max(240, holder.clientWidth || 600);
    const height = 180;
    const pad = { top: 8, right: 4, bottom: 22, left: 36 };
    const values = data.map(value);
    const max = Math.max(0, ...values.filter((v) => v !== null));
    const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': title });
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;

    if (!max) {
      svg.append(s('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'empty' }, emptyText));
      holder.replaceChildren(svg);
      return;
    }
    const nice = niceMax(max);
    const ticks = [0, nice / 2, nice];
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
    holder.replaceChildren(svg);
  };

  requestAnimationFrame(draw);
  new ResizeObserver(() => draw()).observe(holder);

  wrap.append(h('details', { class: 'table-view' }, h('summary', {}, 'Table'),
    table([{ label: 'Day', render: (d) => fmt.day(d.day) }, { label: title, num: true, render: (d) => (value(d) === null ? '—' : format(value(d))) }], data)));
  return wrap;
}

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// ---------- views ----------
async function renderOverview() {
  const o = await api('overview', { days: state.days });
  const t = o.totals;
  const learningOn = o.options ? o.options.learning !== false : null;
  const phase = document.getElementById('phase');
  phase.textContent = learningOn === null ? '' : learningOn ? 'learning' : 'measuring only';
  phase.title = learningOn ? 'Learning protocol is injected into sessions; writes go through /ouroboros:learn' : 'Learning is off: sessions are only measured';
  const reviewedNote = o.reviewed.n
    ? `${fmt.int(o.reviewed.corrections)} corrections in ${fmt.int(o.reviewed.turns)} reviewed turns (${o.reviewed.n} sessions). This is the baseline learning has to beat.`
    : 'No session reviewed yet. Reviews run when a session ends.';
  const budget = o.cost.budget;

  const hero = h('div', { class: 'card hero' },
    h('div', { class: 'label' }, 'Corrections per 100 turns'),
    h('div', { class: 'value' }, fmt.rate(o.correctionRate)),
    h('div', { class: 'note' }, reviewedNote));

  const tiles = h('div', { class: 'tiles' },
    tile('Sessions', fmt.int(t.sessions), `${fmt.int(t.turns)} user turns`),
    tile('Learned', fmt.int((o.learned.memory || 0) + (o.learned.skill || 0) + (o.learned.profile || 0)),
      o.learned.enabledAt
        ? `${o.learned.profile || 0} profile · ${o.learned.memory || 0} memories · ${o.learned.skill || 0} skills${o.learned.patchedNative ? ` · ${o.learned.patchedNative} refined` : ''}`
        : 'nothing written yet'),
    tile('Recoveries', fmt.int(t.recoveries), 'errors followed by a working path'),
    tile('Would learn', fmt.int((o.candidates.memory || 0) + (o.candidates.skill || 0)), `${o.candidates.memory || 0} memories · ${o.candidates.skill || 0} skills`),
    tile('Misses', fmt.int(o.misses), 'had to repeat something already saved'),
    h('div', { class: 'card tile' },
      h('div', { class: 'label' }, 'Reviewer cost this month'),
      h('div', { class: 'value' }, fmt.usd(o.cost.month)),
      budget ? meter(o.cost.month, budget) : null,
      h('div', { class: 'sub' }, budget ? `of ${fmt.usd(budget)} monthly budget` : 'budget not reported yet')));

  const rate = (d) => (d.reviewedTurns ? (d.corrections / d.reviewedTurns) * 100 : null);
  const charts = h('div', { class: 'charts' },
    barChart({
      title: 'Corrections per 100 turns',
      data: o.series, value: rate, format: (v) => v.toFixed(v > 0 && v < 10 ? 1 : 0),
      tip: (d) => [fmt.day(d.day), `${d.corrections} corrections · ${d.reviewedTurns} turns reviewed`],
      emptyText: 'No reviewed sessions in this period',
    }),
    barChart({
      title: 'User turns',
      data: o.series, value: (d) => d.turns, format: (v) => fmt.compact(v),
      tip: (d) => [fmt.day(d.day), `${d.sessions} sessions`],
    }),
    barChart({
      title: 'Reviewer cost',
      data: o.series, value: (d) => d.cost, format: fmt.usd,
      tip: (d) => [fmt.day(d.day)],
    }));

  const sessions = h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Recent sessions')),
    h('div', { class: 'card' }, table([
      { label: 'Started', render: (r) => fmt.datetime(r.started_at) },
      { label: 'Project', render: (r) => projectName(r.project, r.cwd) },
      { label: 'Turns', num: true, render: (r) => fmt.int(r.turns) },
      { label: 'Tool calls', num: true, render: (r) => `${fmt.int(r.tool_calls)}${r.tool_fails ? ` (${r.tool_fails} failed)` : ''}` },
      { label: 'Recoveries', num: true, render: (r) => fmt.int(r.recoveries) },
      { label: 'Corrections', num: true, render: (r) => fmt.int(r.corrections) },
      { label: 'Would learn', num: true, render: (r) => fmt.int(r.candidates) },
      { label: 'Cost', num: true, render: (r) => fmt.usd(r.cost) },
      { label: 'Review', render: (r) => reviewState(r.queue_state) },
    ], o.sessions, { empty: 'No sessions recorded yet. Start a Claude Code session with the plugin enabled.' })));

  view.replaceChildren(h('div', { class: 'hero-row' }, hero, tiles), h('section', { class: 'section' }, charts), sessions);
}

function tile(label, value, sub) {
  return h('div', { class: 'card tile' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), h('div', { class: 'sub' }, sub));
}

function reviewState(st) {
  const map = { done: ['good', 'reviewed'], queued: ['warn', 'queued'], running: ['warn', 'running'], skipped: ['', 'skipped'], failed: ['bad', 'failed'] };
  const [cls, label] = map[st] || ['', 'not queued'];
  return h('span', { class: 'small' }, h('span', { class: `status-dot ${cls}` }), label);
}

const KIND_LABEL = { profile: 'profile', memory: 'memory', skill: 'skill' };

function learnedSection(learned, writes) {
  const active = learned.filter((l) => l.status === 'active');
  const table1 = table([
    { label: 'Learning', render: (r) => h('div', {}, h('div', {}, r.title), h('div', { class: 'desc mono' }, r.path)) },
    { label: 'Kind', render: (r) => h('span', { class: `badge ${r.kind}` }, r.kind === 'profile' ? `profile · ${r.block}` : r.memory_type ? `${KIND_LABEL[r.kind]} · ${r.memory_type}` : KIND_LABEL[r.kind]) },
    { label: 'Origin', render: (r) => (r.origin_session === 'native' ? 'refined' : r.trigger || '—') },
    { label: 'Uses', num: true, render: (r) => fmt.int(r.uses) },
    { label: 'Last used', render: (r) => (r.last_used_at ? fmt.ago(r.last_used_at) : '—') },
    { label: 'Confidence', render: (r) => h('span', { class: 'conf' }, meter(r.confidence || 0, 1, { plain: true }), fmt.pct((r.confidence || 0) * 100)) },
    { label: 'Updated', render: (r) => fmt.date(r.updated_at) },
  ], active, { empty: 'Nothing learned yet. Ask Claude to remember something, or run /ouroboros:learn after a session with corrections.' });

  const opLabel = { create: 'learned', patch: 'updated', archive: 'archived' };
  const log = writes.length
    ? h('ul', { class: 'list' }, writes.map((w) => h('li', {},
        h('div', {}, h('span', { class: `status-dot ${w.reverted_at ? '' : 'good'}` }), `${opLabel[w.op] || w.op}: `, w.title || '(unknown)', w.reverted_at ? h('span', { class: 'faint' }, ' — undone') : null),
        h('div', { class: 'faint small' }, `${fmt.datetime(w.ts)} · ${w.actor} · ${w.learning_id || ''}`))))
    : h('p', { class: 'muted small' }, 'No writes yet.');

  return [
    h('div', { class: 'section-head' },
      h('div', {}, h('h2', {}, 'Learned'), h('div', { class: 'muted small' }, `${active.length} active · undo with /ouroboros:undo, archive with /ouroboros:forget`))),
    h('div', { class: 'card' }, table1),
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', {}, 'Write log')), h('div', { class: 'card' }, log)),
  ];
}

async function renderLearnings() {
  const { learned, writes, candidates, corrections } = await api('learnings');
  const f = state.filters;
  const chipGroup = (key, options) => h('div', { class: 'chips', role: 'group' }, options.map(([value, label]) =>
    h('button', { class: 'chip', 'aria-pressed': String(f[key] === value), onclick: () => { f[key] = value; renderLearnings(); } }, label)));

  const shown = candidates.filter((c) => (f.kind === 'all' || c.kind === f.kind) && (f.scope === 'all' || c.scope === f.scope));
  const cards = shown.length
    ? h('div', { class: 'cards' }, shown.map((c) => h('article', { class: 'card lcard' },
        h('div', { class: 'meta' },
          h('span', { class: `badge ${c.kind}` }, c.kind === 'memory' && c.memory_type ? `memory · ${c.memory_type}` : c.kind),
          h('span', { class: 'badge' }, c.scope || '—'),
          h('span', {}, `${projectName(c.project, c.cwd)} · ${fmt.date(c.session_started_at)}`),
          h('span', { class: 'conf', title: 'Reviewer confidence' }, meter(c.confidence || 0, 1, { plain: true }), fmt.pct((c.confidence || 0) * 100))),
        h('div', { class: 'title' }, c.title),
        h('div', { class: 'summary' }, c.summary),
        c.repeats ? h('div', { class: 'small' }, h('span', { class: 'status-dot warn' }), `Repeats existing: ${c.repeats}`) : null,
        h('div', { class: 'evidence' }, c.evidence))))
    : emptyState('Nothing here yet', 'Each reviewed session lists what it would have learned. Phase 1 only records these; nothing is written.');

  const corr = h('div', { class: 'card' }, corrections.length
    ? h('ul', { class: 'list' }, corrections.map((c) => h('li', {},
        h('div', { class: 'quote' }, c.quote),
        h('div', { class: 'faint small' }, `${c.kind} · ${projectName(c.project, c.cwd)} · ${fmt.date(c.session_started_at)}`))))
    : h('p', { class: 'muted small' }, 'No corrections recorded.'));

  view.replaceChildren(
    ...learnedSection(learned, writes),
    h('section', { class: 'section' }, h('div', { class: 'section-head' },
      h('div', {}, h('h2', {}, 'Review candidates'), h('div', { class: 'muted small' }, `${shown.length} of ${candidates.length} — what end-of-session reviews found worth learning (recorded, not written)`)),
      h('div', { class: 'chips' }, chipGroup('kind', [['all', 'All'], ['memory', 'Memories'], ['skill', 'Skills']]), chipGroup('scope', [['all', 'Any scope'], ['global', 'Global'], ['project', 'Project']])))),
    cards,
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', {}, 'Corrections'), h('span', { class: 'muted small' }, `${corrections.length} recorded`)), corr));
}

async function renderInventory() {
  const inv = await api('inventory');
  const q = state.filters.q.toLowerCase();
  const match = (...xs) => !q || xs.some((x) => String(x || '').toLowerCase().includes(q));
  const memories = inv.memories.filter((m) => !m.index && match(m.name, m.description, m.project));
  const skills = inv.skills.filter((sk) => match(sk.name, sk.description, sk.scope));

  const search = h('input', { type: 'search', placeholder: 'Filter…', value: state.filters.q, 'aria-label': 'Filter inventory' });
  search.addEventListener('input', () => { state.filters.q = search.value; renderInventory().then(() => { const el = view.querySelector('input[type=search]'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }); });

  view.replaceChildren(
    h('div', { class: 'section-head' }, h('h2', {}, 'Inventory'), search),
    h('p', { class: 'muted small' }, 'Everything Claude already knows on this machine. "Learned" items will carry the Ouroboros origin once learning is on (phase 2).'),
    h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', {}, `Skills (${skills.length})`)),
      h('div', { class: 'card' }, table([
        { label: 'Skill', render: (r) => h('div', {}, h('div', {}, r.name, r.origin ? h('span', { class: 'badge skill', style: 'margin-left:6px' }, 'learned') : null), h('div', { class: 'desc' }, r.description.slice(0, 220))) },
        { label: 'Scope', render: (r) => r.scope === 'project' ? `project · ${projectName(r.project)}` : r.scope },
        { label: 'Uses', num: true, render: (r) => fmt.int(r.uses) },
        { label: 'Last used', render: (r) => (r.lastUsed ? fmt.ago(r.lastUsed) : '—') },
        { label: 'Description', num: true, render: (r) => `${fmt.int(r.descriptionChars)} ch` },
      ], skills, { empty: 'No skills found.' }))),
    h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', {}, `Memories (${memories.length})`)),
      h('div', { class: 'card' }, table([
        { label: 'Memory', render: (r) => h('div', {}, h('div', {}, r.name), h('div', { class: 'desc' }, r.description)) },
        { label: 'Type', render: (r) => r.type || '—' },
        { label: 'Project', render: (r) => r.project },
        { label: 'Reads', num: true, render: (r) => fmt.int(r.reads) },
        { label: 'Updated', render: (r) => fmt.date(r.mtime) },
      ], memories, { empty: 'No memory files found.' }))),
    h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', {}, 'Instruction files')),
      h('div', { class: 'card' }, table([
        { label: 'File', render: (r) => h('span', { class: 'mono' }, r.file) },
        { label: 'Scope', render: (r) => r.scope },
        { label: 'Lines', num: true, render: (r) => fmt.int(r.lines) },
        { label: 'Updated', render: (r) => fmt.date(r.mtime) },
      ], inv.instructions))));
}

async function renderHealth() {
  const hl = await api('health');
  const LISTING_REF = 2000; // ~1% of a 200K-token context
  const queue = Object.fromEntries(hl.queue.map((q) => [q.state, q.n]));
  const alive = hl.capture.lastEventAt && Date.now() - hl.capture.lastEventAt < 7 * 86_400_000;

  view.replaceChildren(
    h('div', { class: 'grid-2' },
      h('div', { class: 'card' },
        h('h3', {}, 'Capture'),
        h('div', {}, h('span', { class: `status-dot ${alive ? 'good' : 'warn'}` }), alive ? 'Hooks are recording' : 'No hook activity recently'),
        h('div', { class: 'muted small' }, `Last event ${fmt.ago(hl.capture.lastEventAt)} · ${fmt.int(hl.capture.eventsLast24h)} events in 24 h`)),
      h('div', { class: 'card' },
        h('h3', {}, 'Reviewer'),
        h('div', {}, `${fmt.int(queue.done || 0)} reviewed · ${fmt.int(queue.skipped || 0)} skipped · ${fmt.int((queue.queued || 0) + (queue.running || 0))} pending · ${fmt.int(queue.failed || 0)} failed`),
        h('div', { class: 'muted small' }, hl.options ? `Model ${hl.options.reviewerModel} · measurement ${hl.options.measureReview ? 'on' : 'off'}` : 'Options are reported at the next session start.'),
        hl.skippedReviews.length ? h('div', { class: 'faint small' }, `Skipped: ${hl.skippedReviews.map((r) => `${r.detail} (${r.n})`).join(', ')}`) : null)),

    h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', {}, 'Context budgets')),
      h('div', { class: 'grid-2' },
        h('div', { class: 'card' },
          h('h3', {}, 'Skill listing'),
          h('div', {}, `${fmt.int(hl.skillListing.tokens)} tokens · ${hl.skillListing.skills} model-invocable skills`),
          meter(hl.skillListing.tokens, LISTING_REF),
          h('div', { class: 'faint small' }, `Personal and project skills only (plugin skills not counted). Reference: ${fmt.int(LISTING_REF)} tokens ≈ 1% of a 200K context; past the budget, Claude Code drops descriptions of rarely used skills.`)),
        h('div', { class: 'card' },
          h('h3', {}, 'Global profile (user.md)'),
          ...[['User', hl.budgets.userBlock], ['Environment & lessons', hl.budgets.environmentBlock]].map(([label, b]) => h('div', { style: 'margin-bottom:10px' },
            h('div', { class: 'small' }, `${label} — ${fmt.int(b.used)} / ${fmt.int(b.limit)} chars · ${b.items} facts`),
            meter(b.used, b.limit))),
          h('div', { class: 'small' }, `Learned skills — ${hl.budgets.learnedSkills.used} / ${hl.budgets.learnedSkills.limit}`),
          meter(hl.budgets.learnedSkills.used, hl.budgets.learnedSkills.limit),
          h('div', { class: 'faint small' }, 'Budgets live in ~/.ouroboros/config.json. Past 80%, consolidate.'))),
      h('div', { class: 'card', style: 'margin-top:16px' },
        h('h3', {}, 'MEMORY.md indexes'),
        h('p', { class: 'faint small', style: 'margin-top:0' }, `Claude Code loads only the first 200 lines (or 25 KB) of each index; Ouroboros stops adding at ${hl.budgets.memoryIndexLines}.`),
        hl.indexes.length ? h('div', {}, hl.indexes.map((ix) => h('div', { style: 'margin-bottom:10px' },
          h('div', { class: 'small' }, h('span', { class: 'mono' }, ix.project), ` — ${ix.lines} / ${hl.budgets.memoryIndexLines} lines`),
          meter(ix.lines, hl.budgets.memoryIndexLines)))) : h('p', { class: 'muted small' }, 'No memory indexes found.'))),

    h('section', { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', {}, 'Problems')),
      h('div', { class: 'grid-2' },
        h('div', { class: 'card' }, h('h3', {}, 'Failed reviews'),
          hl.failedReviews.length
            ? h('ul', { class: 'list' }, hl.failedReviews.map((r) => h('li', {}, h('div', { class: 'small' }, r.detail), h('div', { class: 'faint small' }, `${fmt.datetime(r.ts)} · ${r.session_id}`))))
            : h('p', { class: 'muted small' }, 'None.')),
        h('div', { class: 'card' }, h('h3', {}, 'Errors'),
          hl.errors.length
            ? h('ul', { class: 'list' }, hl.errors.map((e) => h('li', {}, h('div', { class: 'mono' }, e.message.split('\n')[0]), h('div', { class: 'faint small' }, `${fmt.datetime(e.ts)} · ${e.source}`))))
            : h('p', { class: 'muted small' }, 'None.')))));
}

// ---------- shell ----------
const renderers = { overview: renderOverview, learnings: renderLearnings, inventory: renderInventory, health: renderHealth };

async function render() {
  hideTip();
  rangeSelect.disabled = state.tab !== 'overview';
  try {
    await renderers[state.tab]();
  } catch (err) {
    view.replaceChildren(emptyState('Could not load data', String(err.message)));
  }
}

for (const btn of document.querySelectorAll('.tabs button')) {
  btn.addEventListener('click', () => {
    state.tab = btn.dataset.tab;
    for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b === btn));
    history.replaceState(null, '', `#${state.tab}`);
    render();
  });
}
rangeSelect.addEventListener('change', () => { state.days = Number(rangeSelect.value); render(); });

const themeBtn = document.getElementById('theme');
try {
  const saved = localStorage.getItem('ouroboros-theme');
  if (saved) document.documentElement.dataset.theme = saved;
} catch { /* storage unavailable */ }
themeBtn.addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('ouroboros-theme', next); } catch { /* ignore */ }
});

const initial = location.hash.slice(1);
if (renderers[initial]) document.querySelector(`.tabs button[data-tab="${initial}"]`).click();
else render();
setInterval(() => { if (!document.hidden && state.tab === 'overview') render(); }, 60_000);
