// Writing files: vector PDF (pdf-lib, drawn as real paths), PNG at a chosen dpi, DXF to scale
// (R12 ASCII: closed polylines with exact arcs as bulges, circles as CIRCLE), and .vdraw.

import { PDFDocument, PDFName, StandardFonts } from '../../vendor/pdf-lib.esm.min.js';
import { segments, flatten, fmt, bez } from '../geom.js';
import { textLines, LINE, bounds, UNITS } from '../doc.js';
import { exportSvg, dashArray } from '../render.js';
import { loadImage } from './import.js';

// ======================================================================= PDF

const rgb = (hex) => {
  const h = String(hex || '#000').replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0');
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16) / 255);
};
const n = (v) => fmt(v, 4);
const col = (hex) => rgb(hex).map((v) => fmt(v, 4)).join(' ');
const solid = (p) => (!p ? null : typeof p === 'string' ? p : p.stops?.[0]?.color || '#000000');

function fontFor(o) {
  const f = (o.font || '').toLowerCase();
  const bold = (o.weight || 400) >= 600, it = !!o.italic;
  if (/mono|courier|consol/.test(f)) return bold ? (it ? 'CourierBoldOblique' : 'CourierBold') : it ? 'CourierOblique' : 'Courier';
  if (/times|georgia|garamond|cambria|book|serif/.test(f) && !/sans/.test(f)) return bold ? (it ? 'TimesRomanBoldItalic' : 'TimesRomanBold') : it ? 'TimesRomanItalic' : 'TimesRoman';
  return bold ? (it ? 'HelveticaBoldOblique' : 'HelveticaBold') : it ? 'HelveticaOblique' : 'Helvetica';
}

function dataUrlBytes(url) {
  const comma = url.indexOf(',');
  const meta = url.slice(5, comma);
  const data = url.slice(comma + 1);
  if (meta.endsWith(';base64')) {
    const bin = atob(data);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return { mime: meta.split(';')[0], bytes: out };
  }
  return { mime: meta.split(';')[0], bytes: new TextEncoder().encode(decodeURIComponent(data)) };
}

async function toPng(href) {
  const im = await loadImage(href);
  const c = document.createElement('canvas');
  c.width = im.naturalWidth || 300; c.height = im.naturalHeight || 150;
  c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
  const b = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new Uint8Array(await b.arrayBuffer());
}

export async function exportPdf(doc) {
  const pdf = await PDFDocument.create();
  pdf.setCreator('Vector Draw — Badger Metal & Machine Fabrication');
  pdf.setProducer('Vector Draw');
  const ctx = pdf.context;
  const W = doc.width * 0.75, H = doc.height * 0.75;
  const res = { Font: {}, XObject: {}, ExtGState: {}, Shading: {} };
  const fonts = new Map(), images = new Map(), states = new Map();
  let shadings = 0;

  const gs = (alpha) => {
    const k = fmt(alpha, 3);
    if (!states.has(k)) {
      const name = `G${states.size}`;
      res.ExtGState[name] = ctx.register(ctx.obj({ Type: 'ExtGState', ca: alpha, CA: alpha }));
      states.set(k, name);
    }
    return `/${states.get(k)} gs\n`;
  };
  const font = async (o) => {
    const key = fontFor(o);
    if (!fonts.has(key)) {
      const f = await pdf.embedFont(StandardFonts[key]);
      const name = `F${fonts.size}`;
      res.Font[name] = f.ref;
      fonts.set(key, { f, name });
    }
    return fonts.get(key);
  };
  const image = async (href) => {
    if (!images.has(href)) {
      const { mime, bytes } = dataUrlBytes(href);
      let img;
      if (mime === 'image/jpeg') img = await pdf.embedJpg(bytes);
      else if (mime === 'image/png') img = await pdf.embedPng(bytes);
      else img = await pdf.embedPng(await toPng(href));
      const name = `I${images.size}`;
      res.XObject[name] = img.ref;
      images.set(href, name);
    }
    return images.get(href);
  };
  const shading = (g) => {
    let stops = (g.stops || []).slice().sort((a, b) => a.offset - b.offset);
    if (!stops.length) stops = [{ offset: 0, color: '#000000' }];
    if (stops[0].offset > 0) stops.unshift({ ...stops[0], offset: 0 });
    if (stops[stops.length - 1].offset < 1) stops.push({ ...stops[stops.length - 1], offset: 1 });
    const fns = [], bounds = [], encode = [];
    for (let i = 0; i + 1 < stops.length; i++) {
      fns.push(ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: rgb(stops[i].color), C1: rgb(stops[i + 1].color), N: 1 }));
      if (i > 0) bounds.push(stops[i].offset);
      encode.push(0, 1);
    }
    const fn = fns.length === 1 ? fns[0] : ctx.obj({ FunctionType: 3, Domain: [0, 1], Functions: fns, Bounds: bounds, Encode: encode });
    let coords, type;
    if (g.type === 'radial') { type = 3; coords = [0.5, 0.5, 0, 0.5, 0.5, 0.5]; } else {
      const a = ((g.angle || 0) * Math.PI) / 180, dx = Math.cos(a) / 2, dy = Math.sin(a) / 2;
      type = 2; coords = [0.5 - dx, 0.5 - dy, 0.5 + dx, 0.5 + dy];
    }
    const name = `S${shadings++}`;
    res.Shading[name] = ctx.register(ctx.obj({ ShadingType: type, ColorSpace: 'DeviceRGB', Coords: coords, Function: fn, Extend: [true, true] }));
    return name;
  };

  const pathOps = (o) => {
    let s = '';
    for (const sp of o.subpaths) {
      if (!sp.nodes.length) continue;
      s += `${n(sp.nodes[0].x)} ${n(sp.nodes[0].y)} m\n`;
      for (const g of segments(sp)) {
        if (g.line) s += `${n(g.p3.x)} ${n(g.p3.y)} l\n`;
        else s += `${n(g.c1.x)} ${n(g.c1.y)} ${n(g.c2.x)} ${n(g.c2.y)} ${n(g.p3.x)} ${n(g.p3.y)} c\n`;
      }
      if (sp.closed) s += 'h\n';
    }
    return s;
  };
  const strokeSetup = (st) => {
    let s = `${n(st.strokeWidth)} w ${col(solid(st.stroke))} RG `;
    s += `${{ butt: 0, round: 1, square: 2 }[st.cap] || 0} J ${{ miter: 0, round: 1, bevel: 2 }[st.join] || 0} j `;
    const d = dashArray(st);
    s += d ? `[${d}] 0 d\n` : '[] 0 d\n';
    return s;
  };

  const draw = async (o) => {
    if (o.hidden) return '';
    let s = 'q\n';
    const op = o.style?.opacity;
    if (op != null && op < 1) s += gs(op);
    if (o.type === 'group') {
      for (const c of o.children) s += await draw(c);
    } else if (o.type === 'path') {
      const st = o.style, ops = pathOps(o);
      if (!ops) return '';
      const eo = o.fillRule === 'evenodd' ? '*' : '';
      const hasStroke = st.stroke && st.strokeWidth > 0;
      if (st.fill && typeof st.fill === 'object') {
        const b = bounds(o);
        if (b && b.w > 0 && b.h > 0) s += `q\n${ops}W${eo} n\n${n(b.w)} 0 0 ${n(b.h)} ${n(b.x)} ${n(b.y)} cm /${shading(st.fill)} sh\nQ\n`;
        if (hasStroke) s += strokeSetup(st) + ops + 'S\n';
      } else if (st.fill && hasStroke) s += `${col(st.fill)} rg ` + strokeSetup(st) + ops + `B${eo}\n`;
      else if (st.fill) s += `${col(st.fill)} rg\n` + ops + `f${eo}\n`;
      else if (hasStroke) s += strokeSetup(st) + ops + 'S\n';
    } else if (o.type === 'text') {
      const { f, name } = await font(o);
      const m = o.matrix;
      s += `${m.map(n).join(' ')} cm 1 0 0 -1 0 0 cm\n${col(solid(o.style.fill) || '#000000')} rg\n`;
      textLines(o).forEach((line, i) => {
        const safe = [...line].map((ch) => { try { f.encodeText(ch); return ch; } catch { return '?'; } }).join('');
        const w = f.widthOfTextAtSize(safe, o.size);
        const x = o.align === 'center' ? -w / 2 : o.align === 'right' ? -w : 0;
        s += `BT /${name} ${n(o.size)} Tf ${n(x)} ${n(-i * o.size * LINE)} Td ${f.encodeText(safe).toString()} Tj ET\n`;
      });
    } else if (o.type === 'image') {
      const name = await image(o.href);
      s += `${o.matrix.map(n).join(' ')} cm ${n(o.w)} 0 0 ${n(-o.h)} 0 ${n(o.h)} cm /${name} Do\n`;
    }
    return s + 'Q\n';
  };

  let content = `0.75 0 0 -0.75 0 ${n(H)} cm\n`;
  for (const l of doc.layers) {
    if (!l.visible) continue;
    for (const o of l.children) content += await draw(o);
  }
  const resources = { ProcSet: ['PDF', 'Text', 'ImageB', 'ImageC'] };
  for (const k of Object.keys(res)) if (Object.keys(res[k]).length) resources[k] = res[k];
  const stream = ctx.register(ctx.flateStream(Uint8Array.from(content, (ch) => ch.charCodeAt(0) & 0xff)));
  const page = pdf.addPage([W, H]);
  page.node.set(PDFName.of('Resources'), ctx.obj(resources));
  page.node.set(PDFName.of('Contents'), stream);
  return pdf.save();
}

// ======================================================================= PNG

/** The largest dpi a browser canvas can take for this document. */
export function maxDpi(doc) {
  const side = 16000 / Math.max(doc.width, doc.height);
  const area = Math.sqrt(120e6 / (doc.width * doc.height));
  return Math.floor(96 * Math.min(side, area));
}

export async function exportPng(doc, dpi = 150, transparent = false) {
  const k = dpi / 96;
  const w = Math.max(1, Math.round(doc.width * k)), h = Math.max(1, Math.round(doc.height * k));
  const svg = exportSvg(doc, { background: false });
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const im = await loadImage(url);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    if (!transparent) { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); }
    g.drawImage(im, 0, 0, w, h);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    if (!blob) throw new Error('The picture is too big for this browser; try a lower dpi.');
    return setPngDpi(new Uint8Array(await blob.arrayBuffer()), dpi);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Adds a pHYs chunk so other programs know the picture's real size. */
function setPngDpi(png, dpi) {
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4);
  dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const at = 33; // after the signature (8) and IHDR (25)
  const out = new Uint8Array(png.length + 21);
  out.set(png.subarray(0, at), 0);
  out.set(chunk, at);
  out.set(png.subarray(at), at + 21);
  return out;
}

let crcTable = null;
function crc32(b) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ======================================================================= DXF

const ACI = [
  [1, [255, 0, 0]], [2, [255, 255, 0]], [3, [0, 255, 0]], [4, [0, 255, 255]], [5, [0, 0, 255]], [6, [255, 0, 255]],
  [7, [0, 0, 0]], [8, [128, 128, 128]], [9, [192, 192, 192]], [30, [255, 127, 0]], [250, [51, 51, 51]], [251, [80, 80, 80]],
  [252, [105, 105, 105]], [253, [130, 130, 130]], [254, [190, 190, 190]], [7, [255, 255, 255]],
];
function aci(hex) {
  if (!hex) return 7;
  const c = rgb(hex).map((v) => v * 255);
  let best = 7, bd = Infinity;
  for (const [i, p] of ACI) {
    const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** Is a Bézier segment (DXF coordinates) a circular arc? [cx, cy, r, sweep] or null. */
function arcOf(g) {
  const m = bez(g, 0.5);
  const ax = g.p0.x, ay = g.p0.y, bx = m.x, by = m.y, qx = g.p3.x, qy = g.p3.y;
  const d = 2 * (ax * (by - qy) + bx * (qy - ay) + qx * (ay - by));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, q2 = qx * qx + qy * qy;
  const cx = (a2 * (by - qy) + b2 * (qy - ay) + q2 * (ay - by)) / d;
  const cy = (a2 * (qx - bx) + b2 * (ax - qx) + q2 * (bx - ax)) / d;
  const r = Math.hypot(ax - cx, ay - cy);
  if (!(r > 1e-9) || r > 1e7) return null;
  const tol = Math.max(1e-6, r * 2e-4);
  for (const t of [0.125, 0.25, 0.375, 0.625, 0.75, 0.875]) {
    const p = bez(g, t);
    if (Math.abs(Math.hypot(p.x - cx, p.y - cy) - r) > tol) return null;
  }
  const cross = (bx - ax) * (qy - by) - (by - ay) * (qx - bx);
  const a0 = Math.atan2(ay - cy, ax - cx), a1 = Math.atan2(qy - cy, qx - cx);
  let sw = a1 - a0;
  if (cross > 0) { while (sw <= 0) sw += 2 * Math.PI; } else { while (sw >= 0) sw -= 2 * Math.PI; }
  if (Math.abs(sw) > Math.PI * 1.01) return null;
  return [cx, cy, r, sw];
}

const dnum = (v) => {
  let s = (Math.round(v * 1e6) / 1e6).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
};
const layerName = (s) => String(s || '0').replace(/[<>/\\":;?*|=`,]/g, '_').slice(0, 250) || '0';

/** DXF text (R12 ASCII). Coordinates in document units, origin at the artboard's lower-left. */
export function exportDxf(doc) {
  const u = UNITS[doc.units].px;
  const insunits = { in: 1, mm: 4, px: 0 }[doc.units];
  const X = (x) => x / u, Y = (y) => (doc.height - y) / u;
  const out = [];
  const c = (code, v) => out.push(String(code), String(v));
  const ents = [];
  const e = (code, v) => ents.push(String(code), String(v));
  const layers = new Map();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const grow = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };

  const sub = (sp, layer, color) => {
    if (sp.nodes.length < 2 && !sp.closed) return;
    const dn = { closed: sp.closed, nodes: sp.nodes.map((q) => ({ x: X(q.x), y: Y(q.y), in: q.in && { x: X(q.in.x), y: Y(q.in.y) }, out: q.out && { x: X(q.out.x), y: Y(q.out.y) } })) };
    const segs = segments(dn);
    // a whole circle?
    if (sp.closed && segs.length >= 2 && segs.every((g) => !g.line)) {
      const arcs = segs.map(arcOf);
      if (arcs.every(Boolean)) {
        const [cx, cy, r] = arcs[0];
        const tol = r * 1e-3 + 1e-6;
        const total = arcs.reduce((s, a) => s + a[3], 0);
        if (arcs.every((a) => Math.abs(a[0] - cx) < tol && Math.abs(a[1] - cy) < tol && Math.abs(a[2] - r) < tol) && Math.abs(Math.abs(total) - 2 * Math.PI) < 1e-3) {
          e(0, 'CIRCLE'); e(8, layer); e(62, color); e(10, dnum(cx)); e(20, dnum(cy)); e(30, 0); e(40, dnum(r));
          grow(cx - r, cy - r); grow(cx + r, cy + r);
          return;
        }
      }
    }
    // vertices with bulges; non-circular curves flattened finely (0.0002 in)
    const verts = [[dn.nodes[0].x, dn.nodes[0].y, 0]];
    const tol = doc.units === 'mm' ? 0.005 : doc.units === 'in' ? 0.0002 : 0.02;
    for (const g of segs) {
      const last = verts[verts.length - 1];
      if (!g.line) {
        const a = arcOf(g);
        if (a) {
          last[2] = Math.tan(a[3] / 4);
        } else {
          const one = flatten({ subpaths: [{ closed: false, nodes: [{ ...g.p0, in: null, out: g.c1 }, { ...g.p3, in: g.c2, out: null }] }] }, tol)[0].pts;
          for (const p of one.slice(1, -1)) verts.push([p.x, p.y, 0]);
        }
      }
      verts.push([g.p3.x, g.p3.y, 0]);
    }
    if (sp.closed) verts.pop(); // the closing vertex is the first one
    for (const v of verts) grow(v[0], v[1]);
    if (!sp.closed && verts.length === 2 && verts[0][2] === 0) {
      e(0, 'LINE'); e(8, layer); e(62, color);
      e(10, dnum(verts[0][0])); e(20, dnum(verts[0][1])); e(30, 0); e(11, dnum(verts[1][0])); e(21, dnum(verts[1][1])); e(31, 0);
      return;
    }
    e(0, 'POLYLINE'); e(8, layer); e(62, color); e(66, 1); e(10, 0); e(20, 0); e(30, 0); e(70, sp.closed ? 1 : 0);
    for (const v of verts) {
      e(0, 'VERTEX'); e(8, layer); e(10, dnum(v[0])); e(20, dnum(v[1])); e(30, 0);
      if (v[2]) e(42, dnum(v[2]));
    }
    e(0, 'SEQEND'); e(8, layer);
  };

  const obj = (o, layer) => {
    if (o.hidden) return;
    if (o.type === 'group') return o.children.forEach((k) => obj(k, layer));
    if (o.type === 'path') {
      const color = aci(solid(o.style.stroke) || solid(o.style.fill));
      for (const sp of o.subpaths) sub(sp, layer, color);
    } else if (o.type === 'text') {
      const m = o.matrix;
      const sx = Math.hypot(m[0], m[1]), sy = Math.hypot(m[2], m[3]);
      const rot = (-Math.atan2(m[1], m[0]) * 180) / Math.PI;
      const h = (o.size * sy * 0.72) / u;
      textLines(o).forEach((line, i) => {
        if (!line.trim()) return;
        const p = { x: m[2] * i * o.size * LINE + m[4], y: m[3] * i * o.size * LINE + m[5] };
        const x = X(p.x), y = Y(p.y);
        e(0, 'TEXT'); e(8, layer); e(62, aci(solid(o.style.fill)));
        e(10, dnum(x)); e(20, dnum(y)); e(30, 0); e(40, dnum(h)); e(1, line.replace(/[\r\n]/g, ' '));
        if (Math.abs(rot) > 1e-6) e(50, dnum(rot));
        if (Math.abs(sx / sy - 1) > 0.01) e(41, dnum(sx / sy));
        const ha = o.align === 'center' ? 1 : o.align === 'right' ? 2 : 0;
        if (ha) { e(72, ha); e(11, dnum(x)); e(21, dnum(y)); e(31, 0); }
        grow(x, y);
      });
    }
  };
  for (const l of doc.layers) {
    if (!l.visible) continue;
    const name = layerName(l.name);
    layers.set(name, aci(l.color));
    for (const o of l.children) obj(o, name);
  }
  if (x0 > x1) { x0 = y0 = 0; x1 = X(doc.width); y1 = Y(0); }

  c(999, 'Vector Draw - Badger Metal & Machine Fabrication');
  c(0, 'SECTION'); c(2, 'HEADER');
  c(9, '$ACADVER'); c(1, 'AC1009');
  c(9, '$INSBASE'); c(10, 0); c(20, 0); c(30, 0);
  c(9, '$EXTMIN'); c(10, dnum(x0)); c(20, dnum(y0)); c(30, 0);
  c(9, '$EXTMAX'); c(10, dnum(x1)); c(20, dnum(y1)); c(30, 0);
  c(9, '$LIMMIN'); c(10, 0); c(20, 0);
  c(9, '$LIMMAX'); c(10, dnum(X(doc.width))); c(20, dnum(Y(0)));
  c(9, '$INSUNITS'); c(70, insunits);
  c(9, '$MEASUREMENT'); c(70, doc.units === 'mm' ? 1 : 0);
  c(0, 'ENDSEC');
  c(0, 'SECTION'); c(2, 'TABLES');
  c(0, 'TABLE'); c(2, 'LTYPE'); c(70, 1);
  c(0, 'LTYPE'); c(2, 'CONTINUOUS'); c(70, 0); c(3, 'Solid line'); c(72, 65); c(73, 0); c(40, 0);
  c(0, 'ENDTAB');
  c(0, 'TABLE'); c(2, 'LAYER'); c(70, layers.size + 1);
  c(0, 'LAYER'); c(2, '0'); c(70, 0); c(62, 7); c(6, 'CONTINUOUS');
  for (const [name, color] of layers) { if (name === '0') continue; c(0, 'LAYER'); c(2, name); c(70, 0); c(62, color); c(6, 'CONTINUOUS'); }
  c(0, 'ENDTAB');
  c(0, 'ENDSEC');
  c(0, 'SECTION'); c(2, 'BLOCKS'); c(0, 'ENDSEC');
  c(0, 'SECTION'); c(2, 'ENTITIES');
  out.push(...ents);
  c(0, 'ENDSEC');
  c(0, 'EOF');
  return out.join('\r\n') + '\r\n';
}

// ======================================================================= .vdraw

export const exportVdraw = (doc) => JSON.stringify(doc);
