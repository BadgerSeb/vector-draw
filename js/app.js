// Vector Draw: start-up, menus, keyboard shortcuts, opening and saving files.

import { S, settings, saveSettings, on, emit, commit, restore, setSel, selected, targetLayer, status } from './state.js';
import { newDocument, adoptDocument, UNITS, PRESETS, toUnits, fromUnits, newId, boundsOf, transformObject, walk, locate } from './doc.js';
import { initView, fitArtboard, fitBox, zoomStep, zoomAt, requestRender, renderNow, stageSize, els, onRendered } from './view.js';
import { initTools, setTool, finishPen, finishText, setSpaceHand, TOOLS, editText, placeEditor } from './tools.js';
import { initTextEditor } from './tools.js';
import { initPanels, buildOptions, swapFillStroke } from './panels.js';
import { ask, message, saveFile, isDialogOpen, h } from './ui.js';
import * as ops from './ops.js';
import { importSvg, importDxf, importImage, parseVdraw } from './io/import.js';
import { exportPdf, exportPng, exportDxf, exportVdraw, maxDpi } from './io/export.js';
import { exportSvg } from './render.js';
import { fmt, translate } from './geom.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ start
function start() {
  S.doc = newDocument(8.5 * 96, 11 * 96, settings.units || 'in');
  const p = PRESETS.find((x) => x.name === settings.lastPreset);
  if (p) { S.doc.width = fromUnits(p.w, p.units); S.doc.height = fromUnits(p.h, p.units); }
  S.activeLayer = S.doc.layers[0].id;
  S.history.reset(S.doc);
  initView();
  initTools();
  initTextEditor();
  initPanels();
  buildMenus();
  initKeys();
  initFiles();
  initStatus();
  on('doc', () => { updateTitle(); placeEditor(); });
  on('settings', () => requestRender('all'));
  on('command', (c) => COMMANDS[c]?.());
  updateTitle();
  requestAnimationFrame(() => { fitArtboard(); renderNow(); });
  registerServiceWorker();
  initLaunchQueue();
  window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
}

function updateTitle() {
  $('docname').innerHTML = `<b>${escapeHtml(S.fileName)}</b>${S.dirty ? ' · not saved' : ''}`;
  document.title = `${S.fileName}${S.dirty ? ' •' : ''} — Vector Draw`;
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------------------ status bar
function initStatus() {
  const pos = $('st-pos'), zoom = $('st-zoom'), size = $('st-size'), msg = $('st-msg'), sel = $('st-sel');
  const u = () => S.doc.units;
  const d = () => UNITS[u()].digits;
  on('cursor', (p) => { pos.textContent = p ? `X ${fmt(toUnits(p.x, u()), d())}  Y ${fmt(toUnits(p.y, u()), d())} ${u()}` : ''; });
  onRendered(() => {
    zoom.textContent = `${fmt(S.zoom * 100, 1)}%`;
    size.textContent = `Artboard ${fmt(toUnits(S.doc.width, u()), d())} × ${fmt(toUnits(S.doc.height, u()), d())} ${u()}`;
    const objs = selected();
    if (!objs.length) sel.textContent = 'Nothing selected';
    else {
      const b = boundsOf(objs);
      const anchors = [...S.anchors.values()].reduce((n, s) => n + s.size, 0);
      sel.textContent = `${objs.length} selected${anchors ? `, ${anchors} anchor${anchors > 1 ? 's' : ''}` : ''}${b ? `  ·  ${fmt(toUnits(b.w, u()), d())} × ${fmt(toUnits(b.h, u()), d())} ${u()}` : ''}`;
    }
  });
  let t = 0;
  on('status', ({ msg: m, kind }) => {
    msg.textContent = m;
    msg.className = `st msg ${kind}`;
    clearTimeout(t);
    t = setTimeout(() => { msg.textContent = ''; }, 6000);
  });
}

// ------------------------------------------------------------ commands
const hasSel = () => S.sel.length > 0;
const COMMANDS = {
  new: () => newDoc(),
  open: () => pickFiles('.vdraw,.svg,.dxf,.png,.jpg,.jpeg,.gif,.webp,.bmp', false, openFile),
  place: () => pickFiles('.svg,.dxf,.png,.jpg,.jpeg,.gif,.webp,.bmp', true, placeFiles),
  save: () => save(false),
  saveAs: () => save(true),
  exportSvg: () => doExport('svg'),
  exportPdf: () => doExport('pdf'),
  exportPng: () => doExport('png'),
  exportDxf: () => doExport('dxf'),
  setup: () => docSetup(),
  undo: () => { finishText(); finishPen(); const d = S.history.undo(); if (d) { restore(d); status(`Undid ${S.history.label(true) || 'the last change'}.`); } },
  redo: () => { const d = S.history.redo(); if (d) { restore(d); status(`Redid ${S.history.label() || 'the change'}.`); } },
  cut: () => ops.copy(true),
  copy: () => ops.copy(false),
  paste: () => ops.paste(false),
  pasteInPlace: () => ops.paste(true),
  duplicate: () => ops.duplicate(),
  delete: () => deleteKey(),
  selectAll: () => ops.selectAll(),
  deselect: () => { S.anchors.clear(); setSel([]); },
  group: () => ops.group(),
  ungroup: () => ops.ungroup(),
  front: () => ops.arrange('front'), forward: () => ops.arrange('forward'), backward: () => ops.arrange('backward'), back: () => ops.arrange('back'),
  flipH: () => ops.flip(true), flipV: () => ops.flip(false),
  rotCW: () => ops.rotateBy(-90), rotCCW: () => ops.rotateBy(90),
  rotate: async () => { const r = await ask('Rotate', [{ id: 'a', label: 'Angle (°, counter-clockwise)', value: 45, type: 'number' }]); if (r && isFinite(r.a)) ops.rotateBy(r.a); },
  move: async () => {
    const u = S.doc.units;
    const r = await ask('Move', [{ id: 'x', label: `Horizontal (${u})`, value: 0, type: 'number' }, { id: 'y', label: `Vertical (${u}, down)`, value: 0, type: 'number' }, { id: 'copy', label: 'Move a copy', value: false, type: 'checkbox' }]);
    if (!r) return;
    if (r.copy) ops.duplicate();
    const objs = selectedRootsForCommands();
    for (const o of objs) transformObject(o, translate(fromUnits(r.x || 0, u) - (r.copy ? ops.nudgeStep() * 2 : 0), fromUnits(r.y || 0, u) - (r.copy ? ops.nudgeStep() * 2 : 0)));
    commit('Move');
  },
  scale: async () => {
    const r = await ask('Scale', [{ id: 'x', label: 'Horizontal %', value: 100, type: 'number' }, { id: 'y', label: 'Vertical %', value: 100, type: 'number' }]);
    if (!r) return;
    const b = boundsOf(selected());
    if (!b) return;
    const c = ops.refPoint(b);
    const { scaleAt } = await import('./geom.js');
    for (const o of selectedRootsForCommands()) transformObject(o, scaleAt((r.x || 100) / 100, (r.y || 100) / 100, c.x, c.y));
    commit('Scale');
  },
  lock: () => ops.lockSel(), unlockAll: () => ops.unlockAll(), hide: () => ops.hideSel(), showAll: () => ops.showAll(),
  unite: () => ops.pathfinder('unite'), minus: () => ops.pathfinder('minus'), intersect: () => ops.pathfinder('intersect'), exclude: () => ops.pathfinder('exclude'),
  offset: async () => {
    if (!hasSel()) return status('Select a shape first.');
    const u = S.doc.units;
    const r = await ask('Offset Path', [
      { id: 'd', label: `Offset (${u})`, value: fmt(toUnits(settings.offset, u), UNITS[u].digits + 2), type: 'number', suffix: 'negative shrinks' },
      { id: 'join', label: 'Corners', type: 'select', value: settings.offsetJoin, options: [['round', 'Round'], ['miter', 'Miter (sharp)'], ['square', 'Square (beveled)']] },
      { type: 'info', html: '<p>Makes a new outline this far outside (or inside, when negative) the shape, e.g. half the kerf for a cutting path. Curves come out as fine straight segments.</p>' },
    ]);
    if (!r || !isFinite(r.d) || r.d === 0) return;
    settings.offset = fromUnits(r.d, u);
    settings.offsetJoin = r.join;
    saveSettings();
    ops.offset(settings.offset, r.join);
  },
  join: () => ops.join(),
  reverse: () => ops.reversePath(),
  compound: () => ops.makeCompound(),
  release: () => ops.releaseCompound(),
  outline: () => ops.outlineObject(),
  roundCorners: async () => {
    const u = S.doc.units;
    const r = await ask('Round Corners', [{ id: 'r', label: `Radius (${u})`, value: fmt(toUnits(settings.radius, u), 4), type: 'number' }]);
    if (r && r.r > 0) ops.roundCorners(fromUnits(r.r, u));
  },
  editText: () => { const t = selected().find((o) => o.type === 'text'); if (t) editText(t.id); },
  zoomIn: () => zoomStep(1), zoomOut: () => zoomStep(-1),
  fit: () => fitArtboard(),
  fitSel: () => fitBox(boundsOf(selected())),
  actual: () => { const s = stageSize(); zoomAt(1, s.w / 2, s.h / 2); },
  rulers: () => toggle('rulers'), grid: () => toggle('grid'), snapGrid: () => toggle('snapGrid'), snapPoints: () => toggle('snapPoints'), smart: () => toggle('smart'),
  gridSetup: () => gridSetup(),
  addLayer: () => ops.addLayer(),
  shortcuts: () => shortcuts(),
  about: () => message('About Vector Draw', `<p><b>Vector Draw</b> — drawing, cut files and layouts to scale, for Badger Metal &amp; Machine Fabrication.</p><p>Everything runs in this browser window; your files never leave this computer. It works offline once opened and can be installed as an app from the browser's address bar.</p><p>Uses pdf-lib (MIT) and Clipper by Angus Johnson (Boost licence).</p>`),
  swapColors: () => swapFillStroke(),
  defaultColors: () => ops.setStyle({ fill: '#ffffff', stroke: '#1c1e21', strokeWidth: 1 }, 'Default colors'),
};
function selectedRootsForCommands() {
  const objs = selected();
  const inside = new Set();
  for (const o of objs) if (o.children) for (const w of walk(o.children)) inside.add(w.obj.id);
  return objs.filter((o) => !inside.has(o.id));
}

function toggle(key) {
  settings[key] = !settings[key];
  saveSettings();
  buildOptions();
  requestRender('all');
  status(`${{ rulers: 'Rulers', grid: 'Grid', snapGrid: 'Snap to grid', snapPoints: 'Snap to points', smart: 'Smart guides' }[key]} ${settings[key] ? 'on' : 'off'}.`);
}

function deleteKey() {
  // with anchors picked by the Direct Selection tool, delete just those
  if (S.tool !== 'select' && S.anchors.size) {
    for (const [id, set] of S.anchors) {
      const o = locate(S.doc, id)?.obj;
      if (!o) continue;
      const keep = o.subpaths.map((sp, si) => ({ ...sp, nodes: sp.nodes.filter((_, ni) => !set.has(`${si},${ni}`)) })).filter((sp) => sp.nodes.length > 1);
      keep.forEach((sp) => { if (sp.closed && sp.nodes.length < 3) sp.closed = false; });
      if (keep.length) o.subpaths = keep;
      else { const l = locate(S.doc, id); l.list.splice(l.index, 1); }
    }
    S.anchors.clear();
    setSel([]);
    return commit('Delete anchors');
  }
  ops.deleteSel();
}

// ------------------------------------------------------------ menus
const M = (label, cmd, key, opts = {}) => ({ label, cmd, key, ...opts });
const MENUS = [
  ['File', [
    M('New…', 'new', 'Ctrl+N'), M('Open…', 'open', 'Ctrl+O'), M('Place…', 'place', 'Ctrl+Shift+P', { title: 'Bring SVG, DXF or pictures into this document' }), '-',
    M('Save', 'save', 'Ctrl+S'), M('Save As…', 'saveAs', 'Ctrl+Shift+S'), '-',
    { heading: 'Export' }, M('SVG…', 'exportSvg', 'Ctrl+E'), M('PDF…', 'exportPdf'), M('PNG picture…', 'exportPng'), M('DXF (to scale)…', 'exportDxf'), '-',
    M('Document Setup…', 'setup', 'Ctrl+Alt+P'),
  ]],
  ['Edit', [
    M('Undo', 'undo', 'Ctrl+Z', { enabled: () => S.history.canUndo, label2: () => S.history.label() }), M('Redo', 'redo', 'Ctrl+Shift+Z', { enabled: () => S.history.canRedo }), '-',
    M('Cut', 'cut', 'Ctrl+X', { enabled: hasSel }), M('Copy', 'copy', 'Ctrl+C', { enabled: hasSel }), M('Paste', 'paste', 'Ctrl+V', { enabled: () => !!S.clip }), M('Paste in Place', 'pasteInPlace', 'Ctrl+Shift+V', { enabled: () => !!S.clip }),
    M('Duplicate', 'duplicate', 'Ctrl+D', { enabled: hasSel }), M('Delete', 'delete', 'Del', { enabled: hasSel }), '-',
    M('Select All', 'selectAll', 'Ctrl+A'), M('Deselect', 'deselect', 'Ctrl+Shift+A'), '-',
    M('Edit Text', 'editText', 'Enter', { enabled: () => selected().some((o) => o.type === 'text') }),
    M('Default Fill and Stroke', 'defaultColors', 'D'), M('Swap Fill and Stroke', 'swapColors', 'Shift+X'),
  ]],
  ['Object', [
    M('Group', 'group', 'Ctrl+G', { enabled: hasSel }), M('Ungroup', 'ungroup', 'Ctrl+Shift+G', { enabled: () => selected().some((o) => o.type === 'group') }), '-',
    { heading: 'Arrange' }, M('Bring to Front', 'front', 'Ctrl+Shift+]'), M('Bring Forward', 'forward', 'Ctrl+]'), M('Send Backward', 'backward', 'Ctrl+['), M('Send to Back', 'back', 'Ctrl+Shift+['), '-',
    { heading: 'Transform' }, M('Move…', 'move', 'Ctrl+Shift+M', { enabled: hasSel }), M('Rotate…', 'rotate', '', { enabled: hasSel }), M('Scale…', 'scale', '', { enabled: hasSel }),
    M('Rotate 90° Clockwise', 'rotCW', '', { enabled: hasSel }), M('Rotate 90° Counter-clockwise', 'rotCCW', '', { enabled: hasSel }),
    M('Flip Horizontal', 'flipH', '', { enabled: hasSel }), M('Flip Vertical', 'flipV', '', { enabled: hasSel }), '-',
    M('Lock Selection', 'lock', 'Ctrl+2', { enabled: hasSel }), M('Unlock All', 'unlockAll', 'Ctrl+Alt+2'), M('Hide Selection', 'hide', 'Ctrl+3', { enabled: hasSel }), M('Show All', 'showAll', 'Ctrl+Alt+3'),
  ]],
  ['Path', [
    { heading: 'Pathfinder' }, M('Unite', 'unite', '', { enabled: hasSel }), M('Minus Front', 'minus', '', { enabled: hasSel }), M('Intersect', 'intersect', '', { enabled: hasSel }), M('Exclude', 'exclude', '', { enabled: hasSel }), '-',
    M('Offset Path…', 'offset', '', { enabled: hasSel }), M('Round Corners…', 'roundCorners', '', { enabled: hasSel }), M('Join', 'join', 'Ctrl+J', { enabled: hasSel }), M('Reverse Direction', 'reverse', '', { enabled: hasSel }), '-',
    M('Make Compound Path', 'compound', 'Ctrl+8', { enabled: hasSel }), M('Release Compound Path', 'release', 'Ctrl+Alt+Shift+8', { enabled: hasSel }),
    M('Convert to Path', 'outline', 'Ctrl+Shift+O', { enabled: hasSel, title: 'Shapes are always editable paths; this turns text and picture boxes into paths' }),
  ]],
  ['View', [
    M('Zoom In', 'zoomIn', 'Ctrl+='), M('Zoom Out', 'zoomOut', 'Ctrl+-'), M('Fit Artboard in Window', 'fit', 'Ctrl+0'), M('Zoom to Selection', 'fitSel', 'Ctrl+Alt+0', { enabled: hasSel }), M('Actual Size', 'actual', 'Ctrl+1'), '-',
    M('Rulers', 'rulers', 'Ctrl+R', { check: () => settings.rulers }), M('Grid', 'grid', "Ctrl+'", { check: () => settings.grid }), M('Snap to Grid', 'snapGrid', "Ctrl+Shift+'", { check: () => settings.snapGrid }),
    M('Snap to Points', 'snapPoints', 'Ctrl+Alt+\'', { check: () => settings.snapPoints }), M('Smart Guides', 'smart', 'Ctrl+U', { check: () => settings.smart }), '-',
    M('Grid Settings…', 'gridSetup'),
  ]],
  ['Help', [M('Keyboard Shortcuts', 'shortcuts', 'F1'), M('About Vector Draw', 'about')]],
];

let openMenu = null;
function buildMenus() {
  const bar = $('menubar');
  const dd = $('dropdown');
  for (const [name, items] of MENUS) {
    const b = h('button', {}, name);
    b.onclick = (e) => { e.stopPropagation(); if (openMenu === b) closeMenu(); else showMenu(b, items); };
    b.onmouseenter = () => { if (openMenu && openMenu !== b) showMenu(b, items); };
    bar.append(b);
  }
  document.addEventListener('pointerdown', (e) => { if (openMenu && !dd.contains(e.target) && !bar.contains(e.target)) closeMenu(); });
}

function showMenu(btn, items) {
  closeMenu();
  const dd = $('dropdown');
  dd.innerHTML = '';
  for (const it of items) {
    if (it === '-') { dd.append(h('hr')); continue; }
    if (it.heading) { dd.append(h('div', { class: 'heading' }, it.heading)); continue; }
    const enabled = it.enabled ? it.enabled() : true;
    const b = h('button', { disabled: !enabled, title: it.title },
      h('span', { class: 'tick' }, it.check ? (it.check() ? '✓' : '') : ''),
      h('span', { class: 'label' }, it.label + (it.label2 && it.label2() ? ` ${it.label2()}` : '')), h('kbd', {}, it.key || ''));
    b.onclick = () => { closeMenu(); COMMANDS[it.cmd](); };
    dd.append(b);
  }
  const r = btn.getBoundingClientRect();
  dd.style.left = `${r.left}px`;
  dd.style.top = `${r.bottom + 2}px`;
  dd.hidden = false;
  btn.classList.add('open');
  openMenu = btn;
}
function closeMenu() {
  $('dropdown').hidden = true;
  openMenu?.classList.remove('open');
  openMenu = null;
}

// ------------------------------------------------------------ keyboard
function initKeys() {
  const typing = (e) => e.target.matches?.('input, textarea, select') || isDialogOpen();
  window.addEventListener('keydown', (e) => {
    if (typing(e)) return;
    const k = e.key, ctrl = e.ctrlKey || e.metaKey, sh = e.shiftKey, alt = e.altKey;
    const run = (c) => { e.preventDefault(); closeMenu(); COMMANDS[c](); };
    if (k === ' ' && !e.repeat) { setSpaceHand(true); e.preventDefault(); return; }
    if (ctrl) {
      const key = k.toLowerCase();
      if (key === 'z') return run(sh ? 'redo' : 'undo');
      if (key === 'y') return run('redo');
      if (key === 'n') return run('new');
      if (key === 'o') return run(sh ? 'outline' : 'open');
      if (key === 's') return run(sh ? 'saveAs' : 'save');
      if (key === 'e') return run('exportSvg');
      if (key === 'p' && sh) return run('place');
      if (key === 'p' && alt) return run('setup');
      if (key === 'a') return run(sh ? 'deselect' : 'selectAll');
      if (key === 'd') return run('duplicate');
      if (key === 'g') return run(sh ? 'ungroup' : 'group');
      if (key === 'j') return run('join');
      if (key === 'm' && sh) return run('move');
      if (k === ']' || k === '}' || e.code === 'BracketRight') return run(sh ? 'front' : 'forward');
      if (k === '[' || k === '{' || e.code === 'BracketLeft') return run(sh ? 'back' : 'backward');
      if (e.code === 'Digit2') return run(alt ? 'unlockAll' : 'lock');
      if (e.code === 'Digit3') return run(alt ? 'showAll' : 'hide');
      if (e.code === 'Digit8') return run(alt && sh ? 'release' : 'compound');
      if (e.code === 'Digit0') return run(alt ? 'fitSel' : 'fit');
      if (e.code === 'Digit1') return run('actual');
      if (k === '=' || k === '+') return run('zoomIn');
      if (k === '-' || k === '_') return run('zoomOut');
      if (key === 'r') return run('rulers');
      if (key === 'u') return run('smart');
      if (e.code === 'Quote') return run(sh ? 'snapGrid' : alt ? 'snapPoints' : 'grid');
      if (key === 'x') { if (ops.copy(true)) e.preventDefault(); return; }
      if (key === 'c') { ops.copy(false); return; } // the copy event puts SVG on the clipboard too
      if (key === 'v') { if (sh) return run('pasteInPlace'); return; } // handled by the paste event
      return;
    }
    if (k === 'F1') return run('shortcuts');
    if (k === 'Escape') {
      closeMenu();
      if (S.pen) return finishPen();
      S.anchors.clear();
      return setSel([]);
    }
    if (k === 'Enter') {
      if (S.pen) return finishPen();
      if (selected().length === 1 && selected()[0].type === 'text') { e.preventDefault(); return editText(selected()[0].id); }
      return;
    }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); if (S.pen) { finishPen(); return; } return deleteKey(); }
    if (k.startsWith('Arrow')) {
      e.preventDefault();
      const s = ops.nudgeStep(sh);
      const d = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[k];
      return ops.nudge(d[0], d[1]);
    }
    if (alt) return;
    if (sh && k.toLowerCase() === 'c') return setTool('convert');
    if (sh && k.toLowerCase() === 'x') return run('swapColors');
    if (!sh && k.toLowerCase() === 'd') return run('defaultColors');
    if (k === '+' || k === '=') return setTool('add-anchor');
    if (k === '-') return setTool('del-anchor');
    const t = TOOLS.find((x) => x.key && x.key !== 'C' && x.key === k.toLowerCase());
    if (t && !sh) setTool(t.id);
  });
  window.addEventListener('keyup', (e) => { if (e.key === ' ') setSpaceHand(false); });
  window.addEventListener('blur', () => setSpaceHand(false));

  // clipboard: SVG text out, pictures / SVG / text / our own objects in
  document.addEventListener('copy', (e) => {
    if (typing(e) || !S.clip) return;
    e.clipboardData.setData('text/plain', ops.copiedSvg());
    e.preventDefault();
  });
  document.addEventListener('cut', (e) => {
    if (typing(e) || !S.clip) return;
    e.clipboardData.setData('text/plain', ops.copiedSvg());
    e.preventDefault();
  });
  document.addEventListener('paste', async (e) => {
    if (typing(e)) return;
    e.preventDefault();
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) return placeFiles(files);
    const text = e.clipboardData?.getData('text/plain') || '';
    if (S.clip && (!text || text === ops.copiedSvg())) return ops.paste(false);
    if (/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) return placeSvgText(text, 'Pasted SVG');
    if (text.trim()) {
      const s = stageSize();
      const c = { x: (s.w / 2 - S.panX) / S.zoom, y: (s.h / 2 - S.panY) / S.zoom };
      const o = { type: 'text', id: newId(), name: 'Text', text: text.replace(/\r/g, ''), font: settings.font, size: settings.fontSize, weight: settings.fontWeight, italic: false, align: 'left', matrix: [1, 0, 0, 1, c.x, c.y], style: { ...settings.style, fill: '#1c1e21', stroke: null } };
      targetLayer().children.push(o);
      setSel([o.id]);
      commit('Paste text');
    } else if (S.clip) ops.paste(false);
  });
}

function shortcuts() {
  const rows = [
    ['V / A', 'Selection / Direct Selection'], ['P, +, −, Shift+C', 'Pen, add / delete anchor, convert anchor'], ['N', 'Pencil'], ['\\', 'Line'], ['M / L', 'Rectangle / Ellipse'],
    ['T', 'Type'], ['I', 'Eyedropper'], ['H, Space', 'Hand (hold Space at any time)'], ['Z', 'Zoom (Alt-click zooms out)'],
    ['Shift while dragging', 'Square / circle, 45° lines, proportional scaling, 15° rotation'], ['Alt while dragging', 'From the center; drag a copy'],
    ['Arrow keys', `Nudge ${S.doc.units === 'in' ? '1/16 in' : S.doc.units === 'mm' ? '1 mm' : '1 px'} (Shift: ×10)`],
    ['Ctrl+G / Ctrl+Shift+G', 'Group / Ungroup'], ['Ctrl+] / Ctrl+[', 'Bring forward / Send backward (Shift: to front / back)'],
    ['Ctrl+C / X / V', 'Copy / Cut / Paste (Ctrl+Shift+V: in place)'], ['Ctrl+D', 'Duplicate'], ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / Redo'],
    ['Ctrl+J', 'Join paths'], ['Ctrl+8', 'Make compound path (holes)'], ['Ctrl+2 / Ctrl+3', 'Lock / Hide (with Alt: unlock all / show all)'],
    ['Ctrl+0 / Ctrl+1', 'Fit artboard / Actual size'], ['Ctrl+wheel or Alt+wheel', 'Zoom at the pointer'], ["Ctrl+R / Ctrl+' / Ctrl+U", 'Rulers / Grid / Smart guides'],
    ['Ctrl+S / Ctrl+O / Ctrl+E', 'Save / Open / Export SVG'], ['Number fields', 'Accept fractions and sums: 3/16, 1 1/2, 2+0.125'],
  ];
  message('Keyboard Shortcuts', `<table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>`);
}

// ------------------------------------------------------------ documents
async function confirmDiscard() {
  if (!S.dirty) return true;
  const r = await ask('Unsaved changes', [{ type: 'info', html: `<p>“${escapeHtml(S.fileName)}” has changes that haven't been saved. Continue without saving them?</p>` }], { ok: 'Discard changes' });
  return !!r;
}

function sizeFields(w, h, units, title) {
  const u0 = units;
  const fields = [
    { id: 'preset', label: 'Size', type: 'select', value: '', options: [['', 'Custom'], ...PRESETS.map((p) => [p.name, `${p.name}  (${p.w} × ${p.h} ${p.units})`])] },
    { id: 'units', label: 'Units', type: 'select', value: u0, options: [['in', 'Inches'], ['mm', 'Millimeters'], ['px', 'Pixels']] },
    { id: 'w', label: 'Width', type: 'number', value: fmt(toUnits(w, u0), UNITS[u0].digits + 1) },
    { id: 'h', label: 'Height', type: 'number', value: fmt(toUnits(h, u0), UNITS[u0].digits + 1) },
  ];
  const match = PRESETS.find((p) => Math.abs(fromUnits(p.w, p.units) - w) < 0.01 && Math.abs(fromUnits(p.h, p.units) - h) < 0.01);
  if (match) fields[0].value = match.name;
  let cur = u0;
  fields[0].onchange = (v, inputs) => {
    const p = PRESETS.find((x) => x.name === v.preset);
    if (!p) return;
    inputs.units.value = p.units; cur = p.units;
    inputs.w.value = p.w; inputs.h.value = p.h;
  };
  fields[1].onchange = (v, inputs) => {
    const k = UNITS[cur].px / UNITS[v.units].px;
    inputs.w.value = fmt(v.w * k, UNITS[v.units].digits + 1);
    inputs.h.value = fmt(v.h * k, UNITS[v.units].digits + 1);
    cur = v.units;
  };
  return fields;
}

async function newDoc() {
  if (!await confirmDiscard()) return;
  const r = await ask('New Document', sizeFields(S.doc.width, S.doc.height, S.doc.units), { ok: 'Create' });
  if (!r || !(r.w > 0) || !(r.h > 0)) return;
  const d = newDocument(fromUnits(r.w, r.units), fromUnits(r.h, r.units), r.units);
  settings.units = r.units;
  settings.lastPreset = r.preset;
  saveSettings();
  loadDoc(d, 'Untitled', null);
}

async function docSetup() {
  const r = await ask('Document Setup', sizeFields(S.doc.width, S.doc.height, S.doc.units));
  if (!r || !(r.w > 0) || !(r.h > 0)) return;
  S.doc.units = r.units;
  S.doc.width = fromUnits(r.w, r.units);
  S.doc.height = fromUnits(r.h, r.units);
  settings.units = r.units;
  saveSettings();
  commit('Document setup');
  fitArtboard();
}

async function gridSetup() {
  const u = S.doc.units;
  const r = await ask('Grid Settings', [
    { id: 'size', label: `Gridline every (${u})`, type: 'number', value: settings.gridSize[u] },
    { id: 'div', label: 'Subdivisions', type: 'number', value: settings.gridDiv[u] },
    { id: 'show', label: 'Show grid', type: 'checkbox', value: settings.grid },
    { id: 'snap', label: 'Snap to grid', type: 'checkbox', value: settings.snapGrid },
  ]);
  if (!r) return;
  if (r.size > 0) settings.gridSize[u] = r.size;
  if (r.div >= 1) settings.gridDiv[u] = Math.round(r.div);
  settings.grid = r.show;
  settings.snapGrid = r.snap;
  saveSettings();
  buildOptions();
  requestRender('all');
}

export function loadDoc(d, name, handle) {
  finishPen();
  finishText();
  S.doc = d;
  S.fileName = name;
  S.fileHandle = handle;
  S.sel = [];
  S.anchors.clear();
  S.activeLayer = d.layers[d.layers.length - 1].id;
  S.history.reset(d);
  S.dirty = false;
  emit('doc');
  emit('selection');
  fitArtboard();
  updateTitle();
}

const ext = (name) => (/\.([^.]+)$/.exec(name || '')?.[1] || '').toLowerCase();
const baseName = (name) => String(name || 'Untitled').replace(/\.[^.]+$/, '');
const IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svgz'];

function pickFiles(accept, multiple, then) {
  const i = $('file-input');
  i.accept = accept;
  i.multiple = multiple;
  i.value = '';
  i.onchange = () => { const f = [...i.files]; if (f.length) then(multiple ? f : f[0]); };
  i.click();
}

export async function openFile(file, handle = null) {
  try {
    if (!await confirmDiscard()) return;
    const e = ext(file.name);
    let d;
    if (e === 'vdraw' || e === 'json') {
      d = parseVdraw(await file.text());
      return loadDoc(d, baseName(file.name), e === 'vdraw' ? handle : null);
    }
    if (e === 'svg') {
      const r = importSvg(await file.text());
      d = newDocument(r.width || 816, r.height || 1056, settings.units);
      if (r.layers) d.layers = r.layers.map((l, k) => ({ id: newId(), name: l.name, visible: !l.hidden, locked: false, color: ['#e8650f', '#1e90ff', '#22c55e', '#e11d48', '#a855f7'][k % 5], children: l.children }));
      else d.layers[0].children = r.objects;
      return loadDoc(adoptDocument(d), baseName(file.name), null);
    }
    if (e === 'dxf') {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const r = importDxf(bytes, settings.units, { margin: 0 });
      const probe = r;
      const units = r.unitName === 'mm' || r.unitName === 'in' ? r.unitName : settings.units;
      const margin = units === 'mm' ? fromUnits(10, 'mm') : 48;
      // the whole drawing (text included) inside a margin
      const all = r.layers.flatMap((l) => l.children);
      const b = boundsOf(all) || { x: 0, y: 0, w: 96, h: 96 };
      for (const o of all) transformObject(o, translate(margin - b.x, margin - b.y));
      d = newDocument(b.w + 2 * margin, b.h + 2 * margin, units);
      d.layers = r.layers.map((l, k) => ({ id: newId(), name: l.name, visible: true, locked: false, color: ['#e8650f', '#1e90ff', '#22c55e', '#e11d48', '#a855f7'][k % 5], children: l.children }));
      loadDoc(adoptDocument(d), baseName(file.name), null);
      status(`Opened ${file.name}: ${fmt(toUnits(r.width, units), 4)} × ${fmt(toUnits(r.height, units), 4)} ${units}${probe.unitName ? '' : ` (the file doesn't say its units; read as ${units})`}.`, 'ok');
      return;
    }
    if (IMAGE.includes(e) || file.type.startsWith('image/')) {
      const im = await importImage(file, baseName(file.name), Infinity, Infinity);
      d = newDocument(im.w, im.h, settings.units);
      d.layers[0].children.push(im);
      return loadDoc(adoptDocument(d), baseName(file.name), null);
    }
    throw new Error(`Vector Draw can't open .${e} files. It opens .vdraw, SVG, DXF and pictures.`);
  } catch (err) {
    status(err.message || String(err), 'bad');
    message("Couldn't open the file", `<p>${escapeHtml(err.message || err)}</p>`);
  }
}

function placeObjects(objs, name, keepPosition) {
  if (!objs.length) return status(`${name} has nothing that can be drawn.`, 'bad');
  let o = objs.length === 1 ? objs[0] : { type: 'group', id: newId(), name, children: objs, style: { opacity: 1 } };
  const b = boundsOf([o]);
  const inBoard = b && b.x > -1 && b.y > -1 && b.x + b.w < S.doc.width + 1 && b.y + b.h < S.doc.height + 1;
  if (b && !(keepPosition && inBoard)) {
    const s = stageSize();
    const c = { x: (s.w / 2 - S.panX) / S.zoom, y: (s.h / 2 - S.panY) / S.zoom };
    transformObject(o, translate(c.x - (b.x + b.w / 2), c.y - (b.y + b.h / 2)));
  }
  targetLayer().children.push(o);
  setSel([o.id]);
  commit(`Place ${name}`);
}

function placeSvgText(text, name) {
  const r = importSvg(text);
  placeObjects(r.objects, name, true);
}

export async function placeFiles(files) {
  for (const file of files) {
    try {
      const e = ext(file.name);
      if (e === 'svg') placeSvgText(await file.text(), baseName(file.name));
      else if (e === 'dxf') {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const r = importDxf(bytes, S.doc.units, { margin: 0 });
        const objs = r.layers.flatMap((l) => l.children);
        // the drawing's own 0,0 at the artboard's lower-left corner
        const g = { type: 'group', id: newId(), name: baseName(file.name), children: objs, style: { opacity: 1 } };
        transformObject(g, translate(r.x0 * r.k, S.doc.height - r.y1 * r.k));
        placeObjects([g], baseName(file.name), true);
        status(`Placed ${file.name} to scale: ${fmt(toUnits(r.width, S.doc.units), 4)} × ${fmt(toUnits(r.height, S.doc.units), 4)} ${S.doc.units}.`, 'ok');
      } else if (e === 'vdraw') {
        const d = parseVdraw(await file.text());
        placeObjects(d.layers.flatMap((l) => l.children), baseName(file.name), true);
      } else if (IMAGE.includes(e) || file.type.startsWith('image/')) {
        const im = await importImage(file, baseName(file.name) || 'Pasted picture', S.doc.width * 0.9, S.doc.height * 0.9);
        placeObjects([im], im.name, false);
      } else throw new Error(`Vector Draw can't place .${e} files.`);
    } catch (err) {
      status(err.message || String(err), 'bad');
      message("Couldn't place the file", `<p>${escapeHtml(err.message || err)}</p>`);
    }
  }
}

async function save(as) {
  finishText(); finishPen();
  const name = `${S.fileName}.vdraw`;
  try {
    const r = await saveFile(exportVdraw(S.doc), name, 'vdraw', as ? null : S.fileHandle);
    if (!r) return;
    S.fileHandle = r.handle;
    S.fileName = baseName(r.name);
    S.dirty = false;
    updateTitle();
    status(`Saved ${r.name}.`, 'ok');
  } catch (err) {
    message("Couldn't save", `<p>${escapeHtml(err.message || err)}</p>`);
  }
}

async function doExport(kind) {
  finishText(); finishPen();
  try {
    let data;
    if (kind === 'svg') data = exportSvg(S.doc);
    else if (kind === 'pdf') { status('Making the PDF…'); data = await exportPdf(S.doc); }
    else if (kind === 'dxf') {
      if (S.doc.units === 'px') {
        const r = await ask('Export DXF', [{ type: 'info', html: '<p>This document is in pixels, so the DXF will have no units. Switch the document to inches or millimeters (File › Document Setup) for a to-scale cut file.</p>' }], { ok: 'Export anyway' });
        if (!r) return;
      }
      data = exportDxf(S.doc);
    } else if (kind === 'png') {
      const top = maxDpi(S.doc);
      const r = await ask('Export PNG', [
        { id: 'dpi', label: 'Resolution (dpi)', type: 'number', value: Math.min(settings.pngDpi, top), suffix: `up to ${top}` },
        { id: 't', label: 'Transparent background', type: 'checkbox', value: settings.pngTransparent },
      ], { ok: 'Export' });
      if (!r || !(r.dpi > 0)) return;
      const dpi = Math.min(Math.round(r.dpi), top);
      settings.pngDpi = dpi; settings.pngTransparent = r.t; saveSettings();
      status('Making the picture…');
      data = await exportPng(S.doc, dpi, r.t);
    }
    const res = await saveFile(data, `${S.fileName}.${kind}`, kind);
    if (res) status(`Exported ${res.name}.`, 'ok');
  } catch (err) {
    status(err.message || String(err), 'bad');
    message("Couldn't export", `<p>${escapeHtml(err.message || err)}</p>`);
  }
}

function initFiles() {
  const hint = $('drop-hint');
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { depth++; hint.hidden = false; e.preventDefault(); } });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) hint.hidden = true; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    hint.hidden = true;
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    // a document opens when this one is empty, everything else is placed into it
    const empty = S.doc.layers.every((l) => !l.children.length);
    if (files.length === 1 && (ext(files[0].name) === 'vdraw' || (empty && ['svg', 'dxf'].includes(ext(files[0].name))))) openFile(files[0]);
    else placeFiles(files);
  });
}

function initLaunchQueue() {
  if (!('launchQueue' in window)) return;
  window.launchQueue.setConsumer(async (params) => {
    const handles = params.files || [];
    if (!handles.length) return;
    const file = await handles[0].getFile();
    openFile(file, handles[0]);
  });
}

function registerServiceWorker() {
  // on this PC's test server only with ?sw, so tests always run the files as they are
  const local = /^(localhost|127\.)/.test(location.hostname);
  if (!('serviceWorker' in navigator) || location.protocol === 'file:' || (local && !new URLSearchParams(location.search).has('sw'))) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const ready = (worker) => {
      if (!S.dirty) worker.postMessage('activate');
      else {
        $('update').hidden = false;
        $('update-now').onclick = () => worker.postMessage('activate');
      }
    };
    if (reg.waiting && navigator.serviceWorker.controller) ready(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) ready(w); });
    });
    setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloading && !S.dirty) { reloading = true; location.reload(); } });
}

// test and console access
window.VD = { S, settings, ops, newDocument, bounds: (o) => boundsOf([o]), COMMANDS, setTool, openFile, placeFiles, loadDoc, renderNow, exportSvg, exportPdf, exportPng, exportDxf, exportVdraw, importDxf, importSvg, els };

start();
