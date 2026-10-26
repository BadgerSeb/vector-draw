// The document: artboard size and units, layers of objects, undo history, object bounds and
// transforms. Coordinates are document pixels (96 per inch), y down, origin at the artboard's
// top-left corner.

import { apply, mul, pathBox, transformSub, emptyBox, growBox, finishBox, unionBox, I, invert } from './geom.js';

export const UNITS = {
  in: { px: 96, label: 'in', digits: 3 },
  mm: { px: 96 / 25.4, label: 'mm', digits: 2 },
  px: { px: 1, label: 'px', digits: 1 },
};

export const PRESETS = [
  { name: 'Letter', w: 8.5, h: 11, units: 'in' },
  { name: 'Tabloid', w: 11, h: 17, units: 'in' },
  { name: 'Legal', w: 8.5, h: 14, units: 'in' },
  { name: 'A4', w: 210, h: 297, units: 'mm' },
  { name: 'A3', w: 297, h: 420, units: 'mm' },
  { name: '4 × 8 ft sheet', w: 96, h: 48, units: 'in' },
  { name: '5 × 10 ft sheet', w: 120, h: 60, units: 'in' },
  { name: '12 × 12 in plate', w: 12, h: 12, units: 'in' },
  { name: 'Screen 1920 × 1080', w: 1920, h: 1080, units: 'px' },
];

export const toUnits = (px, units) => px / UNITS[units].px;
export const fromUnits = (v, units) => v * UNITS[units].px;

export function defaultStyle() {
  return { fill: '#ffffff', stroke: '#1c1e21', strokeWidth: 1, dash: '', cap: 'butt', join: 'miter', opacity: 1 };
}

let counter = 1;
export const newId = () => 'o' + (counter++).toString(36);

export function newDocument(w = 8.5 * 96, h = 11 * 96, units = 'in') {
  return {
    app: 'vector-draw', version: 1, width: w, height: h, units,
    layers: [{ id: newId(), name: 'Layer 1', visible: true, locked: false, color: '#e8650f', children: [] }],
  };
}

/** After loading: make sure ids are unique and the counter is past them. */
export function adoptDocument(d) {
  if (!d || !Array.isArray(d.layers)) throw new Error("This file isn't a Vector Draw document.");
  const seen = new Set();
  const fix = (o) => {
    if (!o.id || seen.has(o.id)) o.id = newId();
    seen.add(o.id);
    const m = /^o([0-9a-z]+)$/.exec(o.id);
    if (m) counter = Math.max(counter, parseInt(m[1], 36) + 1);
    (o.children || []).forEach(fix);
  };
  d.layers.forEach(fix);
  d.units = UNITS[d.units] ? d.units : 'in';
  return d;
}

// ------------------------------------------------------------ walking
export function* walk(list, parent = null, layer = null, deep = true) {
  for (const o of list) {
    yield { obj: o, list, parent, layer: layer || o };
    if (o.children && deep) yield* walk(o.children, o, layer || o, deep);
  }
}

/** { obj, list, index, layer, parent } for an object id */
export function locate(doc, id) {
  for (const w of walk(doc.layers)) if (w.obj.id === id) return { ...w, index: w.list.indexOf(w.obj) };
  return null;
}

export const isLayer = (doc, o) => doc.layers.includes(o);

/** The top-level object (direct child of a layer) that holds id. */
export function topOf(doc, id) {
  for (const l of doc.layers) {
    for (const o of l.children) {
      if (o.id === id) return o;
      if (o.children) for (const w of walk(o.children)) if (w.obj.id === id) return o;
    }
  }
  return null;
}

export function layerOf(doc, id) {
  for (const l of doc.layers) for (const w of walk(l.children)) if (w.obj.id === id) return l;
  return null;
}

// ------------------------------------------------------------ text metrics
let mctx = null;
export function fontCss(t) {
  return `${t.italic ? 'italic ' : ''}${t.weight || 400} ${t.size}px ${quoteFamily(t.font)}`;
}
export const quoteFamily = (f) => (/^[\w-]+$/.test(f) && !/\s/.test(f) ? f : `"${f}"`) + ', sans-serif';
export const textLines = (t) => String(t.text ?? '').split('\n');
export const LINE = 1.2;

export function textWidths(t) {
  if (!mctx) mctx = document.createElement('canvas').getContext('2d');
  mctx.font = fontCss(t);
  return textLines(t).map((l) => mctx.measureText(l).width);
}

/** The local box of a text object (anchor at 0,0 = baseline of the first line). */
export function textLocalBox(t) {
  const ws = textWidths(t);
  const w = Math.max(1, ...ws);
  const x = t.align === 'center' ? -w / 2 : t.align === 'right' ? -w : 0;
  const n = ws.length;
  return { x, y: -t.size * 0.82, w, h: t.size * 0.82 + (n - 1) * t.size * LINE + t.size * 0.24 };
}

// ------------------------------------------------------------ bounds
function cornersBox(m, b) {
  const e = emptyBox();
  for (const p of [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }]) growBox(e, apply(m, p));
  return finishBox(e);
}

export function bounds(o) {
  if (!o) return null;
  switch (o.type) {
    case 'path': return pathBox(o);
    case 'text': return cornersBox(o.matrix || I(), textLocalBox(o));
    case 'image': return cornersBox(o.matrix || I(), { x: 0, y: 0, w: o.w, h: o.h });
    case 'group': case 'layer': {
      let b = null;
      for (const c of o.children) if (!c.hidden) b = unionBox(b, bounds(c));
      return b;
    }
  }
  return null;
}

export function boundsOf(objs) {
  let b = null;
  for (const o of objs) b = unionBox(b, bounds(o));
  return b;
}

/** Bounds including half the stroke, for exports. */
export function visualBounds(objs) {
  let b = null;
  for (const o of objs) {
    let ob = bounds(o);
    if (!ob) continue;
    const sw = o.type === 'path' && o.style.stroke ? (o.style.strokeWidth || 0) / 2 : 0;
    ob = { x: ob.x - sw, y: ob.y - sw, w: ob.w + 2 * sw, h: ob.h + 2 * sw };
    b = unionBox(b, ob);
  }
  return b;
}

// ------------------------------------------------------------ transforms (baked into paths)
export function transformObject(o, m) {
  switch (o.type) {
    case 'path':
      o.subpaths = o.subpaths.map((sp) => transformSub(sp, m));
      break;
    case 'text':
    case 'image':
      o.matrix = mul(m, o.matrix || I());
      break;
    case 'group':
      for (const c of o.children) transformObject(c, m);
      break;
  }
}

export function clone(o) {
  const c = structuredClone(o);
  const re = (x) => { x.id = newId(); (x.children || []).forEach(re); };
  re(c);
  return c;
}

// ------------------------------------------------------------ history
export class History {
  constructor(limit = 120) {
    this.states = [];
    this.labels = [];
    this.index = -1;
    this.limit = limit;
  }
  reset(doc) {
    this.states = [structuredClone(doc)];
    this.labels = [''];
    this.index = 0;
  }
  push(doc, label) {
    this.states = this.states.slice(0, this.index + 1);
    this.states.push(structuredClone(doc));
    this.labels = this.labels.slice(0, this.index + 1);
    this.labels.push(label);
    if (this.states.length > this.limit) { this.states.shift(); this.labels.shift(); }
    this.index = this.states.length - 1;
  }
  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.states.length - 1; }
  undo() { return this.canUndo ? structuredClone(this.states[--this.index]) : null; }
  redo() { return this.canRedo ? structuredClone(this.states[++this.index]) : null; }
  label(next) { return this.labels[next ? this.index + 1 : this.index] || ''; }
}

export { invert };
