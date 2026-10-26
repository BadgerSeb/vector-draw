// Geometry: matrices, Bézier paths, bounds, flattening, hit tests.
//
// A path is { subpaths: [{ closed, nodes: [{ x, y, in, out }] }] } in document pixels (1/96 in).
// `in`/`out` are absolute handle positions or null (a corner without a handle on that side).

export const K = 0.5522847498307936; // circle as four Béziers

// ------------------------------------------------------------ matrices [a b c d e f]
export const I = () => [1, 0, 0, 1, 0, 0];
export const mul = (m, n) => [ // m after n
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
export const apply = (m, p) => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
export function invert(m) {
  const d = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(d) < 1e-12) return I();
  return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
}
export const translate = (x, y) => [1, 0, 0, 1, x, y];
export const scaleAt = (sx, sy, cx, cy) => [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy];
export function rotateAt(rad, cx, cy) {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
}
export const isIdentity = (m) => !m || (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0);

// ------------------------------------------------------------ boxes {x, y, w, h}
export const emptyBox = () => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
export function growBox(b, p) {
  if (p.x < b.x0) b.x0 = p.x;
  if (p.y < b.y0) b.y0 = p.y;
  if (p.x > b.x1) b.x1 = p.x;
  if (p.y > b.y1) b.y1 = p.y;
}
export function unionBox(a, b) {
  if (!b) return a;
  if (!a) return b;
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
}
export const finishBox = (b) => (b.x0 > b.x1 ? null : { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 });
export const boxesTouch = (a, b) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;

// ------------------------------------------------------------ Bézier segments
/** The segments of a subpath: [p0, c1, c2, p3, line?] */
export function segments(sp) {
  const n = sp.nodes, out = [];
  const count = sp.closed ? n.length : n.length - 1;
  for (let i = 0; i < count; i++) {
    const a = n[i], b = n[(i + 1) % n.length];
    const c1 = a.out || a, c2 = b.in || b;
    out.push({ p0: a, c1, c2, p3: b, line: !a.out && !b.in, i });
  }
  return out;
}

export function bez(s, t) {
  const u = 1 - t;
  return {
    x: u * u * u * s.p0.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t * t * t * s.p3.x,
    y: u * u * u * s.p0.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t * t * t * s.p3.y,
  };
}

/** Splits a segment at t (de Casteljau): returns [left, right] control points. */
export function splitSeg(s, t) {
  const l = (a, b) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const ab = l(s.p0, s.c1), bc = l(s.c1, s.c2), cd = l(s.c2, s.p3);
  const abc = l(ab, bc), bcd = l(bc, cd), m = l(abc, bcd);
  return { a1: ab, a2: abc, m, b1: bcd, b2: cd };
}

function extremaT(p0, p1, p2, p3) {
  // derivative roots of one coordinate
  const a = -p0 + 3 * p1 - 3 * p2 + p3, b = 2 * (p0 - 2 * p1 + p2), c = p1 - p0;
  const ts = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) ts.push(-c / b);
  } else {
    const d = b * b - 4 * a * c;
    if (d >= 0) {
      const r = Math.sqrt(d);
      ts.push((-b + r) / (2 * a), (-b - r) / (2 * a));
    }
  }
  return ts.filter((t) => t > 0 && t < 1);
}

export function pathBox(path, m) {
  const b = emptyBox();
  for (const sp of path.subpaths) {
    if (!sp.nodes.length) continue;
    const t = m ? transformSub(sp, m) : sp;
    growBox(b, t.nodes[0]);
    for (const s of segments(t)) {
      growBox(b, s.p3);
      if (s.line) continue;
      for (const k of [...extremaT(s.p0.x, s.c1.x, s.c2.x, s.p3.x), ...extremaT(s.p0.y, s.c1.y, s.c2.y, s.p3.y)]) growBox(b, bez(s, k));
    }
  }
  return finishBox(b);
}

const tp = (m, p) => (p ? apply(m, p) : null);
export function transformSub(sp, m) {
  return { closed: sp.closed, nodes: sp.nodes.map((n) => ({ ...n, ...apply(m, n), in: tp(m, n.in), out: tp(m, n.out) })) };
}

/** Flattens a path to polylines: [{ closed, pts: [{x,y}] }], within `tol` px. */
export function flatten(path, tol = 0.25) {
  const out = [];
  for (const sp of path.subpaths) {
    if (!sp.nodes.length) continue;
    const pts = [{ x: sp.nodes[0].x, y: sp.nodes[0].y }];
    for (const s of segments(sp)) {
      if (!s.line) {
        const len = dist(s.p0, s.c1) + dist(s.c1, s.c2) + dist(s.c2, s.p3);
        const n = Math.min(400, Math.max(2, Math.ceil(Math.sqrt(len / (tol * 1.5)) * 1.6)));
        for (let k = 1; k < n; k++) pts.push(bez(s, k / n));
      }
      pts.push({ x: s.p3.x, y: s.p3.y });
    }
    if (sp.closed && pts.length > 1 && dist(pts[0], pts[pts.length - 1]) < 1e-9) pts.pop();
    out.push({ closed: sp.closed, pts });
  }
  return out;
}

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l = dx * dx + dy * dy;
  let t = l ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** The nearest point on a path: { sub, seg, t, d, pt } */
export function nearestOnPath(path, p) {
  let best = null;
  path.subpaths.forEach((sp, si) => {
    for (const s of segments(sp)) {
      const N = s.line ? 1 : 40;
      let bt = 0, bd = Infinity;
      for (let k = 0; k <= N * (s.line ? 50 : 1); k++) {
        const t = k / (N * (s.line ? 50 : 1));
        const q = bez(s, t), d = dist(q, p);
        if (d < bd) { bd = d; bt = t; }
      }
      // refine
      let step = 1 / (N * 2);
      for (let r = 0; r < 20; r++) {
        for (const t of [bt - step, bt + step]) {
          if (t < 0 || t > 1) continue;
          const d = dist(bez(s, t), p);
          if (d < bd) { bd = d; bt = t; }
        }
        step /= 2;
      }
      if (!best || bd < best.d) best = { sub: si, seg: s.i, t: bt, d: bd, pt: bez(s, bt) };
    }
  });
  return best;
}

/** Point in polygon (even-odd) on flattened rings. */
export function insideRings(rings, p) {
  let inside = false;
  for (const r of rings) {
    const pts = r.pts;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

/** SVG path data for a path. */
export function pathD(path, digits = 3) {
  const f = (v) => fmt(v, digits);
  let d = '';
  for (const sp of path.subpaths) {
    if (!sp.nodes.length) continue;
    d += `M${f(sp.nodes[0].x)} ${f(sp.nodes[0].y)}`;
    for (const s of segments(sp)) {
      if (s.line) d += `L${f(s.p3.x)} ${f(s.p3.y)}`;
      else d += `C${f(s.c1.x)} ${f(s.c1.y)} ${f(s.c2.x)} ${f(s.c2.y)} ${f(s.p3.x)} ${f(s.p3.y)}`;
    }
    if (sp.closed) d += 'Z';
  }
  return d;
}

export function fmt(v, digits = 3) {
  const p = 10 ** digits;
  let s = (Math.round(v * p) / p).toFixed(digits);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

// ------------------------------------------------------------ shape builders (all return paths)
const node = (x, y, inp = null, out = null) => ({ x, y, in: inp, out });

export function rectPath(x, y, w, h, r = 0) {
  r = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  if (r <= 0) {
    return { subpaths: [{ closed: true, nodes: [node(x, y), node(x + w, y), node(x + w, y + h), node(x, y + h)] }] };
  }
  const k = r * (1 - K);
  const n = [
    node(x + r, y, { x: x + k, y }, null), node(x + w - r, y, null, { x: x + w - k, y }),
    node(x + w, y + r, { x: x + w, y: y + k }, null), node(x + w, y + h - r, null, { x: x + w, y: y + h - k }),
    node(x + w - r, y + h, { x: x + w - k, y: y + h }, null), node(x + r, y + h, null, { x: x + k, y: y + h }),
    node(x, y + h - r, { x, y: y + h - k }, null), node(x, y + r, null, { x, y: y + k }),
  ];
  return { subpaths: [{ closed: true, nodes: n }] };
}

export function ellipsePath(cx, cy, rx, ry) {
  rx = Math.abs(rx); ry = Math.abs(ry);
  const kx = rx * K, ky = ry * K;
  return {
    subpaths: [{
      closed: true,
      nodes: [
        node(cx, cy - ry, { x: cx - kx, y: cy - ry }, { x: cx + kx, y: cy - ry }),
        node(cx + rx, cy, { x: cx + rx, y: cy - ky }, { x: cx + rx, y: cy + ky }),
        node(cx, cy + ry, { x: cx + kx, y: cy + ry }, { x: cx - kx, y: cy + ry }),
        node(cx - rx, cy, { x: cx - rx, y: cy + ky }, { x: cx - rx, y: cy - ky }),
      ].map((n) => ({ ...n, smooth: true })),
    }],
  };
}

export function polygonPath(cx, cy, r, sides, rot = -Math.PI / 2) {
  const nodes = [];
  for (let i = 0; i < sides; i++) {
    const a = rot + (i * 2 * Math.PI) / sides;
    nodes.push(node(cx + r * Math.cos(a), cy + r * Math.sin(a)));
  }
  return { subpaths: [{ closed: true, nodes }] };
}

export function starPath(cx, cy, r, points, inner = 0.5, rot = -Math.PI / 2) {
  const nodes = [];
  for (let i = 0; i < points * 2; i++) {
    const a = rot + (i * Math.PI) / points, rr = i % 2 ? r * inner : r;
    nodes.push(node(cx + rr * Math.cos(a), cy + rr * Math.sin(a)));
  }
  return { subpaths: [{ closed: true, nodes }] };
}

/** Circular arc from a0 to a1 (radians, y down) as Bézier nodes, for imports. */
export function arcNodes(cx, cy, r, a0, a1) {
  const sweep = a1 - a0;
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const da = sweep / n, k = (4 / 3) * Math.tan(da / 4) * r;
  const nodes = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + da * i, c = Math.cos(a), s = Math.sin(a);
    const p = { x: cx + r * c, y: cy + r * s };
    nodes.push({
      ...p,
      in: i > 0 ? { x: p.x + k * s, y: p.y - k * c } : null,
      out: i < n ? { x: p.x - k * s, y: p.y + k * c } : null,
      smooth: i > 0 && i < n,
    });
  }
  return nodes;
}

// ------------------------------------------------------------ freehand fitting
export function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i], pts[a], pts[b]);
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol && mi > 0) {
      keep[mi] = 1;
      stack.push([a, mi], [mi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Smooth nodes through points (Catmull-Rom turned into Béziers). */
export function smoothNodes(pts, closed, tension = 1 / 6) {
  const n = pts.length;
  const at = (i) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  return pts.map((p, i) => {
    const a = at(i - 1), b = at(i + 1);
    const dx = (b.x - a.x) * tension, dy = (b.y - a.y) * tension;
    const first = !closed && i === 0, last = !closed && i === n - 1;
    return {
      x: p.x, y: p.y,
      in: first ? null : { x: p.x - dx, y: p.y - dy },
      out: last ? null : { x: p.x + dx, y: p.y + dy },
      smooth: !first && !last,
    };
  });
}
