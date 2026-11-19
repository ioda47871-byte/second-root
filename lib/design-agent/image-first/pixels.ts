/**
 * Issue #293 P1: the pixel steps of a section-sequence comp — scale each part to the viewport's CSS width, stack the
 * parts into one composite, encode it as a PNG. Pure (memory only). Decoding reuses the worker's reader (8-bit RGB /
 * RGBA, non-interlaced: what Chromium and the image tool write); anything else is refused by the caller.
 */
import { crc32, deflateSync } from "node:zlib";
import { decodePng, type Pixels } from "../worker/png-paint";

/** RGB, 3 bytes a pixel, alpha already composited on white. */
export type RgbImage = { width: number; height: number; data: Buffer };

/** Decodes a PNG to RGB (alpha composited on white, as the comparison's grids do), or null when it cannot be read. */
export function decodeRgb(png: Buffer): RgbImage | null {
  let p: Pixels;
  try {
    p = decodePng(png);
  } catch {
    return null;
  }
  if (!(p.width > 0 && p.height > 0) || p.data.length !== p.width * p.height * p.channels) return null;
  const out = Buffer.alloc(p.width * p.height * 3);
  for (let i = 0, o = 0; i < p.data.length; i += p.channels, o += 3) {
    const a = p.channels === 4 ? p.data[i + 3]! / 255 : 1;
    for (let c = 0; c < 3; c++) out[o + c] = Math.round(p.data[i + c]! * a + 255 * (1 - a));
  }
  return { width: p.width, height: p.height, data: out };
}

/**
 * Scales to exactly `width` px wide (height rounded, at least 1): an area average when shrinking, bilinear when
 * enlarging. The scale factor is width / source width.
 */
export function scaleToWidth(src: RgbImage, width: number): RgbImage {
  const height = Math.max(1, Math.round((src.height * width) / src.width));
  const out = Buffer.alloc(width * height * 3);
  const sx = src.width / width;
  const sy = src.height / height;
  if (sx >= 1 && sy >= 1) {
    for (let y = 0; y < height; y++) {
      const y0 = Math.floor(y * sy);
      const y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((y + 1) * sy)));
      for (let x = 0; x < width; x++) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((x + 1) * sx)));
        let r = 0;
        let g = 0;
        let b = 0;
        for (let yy = y0; yy < y1; yy++)
          for (let xx = x0; xx < x1; xx++) {
            const i = (yy * src.width + xx) * 3;
            r += src.data[i]!;
            g += src.data[i + 1]!;
            b += src.data[i + 2]!;
          }
        const n = (y1 - y0) * (x1 - x0);
        const o = (y * width + x) * 3;
        out[o] = Math.round(r / n);
        out[o + 1] = Math.round(g / n);
        out[o + 2] = Math.round(b / n);
      }
    }
    return { width, height, data: out };
  }
  for (let y = 0; y < height; y++) {
    const fy = Math.min(src.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(src.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const tx = fx - x0;
      const o = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) {
        const p00 = src.data[(y0 * src.width + x0) * 3 + c]!;
        const p01 = src.data[(y0 * src.width + x1) * 3 + c]!;
        const p10 = src.data[(y1 * src.width + x0) * 3 + c]!;
        const p11 = src.data[(y1 * src.width + x1) * 3 + c]!;
        out[o + c] = Math.round((p00 * (1 - tx) + p01 * tx) * (1 - ty) + (p10 * (1 - tx) + p11 * tx) * ty);
      }
    }
  }
  return { width, height, data: out };
}

/** Stacks pictures of the same width top to bottom. */
export function stack(parts: readonly RgbImage[]): RgbImage {
  const width = parts[0]!.width;
  if (parts.some((p) => p.width !== width)) throw new Error("parts differ in width");
  return { width, height: parts.reduce((h, p) => h + p.height, 0), data: Buffer.concat(parts.map((p) => p.data)) };
}

/** Encodes RGB as an 8-bit truecolour PNG (filter 0 rows), which decodePng and Chromium both read. */
export function encodePng(img: RgbImage): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, "latin1");
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = img.width * 3;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) img.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Mean colour of `cols` cells across a band of rows [y0, y1) (for seam checks). */
export function bandCells(img: RgbImage, y0: number, y1: number, cols: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let c = 0; c < cols; c++) {
    const x0 = Math.floor((c * img.width) / cols);
    const x1 = Math.max(x0 + 1, Math.floor(((c + 1) * img.width) / cols));
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * img.width + x) * 3;
        r += img.data[i]!;
        g += img.data[i + 1]!;
        b += img.data[i + 2]!;
        n++;
      }
    out.push(n ? [r / n, g / n, b / n] : [255, 255, 255]);
  }
  return out;
}

/**
 * Whether `needle` occurs pixel-for-pixel inside `hay` (an un-scaled crop). Candidate positions are those whose top-left
 * pixel matches; each is confirmed on a few sample points and then fully. Small needles (< 16 px a side) are not searched.
 */
export function containsExactCrop(hay: RgbImage, needle: RgbImage): boolean {
  if (needle.width < 16 || needle.height < 16 || needle.width > hay.width || needle.height > hay.height) return false;
  const px = (img: RgbImage, x: number, y: number) => (y * img.width + x) * 3;
  const same = (x: number, y: number, nx: number, ny: number) => {
    const a = px(hay, x + nx, y + ny);
    const b = px(needle, nx, ny);
    return hay.data[a] === needle.data[b] && hay.data[a + 1] === needle.data[b + 1] && hay.data[a + 2] === needle.data[b + 2];
  };
  const samples: [number, number][] = [
    [needle.width - 1, 0],
    [0, needle.height - 1],
    [needle.width - 1, needle.height - 1],
    [needle.width >> 1, needle.height >> 1],
    [needle.width >> 2, (3 * needle.height) >> 2],
  ];
  for (let y = 0; y + needle.height <= hay.height; y++)
    for (let x = 0; x + needle.width <= hay.width; x++) {
      if (!same(x, y, 0, 0) || !samples.every(([nx, ny]) => same(x, y, nx, ny))) continue;
      let all = true;
      for (let ny = 0; ny < needle.height && all; ny++) {
        const a = px(hay, x, y + ny);
        const b = px(needle, 0, ny);
        if (!hay.data.subarray(a, a + needle.width * 3).equals(needle.data.subarray(b, b + needle.width * 3))) all = false;
      }
      if (all) return true;
    }
  return false;
}
