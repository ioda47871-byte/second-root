/**
 * Strict PNG checks for the design-image PoC (DEV-074): the image Codex's
 * built-in image tool left in CODEX_HOME/generated_images/<thread>/ is
 * accepted only when it is a complete, well-formed PNG of a sane size.
 *
 * - opened without following a link (O_NOFOLLOW), a regular file, size cap
 * - signature, then a full chunk walk: every length inside the file, every
 *   chunk type four ASCII letters, every CRC correct
 * - IHDR first (13 bytes, valid bit depth / colour type, compression 0,
 *   filter 0, interlace 0/1), width and height inside the limits
 * - at least one IDAT, IEND last and empty, nothing after IEND
 *
 * Failures carry a fixed code only.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { crc32 } from "node:zlib";

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngLimits {
  maxBytes: number;
  minSide: number;
  maxSide: number;
  maxPixels: number;
}

/** The image tool's sizes are around 1024–1536 px a side; the limits leave room without accepting absurd files. */
export const MOCKUP_PNG_LIMITS: PngLimits = { maxBytes: 24 * 1024 * 1024, minSide: 512, maxSide: 8192, maxPixels: 40_000_000 };

export class PngError extends Error {
  constructor(readonly code: "CODEX_IMAGE_INVALID") {
    super(code);
    this.name = "PngError";
  }
}

export interface PngInfo {
  width: number;
  height: number;
  chunks: number;
}

/** Valid (colour type → bit depths) pairs from the PNG specification. */
const DEPTHS: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

const fail = (): never => {
  throw new PngError("CODEX_IMAGE_INVALID");
};

/** Checks a whole PNG in memory; returns its size and chunk count, or throws CODEX_IMAGE_INVALID. */
export function checkPng(bytes: Buffer, limits: PngLimits = MOCKUP_PNG_LIMITS): PngInfo {
  if (bytes.length > limits.maxBytes || bytes.length < PNG_SIGNATURE.length + 12 * 3 + 13) fail();
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) fail();
  let at = 8;
  let chunks = 0;
  let width = 0;
  let height = 0;
  let idat = 0;
  let ended = false;
  while (at < bytes.length) {
    if (ended) fail(); // trailing data after IEND
    if (at + 12 > bytes.length) fail(); // truncated chunk header / CRC
    const length = bytes.readUInt32BE(at);
    if (length > 0x7fffffff || at + 12 + length > bytes.length) fail();
    const type = bytes.subarray(at + 4, at + 8);
    if (!/^[A-Za-z]{4}$/.test(type.toString("latin1"))) fail();
    const data = bytes.subarray(at + 8, at + 8 + length);
    const crc = bytes.readUInt32BE(at + 8 + length);
    if ((crc32(Buffer.concat([type, data])) >>> 0) !== crc) fail();
    const name = type.toString("latin1");
    if (chunks === 0) {
      if (name !== "IHDR" || length !== 13) fail();
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8]!;
      const colour = data[9]!;
      if (!(DEPTHS[colour] ?? []).includes(depth) || data[10] !== 0 || data[11] !== 0 || (data[12] !== 0 && data[12] !== 1)) fail();
      if (width < limits.minSide || height < limits.minSide || width > limits.maxSide || height > limits.maxSide) fail();
      if (width * height > limits.maxPixels) fail();
    } else if (name === "IHDR") {
      fail();
    }
    if (name === "IDAT") idat += 1;
    if (name === "IEND") {
      if (length !== 0) fail();
      ended = true;
    }
    chunks += 1;
    at += 12 + length;
  }
  if (!ended || idat === 0) fail();
  return { width, height, chunks };
}

/** Reads a PNG without following a link: a regular file within the size cap, then checkPng. */
export async function readPngNoFollow(path: string, limits: PngLimits = MOCKUP_PNG_LIMITS): Promise<{ bytes: Buffer } & PngInfo> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return fail();
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limits.maxBytes) fail();
    const bytes = await handle.readFile();
    return { bytes, ...checkPng(bytes, limits) };
  } finally {
    await handle.close();
  }
}
