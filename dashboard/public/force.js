// A small force-directed layout (no dependencies), after the model d3-force uses:
// springs along edges, repulsion between every pair of nodes, a pull toward the
// center and collision, integrated with velocity decay while `alpha` cools down.
// O(n²) repulsion is fine for the few hundred items a knowledge graph has.

/** Rest length and stiffness per edge type. */
const LINK = {
  belongs: { dist: 70, k: 0.25 },
  contains: { dist: 34, k: 0.9 },
  link: { dist: 60, k: 0.7 },
  mention: { dist: 80, k: 0.5 },
  used: { dist: 90, k: 0.3 },
  similar: { dist: 110, k: 0.08 },
};

const ALPHA_MIN = 0.002;
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 300);
const VELOCITY_KEEP = 0.6;
const GRAVITY = 0.04;
const MAX_REPULSION_DIST2 = 600 * 600;

/**
 * `nodes`: [{ id, x?, y?, r, charge }] (mutated: x, y, vx, vy; set fx/fy to pin one).
 * `edges`: [{ source, target, type }] by id. Returns { tick, alpha, reheat, done }.
 */
export function forceLayout(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Deterministic start (a phyllotaxis spiral) for nodes without a saved position.
  nodes.forEach((n, i) => {
    if (Number.isFinite(n.x) && Number.isFinite(n.y)) return;
    const r = 12 * Math.sqrt(0.5 + i);
    const a = i * Math.PI * (3 - Math.sqrt(5));
    n.x = r * Math.cos(a);
    n.y = r * Math.sin(a);
  });
  for (const n of nodes) { n.vx = 0; n.vy = 0; }

  const links = edges.map((e) => ({ s: byId.get(e.source), t: byId.get(e.target), ...(LINK[e.type] || LINK.link) })).filter((l) => l.s && l.t);
  const degree = new Map();
  for (const l of links) {
    degree.set(l.s, (degree.get(l.s) || 0) + 1);
    degree.set(l.t, (degree.get(l.t) || 0) + 1);
  }
  for (const l of links) {
    const ds = degree.get(l.s);
    const dt = degree.get(l.t);
    l.bias = ds / (ds + dt);
    l.strength = l.k / Math.min(ds, dt);
  }

  let alpha = 1;

  function tick() {
    for (const l of links) {
      let x = l.t.x + l.t.vx - l.s.x - l.s.vx;
      let y = l.t.y + l.t.vy - l.s.y - l.s.vy;
      const d = Math.hypot(x, y) || 1e-6;
      const f = ((d - l.dist) / d) * alpha * l.strength;
      x *= f;
      y *= f;
      l.t.vx -= x * l.bias;
      l.t.vy -= y * l.bias;
      l.s.vx += x * (1 - l.bias);
      l.s.vy += y * (1 - l.bias);
    }
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        if (dx === 0 && dy === 0) { dx = (Math.random() - 0.5) * 1e-3; dy = (Math.random() - 0.5) * 1e-3; }
        let d2 = dx * dx + dy * dy;
        if (d2 > MAX_REPULSION_DIST2) continue;
        const min = a.r + b.r + 3;
        if (d2 < min * min) {
          // Collision: push the two apart by part of their overlap.
          const d = Math.sqrt(d2);
          const push = ((min - d) / d) * 0.35;
          a.vx -= dx * push; a.vy -= dy * push;
          b.vx += dx * push; b.vy += dy * push;
        }
        d2 = Math.max(d2, 25);
        // Charges are negative (repulsion), as in d3's many-body force.
        a.vx += (dx * b.charge * alpha) / d2;
        a.vy += (dy * b.charge * alpha) / d2;
        b.vx -= (dx * a.charge * alpha) / d2;
        b.vy -= (dy * a.charge * alpha) / d2;
      }
    }
    for (const n of nodes) {
      n.vx -= n.x * GRAVITY * alpha;
      n.vy -= n.y * GRAVITY * alpha;
      if (n.fx !== undefined && n.fx !== null) { n.x = n.fx; n.vx = 0; } else { n.vx *= VELOCITY_KEEP; n.x += n.vx; }
      if (n.fy !== undefined && n.fy !== null) { n.y = n.fy; n.vy = 0; } else { n.vy *= VELOCITY_KEEP; n.y += n.vy; }
    }
    alpha += (0 - alpha) * ALPHA_DECAY;
  }

  return {
    tick,
    alpha: () => alpha,
    /** Warm the layout up again (after a drag), never cooling it down. */
    reheat: (to = 0.3) => { alpha = Math.max(alpha, to); },
    done: () => alpha < ALPHA_MIN,
  };
}
