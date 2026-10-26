// Boolean path operations (Unite, Minus Front, Intersect, Exclude) and Offset Path, on curves
// flattened to fine polygons, using Angus Johnson's Clipper (vendor/clipper.js, Boost licence).

import { flatten } from './geom.js';
import { textLocalBox } from './doc.js';
import { apply } from './geom.js';

const S = 1000; // Clipper works in integers: 1/1000 px
const TOL = 0.05; // curve flattening, px (about 0.0005 in)

const CL = () => {
  if (!window.ClipperLib) throw new Error('The path library did not load.');
  return window.ClipperLib;
};

/** Every object (groups opened up) as Clipper polygons, normalized to non-zero filling. */
export function toPolygons(o) {
  const C = CL();
  const raw = [];
  let rule = C.PolyFillType.pftNonZero;
  const add = (x) => {
    if (x.type === 'group') return x.children.forEach(add);
    if (x.type === 'path') {
      for (const r of flatten(x, TOL)) if (r.pts.length > 2) raw.push(r.pts.map((p) => ({ X: Math.round(p.x * S), Y: Math.round(p.y * S) })));
      if (x.fillRule === 'evenodd') rule = C.PolyFillType.pftEvenOdd;
    } else if (x.type === 'text' || x.type === 'image') {
      const b = x.type === 'text' ? textLocalBox(x) : { x: 0, y: 0, w: x.w, h: x.h };
      const m = x.matrix || [1, 0, 0, 1, 0, 0];
      raw.push([{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }]
        .map((p) => apply(m, p)).map((p) => ({ X: Math.round(p.x * S), Y: Math.round(p.y * S) })));
    }
  };
  add(o);
  return C.Clipper.SimplifyPolygons(raw, rule);
}

function run(type, subj, clip) {
  const C = CL();
  const c = new C.Clipper();
  c.AddPaths(subj, C.PolyType.ptSubject, true);
  if (clip && clip.length) c.AddPaths(clip, C.PolyType.ptClip, true);
  const out = new C.Paths();
  c.Execute(type, out, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
  return out;
}

/** op: 'unite' | 'minus' | 'intersect' | 'exclude'. objs back to front. Returns subpaths. */
export function booleanOp(op, objs) {
  const C = CL(), T = C.ClipType;
  const polys = objs.map(toPolygons);
  let res;
  if (op === 'unite') res = run(T.ctUnion, polys.flat());
  else if (op === 'minus') res = run(T.ctDifference, polys[0], polys.slice(1).flat());
  else if (op === 'intersect') {
    res = polys[0];
    for (const p of polys.slice(1)) res = run(T.ctIntersection, res, p);
  } else {
    res = polys[0];
    for (const p of polys.slice(1)) res = run(T.ctXor, res, p);
  }
  return toSubpaths(C.Clipper.CleanPolygons(res, 0.002 * S));
}

/**
 * Offset (positive grows, negative shrinks) by `delta` px. join: 'round' | 'miter' | 'square'.
 * Open paths are outlined (both sides).
 */
export function offsetPath(o, delta, join = 'round', miter = 4) {
  const C = CL();
  const jt = { round: C.JoinType.jtRound, miter: C.JoinType.jtMiter, square: C.JoinType.jtSquare }[join];
  const co = new C.ClipperOffset(miter, TOL * S);
  const closed = [], open = [];
  const add = (x) => {
    if (x.type === 'group') return x.children.forEach(add);
    if (x.type !== 'path') return;
    for (const r of flatten(x, TOL)) {
      const pts = r.pts.map((p) => ({ X: Math.round(p.x * S), Y: Math.round(p.y * S) }));
      if (r.closed && pts.length > 2) closed.push(pts);
      else if (pts.length > 1) open.push(pts);
    }
  };
  add(o);
  if (closed.length) co.AddPaths(C.Clipper.SimplifyPolygons(closed, o.fillRule === 'evenodd' ? C.PolyFillType.pftEvenOdd : C.PolyFillType.pftNonZero), jt, C.EndType.etClosedPolygon);
  if (open.length) co.AddPaths(open, jt, join === 'round' ? C.EndType.etOpenRound : join === 'square' ? C.EndType.etOpenSquare : C.EndType.etOpenButt);
  const out = new C.Paths();
  co.Execute(out, (open.length && !closed.length ? Math.abs(delta) : delta) * S);
  return toSubpaths(C.Clipper.CleanPolygons(out, 0.002 * S));
}

function toSubpaths(paths) {
  return paths.filter((p) => p.length > 2).map((p) => ({
    closed: true,
    nodes: p.map((q) => ({ x: q.X / S, y: q.Y / S, in: null, out: null })),
  }));
}
