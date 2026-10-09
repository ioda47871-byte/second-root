import { inflateSync } from "node:zlib";

// Was a photo actually painted in a screenshot? (DEV-029, poc-photo-004: the
// About photo was loaded but painted as an empty frame on mobile.) Reads the
// 8-bit RGB / RGBA, non-interlaced PNGs Chromium writes, and counts the
// distinct colours (16 levels per channel) in the middle of a box: an empty
// frame is one flat colour, a photo is many. Used by the production preview
// check, whose fixture photos are known not to be flat.

export type Pixels = { width: number; height: number; channels: number; data: Buffer };

export function decodePng(png: Buffer): Pixels {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colour = data[9];
      const interlace = data[12];
      if (depth !== 8 || (colour !== 2 && colour !== 6) || interlace !== 0) throw new Error("unsupported PNG");
      channels = colour === 2 ? 3 : 4;
    } else if (type === "IDAT") idat.push(data);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[row + x - channels]! : 0;
      const b = y > 0 ? out[row - stride + x]! : 0;
      const c = x >= channels && y > 0 ? out[row - stride + x - channels]! : 0;
      let v = raw[src + x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[row + x] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}

/** Distinct colours in the middle 60 % of a CSS-pixel box (scale: device pixels per CSS pixel). */
export function colourVariety(px: Pixels, box: { top: number; bottom: number; left: number; right: number }, scale: number): number {
  const w = box.right - box.left;
  const h = box.bottom - box.top;
  const x0 = Math.max(0, Math.floor((box.left + w * 0.2) * scale));
  const x1 = Math.min(px.width, Math.floor((box.right - w * 0.2) * scale));
  const y0 = Math.max(0, Math.floor((box.top + h * 0.2) * scale));
  const y1 = Math.min(px.height, Math.floor((box.bottom - h * 0.2) * scale));
  const seen = new Set<number>();
  const step = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 40));
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * px.width + x) * px.channels;
      seen.add(((px.data[i]! >> 4) << 8) | ((px.data[i + 1]! >> 4) << 4) | (px.data[i + 2]! >> 4));
    }
  }
  return seen.size;
}
