// Small UI helpers: element building, dialogs, saving files.

import { esc } from './render.js';

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

let open = null;

/**
 * A dialog with fields: [{ id, label, type: number|text|select|checkbox|info, value, options:[[v,label]], step, onchange }]
 * Resolves with { id: value } or null (cancelled).
 */
export function ask(title, fields, { ok = 'OK', cancel = 'Cancel', wide = false } = {}) {
  if (open) open(null);
  const back = document.getElementById('modal');
  const form = document.getElementById('modal-form');
  form.innerHTML = '';
  form.style.minWidth = wide ? '520px' : '';
  const content = h('div', { class: 'content' });
  const inputs = {};
  for (const f of fields) {
    if (f.type === 'info') { content.append(h('div', { html: f.html })); continue; }
    let input;
    if (f.type === 'select') {
      input = h('select', { class: 'sel grow', id: 'f-' + f.id }, ...f.options.map(([v, l]) => h('option', { value: v }, l)));
      input.value = f.value;
    } else if (f.type === 'checkbox') {
      input = h('input', { type: 'checkbox', id: 'f-' + f.id, checked: f.value });
    } else {
      input = h('input', { class: f.type === 'number' ? 'num' : 'txt', type: f.type === 'number' ? 'text' : 'text', inputmode: f.type === 'number' ? 'decimal' : null, id: 'f-' + f.id, value: f.value ?? '' });
      if (f.type !== 'number') input.style.width = '100%';
      else input.style.width = '110px';
    }
    inputs[f.id] = input;
    const row = h('label', { class: 'row' }, h('span', {}, f.label), input, f.suffix ? h('span', { class: 'note' }, f.suffix) : null);
    if (f.hidden) row.hidden = true;
    f.row = row;
    content.append(row);
  }
  const read = () => {
    const out = {};
    for (const f of fields) {
      const i = inputs[f.id];
      if (!i) continue;
      out[f.id] = f.type === 'checkbox' ? i.checked : f.type === 'number' ? evalNum(i.value) : i.value;
    }
    return out;
  };
  for (const f of fields) if (f.onchange && inputs[f.id]) inputs[f.id].addEventListener(f.type === 'select' || f.type === 'checkbox' ? 'change' : 'input', () => f.onchange(read(), inputs, fields));
  const okBtn = h('button', { class: 'btn primary', type: 'submit' }, ok);
  const actions = h('div', { class: 'actions' }, cancel ? h('button', { class: 'btn', type: 'button', onclick: () => done(null) }, cancel) : null, okBtn);
  form.append(h('h2', {}, title), content, actions);
  back.hidden = false;
  let resolve;
  const done = (v) => {
    back.hidden = true;
    open = null;
    form.onsubmit = null;
    resolve(v);
  };
  open = done;
  form.onsubmit = (e) => { e.preventDefault(); done(read()); };
  form.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); done(null); } };
  setTimeout(() => {
    const first = form.querySelector('input:not([type=checkbox]), select');
    if (first) { first.focus(); first.select?.(); } else okBtn.focus();
  }, 0);
  return new Promise((r) => { resolve = r; });
}

export const isDialogOpen = () => !!open;

/** Accepts plain numbers and simple fractions or sums like 3/16, 1 1/2, 2+0.125. */
export function evalNum(s) {
  s = String(s).trim().replace(/,/g, '.').replace(/["″]|in$|mm$|px$|pt$/g, '').trim();
  if (/^-?\d+\s+\d+\/\d+$/.test(s)) {
    const [w, f] = s.split(/\s+/);
    const [a, b] = f.split('/').map(Number);
    const sign = w.startsWith('-') ? -1 : 1;
    return sign * (Math.abs(+w) + a / b);
  }
  if (/^[-+*/().\d\s]+$/.test(s) && /\d/.test(s)) {
    try {
      // only digits and arithmetic are allowed through the check above
      const v = Function(`"use strict"; return (${s});`)();
      if (typeof v === 'number' && isFinite(v)) return v;
    } catch { /* fall through */ }
  }
  const v = parseFloat(s);
  return isFinite(v) ? v : NaN;
}

export async function message(title, html) {
  await ask(title, [{ type: 'info', html }], { cancel: null, wide: true });
}

// ------------------------------------------------------------ saving
const PICKER_TYPES = {
  vdraw: { description: 'Vector Draw document', accept: { 'application/json': ['.vdraw'] } },
  svg: { description: 'SVG drawing', accept: { 'image/svg+xml': ['.svg'] } },
  pdf: { description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } },
  png: { description: 'PNG picture', accept: { 'image/png': ['.png'] } },
  dxf: { description: 'DXF drawing', accept: { 'application/dxf': ['.dxf'] } },
};

/**
 * Saves data (string or bytes) as `name`. Uses the Save dialog when the browser has one,
 * otherwise a download. Returns { handle, name } or null when cancelled.
 */
export async function saveFile(data, name, kind, handle = null) {
  const mime = Object.keys(PICKER_TYPES[kind].accept)[0];
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  if (window.showSaveFilePicker) {
    try {
      const hnd = handle || await window.showSaveFilePicker({ suggestedName: name, types: [PICKER_TYPES[kind]], id: 'vector-draw-' + kind });
      const w = await hnd.createWritable();
      await w.write(blob);
      await w.close();
      return { handle: hnd, name: hnd.name };
    } catch (e) {
      if (e.name === 'AbortError') return null;
      if (handle) return saveFile(data, name, kind, null);
      throw e;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return { handle: null, name };
}

export { esc };
