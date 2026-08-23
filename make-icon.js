#!/usr/bin/env node
/*
 * Generates the BurnMeter icon: public/icon.svg for the browser tab, and
 * desktop/burnmeter.ico for the Windows shortcuts.
 *
 * The .ico is built from scratch — a tiny PNG encoder over Node's built-in
 * zlib, wrapped in an ICONDIR. No image libraries, nothing to install.
 * Re-run after changing the artwork: node make-icon.js
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ------------------------------------------------------------ PNG encoder ---

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** rgba: Buffer of size*size*4 -> PNG buffer. */
function encodePNG(rgba, size) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;                        // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ----------------------------------------------------------------- artwork ---

const BG     = [0x15, 0x15, 0x13];
const TRACK  = [0x2e, 0x2e, 0x2a];
const ACCENT = [0xe2, 0x67, 0x3a];
const HOT    = [0xe0, 0xa5, 0x16];
const INK    = [0xff, 0xff, 0xff];

const FILL_TO = 0.70;                    // where the needle sits, 0..1 round the arc

function roundRect(px, py, w, h, r) {     // inside test in unit space
  const dx = Math.max(Math.abs(px - w / 2) - (w / 2 - r), 0);
  const dy = Math.max(Math.abs(py - h / 2) - (h / 2 - r), 0);
  return Math.hypot(dx, dy) <= r;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 ? (wx * vx + wy * vy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** Colour of one point in unit space (0..1), or null for transparent. */
function shade(x, y) {
  if (!roundRect(x, y, 1, 1, 0.225)) return null;

  const cx = 0.5, cy = 0.635, R = 0.335, W = 0.088;
  const dx = x - cx, dy = y - cy;
  const rad = Math.hypot(dx, dy);

  // Needle first so it reads on top of the arc.
  const na = Math.PI * (1 + FILL_TO);
  const nx = cx + (R - 0.055) * Math.cos(na), ny = cy + (R - 0.055) * Math.sin(na);
  const tx = cx - 0.05 * Math.cos(na),        ty = cy - 0.05 * Math.sin(na);
  if (distToSegment(x, y, tx, ty, nx, ny) <= 0.024) return INK;
  if (rad <= 0.052) return INK;

  // Gauge arc: upper semicircle only.
  if (Math.abs(rad - R) <= W / 2 && dy <= 0.004) {
    const a = Math.atan2(dy, dx);            // -PI..0 across the top
    const f = (a + Math.PI) / Math.PI;
    if (f < 0 || f > 1) return BG;
    if (f > FILL_TO) return TRACK;
    // Warm up as the needle climbs.
    const k = Math.min(1, f / FILL_TO);
    return [
      Math.round(HOT[0] + (ACCENT[0] - HOT[0]) * k),
      Math.round(HOT[1] + (ACCENT[1] - HOT[1]) * k),
      Math.round(HOT[2] + (ACCENT[2] - HOT[2]) * k)
    ];
  }
  return BG;
}

/** Render at `size`, supersampled SS x SS for clean edges. */
function render(size, SS = 4) {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (x + (sx + 0.5) / SS) / size;
          const uy = (y + (sy + 0.5) / SS) / size;
          const c = shade(ux, uy);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      // Un-premultiply so edge pixels keep their colour at partial alpha.
      const cover = a / (255 * n);
      out[i]     = cover > 0 ? Math.round(r / (n * cover)) : 0;
      out[i + 1] = cover > 0 ? Math.round(g / (n * cover)) : 0;
      out[i + 2] = cover > 0 ? Math.round(b / (n * cover)) : 0;
      out[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

// --------------------------------------------------------------------- ICO ---

function buildICO(sizes) {
  const images = sizes.map(s => ({ size: s, png: encodePNG(render(s), s) }));
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);            // reserved
  dir.writeUInt16LE(1, 2);            // type: icon
  dir.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = [];
  for (const im of images) {
    const e = Buffer.alloc(16);
    e[0] = im.size >= 256 ? 0 : im.size;   // 0 means 256
    e[1] = im.size >= 256 ? 0 : im.size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);                 // colour planes
    e.writeUInt16LE(32, 6);                // bits per pixel
    e.writeUInt32LE(im.png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += im.png.length;
    entries.push(e);
  }
  return Buffer.concat([dir, ...entries, ...images.map(i => i.png)]);
}

// --------------------------------------------------------------------- SVG ---

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#151513"/>
  <path d="M10.6 40.6a21.4 21.4 0 0 1 42.8 0" fill="none" stroke="#2e2e2a"
        stroke-width="5.6" stroke-linecap="round"/>
  <path d="M10.6 40.6A21.4 21.4 0 0 1 45.9 24.4" fill="none" stroke="#e2673a"
        stroke-width="5.6" stroke-linecap="round"/>
  <path d="M30.4 43.8 45.1 26.9" stroke="#fff" stroke-width="3.1" stroke-linecap="round"/>
  <circle cx="32" cy="40.6" r="3.4" fill="#fff"/>
</svg>
`;

// -------------------------------------------------------------------- main ---

const here = __dirname;
fs.mkdirSync(path.join(here, 'public'),  { recursive: true });
fs.mkdirSync(path.join(here, 'desktop'), { recursive: true });

fs.writeFileSync(path.join(here, 'public', 'icon.svg'), SVG);

const ico = buildICO([256, 64, 48, 32, 16]);
fs.writeFileSync(path.join(here, 'desktop', 'burnmeter.ico'), ico);

fs.writeFileSync(path.join(here, 'public', 'icon.png'), encodePNG(render(128), 128));

console.log(`icon.svg  ${SVG.length} bytes`);
console.log(`burnmeter.ico  ${ico.length} bytes  (256, 64, 48, 32, 16)`);
console.log('icon.png  128x128');
