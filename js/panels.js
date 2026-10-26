// The tool column, the options bar above the canvas, and the panels on the right
// (Properties, Swatches, Align & Pathfinder, Layers).

import { S, settings, saveSettings, on, emit, commit, live, setSel, selected, selectedRoots, status } from './state.js';
import { TOOLS, setTool } from './tools.js';
import { ICONS } from './icons.js';
import { h, evalNum, ask } from './ui.js';
import { boundsOf, toUnits, fromUnits, UNITS, locate, walk, PRESETS } from './doc.js';
import { fmt } from './geom.js';
import * as ops from './ops.js';
import { requestRender } from './view.js';

const $ = (id) => document.getElementById(id);
const unitsOf = () => S.doc.units;
const fmtU = (px) => fmt(toUnits(px, unitsOf()), UNITS[unitsOf()].digits + 1);
const toPx = (v) => fromUnits(v, unitsOf());

export function initPanels() {
  buildTools();
  buildOptions();
  buildPanels();
  on('tool', () => { buildTools(); buildOptions(); });
  on('selection', schedule);
  on('doc', schedule);
}

let timer = 0;
function schedule() {
  if (timer) return;
  timer = requestAnimationFrame(() => { timer = 0; buildPanels(); buildTools(); });
}

// ------------------------------------------------------------ tool column
function buildTools() {
  const el = $('tools');
  const groups = [['select', 'direct'], ['pen', 'add-anchor', 'del-anchor', 'convert', 'pencil'], ['line', 'rect', 'rrect', 'ellipse', 'polygon', 'star'], ['text'], ['eyedropper', 'hand', 'zoom']];
  el.innerHTML = '';
  groups.forEach((g, gi) => {
    if (gi) el.append(h('hr'));
    for (const id of g) {
      const t = TOOLS.find((x) => x.id === id);
      const key = t.key === 'C' ? 'Shift+C' : t.key ? t.key.toUpperCase() : '';
      el.append(h('button', { class: S.tool === id ? 'on' : '', title: `${t.name}${key ? ` (${key})` : ''}`, 'data-tool': id, html: ICONS[id], onclick: () => setTool(id) }));
    }
  });
  // current fill and stroke
  const st = currentStyle();
  const chip = (p) => (!p ? 'none-pat' : '');
  const bg = (p) => (!p ? '' : typeof p === 'string' ? p : gradCss(p));
  const colors = h('div', { class: 'colors', title: 'Fill (front) and stroke. Click to swap them (Shift+X).' },
    h('span', { class: `chip fill ${chip(st.fill)}`, style: `background:${bg(st.fill)}` }),
    h('span', { class: `chip stroke ${chip(st.stroke)}`, style: `background:${bg(st.stroke)}` }));
  colors.onclick = swapFillStroke;
  el.append(colors);
}

export function swapFillStroke() {
  const st = currentStyle();
  const fill = typeof st.stroke === 'string' ? st.stroke : null;
  const stroke = typeof st.fill === 'string' ? st.fill : st.fill?.stops?.[0]?.color || null;
  ops.setStyle({ fill, stroke, strokeWidth: st.strokeWidth || 1 }, 'Swap fill and stroke');
}

export function gradCss(g) {
  const stops = (g.stops || []).map((s) => `${s.color} ${fmt(s.offset * 100, 1)}%`).join(', ');
  return g.type === 'radial' ? `radial-gradient(${stops})` : `linear-gradient(${90 + (g.angle || 0)}deg, ${stops})`;
}

/** The style shown in the panels: the first selected object's, or the one for new shapes. */
function currentStyle() {
  for (const o of selected()) for (const w of walk([o])) if (w.obj.style && w.obj.type !== 'group' && w.obj.type !== 'image') return w.obj.style;
  return settings.style;
}

// ------------------------------------------------------------ options bar
function numField(value, onchange, { cls = 'num short', title, step } = {}) {
  const i = h('input', { class: cls, value, title, inputmode: 'decimal' });
  i.addEventListener('change', () => { const v = evalNum(i.value); if (isFinite(v)) onchange(v); else i.value = value; });
  i.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') i.blur();
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && step) {
      e.preventDefault();
      const v = (evalNum(i.value) || 0) + (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 10 : 1);
      i.value = fmt(v, 4);
      onchange(v);
    }
  });
  return i;
}

export function buildOptions() {
  const el = $('optionsbar');
  const t = TOOLS.find((x) => x.id === S.tool);
  el.innerHTML = '';
  el.append(h('span', { class: 'tool-name' }, t.name));
  const add = (...k) => el.append(...k);
  const lab = (text, input) => h('label', {}, text, input);
  const u = unitsOf();
  switch (S.tool) {
    case 'rrect':
      add(lab(`Corner radius (${u})`, numField(fmtU(settings.radius), (v) => { settings.radius = Math.max(0, toPx(v)); saveSettings(); }, { step: u === 'mm' ? 1 : 0.0625 })));
      break;
    case 'polygon':
      add(lab('Sides', numField(settings.sides, (v) => { settings.sides = Math.max(3, Math.min(100, Math.round(v))); saveSettings(); buildOptions(); }, { step: 1 })));
      break;
    case 'star':
      add(lab('Points', numField(settings.points, (v) => { settings.points = Math.max(3, Math.min(100, Math.round(v))); saveSettings(); buildOptions(); }, { step: 1 })));
      add(lab('Inner radius %', numField(settings.inner, (v) => { settings.inner = Math.max(1, Math.min(100, v)); saveSettings(); }, { step: 5 })));
      break;
    case 'pencil':
      add(lab('Smoothing %', numField(settings.smooth, (v) => { settings.smooth = Math.max(0, Math.min(100, v)); saveSettings(); }, { step: 10 })));
      break;
    case 'text': {
      add(lab('Font', fontInput(settings.font, (v) => { settings.font = v; saveSettings(); })));
      add(lab('Size (pt)', numField(fmt(settings.fontSize * 0.75, 2), (v) => { settings.fontSize = Math.max(1, v / 0.75); saveSettings(); }, { step: 1 })));
      break;
    }
  }
  add(h('span', { class: 'sep' }));
  for (const [key, label, title] of [['snapPoints', 'Snap to points', 'Snap to anchors and the artboard while drawing and editing'], ['snapGrid', 'Snap to grid', 'Snap to the grid (View › Grid settings)'], ['smart', 'Smart guides', 'Line up edges and centers with other objects while moving (Ctrl+U)']]) {
    const cb = h('input', { type: 'checkbox', checked: settings[key] });
    cb.onchange = () => { settings[key] = cb.checked; saveSettings(); emit('settings'); };
    add(h('label', { title }, cb, label));
  }
  add(h('span', { class: 'sep' }), h('span', { class: 'hint', title: t.hint }, t.hint));
}

const FONTS = ['Segoe UI', 'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Consolas', 'Courier New', 'Georgia', 'Impact', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];
function fontInput(value, onchange) {
  const id = 'fonts-list';
  if (!$(id)) document.body.append(h('datalist', { id }, ...FONTS.map((f) => h('option', { value: f }))));
  const i = h('input', { class: 'txt', value, list: id });
  i.addEventListener('change', () => onchange(i.value.trim() || 'Segoe UI'));
  i.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') i.blur(); });
  return i;
}

// ------------------------------------------------------------ panels
const SWATCHES = [
  '#d25800', '#f07a24', '#1b1d20', '#464a50', '#6b7078', '#9ba0a7', '#c8ccd1', '#e8e9eb', '#ffffff', '#000000',
  '#dc2626', '#ea580c', '#eab308', '#16a34a', '#0d9488', '#0284c7', '#2563eb', '#7c3aed', '#c026d3', '#78350f',
];
const GRADIENTS = [
  { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#d25800' }, { offset: 1, color: '#1b1d20' }] },
  { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#e8e9eb' }, { offset: 0.5, color: '#9ba0a7' }, { offset: 1, color: '#464a50' }] },
  { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#000000' }] },
  { type: 'radial', stops: [{ offset: 0, color: '#f9b37a' }, { offset: 1, color: '#d25800' }] },
  { type: 'radial', stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#6b7078' }] },
];

function panel(key, title, body) {
  const closed = settings.panels[key] === false;
  const p = h('section', { class: `panel${closed ? ' closed' : ''}`, 'data-panel': key });
  const hd = h('h3', {}, title);
  hd.onclick = () => { settings.panels[key] = p.classList.toggle('closed') ? false : true; saveSettings(); };
  p.append(hd, h('div', { class: 'body' }, body));
  return p;
}

export function buildPanels() {
  const el = $('panels');
  // keep the focused field focused across rebuilds
  const focus = document.activeElement && el.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  if (focus && document.activeElement.matches('input.txt, textarea')) return;
  const scroll = el.scrollTop;
  const layersScroll = el.querySelector('.layers')?.scrollTop || 0;
  el.innerHTML = '';
  el.append(panel('props', 'Properties', propsBody()));
  el.append(panel('swatches', 'Swatches', swatchesBody()));
  el.append(panel('align', 'Align & Pathfinder', alignBody()));
  el.append(panel('layers', 'Layers', layersBody()));
  el.scrollTop = scroll;
  const ls = el.querySelector('.layers');
  if (ls) ls.scrollTop = layersScroll;
  if (focus) el.querySelector(`[data-key="${focus}"]`)?.focus();
}

function propsBody() {
  const frag = [];
  const objs = selectedRoots();
  const u = unitsOf();
  if (!objs.length) {
    frag.push(h('div', { class: 'sub' }, 'Document'));
    const preset = h('select', { class: 'sel grow' }, h('option', { value: '' }, 'Custom'), ...PRESETS.map((p) => h('option', { value: p.name }, p.name)));
    const match = PRESETS.find((p) => Math.abs(fromUnits(p.w, p.units) - S.doc.width) < 0.01 && Math.abs(fromUnits(p.h, p.units) - S.doc.height) < 0.01);
    preset.value = match ? match.name : '';
    preset.onchange = () => {
      const p = PRESETS.find((x) => x.name === preset.value);
      if (!p) return;
      S.doc.width = fromUnits(p.w, p.units); S.doc.height = fromUnits(p.h, p.units);
      commit('Artboard size');
      import('./view.js').then((v) => v.fitArtboard());
    };
    frag.push(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Size'), preset));
    const wf = numField(fmtU(S.doc.width), (v) => { if (v > 0) { S.doc.width = toPx(v); commit('Artboard size'); } }, { cls: 'num' });
    const hf = numField(fmtU(S.doc.height), (v) => { if (v > 0) { S.doc.height = toPx(v); commit('Artboard size'); } }, { cls: 'num' });
    frag.push(h('div', { class: 'fields' }, h('label', {}, 'W'), wf, h('label', {}, 'H'), hf));
    const us = h('select', { class: 'sel grow' }, ...Object.keys(UNITS).map((k) => h('option', { value: k }, { in: 'Inches', mm: 'Millimeters', px: 'Pixels' }[k])));
    us.value = u;
    us.onchange = () => { S.doc.units = us.value; settings.units = us.value; saveSettings(); commit('Units'); };
    frag.push(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Units'), us));
    const rot = h('button', { class: 'btn grow', onclick: () => { [S.doc.width, S.doc.height] = [S.doc.height, S.doc.width]; commit('Orientation'); import('./view.js').then((v) => v.fitArtboard()); } }, 'Swap portrait / landscape');
    frag.push(h('div', { class: 'row' }, rot));
    frag.push(h('div', { class: 'sub' }, 'New shapes'));
    frag.push(...appearance(settings.style));
    frag.push(h('p', { class: 'note' }, 'Nothing selected: these colors are used for the next shapes you draw.'));
    return frag;
  }
  // transform
  const b = boundsOf(objs);
  const ref = ops.refPoint(b);
  const rp = h('div', { class: 'refpt', title: 'Reference point for X/Y, sizes and rotation' });
  for (let i = 0; i < 9; i++) {
    const c = h('i', { class: settings.refpt === i ? 'on' : '' });
    c.onclick = () => { settings.refpt = i; saveSettings(); buildPanels(); };
    rp.append(c);
  }
  const step = u === 'in' ? 0.0625 : u === 'mm' ? 1 : 1;
  const f = (key, val) => {
    const i = numField(fmtU(val), (v) => ops.setGeometry(key, toPx(v), settings.keepRatio), { cls: 'num', step });
    i.dataset.key = 'geo-' + key;
    return i;
  };
  const kr = h('button', { class: `btn icon${settings.keepRatio ? ' on' : ''}`, title: 'Keep width and height in proportion', html: ICONS.link, onclick: () => { settings.keepRatio = !settings.keepRatio; saveSettings(); buildPanels(); } });
  frag.push(h('div', { class: 'sub' }, `Transform  ·  ${objs.length === 1 ? kindName(objs[0]) : objs.length + ' objects'}`));
  frag.push(h('div', { class: 'row' }, rp, h('div', { class: 'fields grow' }, h('label', {}, 'X'), f('x', ref.x), h('label', {}, 'Y'), f('y', ref.y), h('label', {}, 'W'), f('w', b.w), h('label', {}, 'H'), f('h', b.h)), kr));
  const rot = numField('0', (v) => { ops.rotateBy(v); }, { cls: 'num short', title: 'Rotate by this many degrees (counter-clockwise) about the reference point' });
  rot.dataset.key = 'rot';
  frag.push(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Rotate °'), rot,
    h('span', { class: 'grow' }),
    h('button', { class: 'btn icon', title: 'Rotate 90° counter-clockwise', html: ICONS.rotCCW, onclick: () => ops.rotateBy(90) }),
    h('button', { class: 'btn icon', title: 'Rotate 90° clockwise', html: ICONS.rotCW, onclick: () => ops.rotateBy(-90) }),
    h('button', { class: 'btn icon', title: 'Flip horizontal', html: ICONS.flipH, onclick: () => ops.flip(true) }),
    h('button', { class: 'btn icon', title: 'Flip vertical', html: ICONS.flipV, onclick: () => ops.flip(false) })));
  // appearance
  const st = currentStyle();
  frag.push(h('div', { class: 'sub' }, 'Appearance'));
  if (objs.every((o) => o.type === 'image')) frag.push(opacityRow(objs[0].style || {}));
  else frag.push(...appearance(st));
  // text
  const texts = [];
  for (const o of objs) for (const w of walk([o])) if (w.obj.type === 'text') texts.push(w.obj);
  if (texts.length) frag.push(...textProps(texts[0]));
  return frag;
}

function kindName(o) {
  if (o.type === 'group') return `Group of ${o.children.length}`;
  if (o.type === 'path') return o.name || 'Path';
  return { text: 'Text', image: 'Picture' }[o.type];
}

function paintRow(label, p, key) {
  const kind = !p ? 'none' : typeof p === 'string' ? 'solid' : p.type;
  const sel = h('select', { class: 'sel', title: `${label} type` },
    h('option', { value: 'none' }, 'None'), h('option', { value: 'solid' }, 'Color'),
    ...(key === 'fill' ? [h('option', { value: 'linear' }, 'Linear gradient'), h('option', { value: 'radial' }, 'Radial gradient')] : []));
  sel.value = kind;
  const solidOf = (q) => (typeof q === 'string' ? q : q?.stops?.[0]?.color || '#808080');
  sel.onchange = () => {
    const v = sel.value, c = solidOf(p);
    let np = null;
    if (v === 'solid') np = c;
    else if (v === 'linear' || v === 'radial') np = { type: v, angle: p?.angle || 0, stops: p?.stops ? structuredClone(p.stops) : [{ offset: 0, color: c }, { offset: 1, color: '#1b1d20' }] };
    ops.setStyle({ [key]: np }, label);
  };
  const row = h('div', { class: 'row' }, h('span', { class: 'lbl' }, label), sel);
  const colorChip = (color, apply) => {
    const inp = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(color) ? color : '#808080' });
    const btn = h('span', { class: 'swatch-btn', style: `background:${color}`, title: color }, inp);
    inp.addEventListener('input', () => { btn.style.background = inp.value; apply(inp.value, false); });
    inp.addEventListener('change', () => apply(inp.value, true));
    return btn;
  };
  const liveSet = (val, done) => {
    if (done) return ops.setStyle({ [key]: val }, label);
    // while the color picker is open: show it without an undo step per color
    for (const o of selected()) for (const w of walk([o])) if (w.obj.style && w.obj.type !== 'group' && w.obj.type !== 'image') w.obj.style[key] = structuredClone(val);
    live();
  };
  if (kind === 'solid') row.append(colorChip(p, (c, d) => liveSet(c, d)));
  if (kind === 'none') row.append(h('span', { class: 'swatch-btn none-pat', title: 'None' }));
  const extra = [];
  if (kind === 'linear' || kind === 'radial') {
    const stops = p.stops;
    const gr = h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Stops'));
    stops.forEach((s, i) => gr.append(colorChip(s.color, (c, d) => { const g = structuredClone(p); g.stops[i].color = c; liveSet(g, d); })));
    gr.append(h('span', { class: 'swatch-btn', style: `background:${gradCss(p)};width:60px` }));
    gr.append(h('button', { class: 'btn icon', title: 'Swap the end colors', html: ICONS.swap, onclick: () => { const g = structuredClone(p); g.stops = g.stops.map((s) => ({ ...s, offset: 1 - s.offset })).reverse(); ops.setStyle({ fill: g }, 'Gradient'); } }));
    extra.push(gr);
    if (kind === 'linear') {
      const a = numField(fmt(p.angle || 0, 1), (v) => { const g = structuredClone(p); g.angle = v; ops.setStyle({ fill: g }, 'Gradient angle'); }, { step: 15 });
      extra.push(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Angle °'), a));
    }
  }
  return [row, ...extra];
}

function appearance(st) {
  const out = [...paintRow('Fill', st.fill, 'fill'), ...paintRow('Stroke', st.stroke, 'stroke')];
  if (st.stroke) {
    const w = numField(fmt((st.strokeWidth ?? 1) * 0.75, 3), (v) => ops.setStyle({ strokeWidth: Math.max(0, v / 0.75) }, 'Stroke width'), { step: 0.25 });
    w.dataset.key = 'sw';
    const dash = h('input', { class: 'txt', style: 'width:76px', value: String(st.dash || '').split(/[\s,]+/).filter(Boolean).map((x) => fmt(+x * 0.75, 2)).join(' '), placeholder: 'solid', title: 'Dash and gap lengths in points, e.g. 6 3' });
    dash.onchange = () => ops.setStyle({ dash: dash.value.split(/[\s,]+/).filter(Boolean).map((x) => fmt(evalNum(x) / 0.75, 3)).filter((x) => x !== 'NaN').join(' ') }, 'Dashes');
    dash.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') dash.blur(); };
    out.push(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Weight'), w, h('span', { class: 'note' }, 'pt'), h('span', { class: 'note' }, 'Dash'), dash));
    const cap = h('select', { class: 'sel grow', title: 'Line ends' }, ...[['butt', 'Butt cap'], ['round', 'Round cap'], ['square', 'Square cap']].map(([v, l]) => h('option', { value: v }, l)));
    cap.value = st.cap || 'butt';
    cap.onchange = () => ops.setStyle({ cap: cap.value }, 'Cap');
    const join = h('select', { class: 'sel grow', title: 'Corners' }, ...[['miter', 'Miter join'], ['round', 'Round join'], ['bevel', 'Bevel join']].map(([v, l]) => h('option', { value: v }, l)));
    join.value = st.join || 'miter';
    join.onchange = () => ops.setStyle({ join: join.value }, 'Join');
    out.push(h('div', { class: 'row' }, h('span', { class: 'lbl' }, ''), cap, join));
  }
  out.push(opacityRow(st));
  return out;
}

function opacityRow(st) {
  const op = numField(fmt((st.opacity ?? 1) * 100, 1), (v) => ops.setStyle({ opacity: Math.max(0, Math.min(100, v)) / 100 }, 'Opacity'), { step: 10 });
  op.dataset.key = 'op';
  return h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Opacity'), op, h('span', { class: 'note' }, '%'));
}

function textProps(t) {
  const out = [h('div', { class: 'sub' }, 'Text')];
  out.push(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Font'), fontInput(t.font, (v) => ops.setTextProps({ font: v }))));
  const size = numField(fmt(t.size * 0.75, 2), (v) => ops.setTextProps({ size: Math.max(1, v / 0.75) }), { step: 1 });
  size.dataset.key = 'tsize';
  const weight = h('select', { class: 'sel' }, ...[[300, 'Light'], [400, 'Regular'], [600, 'Semibold'], [700, 'Bold'], [900, 'Black']].map(([v, l]) => h('option', { value: v }, l)));
  weight.value = t.weight || 400;
  weight.onchange = () => ops.setTextProps({ weight: +weight.value });
  const it = h('button', { class: `btn icon${t.italic ? ' on' : ''}`, title: 'Italic', html: '<i style="font:italic 700 14px Georgia">I</i>', onclick: () => ops.setTextProps({ italic: !t.italic }) });
  out.push(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Size'), size, h('span', { class: 'note' }, 'pt'), weight, it));
  const al = h('div', { class: 'btn-row' }, ...['left', 'center', 'right'].map((a) => h('button', { class: `btn icon${t.align === a ? ' on' : ''}`, title: `Align ${a}`, html: ICONS[a], onclick: () => ops.setTextProps({ align: a }) })));
  out.push(h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Align'), al));
  const area = h('textarea', { class: 'area', 'data-key': 'tcontent' });
  area.value = t.text;
  area.onchange = () => { const o = locate(S.doc, t.id)?.obj; if (o) { o.text = area.value; commit('Edit text'); } };
  area.onkeydown = (e) => e.stopPropagation();
  out.push(area);
  return out;
}

function swatchesBody() {
  const grid = h('div', { class: 'swatches' });
  const none = h('button', { class: 'none-pat', title: 'None (Shift-click: no stroke)' });
  none.onclick = (e) => ops.setStyle({ [e.shiftKey ? 'stroke' : 'fill']: null }, 'Swatch');
  for (const c of SWATCHES) {
    const b = h('button', { style: `background:${c}`, title: `${c} — click for fill, Shift-click for stroke` });
    b.onclick = (e) => ops.setStyle(e.shiftKey ? { stroke: c, strokeWidth: currentStyle().strokeWidth || 1 } : { fill: c }, 'Swatch');
    grid.append(b);
  }
  grid.append(none);
  for (const g of GRADIENTS) {
    const b = h('button', { style: `background:${gradCss(g)}`, title: 'Gradient fill' });
    b.onclick = () => ops.setStyle({ fill: structuredClone(g) }, 'Swatch');
    grid.append(b);
  }
  return [grid, h('p', { class: 'note' }, 'Click: fill · Shift-click: stroke')];
}

function alignBody() {
  const B = (icon, title, fn) => h('button', { class: 'btn icon', title, html: ICONS[icon], onclick: fn });
  const to = h('select', { class: 'sel' }, h('option', { value: 'selection' }, 'Align to selection'), h('option', { value: 'artboard' }, 'Align to artboard'));
  to.value = settings.alignTo;
  to.onchange = () => { settings.alignTo = to.value; saveSettings(); };
  return [
    h('div', { class: 'btn-row' },
      B('alignLeft', 'Align left edges', () => ops.align('left')), B('alignHCenter', 'Align horizontal centers', () => ops.align('hcenter')), B('alignRight', 'Align right edges', () => ops.align('right')),
      B('alignTop', 'Align top edges', () => ops.align('top')), B('alignVCenter', 'Align vertical centers', () => ops.align('vcenter')), B('alignBottom', 'Align bottom edges', () => ops.align('bottom'))),
    h('div', { class: 'btn-row' },
      B('distH', 'Distribute horizontal centers', () => ops.distribute('hcenter')), B('distV', 'Distribute vertical centers', () => ops.distribute('vcenter')),
      B('spaceH', 'Equal horizontal spacing', () => ops.distribute('hspace')), B('spaceV', 'Equal vertical spacing', () => ops.distribute('vspace')), to),
    h('div', { class: 'sub' }, 'Pathfinder'),
    h('div', { class: 'btn-row' },
      B('unite', 'Unite: merge into one shape', () => ops.pathfinder('unite')), B('minus', 'Minus Front: cut the front shapes out of the back one', () => ops.pathfinder('minus')),
      B('intersect', 'Intersect: keep only where they overlap', () => ops.pathfinder('intersect')), B('exclude', 'Exclude: remove where they overlap', () => ops.pathfinder('exclude')),
      B('offset', 'Offset Path… (grow or shrink, e.g. for kerf)', () => emit('command', 'offset')), B('join', 'Join open paths (Ctrl+J)', () => ops.join())),
  ];
}

let expanded = new Set();
function layersBody() {
  const list = h('div', { class: 'layers' });
  const selIds = new Set(S.sel);
  for (const l of [...S.doc.layers].reverse()) {
    const open = expanded.has(l.id);
    const row = h('div', { class: `lrow layer${l.id === S.activeLayer ? ' active' : ''}`, title: 'Click to make this the layer new objects go into. Double-click to rename.' },
      h('span', { class: 'bar', style: `background:${l.color}` }),
      tog(l.visible, 'eye', 'Show or hide the layer', () => { l.visible = !l.visible; commit(l.visible ? 'Show layer' : 'Hide layer'); }),
      tog(!l.locked, l.locked ? 'lock' : 'unlock', 'Lock or unlock the layer', () => { l.locked = !l.locked; if (l.locked) setSel(S.sel.filter((id) => locate(S.doc, id)?.layer !== l)); commit(l.locked ? 'Lock layer' : 'Unlock layer'); }),
      h('button', { class: 'exp', onclick: (e) => { e.stopPropagation(); if (open) expanded.delete(l.id); else expanded.add(l.id); buildPanels(); } }, open ? '▾' : '▸'),
      h('span', { class: 'name' }, `${l.name}`), h('span', { class: 'note' }, String(l.children.length)));
    row.onclick = () => { S.activeLayer = l.id; buildPanels(); };
    row.ondblclick = () => rename(row, l.name, (v) => { l.name = v; commit('Rename layer'); });
    list.append(row);
    if (open) for (const o of [...l.children].reverse()) list.append(objRow(o, 1, selIds));
  }
  const B = (icon, title, fn) => h('button', { class: 'btn icon', title, html: ICONS[icon], onclick: fn });
  return [list, h('div', { class: 'btn-row' },
    B('plus', 'New layer', () => { ops.addLayer(); expanded.add(S.activeLayer); }),
    B('trash', 'Delete the highlighted layer and everything on it', async () => {
      const l = S.doc.layers.find((x) => x.id === S.activeLayer);
      if (l.children.length) { const r = await ask('Delete layer', [{ type: 'info', html: `<p>Delete “${l.name}” and the ${l.children.length} object(s) on it?</p>` }], { ok: 'Delete' }); if (!r) return; }
      ops.deleteLayer();
    }),
    B('up', 'Move the layer up', () => ops.moveLayer(S.activeLayer, 1)), B('down', 'Move the layer down', () => ops.moveLayer(S.activeLayer, -1)),
    B('toLayer', 'Move the selection to the highlighted layer', () => ops.moveSelToLayer(S.activeLayer)))];
}

function objRow(o, depth, selIds) {
  const isSel = selIds.has(o.id);
  const row = h('div', { class: `lrow${isSel ? ' sel' : ''}`, style: `padding-left:${depth * 14}px` },
    tog(!o.hidden, 'eye', 'Show or hide', () => { o.hidden = !o.hidden; if (o.hidden) setSel(S.sel.filter((x) => x !== o.id)); commit(o.hidden ? 'Hide' : 'Show'); }),
    tog(!o.locked, o.locked ? 'lock' : 'unlock', 'Lock or unlock', () => { o.locked = !o.locked; if (o.locked) setSel(S.sel.filter((x) => x !== o.id)); commit(o.locked ? 'Lock' : 'Unlock'); }),
    h('span', { class: 'name' }, o.name || kindName(o)), h('span', { class: 'dot' }));
  row.onclick = (e) => {
    if (o.hidden || o.locked) return;
    const id = o.id;
    setSel(e.shiftKey || e.ctrlKey ? (S.sel.includes(id) ? S.sel.filter((x) => x !== id) : [...S.sel, id]) : [id]);
  };
  row.ondblclick = () => rename(row, o.name || kindName(o), (v) => { o.name = v; commit('Rename'); });
  return row;
}

function tog(on, icon, title, fn) {
  return h('button', { class: `tog${on ? '' : ' off'}`, title, html: ICONS[icon], onclick: (e) => { e.stopPropagation(); fn(); } });
}

function rename(row, value, done) {
  const name = row.querySelector('.name');
  const i = h('input', { class: 'txt', value });
  name.replaceWith(i);
  i.focus(); i.select();
  const finish = (ok) => { if (ok && i.value.trim() && i.value !== value) done(i.value.trim()); else buildPanels(); };
  i.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
  i.onblur = () => finish(true);
  i.onclick = (e) => e.stopPropagation();
}

export { requestRender, status, live };
