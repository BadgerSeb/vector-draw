// Commands on the selection and the document: arrange, group, align, transform, path operations,
// clipboard and layers. Each finished command is one undo step.

import { S, settings, saveSettings, commit, setSel, selected, selectedRoots, targetLayer, activeLayer, status, emit } from './state.js';
import { locate, topOf, bounds, boundsOf, newId, transformObject, clone, walk, layerOf, textWidths as textWidthsOf } from './doc.js';
import { scaleAt, rotateAt, translate, segments } from './geom.js';
import { booleanOp, offsetPath } from './pathops.js';
import { joinChains, reverseNodes, boxPathOf } from './pathtools.js';
import { exportSvg } from './render.js';

const roots = () => selectedRoots().filter((o) => locate(S.doc, o.id));
const need = (n = 1) => {
  const r = roots();
  if (r.length < n) { status(n === 1 ? 'Select something first.' : `Select at least ${n} objects.`); return null; }
  return r;
};

// ------------------------------------------------------------ basics
export function deleteSel() {
  const r = roots();
  if (!r.length) return;
  for (const o of r) { const l = locate(S.doc, o.id); if (l) l.list.splice(l.index, 1); }
  setSel([]);
  commit('Delete');
}

export function nudgeStep(big) {
  const u = S.doc.units;
  const base = u === 'in' ? 96 / 16 : u === 'mm' ? 96 / 25.4 : 1;
  return base * (big ? 10 : 1);
}

export function nudge(dx, dy) {
  // with anchors picked, move just those
  if (S.anchors.size && S.tool !== 'select') {
    for (const [id, set] of S.anchors) {
      const o = locate(S.doc, id)?.obj;
      if (!o) continue;
      for (const k of set) {
        const [si, ni] = k.split(',').map(Number);
        const n = o.subpaths[si]?.nodes[ni];
        if (!n) continue;
        n.x += dx; n.y += dy;
        if (n.in) n.in = { x: n.in.x + dx, y: n.in.y + dy };
        if (n.out) n.out = { x: n.out.x + dx, y: n.out.y + dy };
      }
    }
    return commit('Nudge');
  }
  const r = roots();
  if (!r.length) return;
  for (const o of r) transformObject(o, translate(dx, dy));
  commit('Nudge');
}

export function duplicate() {
  const r = roots();
  if (!r.length) return;
  const d = nudgeStep(false) * 2;
  const ids = [];
  for (const o of r) {
    const l = locate(S.doc, o.id);
    const c = clone(o);
    transformObject(c, translate(d, d));
    l.list.splice(l.index + 1, 0, c);
    ids.push(c.id);
  }
  setSel(ids);
  commit('Duplicate');
}

export function selectAll() {
  const ids = [];
  for (const l of S.doc.layers) if (l.visible && !l.locked) for (const o of l.children) if (!o.hidden && !o.locked) ids.push(o.id);
  if (S.tool !== 'select') {
    S.anchors.clear();
    for (const id of ids) for (const w of walk([locate(S.doc, id).obj])) {
      if (w.obj.type !== 'path') continue;
      const set = new Set();
      w.obj.subpaths.forEach((sp, si) => sp.nodes.forEach((_, ni) => set.add(`${si},${ni}`)));
      S.anchors.set(w.obj.id, set);
    }
    return setSel([...S.anchors.keys(), ...ids.filter((id) => locate(S.doc, id).obj.type !== 'path' && locate(S.doc, id).obj.type !== 'group')], { anchors: true });
  }
  setSel(ids);
}

// ------------------------------------------------------------ clipboard
let lastCopiedSvg = '';
export function copy(cut = false) {
  const r = roots();
  if (!r.length) return false;
  S.clip = r.map((o) => structuredClone(o));
  // as SVG too, for pasting into other programs
  const tmp = { ...S.doc, layers: [{ id: 'clip', name: 'Clipboard', visible: true, locked: false, children: S.clip }] };
  lastCopiedSvg = exportSvg(tmp);
  if (cut) {
    for (const o of r) { const l = locate(S.doc, o.id); if (l) l.list.splice(l.index, 1); }
    setSel([]);
    commit('Cut');
  }
  status(`${cut ? 'Cut' : 'Copied'} ${r.length} object${r.length > 1 ? 's' : ''}.`);
  return true;
}
export const copiedSvg = () => lastCopiedSvg;

export function paste(inPlace = false) {
  if (!S.clip || !S.clip.length) return false;
  const objs = S.clip.map((o) => clone(o));
  if (!inPlace) {
    // centered in the visible area
    const b = boundsOf(objs);
    const wrap = document.getElementById('stage-wrap').getBoundingClientRect();
    const cx = (wrap.width / 2 - S.panX) / S.zoom, cy = (wrap.height / 2 - S.panY) / S.zoom;
    if (b) for (const o of objs) transformObject(o, translate(cx - (b.x + b.w / 2), cy - (b.y + b.h / 2)));
  }
  const l = targetLayer();
  l.children.push(...objs);
  setSel(objs.map((o) => o.id));
  commit('Paste');
  return true;
}

// ------------------------------------------------------------ arrange and group
export function arrange(how) {
  const r = roots();
  if (!r.length) return;
  // per containing list, keep the selection's own order
  const lists = new Map();
  for (const o of r) {
    const l = locate(S.doc, o.id);
    if (!lists.has(l.list)) lists.set(l.list, []);
    lists.get(l.list).push(o);
  }
  for (const [list, objs] of lists) {
    const set = new Set(objs);
    if (how === 'front' || how === 'back') {
      const rest = list.filter((o) => !set.has(o));
      const moved = list.filter((o) => set.has(o));
      list.splice(0, list.length, ...(how === 'front' ? [...rest, ...moved] : [...moved, ...rest]));
    } else if (how === 'forward') {
      for (let i = list.length - 2; i >= 0; i--) if (set.has(list[i]) && !set.has(list[i + 1])) [list[i], list[i + 1]] = [list[i + 1], list[i]];
    } else {
      for (let i = 1; i < list.length; i++) if (set.has(list[i]) && !set.has(list[i - 1])) [list[i], list[i - 1]] = [list[i - 1], list[i]];
    }
  }
  commit({ front: 'Bring to front', back: 'Send to back', forward: 'Bring forward', backward: 'Send backward' }[how]);
}

export function group() {
  const r = need(1);
  if (!r) return;
  // goes where the top-most selected object was
  const locs = r.map((o) => locate(S.doc, o.id));
  const top = locs[locs.length - 1];
  const list = top.list;
  const ordered = [];
  for (const w of walk(S.doc.layers)) if (r.includes(w.obj)) ordered.push(w.obj);
  const g = { type: 'group', id: newId(), name: 'Group', children: ordered, style: { opacity: 1 } };
  let at = list.indexOf(top.obj);
  for (const l of locs) { const i = l.list.indexOf(l.obj); l.list.splice(i, 1); if (l.list === list && i < at) at--; }
  list.splice(at, 0, g);
  setSel([g.id]);
  commit('Group');
}

export function ungroup() {
  const r = roots().filter((o) => o.type === 'group');
  if (!r.length) return status('Select a group first.');
  const ids = [];
  for (const g of r) {
    const l = locate(S.doc, g.id);
    const op = g.style?.opacity ?? 1;
    if (op < 1) for (const c of g.children) { c.style = c.style || {}; c.style.opacity = (c.style.opacity ?? 1) * op; }
    l.list.splice(l.index, 1, ...g.children);
    ids.push(...g.children.map((c) => c.id));
  }
  setSel(ids);
  commit('Ungroup');
}

// ------------------------------------------------------------ align and distribute
export function align(kind) {
  const r = roots();
  const toBoard = settings.alignTo === 'artboard' || r.length === 1;
  if (!r.length) return status('Select something first.');
  const ref = toBoard ? { x: 0, y: 0, w: S.doc.width, h: S.doc.height } : boundsOf(r);
  for (const o of r) {
    const b = bounds(o);
    if (!b) continue;
    let dx = 0, dy = 0;
    if (kind === 'left') dx = ref.x - b.x;
    if (kind === 'hcenter') dx = ref.x + ref.w / 2 - (b.x + b.w / 2);
    if (kind === 'right') dx = ref.x + ref.w - (b.x + b.w);
    if (kind === 'top') dy = ref.y - b.y;
    if (kind === 'vcenter') dy = ref.y + ref.h / 2 - (b.y + b.h / 2);
    if (kind === 'bottom') dy = ref.y + ref.h - (b.y + b.h);
    transformObject(o, translate(dx, dy));
  }
  commit('Align');
}

export function distribute(kind) {
  const r = roots();
  if (r.length < 3 && !(settings.alignTo === 'artboard' && r.length >= 2)) return status('Select at least three objects to distribute.');
  const horiz = kind.startsWith('h');
  const items = r.map((o) => ({ o, b: bounds(o) })).filter((i) => i.b);
  const key = (i) => (horiz ? i.b.x + i.b.w / 2 : i.b.y + i.b.h / 2);
  items.sort((a, b) => key(a) - key(b));
  const all = settings.alignTo === 'artboard' ? { x: 0, y: 0, w: S.doc.width, h: S.doc.height } : boundsOf(r);
  if (kind.endsWith('space')) {
    const total = items.reduce((s, i) => s + (horiz ? i.b.w : i.b.h), 0);
    const gap = ((horiz ? all.w : all.h) - total) / (items.length - 1);
    let pos = horiz ? all.x : all.y;
    for (const i of items) {
      const d = pos - (horiz ? i.b.x : i.b.y);
      transformObject(i.o, horiz ? translate(d, 0) : translate(0, d));
      pos += (horiz ? i.b.w : i.b.h) + gap;
    }
  } else {
    let first = key(items[0]), last = key(items[items.length - 1]);
    if (settings.alignTo === 'artboard') {
      const f = items[0].b, l = items[items.length - 1].b;
      first = horiz ? all.x + f.w / 2 : all.y + f.h / 2;
      last = horiz ? all.x + all.w - l.w / 2 : all.y + all.h - l.h / 2;
    }
    items.forEach((i, k) => {
      const target = first + ((last - first) * k) / (items.length - 1);
      const d = target - key(i);
      transformObject(i.o, horiz ? translate(d, 0) : translate(0, d));
    });
  }
  commit('Distribute');
}

// ------------------------------------------------------------ transforms
/** The reference point (0..8, left to right, top to bottom) of a box. */
export function refPoint(b, ref = settings.refpt) {
  const cx = ref % 3, cy = Math.floor(ref / 3);
  return { x: b.x + (b.w * cx) / 2, y: b.y + (b.h * cy) / 2 };
}

export function flip(horizontal) {
  const r = roots();
  const b = boundsOf(r);
  if (!b) return;
  const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  for (const o of r) transformObject(o, horizontal ? scaleAt(-1, 1, c.x, c.y) : scaleAt(1, -1, c.x, c.y));
  commit(horizontal ? 'Flip horizontal' : 'Flip vertical');
}

export function rotateBy(deg) {
  const r = roots();
  const b = boundsOf(r);
  if (!b || !deg) return;
  const c = refPoint(b, settings.refpt === undefined ? 4 : settings.refpt);
  // degrees counter-clockwise, as drawing programs show them (y points down here)
  for (const o of r) transformObject(o, rotateAt((-deg * Math.PI) / 180, c.x, c.y));
  commit('Rotate');
}

/** Sets X, Y, W or H (document px) of the selection, about the reference point. */
export function setGeometry(field, value, keepRatio) {
  const r = roots();
  const b = boundsOf(r);
  if (!b || !isFinite(value)) return;
  const ref = refPoint(b);
  if (field === 'x' || field === 'y') {
    const d = value - (field === 'x' ? ref.x : ref.y);
    for (const o of r) transformObject(o, field === 'x' ? translate(d, 0) : translate(0, d));
  } else {
    if (value <= 0) return;
    let sx = 1, sy = 1;
    if (field === 'w') { sx = b.w ? value / b.w : 1; if (keepRatio) sy = sx; } else { sy = b.h ? value / b.h : 1; if (keepRatio) sx = sy; }
    for (const o of r) transformObject(o, scaleAt(sx, sy, ref.x, ref.y));
  }
  commit('Transform');
}

// ------------------------------------------------------------ appearance
export function setStyle(patch, label = 'Style') {
  const r = selected();
  Object.assign(settings.style, structuredClone(patch));
  saveSettings();
  if (!r.length) { emit('selection'); return; }
  const apply = (o) => {
    if (o.type === 'group') return o.children.forEach(apply);
    o.style = o.style || {};
    const p = structuredClone(patch);
    if (o.type === 'image') { if ('opacity' in p) o.style.opacity = p.opacity; return; }
    Object.assign(o.style, p);
  };
  r.forEach(apply);
  commit(label);
}

export function setTextProps(patch) {
  const r = selected();
  for (const k of ['font', 'size', 'weight', 'align']) if (k in patch) settings[{ font: 'font', size: 'fontSize', weight: 'fontWeight', align: 'align' }[k]] = patch[k];
  saveSettings();
  let n = 0;
  const apply = (o) => {
    if (o.type === 'group') return o.children.forEach(apply);
    if (o.type !== 'text') return;
    if ('align' in patch && patch.align !== o.align) {
      // keep the text where it is when its anchor changes side
      const w = Math.max(1, ...textWidthsOf(o));
      const pos = { left: 0, center: 0.5, right: 1 };
      const d = (pos[patch.align] - pos[o.align]) * w;
      o.matrix = [o.matrix[0], o.matrix[1], o.matrix[2], o.matrix[3], o.matrix[4] + o.matrix[0] * d, o.matrix[5] + o.matrix[1] * d];
    }
    Object.assign(o, patch);
    n++;
  };
  r.forEach(apply);
  if (n) commit('Text');
  else emit('selection');
}

// ------------------------------------------------------------ visibility and locking
export function lockSel() {
  const r = roots();
  for (const o of r) o.locked = true;
  setSel([]);
  commit('Lock');
}
export function unlockAll() {
  const ids = [];
  for (const l of S.doc.layers) for (const o of l.children) if (o.locked) { o.locked = false; ids.push(o.id); }
  setSel(ids);
  commit('Unlock all');
}
export function hideSel() {
  const r = roots();
  for (const o of r) o.hidden = true;
  setSel([]);
  commit('Hide');
}
export function showAll() {
  const ids = [];
  for (const l of S.doc.layers) for (const o of l.children) if (o.hidden) { o.hidden = false; ids.push(o.id); }
  setSel(ids);
  commit('Show all');
}

// ------------------------------------------------------------ paths
function replaceWith(objs, path, name) {
  const locs = objs.map((o) => locate(S.doc, o.id));
  const last = locs[locs.length - 1];
  const base = objs[0].type === 'group' ? firstPath(objs[0]) : objs[0];
  const style = structuredClone(base?.style || settings.style);
  if (base?.type === 'text' || base?.type === 'image' || !style.fill && !style.stroke) style.fill = '#808080';
  const o = { type: 'path', id: newId(), name, subpaths: path, style, fillRule: 'nonzero' };
  const list = last.list;
  let at = list.indexOf(last.obj);
  for (const l of locs) { const i = l.list.indexOf(l.obj); l.list.splice(i, 1); if (l.list === list && i < at) at--; }
  list.splice(at + 1, 0, o);
  setSel([o.id]);
  return o;
}
const firstPath = (g) => { for (const w of walk([g])) if (w.obj.type === 'path') return w.obj; return null; };

export function pathfinder(op) {
  const r = need(op === 'unite' ? 1 : 2);
  if (!r) return;
  // back to front, as stacked in the document
  const order = [];
  for (const w of walk(S.doc.layers)) if (r.includes(w.obj)) order.push(w.obj);
  const res = booleanOp(op, order);
  const name = { unite: 'Unite', minus: 'Minus Front', intersect: 'Intersect', exclude: 'Exclude' }[op];
  if (!res.length) {
    for (const o of order) { const l = locate(S.doc, o.id); l.list.splice(l.index, 1); }
    setSel([]);
    commit(name);
    return status(`${name} left nothing: the shapes don't overlap that way.`);
  }
  // minus front keeps the back object's look; the others the front-most's
  const keep = op === 'minus' ? order[0] : order[order.length - 1];
  const o = replaceWith(order, res, name);
  const kp = keep.type === 'group' ? firstPath(keep) : keep;
  if (kp?.style) o.style = structuredClone(kp.style);
  commit(name);
}

export function offset(delta, join) {
  const r = need(1);
  if (!r) return;
  const ids = [];
  for (const src of r) {
    const res = offsetPath(src, delta, join);
    if (!res.length) continue;
    const l = locate(S.doc, src.id);
    const base = src.type === 'group' ? firstPath(src) : src;
    const o = { type: 'path', id: newId(), name: 'Offset path', subpaths: res, style: structuredClone(base?.style || settings.style), fillRule: 'nonzero' };
    l.list.splice(delta > 0 ? l.index : l.index + 1, 0, o);
    ids.push(o.id);
  }
  if (!ids.length) return status('Offset Path left nothing (the inset is larger than the shape).');
  setSel(ids);
  commit('Offset path');
}

/** Joins the open paths in the selection whose ends meet (or nearly meet, within tol px). */
export function join(tol = 0.5) {
  const r = roots().filter((o) => o.type === 'path');
  if (!r.length) return status('Select open paths to join.');
  const chains = [];
  for (const o of r) for (const sp of o.subpaths) chains.push({ nodes: sp.nodes, closed: sp.closed });
  let joined = joinChains(chains, tol);
  // two open ends that are apart: one selected path with one open subpath gets closed
  if (r.length === 1 && joined.length === 1 && !joined[0].closed) joined[0].closed = true;
  const o = replaceWith(r, joined.map((c) => ({ closed: c.closed, nodes: c.nodes })), r[0].name || 'Path');
  o.style = structuredClone(r[0].style);
  o.fillRule = r[0].fillRule;
  commit('Join');
}

export function reversePath() {
  const r = roots().filter((o) => o.type === 'path');
  for (const o of r) o.subpaths = o.subpaths.map((sp) => ({ ...sp, nodes: reverseNodes(sp.nodes) }));
  if (r.length) commit('Reverse path');
}

export function makeCompound() {
  const r = need(1);
  if (!r) return;
  const paths = [];
  for (const o of r) for (const w of walk([o])) if (w.obj.type === 'path') paths.push(w.obj);
  if (!paths.length) return;
  const o = replaceWith(r, paths.flatMap((p) => structuredClone(p.subpaths)), 'Compound path');
  o.style = structuredClone(paths[paths.length - 1].style);
  o.fillRule = 'evenodd';
  commit('Make compound path');
}

export function releaseCompound() {
  const r = roots().filter((o) => o.type === 'path' && o.subpaths.length > 1);
  if (!r.length) return status('Select a compound path first.');
  const ids = [];
  for (const o of r) {
    const l = locate(S.doc, o.id);
    const parts = o.subpaths.map((sp) => ({ type: 'path', id: newId(), name: 'Path', subpaths: [sp], style: structuredClone(o.style) }));
    l.list.splice(l.index, 1, ...parts);
    ids.push(...parts.map((p) => p.id));
  }
  setSel(ids);
  commit('Release compound path');
}

/** Text and pictures become plain rectangles (box outlines). */
export function outlineObject() {
  const r = roots().filter((o) => o.type === 'text' || o.type === 'image');
  if (!r.length) return status('Shapes are already editable paths. Select text or a picture to turn its box into a path.');
  const ids = [];
  for (const o of r) {
    const l = locate(S.doc, o.id);
    const p = { type: 'path', id: newId(), name: o.type === 'text' ? 'Text box' : 'Picture box', subpaths: boxPathOf(o).subpaths, style: { ...settings.style } };
    l.list.splice(l.index, 1, p);
    ids.push(p.id);
  }
  setSel(ids);
  commit('Convert to path');
}

/** Rounds every corner of the selected paths with the given radius (px). */
export function roundCorners(radius) {
  const r = roots().filter((o) => o.type === 'path');
  if (!r.length || !(radius > 0)) return;
  for (const o of r) {
    o.subpaths = o.subpaths.map((sp) => {
      const n = sp.nodes, len = n.length, out = [];
      for (let i = 0; i < len; i++) {
        const p = n[i];
        const hasPrev = sp.closed || i > 0, hasNext = sp.closed || i < len - 1;
        if (p.in || p.out || !hasPrev || !hasNext) { out.push({ ...p }); continue; }
        const a = n[(i - 1 + len) % len], b = n[(i + 1) % len];
        const v1 = { x: a.x - p.x, y: a.y - p.y }, v2 = { x: b.x - p.x, y: b.y - p.y };
        const l1 = Math.hypot(v1.x, v1.y), l2 = Math.hypot(v2.x, v2.y);
        const ang = Math.acos(Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (l1 * l2 || 1))));
        if (!(ang > 1e-3 && ang < Math.PI - 1e-3)) { out.push({ ...p }); continue; }
        let t = radius / Math.tan(ang / 2);
        t = Math.min(t, l1 / 2, l2 / 2);
        const rr = t * Math.tan(ang / 2);
        const k = (4 / 3) * Math.tan((Math.PI - ang) / 4) * rr;
        const u1 = { x: v1.x / l1, y: v1.y / l1 }, u2 = { x: v2.x / l2, y: v2.y / l2 };
        const p1 = { x: p.x + u1.x * t, y: p.y + u1.y * t }, p2 = { x: p.x + u2.x * t, y: p.y + u2.y * t };
        out.push({ ...p1, in: null, out: { x: p1.x - u1.x * k, y: p1.y - u1.y * k } });
        out.push({ ...p2, in: { x: p2.x - u2.x * k, y: p2.y - u2.y * k }, out: null });
      }
      return { closed: sp.closed, nodes: out };
    });
  }
  commit('Round corners');
}

// ------------------------------------------------------------ layers
const LAYER_COLORS = ['#e8650f', '#1e90ff', '#22c55e', '#e11d48', '#a855f7', '#eab308', '#06b6d4', '#f97316'];
export function addLayer() {
  const n = S.doc.layers.length + 1;
  let name = `Layer ${n}`;
  for (let k = n; S.doc.layers.some((l) => l.name === name); k++) name = `Layer ${k + 1}`;
  const l = { id: newId(), name, visible: true, locked: false, color: LAYER_COLORS[(n - 1) % LAYER_COLORS.length], children: [] };
  const at = S.doc.layers.indexOf(activeLayer());
  S.doc.layers.splice(at + 1, 0, l);
  S.activeLayer = l.id;
  commit('New layer');
}

export function deleteLayer(id = S.activeLayer) {
  if (S.doc.layers.length < 2) return status("A document needs at least one layer.");
  const i = S.doc.layers.findIndex((l) => l.id === id);
  if (i < 0) return;
  S.doc.layers.splice(i, 1);
  S.activeLayer = S.doc.layers[Math.max(0, i - 1)].id;
  commit('Delete layer');
}

export function moveLayer(id, dir) {
  const L = S.doc.layers, i = L.findIndex((l) => l.id === id), j = i + dir;
  if (i < 0 || j < 0 || j >= L.length) return;
  [L[i], L[j]] = [L[j], L[i]];
  commit('Move layer');
}

export function moveSelToLayer(id) {
  const target = S.doc.layers.find((l) => l.id === id);
  const r = roots();
  if (!target || !r.length) return;
  for (const o of r) { const l = locate(S.doc, o.id); l.list.splice(l.index, 1); target.children.push(o); }
  S.activeLayer = id;
  commit('Move to layer');
}

export { layerOf, topOf, segments };
