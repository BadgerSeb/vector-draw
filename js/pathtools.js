// Path editing helpers: reversing, joining open pieces into chains, splitting segments,
// converting anchors, and turning shapes into paths.

import { segments, splitSeg, dist, rectPath } from './geom.js';
import { textLocalBox } from './doc.js';

export function reverseNodes(nodes) {
  return nodes.slice().reverse().map((n) => ({ ...n, in: n.out, out: n.in }));
}

/**
 * Joins open node chains whose ends meet (within tol) into longer chains; chains whose two ends
 * meet become closed. Input/Output: [{ nodes, closed, ...meta }].
 */
export function joinChains(chains, tol) {
  const open = chains.filter((c) => !c.closed && c.nodes.length > 1).map((c) => ({ ...c, nodes: c.nodes.slice() }));
  const done = chains.filter((c) => c.closed || c.nodes.length <= 1);
  const key = (p) => `${Math.round(p.x / tol)},${Math.round(p.y / tol)}`;
  const near = (a, b) => dist(a, b) <= tol;
  // endpoint index for speed (neighbouring cells checked too)
  const ends = new Map();
  const put = (c) => {
    for (const p of [c.nodes[0], c.nodes[c.nodes.length - 1]]) {
      const k = key(p);
      if (!ends.has(k)) ends.set(k, new Set());
      ends.get(k).add(c);
    }
  };
  const drop = (c) => { for (const s of ends.values()) s.delete(c); };
  open.forEach(put);
  const find = (p, self) => {
    const gx = Math.round(p.x / tol), gy = Math.round(p.y / tol);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const s = ends.get(`${gx + dx},${gy + dy}`);
      if (!s) continue;
      for (const c of s) if (c !== self && (near(c.nodes[0], p) || near(c.nodes[c.nodes.length - 1], p))) return c;
    }
    return null;
  };
  const alive = new Set(open);
  for (const c of open) {
    if (!alive.has(c)) continue;
    let grew = true;
    while (grew) {
      grew = false;
      const first = c.nodes[0], last = c.nodes[c.nodes.length - 1];
      if (c.nodes.length > 2 && near(first, last)) break;
      for (const [end, atEnd] of [[last, true], [first, false]]) {
        const o = find(end, c);
        if (!o) continue;
        drop(o); drop(c);
        alive.delete(o);
        let on = o.nodes;
        if (atEnd) {
          if (!near(on[0], end)) on = reverseNodes(on);
          c.nodes[c.nodes.length - 1] = { ...c.nodes[c.nodes.length - 1], out: on[0].out };
          c.nodes.push(...on.slice(1));
        } else {
          if (!near(on[on.length - 1], end)) on = reverseNodes(on);
          c.nodes[0] = { ...c.nodes[0], in: on[on.length - 1].in };
          c.nodes.unshift(...on.slice(0, -1));
        }
        put(c);
        grew = true;
        break;
      }
    }
  }
  const out = [...done];
  for (const c of open) {
    if (!alive.has(c)) continue;
    const n = c.nodes;
    if (n.length > 2 && near(n[0], n[n.length - 1])) {
      n[0] = { ...n[0], in: n[n.length - 1].in };
      n.pop();
      c.closed = true;
    }
    out.push(c);
  }
  return out;
}

/** Inserts an anchor at t on segment `seg` of subpath sp (mutates). Returns the new node index. */
export function insertAnchor(sp, seg, t) {
  const segs = segments(sp);
  const s = segs.find((g) => g.i === seg);
  if (!s) return -1;
  const a = sp.nodes[seg], bi = (seg + 1) % sp.nodes.length, b = sp.nodes[bi];
  if (s.line) {
    const p = { x: s.p0.x + (s.p3.x - s.p0.x) * t, y: s.p0.y + (s.p3.y - s.p0.y) * t };
    sp.nodes.splice(seg + 1, 0, { ...p, in: null, out: null });
    return seg + 1;
  }
  const r = splitSeg(s, t);
  a.out = r.a1;
  b.in = r.b2;
  sp.nodes.splice(seg + 1, 0, { x: r.m.x, y: r.m.y, in: r.a2, out: r.b1, smooth: true });
  return seg + 1;
}

/** Toggles an anchor between corner (no handles) and smooth (handles along its neighbours). */
export function convertAnchor(sp, i) {
  const n = sp.nodes[i];
  if (n.in || n.out) {
    n.in = n.out = null;
    n.smooth = false;
    return;
  }
  const len = sp.nodes.length;
  const prev = sp.nodes[(i - 1 + len) % len], next = sp.nodes[(i + 1) % len];
  const hasPrev = sp.closed || i > 0, hasNext = sp.closed || i < len - 1;
  const a = hasPrev ? prev : n, b = hasNext ? next : n;
  let dx = b.x - a.x, dy = b.y - a.y;
  const l = Math.hypot(dx, dy) || 1;
  dx /= l; dy /= l;
  const d1 = hasPrev ? dist(n, prev) / 3 : 0, d2 = hasNext ? dist(n, next) / 3 : 0;
  n.in = hasPrev ? { x: n.x - dx * d1, y: n.y - dy * d1 } : null;
  n.out = hasNext ? { x: n.x + dx * d2, y: n.y + dy * d2 } : null;
  n.smooth = true;
}

/** A text or image as a path of its box outline (text has no outlines here). */
export function boxPathOf(o) {
  const b = o.type === 'text' ? textLocalBox(o) : { x: 0, y: 0, w: o.w, h: o.h };
  const p = rectPath(b.x, b.y, b.w, b.h);
  const m = o.matrix || [1, 0, 0, 1, 0, 0];
  for (const n of p.subpaths[0].nodes) {
    const x = n.x, y = n.y;
    n.x = m[0] * x + m[2] * y + m[4];
    n.y = m[1] * x + m[3] * y + m[5];
  }
  return p;
}
