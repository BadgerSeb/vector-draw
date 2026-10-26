// The canvas: zoom and pan, drawing the document, the selection overlay (in screen pixels so
// handles keep their size), the grid and the rulers.

import { S, settings, selected, on } from './state.js';
import { layersSvg, esc } from './render.js';
import { pathD, transformSub, fmt } from './geom.js';
import { bounds, boundsOf, UNITS, toUnits, layerOf, textLocalBox, locate } from './doc.js';
import { apply } from './geom.js';

const $ = (id) => document.getElementById(id);
export const els = {};

export function initView() {
  for (const id of ['stage', 'view', 'content', 'overlay', 'board', 'board-shadow', 'board-edge', 'grid', 'stage-defs', 'stage-wrap', 'ruler-top', 'ruler-left', 'work']) els[id] = $(id);
  new ResizeObserver(() => { requestRender('view'); }).observe(els['stage-wrap']);
  on('doc', () => requestRender('all'));
  on('selection', () => requestRender('overlay'));
}

// ------------------------------------------------------------ coordinates
export const toDoc = (sx, sy) => ({ x: (sx - S.panX) / S.zoom, y: (sy - S.panY) / S.zoom });
export const toScreen = (p) => ({ x: p.x * S.zoom + S.panX, y: p.y * S.zoom + S.panY });
export const screenMatrix = () => [S.zoom, 0, 0, S.zoom, S.panX, S.panY];

export function stageSize() {
  const r = els['stage-wrap'].getBoundingClientRect();
  return { w: r.width, h: r.height };
}

/** Pointer position relative to the stage. */
export function stagePoint(e) {
  const r = els['stage-wrap'].getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

export function fitArtboard() {
  const { w, h } = stageSize();
  if (w < 10 || h < 10) return;
  const z = Math.min((w - 60) / S.doc.width, (h - 60) / S.doc.height);
  S.zoom = clampZoom(z);
  S.panX = (w - S.doc.width * S.zoom) / 2;
  S.panY = (h - S.doc.height * S.zoom) / 2;
  requestRender('all');
}

export function fitBox(b) {
  if (!b) return fitArtboard();
  const { w, h } = stageSize();
  const z = clampZoom(Math.min((w - 80) / Math.max(b.w, 1), (h - 80) / Math.max(b.h, 1)));
  S.zoom = z;
  S.panX = w / 2 - (b.x + b.w / 2) * z;
  S.panY = h / 2 - (b.y + b.h / 2) * z;
  requestRender('all');
}

export const clampZoom = (z) => Math.max(0.01, Math.min(256, z));

export function zoomAt(z, sx, sy) {
  z = clampZoom(z);
  const p = toDoc(sx, sy);
  S.zoom = z;
  S.panX = sx - p.x * z;
  S.panY = sy - p.y * z;
  requestRender('all');
}

export function zoomStep(dir, sx, sy) {
  const steps = [0.03125, 0.0625, 0.125, 0.25, 0.333, 0.5, 0.667, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 64, 128, 256];
  const cur = S.zoom;
  let z = dir > 0 ? steps.find((s) => s > cur * 1.001) : [...steps].reverse().find((s) => s < cur / 1.001);
  if (!z) z = cur;
  if (sx == null) { const s = stageSize(); sx = s.w / 2; sy = s.h / 2; }
  zoomAt(z, sx, sy);
}

// ------------------------------------------------------------ batching
let pending = new Set();
let frame = 0;
export function requestRender(part = 'all') {
  pending.add(part);
  if (!frame) frame = requestAnimationFrame(flush);
}
function flush() {
  frame = 0;
  const p = pending;
  pending = new Set();
  const all = p.has('all') || p.has('view');
  if (all) renderContent();
  renderOverlay();
  renderRulers();
  for (const fn of afterRender) fn(all);
}
const afterRender = [];
export const onRendered = (fn) => afterRender.push(fn);

/** Renders now (tests and exports want the DOM up to date). */
export function renderNow() {
  pending.add('all');
  if (frame) cancelAnimationFrame(frame);
  flush();
}

// ------------------------------------------------------------ content
function renderContent() {
  const d = S.doc;
  els.view.setAttribute('transform', `translate(${fmt(S.panX, 3)} ${fmt(S.panY, 3)}) scale(${fmt(S.zoom, 6)})`);
  for (const r of [els.board, els['board-edge']]) {
    r.setAttribute('width', d.width); r.setAttribute('height', d.height);
  }
  const sh = els['board-shadow'];
  sh.setAttribute('x', 3 / S.zoom); sh.setAttribute('y', 3 / S.zoom);
  sh.setAttribute('width', d.width); sh.setAttribute('height', d.height);
  renderGrid();
  const ctx = { defs: [], n: 0, prefix: 'st', stage: true, zoom: S.zoom };
  const body = layersSvg(d, ctx);
  els['stage-defs'].innerHTML = ctx.defs.join('');
  els.content.innerHTML = body;
  if (S.editing) {
    const el = els.content.querySelector(`[data-id="${S.editing}"]`);
    if (el) el.setAttribute('visibility', 'hidden');
  }
}

export function gridStep() {
  const u = S.doc.units;
  const major = (settings.gridSize[u] || 1) * UNITS[u].px;
  const div = Math.max(1, Math.round(settings.gridDiv[u] || 1));
  return { major, minor: major / div, div };
}

function renderGrid() {
  const g = els.grid;
  if (!settings.grid) { g.innerHTML = ''; return; }
  const { major, minor, div } = gridStep();
  const z = S.zoom;
  if (major * z < 6) { g.innerHTML = ''; return; }
  const w = 1 / z;
  let lines = '';
  const showMinor = minor * z >= 7;
  if (showMinor) for (let i = 1; i < div; i++) {
    const p = fmt(i * minor, 4);
    lines += `<path d="M${p} 0V${fmt(major, 4)}M0 ${p}H${fmt(major, 4)}" stroke="#e3e7eb" stroke-width="${fmt(w, 5)}"/>`;
  }
  lines += `<path d="M0 0V${fmt(major, 4)}M0 0H${fmt(major, 4)}" stroke="#c2c9d1" stroke-width="${fmt(w, 5)}"/>`;
  g.innerHTML = `<defs><pattern id="gridpat" patternUnits="userSpaceOnUse" width="${fmt(major, 4)}" height="${fmt(major, 4)}">${lines}</pattern></defs>` +
    `<rect width="${S.doc.width}" height="${S.doc.height}" fill="url(#gridpat)" pointer-events="none"/>`;
}

// ------------------------------------------------------------ overlay
const ACC = '#1e90ff'; // selection blue reads well on a white artboard
export const HANDLE = 4; // half size, px

/** The screen box of the selection (null when nothing is selected). */
export function selectionScreenBox() {
  const b = boundsOf(selected());
  if (!b) return null;
  const p0 = toScreen({ x: b.x, y: b.y });
  return { x: p0.x, y: p0.y, w: b.w * S.zoom, h: b.h * S.zoom, doc: b };
}

/** The 8 handle positions of a screen box: 0 tl,1 t,2 tr,3 r,4 br,5 b,6 bl,7 l */
export function handlePoints(b) {
  const { x, y, w, h } = b;
  return [[x, y], [x + w / 2, y], [x + w, y], [x + w, y + h / 2], [x + w, y + h], [x + w / 2, y + h], [x, y + h], [x, y + h / 2]];
}

export const directTools = new Set(['direct', 'pen', 'add-anchor', 'del-anchor', 'convert']);

function outline(o, color, m, width = 1) {
  if (o.hidden) return '';
  if (o.type === 'group') return o.children.map((c) => outline(c, color, m, width)).join('');
  if (o.type === 'path') {
    const d = pathD({ subpaths: o.subpaths.map((sp) => transformSub(sp, m)) }, 2);
    return d ? `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}"/>` : '';
  }
  // text and images: their (possibly rotated) box
  const b = o.type === 'text' ? textLocalBox(o) : { x: 0, y: 0, w: o.w, h: o.h };
  const mm = o.matrix;
  const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map(([x, y]) => apply(m, apply(mm, { x, y })));
  let s = `<path d="M${pts.map((p) => `${fmt(p.x, 2)} ${fmt(p.y, 2)}`).join('L')}Z" fill="none" stroke="${color}" stroke-width="${width}"/>`;
  if (o.type === 'text') {
    const base = [apply(m, apply(mm, { x: b.x, y: 0 })), apply(m, apply(mm, { x: b.x + b.w, y: 0 }))];
    s += `<path d="M${fmt(base[0].x, 2)} ${fmt(base[0].y, 2)}L${fmt(base[1].x, 2)} ${fmt(base[1].y, 2)}" stroke="${color}" stroke-width="1"/>`;
  }
  return s;
}

function renderOverlay() {
  const m = screenMatrix();
  let s = '';
  const objs = selected();
  const direct = directTools.has(S.tool);
  // hover
  if (S.hover && !S.sel.includes(S.hover)) {
    const loc = locate(S.doc, S.hover)?.obj;
    if (loc) s += outline(loc, ACC, m, 1.5);
  }
  for (const o of objs) {
    const l = layerOf(S.doc, o.id);
    const color = l ? l.color : ACC;
    s += outline(o, color, m, 1);
    if (direct && o.type === 'path') s += anchorsSvg(o, m, color);
  }
  if (!direct && objs.length && S.tool === 'select') {
    const b = selectionScreenBox();
    if (b) {
      s += `<rect x="${fmt(b.x, 2)}" y="${fmt(b.y, 2)}" width="${fmt(b.w, 2)}" height="${fmt(b.h, 2)}" fill="none" stroke="${ACC}" stroke-width="1"/>`;
      for (const [x, y] of handlePoints(b)) s += `<rect x="${fmt(x - HANDLE, 2)}" y="${fmt(y - HANDLE, 2)}" width="${HANDLE * 2}" height="${HANDLE * 2}" fill="#fff" stroke="${ACC}" stroke-width="1"/>`;
    }
  }
  // pen rubber band
  if (S.preview) s += `<path d="${S.preview}" fill="none" stroke="${ACC}" stroke-width="1" stroke-dasharray="4 3"/>`;
  // smart guides
  const { w, h } = stageSize();
  for (const g of S.guides) {
    if (g.x != null) { const x = toScreen({ x: g.x, y: 0 }).x; s += `<path d="M${fmt(x, 2)} 0V${h}" stroke="#ff2bd6" stroke-width="1"/>`; }
    if (g.y != null) { const y = toScreen({ x: 0, y: g.y }).y; s += `<path d="M0 ${fmt(y, 2)}H${w}" stroke="#ff2bd6" stroke-width="1"/>`; }
    if (g.label) s += `<g transform="translate(${fmt(g.label.x + 12, 1)} ${fmt(g.label.y + 18, 1)})"><rect x="-3" y="-12" width="${g.label.text.length * 6.6 + 6}" height="16" rx="3" fill="#ff2bd6"/><text font-size="11" fill="#fff" font-family="Segoe UI">${esc(g.label.text)}</text></g>`;
  }
  if (S.marquee) {
    const r = S.marquee;
    s += `<rect x="${fmt(Math.min(r.x0, r.x1), 1)}" y="${fmt(Math.min(r.y0, r.y1), 1)}" width="${fmt(Math.abs(r.x1 - r.x0), 1)}" height="${fmt(Math.abs(r.y1 - r.y0), 1)}" fill="rgba(30,144,255,.08)" stroke="${ACC}" stroke-width="1" stroke-dasharray="3 2"/>`;
  }
  els.overlay.innerHTML = s;
}

function anchorsSvg(o, m, color) {
  const sel = S.anchors.get(o.id) || new Set();
  let s = '';
  o.subpaths.forEach((sp, si) => {
    const n = sp.nodes.length;
    sp.nodes.forEach((nd, ni) => {
      const isSel = sel.has(`${si},${ni}`);
      const neighbour = sel.has(`${si},${(ni + 1) % n}`) || sel.has(`${si},${(ni - 1 + n) % n}`);
      const p = apply(m, nd);
      if (isSel || neighbour || (S.tool === 'pen' && S.pen && S.pen.id === o.id && ni === n - 1)) {
        for (const k of ['in', 'out']) {
          if (!nd[k]) continue;
          if (!isSel && !(S.tool === 'pen')) {
            // a neighbour only shows the handle that points at the selected anchor
            const towards = (k === 'out' && sel.has(`${si},${(ni + 1) % n}`)) || (k === 'in' && sel.has(`${si},${(ni - 1 + n) % n}`));
            if (!towards) continue;
          }
          const h = apply(m, nd[k]);
          s += `<path d="M${fmt(p.x, 2)} ${fmt(p.y, 2)}L${fmt(h.x, 2)} ${fmt(h.y, 2)}" stroke="${color}" stroke-width="1"/>`;
          s += `<circle cx="${fmt(h.x, 2)}" cy="${fmt(h.y, 2)}" r="3.5" fill="${color}" stroke="#fff" stroke-width="1"/>`;
        }
      }
      s += `<rect x="${fmt(p.x - 3.5, 2)}" y="${fmt(p.y - 3.5, 2)}" width="7" height="7" fill="${isSel ? color : '#fff'}" stroke="${color}" stroke-width="1"/>`;
    });
  });
  return s;
}

// ------------------------------------------------------------ rulers
const STEPS = {
  in: [1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 6, 12, 24, 48, 120, 240],
  mm: [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000],
  px: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000],
};

function renderRulers() {
  els.work.classList.toggle('no-rulers', !settings.rulers);
  if (!settings.rulers) return;
  ruler(els['ruler-top'], true);
  ruler(els['ruler-left'], false);
}

function ruler(c, horiz) {
  const dpr = window.devicePixelRatio || 1;
  const r = c.getBoundingClientRect();
  const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
  if (!W || !H) return;
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#1a1c1f';
  g.fillRect(0, 0, r.width, r.height);
  const u = S.doc.units, upx = UNITS[u].px * S.zoom; // screen px per unit
  const steps = STEPS[u];
  const major = steps.find((s) => s * upx >= 70) || steps[steps.length - 1];
  const minors = [major / 2, major / 4, major / 8, major / 10, major / 5].filter((m) => m * upx >= 5);
  const minor = minors.length ? Math.min(...minors.filter((m) => (major / m) % 1 < 1e-9 || Math.abs((major / m) - Math.round(major / m)) < 1e-9)) : major;
  const len = horiz ? r.width : r.height;
  const off = horiz ? S.panX : S.panY;
  const v0 = (0 - off) / upx, v1 = (len - off) / upx;
  // artboard extent shading
  const a0 = off, a1 = off + (horiz ? S.doc.width : S.doc.height) * S.zoom;
  g.fillStyle = '#232528';
  if (horiz) g.fillRect(a0, 0, a1 - a0, r.height); else g.fillRect(0, a0, r.width, a1 - a0);
  g.strokeStyle = '#6b7078';
  g.fillStyle = '#a3a8ae';
  g.font = '10px Segoe UI, sans-serif';
  g.lineWidth = 1;
  g.beginPath();
  const start = Math.floor(v0 / minor) * minor;
  const thick = horiz ? r.height : r.width;
  for (let v = start, n = 0; v <= v1 && n < 4000; v += minor, n++) {
    const s = Math.round(off + v * upx) + 0.5;
    const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
    const isHalf = !isMajor && Math.abs((2 * v) / major - Math.round((2 * v) / major)) < 1e-6;
    const t = isMajor ? thick : isHalf ? thick * 0.45 : thick * 0.25;
    if (horiz) { g.moveTo(s, thick); g.lineTo(s, thick - t); } else { g.moveTo(thick, s); g.lineTo(thick - t, s); }
    if (isMajor) {
      const label = fmtRuler(Math.round(v / major) * major, u);
      if (horiz) g.fillText(label, s + 3, 9);
      else { g.save(); g.translate(9, s + 3); g.rotate(-Math.PI / 2); g.textAlign = 'right'; g.fillText(label, 0, 0); g.restore(); }
    }
  }
  g.stroke();
  // pointer position
  if (S.cursorDoc) {
    const p = toScreen(S.cursorDoc);
    const s = Math.round(horiz ? p.x : p.y) + 0.5;
    g.strokeStyle = '#f07a24';
    g.beginPath();
    if (horiz) { g.moveTo(s, 0); g.lineTo(s, thick); } else { g.moveTo(0, s); g.lineTo(thick, s); }
    g.stroke();
  }
}

function fmtRuler(v, u) {
  const r = Math.round(v * 1000) / 1000;
  return String(r === 0 ? 0 : r);
}

export const unitsLabel = (v, digits) => `${fmt(toUnits(v, S.doc.units), digits ?? UNITS[S.doc.units].digits)} ${S.doc.units}`;
export { bounds };
