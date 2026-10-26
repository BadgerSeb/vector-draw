// Turns the document model into SVG markup. Used for the canvas (with ids and wide invisible
// hit strokes), for SVG export (clean) and for PNG export.

import { pathD, fmt, isIdentity } from './geom.js';
import { textLines, LINE, quoteFamily, toUnits, UNITS } from './doc.js';

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const mat = (m) => (isIdentity(m) ? '' : ` transform="matrix(${m.map((v) => fmt(v, 5)).join(' ')})"`);

function paint(p, ctx) {
  if (!p) return 'none';
  if (typeof p === 'string') return p;
  const id = `${ctx.prefix}g${ctx.n++}`;
  const stops = (p.stops || []).map((s) => `<stop offset="${fmt(s.offset, 4)}" stop-color="${esc(s.color)}"${s.opacity != null && s.opacity < 1 ? ` stop-opacity="${fmt(s.opacity, 3)}"` : ''}/>`).join('');
  if (p.type === 'radial') {
    ctx.defs.push(`<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5">${stops}</radialGradient>`);
  } else {
    const a = ((p.angle || 0) * Math.PI) / 180, dx = Math.cos(a) / 2, dy = Math.sin(a) / 2;
    ctx.defs.push(`<linearGradient id="${id}" x1="${fmt(0.5 - dx, 4)}" y1="${fmt(0.5 - dy, 4)}" x2="${fmt(0.5 + dx, 4)}" y2="${fmt(0.5 + dy, 4)}">${stops}</linearGradient>`);
  }
  return `url(#${id})`;
}

function strokeAttrs(st, ctx) {
  if (!st.stroke || !(st.strokeWidth > 0)) return ' stroke="none"';
  // on screen a stroke is never thinner than one pixel, so hairlines stay visible zoomed out
  const w = ctx.stage ? Math.max(st.strokeWidth, 1 / ctx.zoom) : st.strokeWidth;
  let a = ` stroke="${esc(paint(st.stroke, ctx))}" stroke-width="${fmt(w, 4)}"`;
  if (st.cap && st.cap !== 'butt') a += ` stroke-linecap="${st.cap}"`;
  if (st.join && st.join !== 'miter') a += ` stroke-linejoin="${st.join}"`;
  const dash = dashArray(st);
  if (dash) a += ` stroke-dasharray="${dash}"`;
  return a;
}

export function dashArray(st) {
  const d = String(st.dash || '').trim();
  if (!d) return '';
  const v = d.split(/[\s,]+/).map(Number).filter((x) => x >= 0 && isFinite(x));
  return v.length && v.some((x) => x > 0) ? v.map((x) => fmt(x, 3)).join(' ') : '';
}

const opac = (o) => (o.style && o.style.opacity != null && o.style.opacity < 1 ? ` opacity="${fmt(o.style.opacity, 3)}"` : '');

/**
 * ctx: { defs: [], n: 0, prefix, stage: bool, zoom }
 */
export function objectSvg(o, ctx) {
  if (o.hidden) return '';
  const id = ctx.stage ? ` data-id="${o.id}"` : (o.name ? ` id="${esc(safeId(o.name, ctx))}"` : '');
  const lock = ctx.stage && (o.locked || ctx.locked) ? ' pointer-events="none"' : '';
  switch (o.type) {
    case 'path': {
      const d = pathD(o);
      if (!d) return '';
      const st = o.style;
      const fr = o.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : '';
      let s = `<path${id} d="${d}" fill="${esc(paint(st.fill, ctx))}"${fr}${strokeAttrs(st, ctx)}${opac(o)}${lock}/>`;
      if (ctx.stage && !lock) s += `<path data-id="${o.id}" d="${d}" fill="none" stroke="transparent" stroke-linecap="round" stroke-linejoin="round" stroke-width="${fmt(8 / ctx.zoom, 3)}"/>`;
      return s;
    }
    case 'text': {
      const st = o.style;
      const anchor = o.align === 'center' ? 'middle' : o.align === 'right' ? 'end' : 'start';
      let s = `<text${id}${mat(o.matrix)} font-family="${esc(quoteFamily(o.font))}" font-size="${fmt(o.size, 3)}"`;
      if ((o.weight || 400) !== 400) s += ` font-weight="${o.weight}"`;
      if (o.italic) s += ' font-style="italic"';
      if (anchor !== 'start') s += ` text-anchor="${anchor}"`;
      s += ` fill="${esc(paint(st.fill, ctx))}"${strokeAttrs(st, ctx)}${opac(o)}${lock} xml:space="preserve">`;
      textLines(o).forEach((l, i) => { s += `<tspan x="0" y="${fmt(i * o.size * LINE, 3)}">${esc(l) || ' '}</tspan>`; });
      return s + '</text>';
    }
    case 'image':
      return `<image${id}${mat(o.matrix)} width="${fmt(o.w, 3)}" height="${fmt(o.h, 3)}" preserveAspectRatio="none" href="${esc(o.href)}"${opac(o)}${lock}/>`;
    case 'group': {
      const inner = o.children.map((c) => objectSvg(c, { ...ctx, locked: ctx.locked || o.locked, defs: ctx.defs, get n() { return ctx.n; }, set n(v) { ctx.n = v; } })).join('');
      return `<g${id}${opac(o)}>${inner}</g>`;
    }
  }
  return '';
}

function safeId(name, ctx) {
  ctx.names = ctx.names || new Set();
  let base = String(name).replace(/[^\w-]+/g, '_').replace(/^(\d)/, '_$1') || 'object';
  let n = base, i = 2;
  while (ctx.names.has(n)) n = `${base}_${i++}`;
  ctx.names.add(n);
  return n;
}

/** The layers' markup and the defs they need. */
export function layersSvg(doc, ctx) {
  return doc.layers.map((l) => {
    if (!l.visible) return ctx.stage ? `<g data-layer="${l.id}" display="none"></g>` : '';
    const lctx = { ...ctx, locked: l.locked, defs: ctx.defs, get n() { return ctx.n; }, set n(v) { ctx.n = v; } };
    const inner = l.children.map((c) => objectSvg(c, lctx)).join('');
    return ctx.stage ? `<g data-layer="${l.id}">${inner}</g>` : `<g id="${esc(safeId(l.name, ctx))}">${inner}</g>`;
  }).join('');
}

/** A standalone SVG file of the artboard, sized in the document's real units. */
export function exportSvg(doc, { background = false } = {}) {
  const ctx = { defs: [], n: 0, prefix: '', stage: false };
  const body = layersSvg(doc, ctx);
  const u = doc.units === 'px' ? '' : doc.units;
  const dg = UNITS[doc.units].digits + 2;
  const w = fmt(toUnits(doc.width, doc.units), dg) + u, h = fmt(toUnits(doc.height, doc.units), dg) + u;
  const vb = `0 0 ${fmt(doc.width, 3)} ${fmt(doc.height, 3)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${vb}">\n` +
    `<!-- Made with Vector Draw, Badger Metal & Machine Fabrication -->\n` +
    (ctx.defs.length ? `<defs>${ctx.defs.join('')}</defs>\n` : '') +
    (background ? `<rect width="100%" height="100%" fill="#ffffff"/>\n` : '') +
    body + '\n</svg>\n';
}
