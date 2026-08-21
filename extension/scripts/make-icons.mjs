/**
 * Generates the extension's raster icons.
 *
 * Written rather than checked in as binaries: the icon is a handful of shapes,
 * and a 40-line generator is easier to review, restyle and re-render at new
 * sizes than four opaque PNGs. Chrome needs raster icons here -- SVG is not
 * accepted for `action.default_icon` or for notification images -- so this
 * encodes PNG directly using Node's built-in zlib, with no image dependency.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
const SIZES = [16, 32, 48, 128];

const BLUE = [0x1f, 0x6f, 0xeb];
const WHITE = [0xff, 0xff, 0xff];

/* ---------- geometry, in normalised 0..1 icon space ---------- */

function insideRoundedRect(u, v, x0, y0, x1, y1, radius) {
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const cx = Math.min(Math.max(u, x0 + radius), x1 - radius);
  const cy = Math.min(Math.max(v, y0 + radius), y1 - radius);
  const dx = u - cx;
  const dy = v - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * A shield: rounded top corners, straight flanks, elliptical taper to a point.
 *
 * Expressed as a half-width per scanline rather than as a union of shapes. A
 * rounded rectangle joined to a taper leaves a visible notch at the shoulder,
 * because the rectangle's *bottom* corners round inward exactly where the
 * flanks should still be at full width.
 */
function insideShield(u, v) {
  const left = 0.25;
  const right = 0.75;
  const top = 0.18;
  const shoulder = 0.42;
  const tip = 0.86;
  const corner = 0.08;

  if (v < top || v > tip) return false;

  let halfWidth = (right - left) / 2;
  if (v <= shoulder) {
    if (v < top + corner) {
      const dy = top + corner - v;
      halfWidth -= corner - Math.sqrt(Math.max(0, corner * corner - dy * dy));
    }
  } else {
    // A circular falloff stays near full width for most of its run and reads
    // as a tombstone; this curve leaves the flanks steadily and comes to a
    // point, which is what makes the silhouette legible as a shield at 16px.
    const t = (v - shoulder) / (tip - shoulder);
    halfWidth *= Math.max(0, 1 - t) ** 0.55;
  }
  return Math.abs(u - 0.5) <= halfWidth;
}

/** A scanning slit across the shield, drawn only where it stays legible. */
function insideSlit(u, v, size) {
  if (size < 48) return false;
  return v > 0.355 && v < 0.415 && u > 0.325 && u < 0.675;
}

function colourAt(u, v, size) {
  if (!insideRoundedRect(u, v, 0, 0, 1, 1, 0.22)) return null; // transparent corner
  if (insideShield(u, v) && !insideSlit(u, v, size)) return WHITE;
  return BLUE;
}

/* ---------- rendering ---------- */

const SAMPLES = 4;

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const u = (x + (sx + 0.5) / SAMPLES) / size;
          const v = (y + (sy + 0.5) / SAMPLES) / size;
          const colour = colourAt(u, v, size);
          if (colour) {
            r += colour[0];
            g += colour[1];
            b += colour[2];
            a += 255;
          }
        }
      }
      const total = SAMPLES * SAMPLES;
      const offset = (y * size + x) * 4;
      // Pre-average colour over covered samples only, so edges blend against
      // the shape rather than toward black.
      const covered = a / 255;
      pixels[offset] = covered > 0 ? Math.round(r / covered) : 0;
      pixels[offset + 1] = covered > 0 ? Math.round(g / covered) : 0;
      pixels[offset + 2] = covered > 0 ? Math.round(b / covered) : 0;
      pixels[offset + 3] = Math.round(a / total);
    }
  }
  return pixels;
}

/* ---------- PNG encoding ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of SIZES) {
  const path = join(OUT, `icon-${size}.png`);
  writeFileSync(path, encodePng(size, render(size)));
  console.log(`${path}  ${size}x${size}`);
}
