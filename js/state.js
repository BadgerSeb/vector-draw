// Shared application state, settings and the small event hub the parts of the app talk through.

import { newDocument, History, locate, topOf, walk, defaultStyle } from './doc.js';

export const S = {
  doc: newDocument(),
  history: new History(),
  sel: [], // selected object ids (top-level ones with the selection tool, any with direct selection)
  anchors: new Map(), // path id -> Set of "subpath,node"
  tool: 'select',
  zoom: 1, panX: 0, panY: 0,
  activeLayer: null,
  dirty: false,
  fileHandle: null,
  fileName: 'Untitled',
  clip: null,
  pen: null, // { id, si } path being drawn with the pen
  marquee: null, // screen rect
  guides: [], // smart guide lines, doc coords [{x}|{y}]
  hover: null,
  editing: null, // text object id being edited
  preview: null, // pen rubber band
  cursorDoc: null,
};

// ------------------------------------------------------------ settings (remembered per browser)
const DEFAULTS = {
  grid: true, snapGrid: false, snapPoints: true, smart: true, rulers: true,
  gridSize: { in: 1, mm: 10, px: 100 }, gridDiv: { in: 4, mm: 10, px: 10 },
  radius: 0.25 * 96, sides: 6, points: 5, inner: 50, smooth: 50,
  font: 'Segoe UI', fontSize: 32, fontWeight: 400, align: 'left',
  style: { ...defaultStyle() }, lineStyle: { ...defaultStyle(), fill: null },
  pngDpi: 300, pngTransparent: false, alignTo: 'selection', refpt: 0, panels: {},
  units: 'in', lastPreset: 'Letter', offset: 0.0625 * 96, offsetJoin: 'round',
};
export const settings = load();
function load() {
  try {
    const s = JSON.parse(localStorage.getItem('vector-draw-settings') || '{}');
    return { ...structuredClone(DEFAULTS), ...s };
  } catch {
    return structuredClone(DEFAULTS);
  }
}
let saveTimer = 0;
export function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem('vector-draw-settings', JSON.stringify(settings)); } catch { /* private window */ }
  }, 200);
}

// ------------------------------------------------------------ events
const handlers = new Map();
export function on(ev, fn) {
  if (!handlers.has(ev)) handlers.set(ev, []);
  handlers.get(ev).push(fn);
}
export function emit(ev, arg) {
  for (const fn of handlers.get(ev) || []) fn(arg);
}

// ------------------------------------------------------------ document changes
/** After a finished change: remember it for undo and redraw everything. */
export function commit(label) {
  cleanSelection();
  S.history.push(S.doc, label);
  S.dirty = true;
  emit('doc');
  emit('selection');
}

/** During a drag: redraw without an undo step. */
export const live = () => emit('doc');

export function restore(doc) {
  if (!doc) return;
  S.doc = doc;
  cleanSelection();
  S.dirty = true;
  emit('doc');
  emit('selection');
}

export function cleanSelection() {
  S.sel = S.sel.filter((id) => locate(S.doc, id));
  for (const id of [...S.anchors.keys()]) if (!S.sel.includes(id)) S.anchors.delete(id);
  if (!S.doc.layers.some((l) => l.id === S.activeLayer)) S.activeLayer = S.doc.layers[S.doc.layers.length - 1].id;
}

export function setSel(ids, { anchors = false } = {}) {
  S.sel = [...new Set(ids)];
  if (!anchors) S.anchors.clear();
  const first = S.sel.length ? locate(S.doc, S.sel[0]) : null;
  if (first) S.activeLayer = first.layer.id;
  emit('selection');
}

export const selected = () => S.sel.map((id) => locate(S.doc, id)?.obj).filter(Boolean);

/** Selected objects with nested duplicates (a child of a selected group) dropped. */
export function selectedRoots() {
  const objs = selected();
  const inside = new Set();
  for (const o of objs) if (o.children) for (const w of walk(o.children)) inside.add(w.obj.id);
  return objs.filter((o) => !inside.has(o.id));
}

export const activeLayer = () => S.doc.layers.find((l) => l.id === S.activeLayer) || S.doc.layers[S.doc.layers.length - 1];

/** The layer new objects go into (an unlocked, visible one; the active one if it can be). */
export function targetLayer() {
  let l = activeLayer();
  if (l.locked || !l.visible) {
    l.locked = false;
    l.visible = true;
  }
  return l;
}

export function isEditable(id) {
  const loc = locate(S.doc, id);
  if (!loc) return false;
  if (loc.layer.locked || !loc.layer.visible) return false;
  let o = topOf(S.doc, id);
  if (o && (o.locked || o.hidden)) return false;
  return !loc.obj.locked && !loc.obj.hidden;
}

export function status(msg, kind = '') {
  emit('status', { msg, kind });
}
