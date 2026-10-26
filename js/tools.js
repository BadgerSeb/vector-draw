// The drawing and editing tools: what happens on the canvas when you press, drag and let go.

import { S, settings, saveSettings, commit, live, setSel, selected, selectedRoots, targetLayer, isEditable, emit, status } from './state.js';
import { els, toDoc, toScreen, stagePoint, requestRender, selectionScreenBox, handlePoints, HANDLE, directTools, zoomStep, fitBox, gridStep, screenMatrix, renderNow } from './view.js';
import { locate, topOf, bounds, boundsOf, newId, transformObject, clone, walk, textLocalBox, fontCss, UNITS, toUnits, fromUnits } from './doc.js';
import { apply, dist, rectPath, ellipsePath, polygonPath, starPath, scaleAt, rotateAt, translate, simplify, smoothNodes, nearestOnPath, pathD, transformSub, fmt } from './geom.js';
import { insertAnchor, convertAnchor, reverseNodes } from './pathtools.js';

export const TOOLS = [
  { id: 'select', key: 'v', name: 'Selection', hint: 'Click to select, drag to move. Drag handles to scale (Shift keeps proportions, Alt from the center); just outside a corner rotates. Alt-drag copies.' },
  { id: 'direct', key: 'a', name: 'Direct Selection', hint: 'Click a path to see its anchors. Drag anchors or handles; Shift-click picks several; drag on empty space to box-select anchors. Alt-drag a handle breaks a smooth point.' },
  { id: 'pen', key: 'p', name: 'Pen', hint: 'Click for corners, drag for curves. Click the first anchor to close. Enter or Esc finishes. Click the end of a selected open path to continue it.' },
  { id: 'add-anchor', key: '+', name: 'Add Anchor Point', hint: 'Click on a path to add an anchor there.' },
  { id: 'del-anchor', key: '-', name: 'Delete Anchor Point', hint: 'Click an anchor to remove it.' },
  { id: 'convert', key: 'C', name: 'Anchor Point', hint: 'Click an anchor to switch between a corner and a smooth point; drag to pull out new handles.' },
  { id: 'pencil', key: 'n', name: 'Pencil', hint: 'Drag to draw freehand. End near the start to close the shape. Smoothing is set above.' },
  { id: 'line', key: '\\', name: 'Line Segment', hint: 'Drag to draw a line. Shift snaps to 45°. Click for an exact length and angle.' },
  { id: 'rect', key: 'm', name: 'Rectangle', hint: 'Drag to draw. Shift for a square, Alt from the center. Click for an exact size.' },
  { id: 'rrect', key: '', name: 'Rounded Rectangle', hint: 'Drag to draw with the corner radius above. Shift for a square, Alt from the center.' },
  { id: 'ellipse', key: 'l', name: 'Ellipse', hint: 'Drag to draw. Shift for a circle, Alt from the center. Click for an exact size.' },
  { id: 'polygon', key: '', name: 'Polygon', hint: 'Drag out from the center; the drag direction sets the rotation (Shift keeps it upright).' },
  { id: 'star', key: '', name: 'Star', hint: 'Drag out from the center. Points and inner radius are set above.' },
  { id: 'text', key: 't', name: 'Type', hint: 'Click to place text and type. Click existing text to edit it. Esc or clicking elsewhere finishes.' },
  { id: 'eyedropper', key: 'i', name: 'Eyedropper', hint: 'Click an object to copy its fill and stroke onto the selection (and use them for new shapes).' },
  { id: 'hand', key: 'h', name: 'Hand', hint: 'Drag to scroll around. Hold Space for this tool at any time.' },
  { id: 'zoom', key: 'z', name: 'Zoom', hint: 'Click to zoom in, Alt-click to zoom out, drag a box to zoom to it.' },
];

let drag = null; // the current press-and-drag
let spaceHand = false;

export function setTool(id) {
  if (S.tool === id) return;
  finishPen();
  finishText();
  S.tool = id;
  S.preview = null;
  if (id === 'select') {
    // back to whole objects
    const tops = [...new Set(S.sel.map((i) => topOf(S.doc, i)?.id).filter(Boolean))];
    setSel(tops);
  }
  emit('tool');
  updateCursor();
  requestRender('overlay');
}

export const setSpaceHand = (v) => { spaceHand = v; updateCursor(); };

function updateCursor(c) {
  const t = spaceHand ? 'hand' : S.tool;
  const base = { select: 'default', direct: 'default', pen: 'pen', 'add-anchor': 'pen', 'del-anchor': 'pen', convert: 'default', pencil: 'crosshair', line: 'crosshair', rect: 'crosshair', rrect: 'crosshair', ellipse: 'crosshair', polygon: 'crosshair', star: 'crosshair', text: 'text', eyedropper: 'dropper', hand: 'grab', zoom: 'zoom-in' }[t];
  els['stage-wrap'].dataset.cursor = c || base;
}

// ------------------------------------------------------------ hit testing and snapping
function hitId(e) {
  const t = e.target.closest && e.target.closest('[data-id]');
  if (!t || !els.content.contains(t)) return null;
  const id = t.getAttribute('data-id');
  return isEditable(id) ? id : null;
}

const tol = () => 6 / S.zoom;

/** Visible, unlocked top-level objects. */
function editableTops() {
  const out = [];
  for (const l of S.doc.layers) {
    if (!l.visible || l.locked) continue;
    for (const o of l.children) if (!o.hidden && !o.locked) out.push(o);
  }
  return out;
}

function snapTargets(exclude) {
  const pts = [];
  const ex = new Set(exclude);
  const W = S.doc.width, H = S.doc.height;
  pts.push({ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }, { x: W / 2, y: H / 2 });
  for (const o of editableTops()) {
    if (ex.has(o.id)) continue;
    for (const w of walk([o])) {
      if (ex.has(w.obj.id)) continue;
      if (w.obj.type === 'path') for (const sp of w.obj.subpaths) for (const n of sp.nodes) pts.push(n);
    }
  }
  return pts;
}

/** Snaps a document point to anchors (and the artboard) or the grid. */
export function snap(p, exclude = [], shiftFree = false) {
  if (shiftFree) return p;
  if (settings.snapPoints) {
    let best = null, bd = tol();
    for (const q of drag?.targets || snapTargets(exclude)) {
      const d = dist(p, q);
      if (d < bd) { bd = d; best = q; }
    }
    if (best) return { x: best.x, y: best.y, snapped: true };
  }
  if (settings.snapGrid) {
    const { minor } = gridStep();
    return { x: Math.round(p.x / minor) * minor, y: Math.round(p.y / minor) * minor };
  }
  return p;
}

// ------------------------------------------------------------ dispatch
export function initTools() {
  const st = els.stage;
  st.addEventListener('pointerdown', (e) => {
    if (e.button === 1 || (e.button === 0 && (spaceHand || S.tool === 'hand'))) return startPan(e);
    if (e.button !== 0) return;
    if (S.editing && e.target !== document.getElementById('text-editor')) finishText();
    try { st.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    const p = stagePoint(e);
    const fn = DOWN[S.tool];
    if (fn) fn(e, p, toDoc(p.x, p.y));
  });
  st.addEventListener('pointermove', (e) => {
    const p = stagePoint(e);
    const d = toDoc(p.x, p.y);
    S.cursorDoc = d;
    emit('cursor', d);
    if (drag && drag.move) {
      drag.move(e, p, d);
      drag.moved = drag.moved || dist(p, drag.start) > 3;
    } else if (!drag) {
      hover(e, p, d);
    }
    requestRender('overlay');
  });
  const end = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    S.guides = [];
    try { st.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (d.up) d.up(e, stagePoint(e), toDoc(stagePoint(e).x, stagePoint(e).y));
    requestRender('overlay');
  };
  st.addEventListener('pointerup', end);
  st.addEventListener('pointercancel', end);
  st.addEventListener('pointerleave', () => { S.cursorDoc = null; if (!drag) { S.hover = null; requestRender('overlay'); } });
  st.addEventListener('dblclick', (e) => {
    const id = hitId(e);
    if (!id) return;
    const loc = locate(S.doc, id);
    if (S.tool === 'select' || S.tool === 'direct') {
      if (loc.obj.type === 'text') { editText(id); return; }
      if (S.tool === 'select' && loc.obj.type === 'path') { setTool('direct'); setSel([id]); }
    }
  });
  st.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = stagePoint(e);
    if (e.ctrlKey || e.altKey) {
      const f = Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015));
      import('./view.js').then((v) => v.zoomAt(S.zoom * f, p.x, p.y));
    } else {
      const k = e.deltaMode ? 30 : 1;
      if (e.shiftKey) S.panX -= (e.deltaY || e.deltaX) * k;
      else { S.panX -= e.deltaX * k; S.panY -= e.deltaY * k; }
      requestRender('view');
    }
  }, { passive: false });
  updateCursor();
}

function startPan(e) {
  e.preventDefault();
  try { els.stage.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
  const s = stagePoint(e), px = S.panX, py = S.panY;
  updateCursor('grabbing');
  drag = {
    start: s,
    move: (ev, p) => { S.panX = px + p.x - s.x; S.panY = py + p.y - s.y; requestRender('view'); },
    up: () => updateCursor(),
  };
}

// ------------------------------------------------------------ hover feedback
function hover(e, p, d) {
  const id = hitId(e);
  S.hover = id && (S.tool === 'select' ? topOf(S.doc, id)?.id : id);
  if (S.tool === 'select') {
    const h = handleAt(p);
    if (h != null) return updateCursor(['nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize', 'ew-resize'][h]);
    if (rotateZone(p)) return updateCursor('rotate');
    return updateCursor(e.altKey && id ? 'copy' : id ? 'move' : 'default');
  }
  if (S.tool === 'pen') {
    if (S.pen) {
      const o = locate(S.doc, S.pen.id)?.obj;
      const sp = o?.subpaths[S.pen.si];
      if (sp && sp.nodes.length) {
        const last = sp.nodes[sp.nodes.length - 1];
        const q = snap(d, [o.id]);
        const m = screenMatrix();
        const a = apply(m, last), c1 = apply(m, last.out || last), b = apply(m, q);
        S.preview = `M${fmt(a.x, 1)} ${fmt(a.y, 1)}C${fmt(c1.x, 1)} ${fmt(c1.y, 1)} ${fmt(b.x, 1)} ${fmt(b.y, 1)} ${fmt(b.x, 1)} ${fmt(b.y, 1)}`;
      }
    } else S.preview = null;
  }
  updateCursor();
}

function handleAt(p) {
  if (S.tool !== 'select' || !S.sel.length) return null;
  const b = selectionScreenBox();
  if (!b) return null;
  const hs = handlePoints(b);
  for (let i = 0; i < 8; i++) {
    // hide middle handles on very thin selections
    if (Math.abs(hs[i][0] - p.x) <= HANDLE + 2 && Math.abs(hs[i][1] - p.y) <= HANDLE + 2) return i;
  }
  return null;
}

function rotateZone(p) {
  if (S.tool !== 'select' || !S.sel.length) return false;
  const b = selectionScreenBox();
  if (!b) return false;
  const inside = p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
  if (inside) return false;
  for (const i of [0, 2, 4, 6]) {
    const [x, y] = handlePoints(b)[i];
    const d = Math.hypot(p.x - x, p.y - y);
    if (d > HANDLE + 2 && d < 20) return true;
  }
  return false;
}

// ------------------------------------------------------------ helpers
const snapshot = (objs) => objs.map((o) => ({ o, orig: structuredClone(o) }));
function resetTo(snap) {
  for (const { o, orig } of snap) {
    for (const k of Object.keys(o)) if (k !== 'id') delete o[k];
    Object.assign(o, structuredClone(orig));
  }
}

function otherBoxes(exclude) {
  const ex = new Set(exclude);
  const out = [{ x: 0, y: 0, w: S.doc.width, h: S.doc.height }];
  for (const o of editableTops()) if (!ex.has(o.id)) { const b = bounds(o); if (b) out.push(b); }
  for (const l of S.doc.layers) if (l.visible && l.locked) for (const o of l.children) { const b = bounds(o); if (b) out.push(b); }
  return out;
}

/** Smart guides: nudges a moving box so its edges or center line up with others. */
function smartSnap(box, boxes, dx, dy) {
  S.guides = [];
  if (!settings.smart) return { dx, dy };
  const t = 5 / S.zoom;
  const xs = [box.x + dx, box.x + box.w / 2 + dx, box.x + box.w + dx];
  const ys = [box.y + dy, box.y + box.h / 2 + dy, box.y + box.h + dy];
  let bx = null, by = null;
  for (const b of boxes) {
    for (const tx of [b.x, b.x + b.w / 2, b.x + b.w]) for (const x of xs) {
      const d = tx - x;
      if (Math.abs(d) < t && (!bx || Math.abs(d) < Math.abs(bx.d))) bx = { d, x: tx };
    }
    for (const ty of [b.y, b.y + b.h / 2, b.y + b.h]) for (const y of ys) {
      const d = ty - y;
      if (Math.abs(d) < t && (!by || Math.abs(d) < Math.abs(by.d))) by = { d, y: ty };
    }
  }
  if (bx) { dx += bx.d; S.guides.push({ x: bx.x }); }
  if (by) { dy += by.d; S.guides.push({ y: by.y }); }
  return { dx, dy };
}

function newPathObj(path, name, style) {
  return { type: 'path', id: newId(), name, subpaths: path.subpaths, style: structuredClone(style || settings.style) };
}

const label = (v) => `${fmt(toUnits(v, S.doc.units), UNITS[S.doc.units].digits)}`;

// ------------------------------------------------------------ the tools
const DOWN = {};

// ---- selection
DOWN.select = (e, p, d) => {
  const h = handleAt(p);
  if (h != null) return startScale(e, p, h);
  if (rotateZone(p)) return startRotate(e, p);
  const id = hitId(e);
  if (!id) {
    if (!e.shiftKey) setSel([]);
    return startMarquee(e, p, false);
  }
  const top = topOf(S.doc, id).id;
  if (e.shiftKey) {
    setSel(S.sel.includes(top) ? S.sel.filter((x) => x !== top) : [...S.sel, top]);
    drag = { start: p };
    return;
  }
  if (!S.sel.includes(top)) setSel([top]);
  startMove(e, p, d);
};

function startMove(e, p, d) {
  let objs = selectedRoots();
  const box0 = boundsOf(objs);
  const boxes = otherBoxes(objs.map((o) => o.id));
  let snap0 = snapshot(objs);
  let copied = false;
  drag = {
    start: p,
    move: (ev, q, dq) => {
      if (!drag.moved && dist(q, p) <= 3) return;
      if (ev.altKey && !copied) {
        // Alt-drag: leave the originals and move copies
        copied = true;
        resetTo(snap0);
        const copies = [];
        for (const o of objs) {
          const loc = locate(S.doc, o.id);
          const c = clone(o);
          loc.list.splice(loc.index + 1, 0, c);
          copies.push(c);
        }
        objs = copies;
        snap0 = snapshot(objs);
        setSel(objs.map((o) => o.id));
      }
      let dx = dq.x - d.x, dy = dq.y - d.y;
      if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      if (box0) {
        if (settings.snapGrid) {
          const { minor } = gridStep();
          dx = Math.round((box0.x + dx) / minor) * minor - box0.x;
          dy = Math.round((box0.y + dy) / minor) * minor - box0.y;
        }
        ({ dx, dy } = smartSnap(box0, boxes, dx, dy));
      }
      resetTo(snap0);
      for (const o of objs) transformObject(o, translate(dx, dy));
      S.guides.push({ label: { x: q.x, y: q.y, text: `${ev.altKey ? 'copy  ' : ''}dX ${label(dx)}  dY ${label(dy)}` } });
      live();
    },
  };
  drag.up = () => { if (moved()) commit(copied ? 'Copy' : 'Move'); };
  const moved = () => snap0.some(({ o, orig }) => JSON.stringify(o.subpaths || o.matrix || o.children) !== JSON.stringify(orig.subpaths || orig.matrix || orig.children)) || copied;
}

function startScale(e, p, h) {
  const objs = selectedRoots();
  const b = boundsOf(objs);
  if (!b) return;
  const snap0 = snapshot(objs);
  const hp = handlePoints({ x: b.x, y: b.y, w: b.w, h: b.h });
  const opp = hp[(h + 4) % 8];
  const center = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const corner = h % 2 === 0;
  const hx = h === 1 || h === 5 ? null : hp[h][0], hy = h === 3 || h === 7 ? null : hp[h][1];
  drag = {
    start: p,
    move: (ev, q, dq) => {
      const a = ev.altKey ? center : { x: opp[0], y: opp[1] };
      dq = snap(dq, objs.map((o) => o.id));
      let sx = hx == null ? 1 : (dq.x - a.x) / ((hx - a.x) || 1e-9);
      let sy = hy == null ? 1 : (dq.y - a.y) / ((hy - a.y) || 1e-9);
      if (ev.shiftKey) {
        if (corner) { const s = Math.abs(sx) > Math.abs(sy) ? sx : sy; sx = Math.sign(sx || 1) * Math.abs(s); sy = Math.sign(sy || 1) * Math.abs(s); } else if (hx == null) sx = Math.abs(sy); else sy = Math.abs(sx);
      }
      const fix = (v) => (Math.abs(v) < 1e-4 ? 1e-4 * (Math.sign(v) || 1) : v);
      sx = fix(sx); sy = fix(sy);
      resetTo(snap0);
      const m = scaleAt(sx, sy, a.x, a.y);
      for (const o of objs) transformObject(o, m);
      S.guides = [{ label: { x: q.x, y: q.y, text: `W ${label(Math.abs(b.w * sx))}  H ${label(Math.abs(b.h * sy))}` } }];
      live();
    },
  };
  drag.up = (ev, q) => { if (dist(q, p) > 1) commit('Scale'); };
}

function startRotate(e, p) {
  const objs = selectedRoots();
  const b = boundsOf(objs);
  if (!b) return;
  const snap0 = snapshot(objs);
  const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const cs = toScreen(c);
  const a0 = Math.atan2(p.y - cs.y, p.x - cs.x);
  drag = {
    start: p,
    move: (ev, q) => {
      let a = Math.atan2(q.y - cs.y, q.x - cs.x) - a0;
      if (ev.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
      resetTo(snap0);
      for (const o of objs) transformObject(o, rotateAt(a, c.x, c.y));
      let deg = (-a * 180) / Math.PI;
      deg = ((deg % 360) + 540) % 360 - 180;
      S.guides = [{ label: { x: q.x, y: q.y, text: `${fmt(deg, 1)}°` } }];
      live();
    },
  };
  drag.up = (ev, q) => { if (dist(q, p) > 1) commit('Rotate'); };
}

function startMarquee(e, p, anchors, onDone) {
  S.marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  const before = [...S.sel];
  const add = e.shiftKey;
  drag = {
    start: p,
    move: (ev, q) => { S.marquee.x1 = q.x; S.marquee.y1 = q.y; },
    up: () => {
      const r = S.marquee;
      S.marquee = null;
      const a = toDoc(Math.min(r.x0, r.x1), Math.min(r.y0, r.y1)), b = toDoc(Math.max(r.x0, r.x1), Math.max(r.y0, r.y1));
      const box = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
      if (onDone) return onDone(box);
      if (box.w * S.zoom < 2 && box.h * S.zoom < 2) return;
      if (anchors) return selectAnchorsIn(box, add);
      const hit = editableTops().filter((o) => { const ob = bounds(o); return ob && ob.x <= box.x + box.w && box.x <= ob.x + ob.w && ob.y <= box.y + box.h && box.y <= ob.y + ob.h && touches(o, box); }).map((o) => o.id);
      setSel(add ? [...new Set([...before, ...hit])] : hit);
    },
  };
}

/** Does an object really reach into a box (not just its bounding box)? */
function touches(o, box) {
  if (o.type === 'group') return o.children.some((c) => touches(c, box));
  if (o.type !== 'path') return true;
  const inside = (q) => q.x >= box.x && q.x <= box.x + box.w && q.y >= box.y && q.y <= box.y + box.h;
  for (const sp of o.subpaths) for (const n of sp.nodes) if (inside(n)) return true;
  // an edge of the box crossing the path, or the box inside a filled shape
  const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const near = nearestOnPath(o, c);
  if (near && inside(near.pt)) return true;
  return !!o.style.fill;
}

function selectAnchorsIn(box, add) {
  const inside = (q) => q.x >= box.x && q.x <= box.x + box.w && q.y >= box.y && q.y <= box.y + box.h;
  if (!add) S.anchors.clear();
  const ids = add ? [...S.sel] : [];
  for (const top of editableTops()) for (const w of walk([top])) {
    const o = w.obj;
    if (o.type !== 'path' || o.hidden) continue;
    const set = S.anchors.get(o.id) || new Set();
    o.subpaths.forEach((sp, si) => sp.nodes.forEach((n, ni) => { if (inside(n)) set.add(`${si},${ni}`); }));
    if (set.size) { S.anchors.set(o.id, set); ids.push(o.id); }
  }
  setSel(ids, { anchors: true });
}

// ---- direct selection
/** Anchor or handle under a screen point among the selected paths. */
function anchorAt(p, handles = true) {
  const m = screenMatrix();
  let best = null, bd = 6;
  for (const o of selected()) {
    if (o.type !== 'path') continue;
    const sel = S.anchors.get(o.id) || new Set();
    o.subpaths.forEach((sp, si) => sp.nodes.forEach((n, ni) => {
      const consider = (pt, kind) => {
        const s = apply(m, pt), d = Math.hypot(s.x - p.x, s.y - p.y);
        if (d < bd || (d === bd && kind === 'node')) { bd = d; best = { o, si, ni, kind }; }
      };
      consider(n, 'node');
      if (handles) {
        const len = sp.nodes.length;
        const near = sel.has(`${si},${ni}`) || sel.has(`${si},${(ni + 1) % len}`) || sel.has(`${si},${(ni - 1 + len) % len}`);
        if (near || (S.pen && S.pen.id === o.id)) { if (n.in) consider(n.in, 'in'); if (n.out) consider(n.out, 'out'); }
      }
    }));
  }
  return best;
}

DOWN.direct = (e, p, d) => {
  const a = anchorAt(p);
  if (a && a.kind !== 'node') return startHandleDrag(a, p);
  if (a) {
    const key = `${a.si},${a.ni}`;
    const set = S.anchors.get(a.o.id) || new Set();
    if (e.shiftKey) { if (set.has(key)) set.delete(key); else set.add(key); } else if (!set.has(key)) { S.anchors.clear(); set.clear(); set.add(key); }
    S.anchors.set(a.o.id, set);
    if (!e.shiftKey) for (const k of [...S.anchors.keys()]) if (!S.sel.includes(k)) S.anchors.delete(k);
    setSel(e.shiftKey ? [...new Set([...S.sel, a.o.id])] : [...new Set([...S.sel.filter((x) => S.anchors.has(x)), a.o.id])], { anchors: true });
    return startAnchorDrag(p, d, a);
  }
  const id = hitId(e);
  if (!id) {
    if (!e.shiftKey) { S.anchors.clear(); setSel([]); }
    return startMarquee(e, p, true);
  }
  if (e.shiftKey) {
    setSel(S.sel.includes(id) ? S.sel.filter((x) => x !== id) : [...S.sel, id], { anchors: true });
    drag = { start: p };
    return;
  }
  if (!S.sel.includes(id)) { S.anchors.clear(); setSel([id]); }
  // drag the whole path (or text/image)
  startMove(e, p, d);
};

function startAnchorDrag(p, d, a) {
  const targets = [];
  for (const [id, set] of S.anchors) {
    const o = locate(S.doc, id)?.obj;
    if (!o || o.type !== 'path') continue;
    for (const k of set) {
      const [si, ni] = k.split(',').map(Number);
      const n = o.subpaths[si]?.nodes[ni];
      if (n) targets.push({ n, orig: structuredClone(n) });
    }
  }
  const main = a.o.subpaths[a.si].nodes[a.ni];
  const main0 = { x: main.x, y: main.y };
  const exclude = [a.o.id];
  drag = {
    start: p,
    targets: snapTargets(exclude).filter((q) => !targets.some((t) => t.n === q)),
    move: (ev, q, dq) => {
      if (!drag.moved && dist(q, p) <= 3) return;
      let target = { x: main0.x + dq.x - d.x, y: main0.y + dq.y - d.y };
      target = snap(target, exclude);
      let dx = target.x - main0.x, dy = target.y - main0.y;
      if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      for (const t of targets) {
        t.n.x = t.orig.x + dx; t.n.y = t.orig.y + dy;
        t.n.in = t.orig.in && { x: t.orig.in.x + dx, y: t.orig.in.y + dy };
        t.n.out = t.orig.out && { x: t.orig.out.x + dx, y: t.orig.out.y + dy };
      }
      live();
    },
  };
  drag.up = () => { if (drag === null && targets.some((t) => t.n.x !== t.orig.x || t.n.y !== t.orig.y)) commit('Move anchor'); };
}

function startHandleDrag(a, p) {
  const n = a.o.subpaths[a.si].nodes[a.ni];
  const orig = structuredClone(n);
  const other = a.kind === 'in' ? 'out' : 'in';
  const otherLen = n[other] ? dist(n, n[other]) : 0;
  drag = {
    start: p,
    move: (ev, q, dq) => {
      n[a.kind] = { x: dq.x, y: dq.y };
      if (ev.altKey) n.smooth = false;
      else if ((n.smooth || orig.smooth) && n[other]) {
        const dx = n.x - dq.x, dy = n.y - dq.y, l = Math.hypot(dx, dy) || 1;
        n[other] = { x: n.x + (dx / l) * otherLen, y: n.y + (dy / l) * otherLen };
      }
      live();
    },
  };
  drag.up = () => { if (JSON.stringify(n) !== JSON.stringify(orig)) commit('Move handle'); };
}

// ---- pen
DOWN.pen = (e, p, d) => {
  if (S.pen) {
    const o = locate(S.doc, S.pen.id)?.obj;
    const sp = o?.subpaths[S.pen.si];
    if (!sp) { S.pen = null; return DOWN.pen(e, p, d); }
    const first = sp.nodes[0];
    const fs = toScreen(first);
    if (sp.nodes.length > 1 && Math.hypot(fs.x - p.x, fs.y - p.y) < 8) {
      sp.closed = true;
      return penDrag(first, p, () => { S.pen = null; S.preview = null; commit('Close path'); });
    }
    const q = snap(d, [o.id]);
    let pt = q;
    if (e.shiftKey) {
      const last = sp.nodes[sp.nodes.length - 1];
      const ang = Math.round(Math.atan2(d.y - last.y, d.x - last.x) / (Math.PI / 4)) * (Math.PI / 4);
      const len = dist(last, d);
      pt = { x: last.x + Math.cos(ang) * len, y: last.y + Math.sin(ang) * len };
    }
    const n = { x: pt.x, y: pt.y, in: null, out: null };
    sp.nodes.push(n);
    live();
    return penDrag(n, p, () => commit('Add anchor'));
  }
  // continue an open path from one of its ends, or edit a selected path
  for (const o of selected()) {
    if (o.type !== 'path' || !isEditable(o.id)) continue;
    for (let si = 0; si < o.subpaths.length; si++) {
      const sp = o.subpaths[si];
      if (sp.closed || !sp.nodes.length) continue;
      for (const end of [sp.nodes.length - 1, 0]) {
        const s = toScreen(sp.nodes[end]);
        if (Math.hypot(s.x - p.x, s.y - p.y) < 7) {
          if (end === 0 && sp.nodes.length > 1) sp.nodes = reverseNodes(sp.nodes);
          S.pen = { id: o.id, si };
          setSel([o.id], { anchors: true });
          status('Continuing the path. Enter or Esc to finish.');
          drag = { start: p };
          return;
        }
      }
    }
  }
  const a = anchorAt(p, false);
  if (a) {
    deleteAnchor(a.o, a.si, a.ni);
    drag = { start: p };
    return;
  }
  const sel = selected().filter((o) => o.type === 'path');
  for (const o of sel) {
    const near = nearestOnPath(o, d);
    if (near && near.d * S.zoom < 5) {
      insertAnchor(o.subpaths[near.sub], near.seg, near.t);
      commit('Add anchor');
      drag = { start: p };
      return;
    }
  }
  // a new path
  const q = snap(d);
  const n = { x: q.x, y: q.y, in: null, out: null };
  const o = newPathObj({ subpaths: [{ closed: false, nodes: [n] }] }, 'Path', { ...settings.style, fill: null });
  targetLayer().children.push(o);
  S.pen = { id: o.id, si: 0 };
  setSel([o.id], { anchors: true });
  live();
  penDrag(n, p, () => { /* committed when the path is finished or grows */ });
};

function penDrag(n, p, done) {
  drag = {
    start: p,
    move: (ev, q, dq) => {
      if (dist(q, p) < 3) return;
      n.out = { x: dq.x, y: dq.y };
      n.in = { x: 2 * n.x - dq.x, y: 2 * n.y - dq.y };
      n.smooth = true;
      live();
    },
  };
  drag.up = done;
}

export function finishPen() {
  if (!S.pen) return;
  const loc = locate(S.doc, S.pen.id);
  S.pen = null;
  S.preview = null;
  if (loc) {
    const o = loc.obj;
    o.subpaths = o.subpaths.filter((sp) => sp.nodes.length > 1);
    if (!o.subpaths.length) loc.list.splice(loc.index, 1);
    commit('Pen');
  }
  requestRender('overlay');
}

function deleteAnchor(o, si, ni) {
  const sp = o.subpaths[si];
  sp.nodes.splice(ni, 1);
  if (sp.nodes.length < 2) o.subpaths.splice(si, 1);
  if (sp.closed && sp.nodes.length === 2) sp.closed = false;
  S.anchors.delete(o.id);
  if (!o.subpaths.length) {
    const loc = locate(S.doc, o.id);
    loc.list.splice(loc.index, 1);
  }
  commit('Delete anchor');
}

DOWN['add-anchor'] = (e, p, d) => {
  const id = hitId(e);
  const cands = id ? [locate(S.doc, id).obj] : selected();
  for (const o of cands) {
    if (o.type !== 'path') continue;
    const near = nearestOnPath(o, d);
    if (near && near.d * S.zoom < 7) {
      const ni = insertAnchor(o.subpaths[near.sub], near.seg, near.t);
      if (!S.sel.includes(o.id)) setSel([o.id]);
      S.anchors.set(o.id, new Set([`${near.sub},${ni}`]));
      commit('Add anchor');
      drag = { start: p };
      return;
    }
  }
  status('Click on a path to add an anchor.');
};

DOWN['del-anchor'] = (e, p) => {
  const id = hitId(e);
  if (id && !S.sel.includes(id)) setSel([id]);
  const a = anchorAt(p, false);
  if (a) deleteAnchor(a.o, a.si, a.ni);
  drag = { start: p };
};

DOWN.convert = (e, p, d) => {
  const id = hitId(e);
  const a = anchorAt(p, true);
  if (!a) {
    if (id) setSel([id]);
    drag = { start: p };
    return;
  }
  if (a.kind !== 'node') return startHandleDrag({ ...a }, p);
  const n = a.o.subpaths[a.si].nodes[a.ni];
  const orig = structuredClone(n);
  drag = {
    start: p,
    move: (ev, q, dq) => {
      if (dist(q, p) < 3) return;
      n.out = { x: dq.x, y: dq.y };
      n.in = { x: 2 * n.x - dq.x, y: 2 * n.y - dq.y };
      n.smooth = true;
      live();
    },
  };
  drag.up = () => {
    if (JSON.stringify(n) === JSON.stringify(orig)) convertAnchor(a.o.subpaths[a.si], a.ni);
    S.anchors.set(a.o.id, new Set([`${a.si},${a.ni}`]));
    commit('Convert anchor');
  };
};

// ---- pencil
DOWN.pencil = (e, p, d) => {
  const pts = [snap(d)];
  const style = { ...settings.style, fill: null };
  const o = newPathObj({ subpaths: [{ closed: false, nodes: [] }] }, 'Pencil', style);
  targetLayer().children.push(o);
  drag = {
    start: p,
    move: (ev, q, dq) => {
      const last = pts[pts.length - 1];
      if (dist(last, dq) * S.zoom < 1.5) return;
      pts.push(dq);
      o.subpaths[0].nodes = pts.map((x) => ({ x: x.x, y: x.y, in: null, out: null }));
      live();
    },
  };
  drag.up = () => {
    const loc = locate(S.doc, o.id);
    if (pts.length < 2) { loc.list.splice(loc.index, 1); live(); return; }
    const end = pts[pts.length - 1];
    const closed = pts.length > 4 && dist(pts[0], end) * S.zoom < 12;
    const smooth = Math.max(0, Math.min(100, settings.smooth));
    let simple = simplify(pts, (0.6 + smooth / 25) / S.zoom);
    if (closed && simple.length > 2) simple = simple.slice(0, -1);
    o.subpaths = [{ closed, nodes: smooth > 0 ? smoothNodes(simple, closed) : simple.map((x) => ({ x: x.x, y: x.y, in: null, out: null })) }];
    setSel([o.id]);
    commit('Pencil');
  };
};

// ---- shapes
function shapeTool(kind) {
  return (e, p, d) => {
    const a = snap(d);
    let o = null;
    const makeName = { line: 'Line', rect: 'Rectangle', rrect: 'Rounded Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', star: 'Star' }[kind];
    drag = {
      start: p,
      move: (ev, q, dq) => {
        if (!o && dist(q, p) < 3) return;
        const b = ev.shiftKey && (kind === 'line') ? dq : snap(dq);
        const path = shapePath(kind, a, b, ev);
        if (!o) {
          o = newPathObj(path, makeName, kind === 'line' ? { ...settings.style, fill: null } : settings.style);
          targetLayer().children.push(o);
          setSel([o.id]);
        } else o.subpaths = path.subpaths;
        const bb = bounds(o);
        S.guides = [{ label: { x: q.x, y: q.y, text: kind === 'line' ? `L ${label(dist(a, b))}  ${fmt((-Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI, 1)}°` : `W ${label(bb.w)}  H ${label(bb.h)}` } }];
        live();
      },
    };
    drag.up = () => {
      if (o) return commit(makeName);
      shapeDialog(kind, a);
    };
  };
}

function shapePath(kind, a, b, ev) {
  let dx = b.x - a.x, dy = b.y - a.y;
  if (kind === 'line') {
    let e = b;
    if (ev.shiftKey) {
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
      e = { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
    }
    return { subpaths: [{ closed: false, nodes: [{ x: a.x, y: a.y, in: null, out: null }, { x: e.x, y: e.y, in: null, out: null }] }] };
  }
  if (kind === 'polygon' || kind === 'star') {
    const r = Math.hypot(dx, dy);
    const rot = ev.shiftKey ? -Math.PI / 2 : Math.atan2(dy, dx);
    return kind === 'polygon' ? polygonPath(a.x, a.y, r, Math.max(3, settings.sides | 0), rot) : starPath(a.x, a.y, r, Math.max(3, settings.points | 0), settings.inner / 100, rot);
  }
  if (ev.shiftKey) { const s = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * s; dy = Math.sign(dy || 1) * s; }
  let x = a.x, y = a.y, w = dx, h = dy;
  if (ev.altKey) { x = a.x - dx; y = a.y - dy; w = dx * 2; h = dy * 2; }
  if (kind === 'ellipse') return ellipsePath(x + w / 2, y + h / 2, w / 2, h / 2);
  return rectPath(x, y, w, h, kind === 'rrect' ? settings.radius : 0);
}

async function shapeDialog(kind, a) {
  const { ask } = await import('./ui.js');
  const u = S.doc.units, dg = UNITS[u].digits + 1;
  const v = (px) => +fmt(toUnits(px, u), dg);
  let fields;
  if (kind === 'line') fields = [{ id: 'len', label: `Length (${u})`, value: v(96), type: 'number' }, { id: 'ang', label: 'Angle (°)', value: 0, type: 'number' }];
  else if (kind === 'polygon') fields = [{ id: 'r', label: `Radius (${u})`, value: v(48), type: 'number' }, { id: 'n', label: 'Sides', value: settings.sides, type: 'number' }];
  else if (kind === 'star') fields = [{ id: 'r', label: `Radius 1 (${u})`, value: v(48), type: 'number' }, { id: 'r2', label: `Radius 2 (${u})`, value: v(24), type: 'number' }, { id: 'n', label: 'Points', value: settings.points, type: 'number' }];
  else {
    fields = [{ id: 'w', label: `Width (${u})`, value: v(96), type: 'number' }, { id: 'h', label: `Height (${u})`, value: v(96), type: 'number' }];
    if (kind === 'rrect') fields.push({ id: 'r', label: `Corner radius (${u})`, value: v(settings.radius), type: 'number' });
  }
  const name = { line: 'Line Segment', rect: 'Rectangle', rrect: 'Rounded Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', star: 'Star' }[kind];
  const r = await ask(name, fields);
  if (!r) return;
  const P = (x) => fromUnits(+x || 0, u);
  let path;
  if (kind === 'line') {
    const ang = (-(+r.ang || 0) * Math.PI) / 180, len = P(r.len);
    path = { subpaths: [{ closed: false, nodes: [{ x: a.x, y: a.y, in: null, out: null }, { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len, in: null, out: null }] }] };
  } else if (kind === 'polygon') path = polygonPath(a.x, a.y, P(r.r), Math.max(3, +r.n | 0));
  else if (kind === 'star') path = starPath(a.x, a.y, P(r.r), Math.max(3, +r.n | 0), P(r.r2) / (P(r.r) || 1));
  else if (kind === 'ellipse') path = ellipsePath(a.x + P(r.w) / 2, a.y + P(r.h) / 2, P(r.w) / 2, P(r.h) / 2);
  else path = rectPath(a.x, a.y, P(r.w), P(r.h), kind === 'rrect' ? P(r.r) : 0);
  const o = newPathObj(path, name, kind === 'line' ? { ...settings.style, fill: null } : settings.style);
  targetLayer().children.push(o);
  setSel([o.id]);
  commit(name);
}

for (const k of ['line', 'rect', 'rrect', 'ellipse', 'polygon', 'star']) DOWN[k] = shapeTool(k);

// ---- type
DOWN.text = (e, p, d) => {
  const id = hitId(e);
  if (id && locate(S.doc, id).obj.type === 'text') {
    setSel([id]);
    drag = { start: p, up: () => editText(id) };
    return;
  }
  const q = snap(d);
  const o = {
    type: 'text', id: newId(), name: 'Text', text: '', font: settings.font, size: settings.fontSize, weight: settings.fontWeight,
    italic: false, align: settings.align, matrix: [1, 0, 0, 1, q.x, q.y], style: { ...settings.style, fill: textFill(), stroke: null, strokeWidth: 0 },
  };
  targetLayer().children.push(o);
  setSel([o.id]);
  live();
  drag = { start: p, up: () => editText(o.id, true) };
};

let editStart = null;
export function editText(id, fresh = false) {
  finishText();
  const loc = locate(S.doc, id);
  if (!loc || loc.obj.type !== 'text') return;
  const o = loc.obj;
  S.editing = id;
  editStart = fresh ? null : o.text;
  const ta = document.getElementById('text-editor');
  ta.value = o.text;
  ta.hidden = false;
  placeEditor();
  requestRender('all');
  setTimeout(() => { ta.focus(); if (!fresh) ta.select(); }, 0);
}

export function placeEditor() {
  if (!S.editing) return;
  const o = locate(S.doc, S.editing)?.obj;
  const ta = document.getElementById('text-editor');
  if (!o) return;
  const m = o.matrix;
  const k = Math.hypot(m[2], m[3]) * S.zoom;
  const lb = textLocalBox(o);
  const tl = toScreen(apply(m, { x: lb.x, y: lb.y }));
  ta.style.font = fontCss({ ...o, size: o.size * k });
  ta.style.lineHeight = '1.2';
  ta.style.textAlign = o.align;
  ta.style.color = typeof o.style.fill === 'string' ? o.style.fill : '#000';
  const lines = ta.value.split('\n');
  ta.style.height = `${Math.max(1, lines.length) * o.size * k * 1.2 + 4}px`;
  ta.style.width = '10px';
  const w = Math.max(30, ta.scrollWidth + o.size * k);
  ta.style.width = `${w}px`;
  const anchor = toScreen(apply(m, { x: 0, y: 0 }));
  const left = o.align === 'center' ? anchor.x - w / 2 : o.align === 'right' ? anchor.x - w : anchor.x;
  ta.style.left = `${left}px`;
  ta.style.top = `${tl.y - o.size * k * 0.08}px`;
}

export function finishText() {
  if (!S.editing) return;
  const ta = document.getElementById('text-editor');
  const id = S.editing;
  S.editing = null;
  ta.hidden = true;
  const loc = locate(S.doc, id);
  if (!loc) return;
  loc.obj.text = ta.value;
  if (!ta.value.trim()) {
    loc.list.splice(loc.index, 1);
    if (editStart !== null) commit('Delete text');
    else live();
    setSel(S.sel.filter((x) => x !== id));
  } else if (ta.value !== editStart) commit('Type');
  else live();
  els.stage.focus?.();
}

export function initTextEditor() {
  const ta = document.getElementById('text-editor');
  ta.addEventListener('input', () => {
    const o = locate(S.doc, S.editing)?.obj;
    if (o) { o.text = ta.value; placeEditor(); emit('textlive'); }
  });
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); finishText(); }
  });
  ta.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ta) finishText(); }, 0));
}

// ---- eyedropper
DOWN.eyedropper = (e, p) => {
  drag = { start: p };
  const id = hitId(e);
  if (!id) return;
  const src = locate(S.doc, id).obj;
  if (!src.style) return;
  const pick = (({ fill, stroke, strokeWidth, dash, cap, join, opacity }) => ({ fill, stroke, strokeWidth, dash, cap, join, opacity }))(src.style);
  const targets = selected().filter((o) => o.id !== id);
  const paint = (o) => {
    if (o.type === 'group') return o.children.forEach(paint);
    if (o.type === 'image') return;
    Object.assign(o.style, structuredClone(pick));
  };
  targets.forEach(paint);
  settings.style = { ...settings.style, ...structuredClone(pick) };
  saveSettings();
  if (targets.length) commit('Eyedropper'); else { emit('selection'); status('Picked the fill and stroke for new shapes.'); }
};

// ---- zoom
DOWN.zoom = (e, p) => {
  if (e.altKey) { zoomStep(-1, p.x, p.y); drag = { start: p }; return; }
  startMarquee(e, p, false, (box) => {
    if (box.w * S.zoom < 5 || box.h * S.zoom < 5) zoomStep(1, p.x, p.y);
    else fitBox(box);
  });
};

export { renderNow };

/** Text takes the current fill, unless that is white or none (it would vanish on the artboard). */
function textFill() {
  const f = settings.style.fill;
  return typeof f === 'string' && !/^#fff(fff)?$/i.test(f) ? f : '#1c1e21';
}
