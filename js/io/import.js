// Reading files: SVG (shapes, paths, groups, transforms, text, images), DXF (lines, arcs,
// circles and polylines as exact curves; splines, ellipses, blocks and text through the DXF
// scene reader) and raster pictures.

import { Drawing } from '../dxf/model.js';
import { Scene, Xf, lwVertices } from '../dxf/scene.js';
import { arcNodes, mul, apply, invert, transformSub, rectPath, ellipsePath, I } from '../geom.js';
import { newId, defaultStyle, adoptDocument, newDocument, boundsOf } from '../doc.js';
import { joinChains } from '../pathtools.js';

// ======================================================================= SVG

export function parsePathData(d) {
  const tokens = String(d).match(/[a-df-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [];
  const subs = [];
  let i = 0, cmd = '', cur = { x: 0, y: 0 }, start = { x: 0, y: 0 }, sp = null;
  let lastC = null, lastQ = null; // reflected control points
  const num = () => parseFloat(tokens[i++]);
  const begin = (p) => {
    sp = { closed: false, nodes: [{ x: p.x, y: p.y, in: null, out: null }] };
    subs.push(sp);
    start = { ...p };
  };
  const ensure = () => { if (!sp) begin(cur); };
  const lineTo = (p) => {
    ensure();
    sp.nodes.push({ x: p.x, y: p.y, in: null, out: null });
    cur = p;
  };
  const cubicTo = (c1, c2, p) => {
    ensure();
    sp.nodes[sp.nodes.length - 1].out = c1;
    sp.nodes.push({ x: p.x, y: p.y, in: c2, out: null });
    cur = p;
  };
  while (i < tokens.length) {
    if (/^[a-z]$/i.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const R = (x, y) => (rel ? { x: cur.x + x, y: cur.y + y } : { x, y });
    const C = cmd.toUpperCase();
    let nextC = null, nextQ = null;
    switch (C) {
      case 'M': {
        const p = R(num(), num());
        cur = p;
        begin(p);
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L': lineTo(R(num(), num())); break;
      case 'H': { const x = num(); lineTo({ x: rel ? cur.x + x : x, y: cur.y }); break; }
      case 'V': { const y = num(); lineTo({ x: cur.x, y: rel ? cur.y + y : y }); break; }
      case 'C': {
        const c1 = R(num(), num()), c2 = R(num(), num()), p = R(num(), num());
        cubicTo(c1, c2, p);
        nextC = c2;
        break;
      }
      case 'S': {
        const c1 = lastC ? { x: 2 * cur.x - lastC.x, y: 2 * cur.y - lastC.y } : { ...cur };
        const c2 = R(num(), num()), p = R(num(), num());
        cubicTo(c1, c2, p);
        nextC = c2;
        break;
      }
      case 'Q': {
        const q = R(num(), num()), p = R(num(), num());
        cubicTo({ x: cur.x + (2 / 3) * (q.x - cur.x), y: cur.y + (2 / 3) * (q.y - cur.y) }, { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) }, p);
        nextQ = q;
        break;
      }
      case 'T': {
        const q = lastQ ? { x: 2 * cur.x - lastQ.x, y: 2 * cur.y - lastQ.y } : { ...cur };
        const p = R(num(), num());
        cubicTo({ x: cur.x + (2 / 3) * (q.x - cur.x), y: cur.y + (2 / 3) * (q.y - cur.y) }, { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) }, p);
        nextQ = q;
        break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num(), large = num(), sweep = num();
        const p = R(num(), num());
        arcTo(cur, rx, ry, rot, large, sweep, p, cubicTo, lineTo);
        break;
      }
      case 'Z':
        if (sp) {
          const n = sp.nodes, f = n[0], l = n[n.length - 1];
          if (n.length > 1 && Math.abs(f.x - l.x) < 1e-9 && Math.abs(f.y - l.y) < 1e-9) {
            f.in = l.in;
            n.pop();
          }
          sp.closed = true;
          cur = { ...start };
          sp = null;
        }
        break;
      default:
        i++;
    }
    lastC = nextC;
    lastQ = nextQ;
    if (C === 'Z') cmd = '';
  }
  return subs.filter((s) => s.nodes.length > 1 || s.closed);
}

function arcTo(p0, rx, ry, rotDeg, large, sweep, p1, cubicTo, lineTo) {
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (!rx || !ry || (p0.x === p1.x && p0.y === p1.y)) return lineTo(p1);
  const phi = (rotDeg * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi);
  const dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2;
  const x1 = cp * dx + sp * dy, y1 = -sp * dx + cp * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  let co = Math.sqrt(Math.max(0, num / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  if (!!large === !!sweep) co = -co;
  const cxp = (co * rx * y1) / ry, cyp = (-co * ry * x1) / rx;
  const cx = cp * cxp - sp * cyp + (p0.x + p1.x) / 2, cy = sp * cxp + cp * cyp + (p0.y + p1.y) / 2;
  const ang = (ux, uy, vx, vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  // unit-circle arc nodes, then scale/rotate/translate
  const nodes = arcNodes(0, 0, 1, t1, t1 + dt);
  const m = [cp * rx, sp * rx, -sp * ry, cp * ry, cx, cy];
  for (let k = 1; k < nodes.length; k++) {
    const c1 = apply(m, nodes[k - 1].out), c2 = apply(m, nodes[k].in);
    const p = k === nodes.length - 1 ? p1 : apply(m, nodes[k]);
    cubicTo(c1, c2, p);
  }
}

const NS = 'http://www.w3.org/2000/svg';

function cssColor(c) {
  if (!c || c === 'none' || c === 'transparent') return null;
  const m = /^rgba?\(([^)]+)\)/.exec(c);
  if (!m) return c.startsWith('#') ? c : null;
  const v = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
  if (v.length > 3 && v[3] === 0) return null;
  return '#' + v.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
}

function gradientFrom(root, url) {
  const id = /url\(["']?#([^"')]+)/.exec(url);
  if (!id) return null;
  let g = root.querySelector(`[id="${CSS.escape(id[1])}"]`);
  if (!g) return null;
  let stopsEl = g;
  for (let n = 0; n < 5 && !stopsEl.querySelector('stop'); n++) {
    const href = stopsEl.getAttribute('href') || stopsEl.getAttribute('xlink:href');
    const next = href && root.querySelector(`[id="${CSS.escape(href.slice(1))}"]`);
    if (!next) break;
    stopsEl = next;
  }
  const stops = [...stopsEl.querySelectorAll('stop')].map((s) => {
    const cs = getComputedStyle(s);
    let off = s.getAttribute('offset') || '0';
    off = off.endsWith('%') ? parseFloat(off) / 100 : parseFloat(off);
    return { offset: Math.max(0, Math.min(1, off || 0)), color: cssColor(cs.stopColor) || '#000000', opacity: parseFloat(cs.stopOpacity) };
  });
  if (!stops.length) return null;
  if (g.localName === 'radialGradient') return { type: 'radial', stops };
  const n = (a, d) => { const v = g.getAttribute(a); return v == null ? d : v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v); };
  const angle = (Math.atan2(n('y2', 0) - n('y1', 0), n('x2', 1) - n('x1', 0)) * 180) / Math.PI;
  return { type: 'linear', angle: Math.round(angle * 100) / 100, stops };
}

function styleOf(el, root, scale) {
  const cs = getComputedStyle(el);
  const st = defaultStyle();
  st.fill = cs.fill.startsWith('url') ? gradientFrom(root, cs.fill) : cssColor(cs.fill);
  st.stroke = cs.stroke.startsWith('url') ? (gradientFrom(root, cs.stroke)?.stops[0].color || null) : cssColor(cs.stroke);
  st.strokeWidth = (parseFloat(cs.strokeWidth) || 0) * scale;
  st.cap = cs.strokeLinecap || 'butt';
  st.join = ['round', 'bevel'].includes(cs.strokeLinejoin) ? cs.strokeLinejoin : 'miter';
  st.dash = cs.strokeDasharray && cs.strokeDasharray !== 'none' ? cs.strokeDasharray.split(/[\s,]+/).map((v) => Math.round(parseFloat(v) * scale * 1000) / 1000).join(' ') : '';
  const o = parseFloat(cs.opacity), fo = parseFloat(cs.fillOpacity);
  st.opacity = (isNaN(o) ? 1 : o) * (isNaN(fo) || !st.fill ? 1 : fo);
  return { st, fillRule: cs.fillRule === 'evenodd' ? 'evenodd' : 'nonzero', hidden: cs.display === 'none' || cs.visibility === 'hidden' };
}

/** Parses SVG text into { width, height, layers?: [{name, children}], objects } (px). */
export function importSvg(text) {
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
  const src = parsed.documentElement;
  if (!src || src.localName !== 'svg' || parsed.querySelector('parsererror')) throw new Error("This SVG file couldn't be read.");
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none';
  const root = document.importNode(src, true);
  // scripts never run: drop them along with event attributes
  root.querySelectorAll('script, foreignObject').forEach((n) => n.remove());
  const vb = (root.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  if (!root.getAttribute('width') && vb.length === 4) root.setAttribute('width', vb[2]);
  if (!root.getAttribute('height') && vb.length === 4) root.setAttribute('height', vb[3]);
  if (!root.getAttribute('width')) root.setAttribute('width', 800);
  if (!root.getAttribute('height')) root.setAttribute('height', 600);
  host.appendChild(root);
  document.body.appendChild(host);
  try {
    const rr = root.getBoundingClientRect();
    const r0 = [1, 0, 0, 1, rr.left, rr.top];
    const toDoc = (el) => {
      const m = el.getScreenCTM();
      if (!m) return I();
      return mul(invert(r0), [m.a, m.b, m.c, m.d, m.e, m.f]);
    };
    const walkEl = (el) => {
      const out = [];
      for (const c of el.children) {
        const o = convert(c);
        if (o) out.push(o);
      }
      return out;
    };
    const convert = (el) => {
      const tag = el.localName;
      if (['defs', 'style', 'title', 'desc', 'metadata', 'clipPath', 'mask', 'symbol', 'marker', 'pattern', 'linearGradient', 'radialGradient', 'filter'].includes(tag)) return null;
      if (tag === 'g' || tag === 'a' || tag === 'switch' || tag === 'svg') {
        const kids = walkEl(el);
        if (!kids.length) return null;
        if (kids.length === 1 && !el.id) return kids[0];
        return { type: 'group', id: newId(), name: el.id || el.getAttribute('inkscape:label') || 'Group', children: kids, style: { opacity: 1 } };
      }
      if (tag === 'use') {
        const href = el.getAttribute('href') || el.getAttribute('xlink:href');
        const ref = href && root.querySelector(`[id="${CSS.escape(href.slice(1))}"]`);
        if (!ref) return null;
        // render the referenced element in place: a temporary clone inside a group with the use's offset
        const g = document.createElementNS(NS, 'g');
        const x = parseFloat(el.getAttribute('x')) || 0, y = parseFloat(el.getAttribute('y')) || 0;
        g.setAttribute('transform', `${el.getAttribute('transform') || ''} translate(${x} ${y})`);
        const copy = ref.cloneNode(true);
        copy.removeAttribute('id');
        if (copy.localName === 'symbol') {
          const inner = document.createElementNS(NS, 'g');
          while (copy.firstChild) inner.appendChild(copy.firstChild);
          g.appendChild(inner);
        } else g.appendChild(copy);
        el.parentNode.insertBefore(g, el);
        const o = convert(g);
        g.remove();
        return o;
      }
      const m = toDoc(el);
      const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
      const { st, fillRule, hidden } = styleOf(el, root, scale);
      const a = (n, d = 0) => { const v = parseFloat(el.getAttribute(n)); return isNaN(v) ? d : v; };
      let subpaths = null;
      switch (tag) {
        case 'path': subpaths = parsePathData(el.getAttribute('d') || ''); break;
        case 'rect': {
          let rx = a('rx', NaN), ry = a('ry', NaN);
          if (isNaN(rx)) rx = isNaN(ry) ? 0 : ry;
          subpaths = rectPath(a('x'), a('y'), a('width'), a('height'), rx).subpaths;
          break;
        }
        case 'circle': subpaths = ellipsePath(a('cx'), a('cy'), a('r'), a('r')).subpaths; break;
        case 'ellipse': subpaths = ellipsePath(a('cx'), a('cy'), a('rx'), a('ry')).subpaths; break;
        case 'line':
          subpaths = [{ closed: false, nodes: [{ x: a('x1'), y: a('y1'), in: null, out: null }, { x: a('x2'), y: a('y2'), in: null, out: null }] }];
          break;
        case 'polyline': case 'polygon': {
          const v = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
          const nodes = [];
          for (let k = 0; k + 1 < v.length; k += 2) nodes.push({ x: v[k], y: v[k + 1], in: null, out: null });
          subpaths = [{ closed: tag === 'polygon', nodes }];
          break;
        }
        case 'text': {
          const cs = getComputedStyle(el);
          const lines = [...el.querySelectorAll('tspan')].length ? [...el.querySelectorAll(':scope > tspan')].map((t) => t.textContent) : [el.textContent];
          const tm = mul(m, [1, 0, 0, 1, a('x'), a('y')]);
          const anchor = cs.textAnchor;
          return {
            type: 'text', id: newId(), name: 'Text', text: lines.join('\n').replace(/ /g, ' '),
            font: (cs.fontFamily || 'Segoe UI').split(',')[0].replace(/["']/g, '').trim(),
            size: parseFloat(cs.fontSize) || 16, weight: parseInt(cs.fontWeight, 10) || 400, italic: cs.fontStyle === 'italic',
            align: anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left',
            matrix: tm, style: { ...st, fill: st.fill || '#000000' }, hidden,
          };
        }
        case 'image': {
          const href = el.getAttribute('href') || el.getAttribute('xlink:href');
          if (!href || !/^data:image\//.test(href)) return null;
          return { type: 'image', id: newId(), name: 'Image', href, w: a('width'), h: a('height'), matrix: mul(m, [1, 0, 0, 1, a('x'), a('y')]), style: { opacity: st.opacity }, hidden };
        }
        default: return null;
      }
      if (!subpaths || !subpaths.length) return null;
      return {
        type: 'path', id: newId(), name: el.id || cap(tag), subpaths: subpaths.map((s) => transformSub(s, m)),
        style: st, fillRule, hidden,
      };
    };
    const allGroups = [...root.children].filter((c) => !['defs', 'style', 'title', 'desc', 'metadata'].includes(c.localName));
    const asLayers = allGroups.length > 0 && allGroups.every((c) => c.localName === 'g');
    let layers = null;
    if (asLayers) {
      layers = allGroups.map((g, k) => ({ name: g.getAttribute('inkscape:label') || g.id || `Layer ${k + 1}`, children: walkEl(g), hidden: getComputedStyle(g).display === 'none' }));
    }
    return { width: rr.width, height: rr.height, layers, objects: asLayers ? layers.flatMap((l) => l.children) : walkEl(root) };
  } finally {
    host.remove();
  }
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ======================================================================= DXF

const UNIT_PX = { 1: 96, 2: 1152, 4: 96 / 25.4, 5: 96 / 2.54, 6: 9600 / 2.54, 8: 96 / 1e6, 9: 96 / 1000, 10: 96 * 36 };
const UNIT_NAME = { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' };

class CurveScene extends Scene {
  constructor(dwg) {
    super(dwg);
    this.curves = [];
    this.layerNow = '0';
  }

  emit(e, xf, depth, byBlock, insertLayer) {
    const kind = e.kind;
    if (!['LINE', 'CIRCLE', 'ARC', 'ELLIPSE', 'LWPOLYLINE', 'POLYLINE'].includes(kind)) {
      // remembered so the strokes the scene makes (splines, solids...) keep their layer
      const l = (e.str(8, '0') || '0').trim();
      if (kind !== 'INSERT') this.layerNow = l === '0' && insertLayer !== null ? insertLayer : l;
      return super.emit(e, xf, depth, byBlock, insertLayer);
    }
    if (depth > 12) return;
    let layer = (e.str(8, '0') || '0').trim();
    if (layer === '0' && insertLayer !== null) layer = insertLayer;
    if (!this.layerVisible(layer)) return;
    const color = this.resolveColor(e, layer, byBlock);
    if (e.dbl(230, 1) < 0 && kind !== 'LINE') xf = xf.then(Xf.scale(-1, 1));
    const P = (p) => xf.apply(p.x, p.y);
    const mapNodes = (nodes) => nodes.map((n) => ({ ...n, ...P(n), in: n.in ? P(n.in) : null, out: n.out ? P(n.out) : null }));
    const push = (nodes, closed) => { if (nodes.length > 1 || closed) this.curves.push({ nodes: mapNodes(nodes), closed, color, layer }); };
    const D = Math.PI / 180;
    switch (kind) {
      case 'LINE':
        push([{ x: e.dbl(10, 0), y: e.dbl(20, 0), in: null, out: null }, { x: e.dbl(11, 0), y: e.dbl(21, 0), in: null, out: null }], false);
        break;
      case 'CIRCLE': {
        const r = e.dbl(40, 0);
        if (r <= 0) return;
        const n = arcNodes(e.dbl(10, 0), e.dbl(20, 0), r, 0, 2 * Math.PI);
        n[0].in = n[n.length - 1].in;
        n.pop();
        n[0].smooth = true;
        push(n, true);
        break;
      }
      case 'ARC': {
        const a0 = e.dbl(50, 0);
        let a1 = e.dbl(51, 360);
        while (a1 <= a0) a1 += 360;
        const r = e.dbl(40, 0);
        if (r > 0) push(arcNodes(e.dbl(10, 0), e.dbl(20, 0), r, a0 * D, a1 * D), false);
        break;
      }
      case 'ELLIPSE': {
        // an affine image of a unit-circle arc: exact for any ratio
        const mx = e.dbl(11, 1), my = e.dbl(21, 0), ratio = e.dbl(40, 1);
        const t0 = e.dbl(41, 0);
        let t1 = e.dbl(42, 2 * Math.PI);
        while (t1 <= t0) t1 += 2 * Math.PI;
        const m = [mx, my, -my * ratio, mx * ratio, e.dbl(10, 0), e.dbl(20, 0)];
        const n = arcNodes(0, 0, 1, t0, t1).map((q) => ({ ...q, ...apply(m, q), in: q.in && apply(m, q.in), out: q.out && apply(m, q.out) }));
        const full = Math.abs(t1 - t0 - 2 * Math.PI) < 1e-9;
        if (full) { n[0].in = n[n.length - 1].in; n.pop(); n[0].smooth = true; }
        push(n, full);
        break;
      }
      case 'LWPOLYLINE':
        this.bulged(lwVertices(e), (e.int(70, 0) & 1) !== 0, push);
        break;
      case 'POLYLINE': {
        const flags = e.int(70, 0);
        if ((flags & (16 | 64)) !== 0) return;
        const verts = e.children.filter((v) => (v.int(70, 0) & (16 | 128)) === 0).map((v) => [{ x: v.dbl(10, 0), y: v.dbl(20, 0) }, v.dbl(42, 0)]);
        this.bulged(verts, (flags & 1) !== 0, push);
        break;
      }
    }
  }

  add(xf, color, closed, pts) {
    super.add(xf, color, closed, pts);
    const last = this.strokes[this.strokes.length - 1];
    if (last) last.layer = this.layerNow;
  }

  bulged(verts, closed, push) {
    if (verts.length < 2) return;
    const nodes = [{ x: verts[0][0].x, y: verts[0][0].y, in: null, out: null }];
    const segs = closed ? verts.length : verts.length - 1;
    for (let i = 0; i < segs; i++) {
      const [a, bulge] = verts[i];
      const b = verts[(i + 1) % verts.length][0];
      const last = nodes[nodes.length - 1];
      const chord = Math.hypot(b.x - a.x, b.y - a.y);
      if (Math.abs(bulge) > 1e-9 && chord > 1e-12) {
        const theta = 4 * Math.atan(bulge);
        const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
        const h = r * Math.cos(theta / 2), sign = bulge > 0 ? 1 : -1;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const cx = mx - (sign * h * (b.y - a.y)) / chord, cy = my + (sign * h * (b.x - a.x)) / chord;
        const a0 = Math.atan2(a.y - cy, a.x - cx);
        const an = arcNodes(cx, cy, Math.abs(r), a0, a0 + theta);
        last.out = an[0].out;
        for (let k = 1; k < an.length; k++) nodes.push({ ...an[k], out: k < an.length - 1 ? an[k].out : null });
        nodes[nodes.length - 1].x = b.x; nodes[nodes.length - 1].y = b.y;
      } else {
        nodes.push({ x: b.x, y: b.y, in: null, out: null });
      }
    }
    if (closed) {
      const f = nodes[0], l = nodes[nodes.length - 1];
      if (Math.hypot(f.x - l.x, f.y - l.y) < 1e-9) { f.in = l.in; nodes.pop(); }
    }
    push(nodes, closed);
  }
}

const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/**
 * Reads a DXF (bytes). fallbackUnits is used when the file doesn't say ($INSUNITS 0).
 * Returns { units, unitName, width, height (px of the drawing's extents), layers: [{ name, children }] }
 * with the drawing's lower-left extents corner at (margin, height + margin) in document px.
 */
export function importDxf(bytes, fallbackUnits = 'in', { join = true, margin = 0 } = {}) {
  const dwg = Drawing.fromBytes(bytes);
  const scene = new CurveScene(dwg);
  scene.build();
  if (!scene.curves.length && !scene.strokes.length && !scene.texts.length) throw new Error("This DXF doesn't contain anything that can be drawn.");
  const k = UNIT_PX[dwg.units] || (fallbackUnits === 'mm' ? 96 / 25.4 : fallbackUnits === 'px' ? 1 : 96);
  // extents in drawing units (curve handles included is fine: arcs bulge less than their handles)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (p) => { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; };
  for (const c of scene.curves) for (const n of c.nodes) grow(n);
  for (const s of scene.strokes) for (const p of s.points) grow(p);
  for (const t of scene.texts) grow(t);
  // exact extents for curves come later from the path bounds; this mapping only needs an origin
  const map = (p) => ({ x: (p.x - x0) * k + margin, y: (y1 - p.y) * k + margin });
  const mapN = (n) => ({ ...n, ...map(n), in: n.in ? map(n.in) : null, out: n.out ? map(n.out) : null });

  let chains = scene.curves.map((c) => ({ nodes: c.nodes.map(mapN), closed: c.closed, color: c.color, layer: c.layer }));
  for (const s of scene.strokes) {
    chains.push({ nodes: s.points.map((p) => ({ ...map(p), in: null, out: null })), closed: s.closed, color: s.color, layer: s.layer || '0', filled: s.filled });
  }
  const byLayer = new Map();
  const layerList = (name) => {
    if (!byLayer.has(name)) byLayer.set(name, []);
    return byLayer.get(name);
  };
  if (join) {
    // join pieces of the same color (a cut outline is often spread over layers), within 0.0005 in
    const groups = new Map();
    for (const c of chains) {
      const key = c.color.join(',');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    chains = [];
    for (const g of groups.values()) {
      const joined = joinChains(g, 0.0005 * 96);
      for (const j of joined) { j.color = g[0].color; j.layer = g[0].layer; }
      chains.push(...joined);
    }
  }
  for (const c of chains) {
    const col = hex(c.color);
    layerList(c.layer).push({
      type: 'path', id: newId(), name: c.closed ? 'Closed path' : 'Path',
      subpaths: [{ closed: c.closed, nodes: c.nodes }],
      style: { ...defaultStyle(), fill: c.filled ? col : null, stroke: col, strokeWidth: 0.75 },
    });
  }
  for (const t of scene.texts) {
    const size = (t.height * k) / 0.72;
    const p = map(t);
    const r = (-t.rotation * Math.PI) / 180;
    const c = Math.cos(r), s = Math.sin(r);
    const n = t.lines.length;
    // vertical alignment: 0 baseline, 1 bottom, 2 middle, 3 top (lines go downwards)
    const lh = size * 1.2, capH = t.height * k;
    const dy = t.vAlign === 3 ? capH : t.vAlign === 2 ? capH / 2 - ((n - 1) * lh) / 2 : t.vAlign === 1 ? -(n - 1) * lh - size * 0.2 : -(n - 1) * lh;
    layerList('Text').push({
      type: 'text', id: newId(), name: 'Text', text: t.lines.join('\n'), font: 'Arial', size, weight: 400, italic: false,
      align: t.hAlign === 1 ? 'center' : t.hAlign === 2 ? 'right' : 'left',
      matrix: mul([c * t.widthFactor, s * t.widthFactor, -s, c, p.x, p.y], [1, 0, 0, 1, 0, dy]),
      style: { ...defaultStyle(), fill: hex(t.color), stroke: null },
    });
  }
  const geo = boundsOf([...byLayer.values()].flat().filter((o) => o.type === 'path')) || { w: (x1 - x0) * k, h: (y1 - y0) * k };
  return {
    x0, y1, k, units: dwg.units, unitName: UNIT_NAME[dwg.units] || '', width: geo.w, height: geo.h,
    layers: [...byLayer.entries()].map(([name, children]) => ({ name, children })),
  };
}

// ======================================================================= pictures and .vdraw

export function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error("This picture couldn't be opened."));
    im.src = src;
  });
}

export const readAsDataUrl = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(blob);
});

/** A picture file as an image object, 96 dpi (or fitted into maxW × maxH). */
export async function importImage(blob, name, maxW, maxH) {
  let href = await readAsDataUrl(blob);
  const im = await loadImage(href);
  let w = im.naturalWidth, h = im.naturalHeight;
  if (!/^data:image\/(png|jpeg|gif|webp|svg\+xml|bmp)/.test(href)) {
    // re-encode unusual types (e.g. BMP variants) as PNG so every export can use them
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(im, 0, 0);
    href = c.toDataURL('image/png');
  }
  const f = Math.min(1, maxW / w, maxH / h);
  w *= f; h *= f;
  return { type: 'image', id: newId(), name: name || 'Image', href, w, h, matrix: [1, 0, 0, 1, 0, 0], style: { opacity: 1 } };
}

export function parseVdraw(text) {
  let d;
  try { d = JSON.parse(text); } catch { throw new Error("This file isn't a Vector Draw document."); }
  if (d.app !== 'vector-draw') throw new Error("This file isn't a Vector Draw document.");
  return adoptDocument(d);
}

export { newDocument };
