// Generates icons/icon{16,32,48,128}.png with zero dependencies
// (node:zlib is all a PNG needs). Black rounded square, white checkmark —
// matches the monochrome solvecha product style.
//
// Usage: node make-icons.mjs

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(ROOT, "icons");
const SIZES = [16, 32, 48, 128];

// ---- minimal PNG encoder -------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = size * 4 + 1; // 1 filter byte per scanline
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- drawing --------------------------------------------------------------

function distToSeg(px, py, a, b) {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const apx = px - a[0];
  const apy = py - a[1];
  const len2 = abx * abx + aby * aby;
  let t = len2 ? (apx * abx + apy * aby) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * abx), py - (a[1] + t * aby));
}

/** Render the icon at `size` with 4x supersampling for clean edges. */
function render(size) {
  const ss = 4;
  const big = size * ss;
  const buf = Buffer.alloc(big * big * 4);

  const inset = big * 0.06;
  const x0 = inset;
  const y0 = inset;
  const x1 = big - inset;
  const y1 = big - inset;
  const radius = big * 0.22;

  const p1 = [x0 + (x1 - x0) * 0.26, y0 + (y1 - y0) * 0.56];
  const p2 = [x0 + (x1 - x0) * 0.44, y0 + (y1 - y0) * 0.74];
  const p3 = [x0 + (x1 - x0) * 0.76, y0 + (y1 - y0) * 0.32];
  const stroke = big * 0.105;

  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const i = (y * big + x) * 4;
      // Rounded-rect coverage.
      const cx = Math.max(x0 + radius, Math.min(x, x1 - radius));
      const cy = Math.max(y0 + radius, Math.min(y, y1 - radius));
      const inRect = x >= x0 && x <= x1 && y >= y0 && y <= y1;
      const inCorner = (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
      if (!inRect && !inCorner) continue; // transparent

      const d1 = distToSeg(x, y, p1, p2);
      const d2 = distToSeg(x, y, p2, p3);
      const onStroke = Math.min(d1, d2) <= stroke / 2;
      if (onStroke) {
        buf[i] = 250;
        buf[i + 1] = 250;
        buf[i + 2] = 250;
      } else {
        buf[i] = 9;
        buf[i + 1] = 9;
        buf[i + 2] = 11;
      }
      buf[i + 3] = 255;
    }
  }

  // Box downsample big -> size.
  const out = Buffer.alloc(size * size * 4);
  const n = ss * ss;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          const i = ((y * ss + dy) * big + (x * ss + dx)) * 4;
          r += buf[i];
          g += buf[i + 1];
          b += buf[i + 2];
          a += buf[i + 3];
        }
      }
      const o = (y * size + x) * 4;
      if (a === 0) continue;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const path = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(path, encodePng(size, render(size)));
  console.log(`wrote ${path}`);
}
