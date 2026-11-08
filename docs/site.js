// Ouroboros site: copy buttons, the loop demo, and one entrance per section.
document.documentElement.classList.add('js');

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

// Copy the install commands.
for (const button of document.querySelectorAll('[data-copy]')) {
  const label = button.querySelector('[data-copy-label]');
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      label.textContent = 'Copied';
      button.classList.add('done');
    } catch {
      label.textContent = 'Select and copy';
    }
    setTimeout(() => { label.textContent = 'Copy'; button.classList.remove('done'); }, 1800);
  });
}

// The loop: a dot travels the ring from station to station; each station shows one frame.
const STEP_MS = 3400;
const TRAVEL = 0.32; // share of a step spent moving; the rest dwells on the station
const dot = document.querySelector('[data-dot]');
const stations = [...document.querySelectorAll('.station')];
const frames = [...document.querySelectorAll('[data-frame]')];
const ease = (t) => 1 - Math.pow(1 - t, 4);
let current = -1;
let start = performance.now();
let paused = false;

function show(step) {
  if (step === current) return;
  current = step;
  stations.forEach((s, i) => s.setAttribute('aria-pressed', String(i === step)));
  frames.forEach((f, i) => { f.hidden = i !== step; });
}
function place(angle) {
  dot?.setAttribute('transform', `rotate(${angle} 220 220)`);
}
function tick(now) {
  if (!paused) {
    const t = (now - start) / STEP_MS;
    const step = Math.floor(t) % 4;
    const p = t - Math.floor(t);
    // Travel from the previous station into this one, then dwell.
    const move = Math.min(p / TRAVEL, 1);
    place(((step - 1) + ease(move)) * 90);
    show(step);
  }
  requestAnimationFrame(tick);
}

stations.forEach((s, i) => s.addEventListener('click', () => {
  paused = true;
  show(i);
  place(i * 90);
}));

if (dot && stations.length) {
  if (reduced.matches) {
    show(0);
    place(0);
    paused = true;
  } else {
    requestAnimationFrame(tick);
  }
}

// Sticky bar border once the page scrolls.
const top = document.querySelector('.top');
const onScroll = () => top?.classList.toggle('scrolled', window.scrollY > 8);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

// One entrance per section, only for content below the first viewport.
if (!reduced.matches && 'IntersectionObserver' in window) {
  const targets = document.querySelectorAll('main > section:not(.hero) .wrap > *');
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px' });
  for (const el of targets) {
    if (el.getBoundingClientRect().top > window.innerHeight) { el.classList.add('reveal'); io.observe(el); }
  }
}
