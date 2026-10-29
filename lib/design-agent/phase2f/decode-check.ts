/**
 * Phase 2f-1: the real decode of a captured PNG (what DEV-114's structural
 * check does not do). It inflates and unfilters the pixels with the worker's
 * PNG reader (8-bit RGB / RGBA, as Chromium writes them), confirms the decoded
 * size, and counts distinct colours over the whole picture: a page that
 * rendered nothing (one flat colour, or almost) is caught here.
 *
 * Only for screenshots the runner itself just captured; never a quality judgement.
 */
import { decodePng } from "../worker/png-paint";

/** Fewer distinct colours (16 levels per channel) than this over the whole page means it rendered blank. */
export const MIN_DISTINCT_COLOURS = 4;
/** Pixels sampled per axis at most (bounded work on a 1440 × 16000 page). */
const SAMPLES = 400;

export type DecodeResult =
  | { ok: true; width: number; height: number; distinctColours: number }
  | { ok: false; code: "RENDER_UNDECODABLE" | "RENDER_UNSUPPORTED_FORMAT" | "RENDER_SIZE_MISMATCH" | "RENDER_BLANK"; width?: number; height?: number };

/** Decodes and checks a PNG whose width must be `expectedWidth` (its height is what it is). */
export function decodeCheck(png: Buffer, expectedWidth: number): DecodeResult {
  let px;
  try {
    px = decodePng(png);
  } catch (e) {
    // the reader handles 8-bit RGB / RGBA only (Chromium's screenshots); another valid format is not a broken image
    return { ok: false, code: e instanceof Error && e.message === "unsupported PNG" ? "RENDER_UNSUPPORTED_FORMAT" : "RENDER_UNDECODABLE" };
  }
  if (px.width !== expectedWidth) return { ok: false, code: "RENDER_SIZE_MISMATCH", width: px.width, height: px.height };
  const seen = new Set<number>();
  const sx = Math.max(1, Math.floor(px.width / SAMPLES));
  const sy = Math.max(1, Math.floor(px.height / SAMPLES));
  for (let y = 0; y < px.height; y += sy) {
    for (let x = 0; x < px.width; x += sx) {
      const i = (y * px.width + x) * px.channels;
      seen.add(((px.data[i]! >> 4) << 8) | ((px.data[i + 1]! >> 4) << 4) | (px.data[i + 2]! >> 4));
    }
  }
  if (seen.size < MIN_DISTINCT_COLOURS) return { ok: false, code: "RENDER_BLANK", width: px.width, height: px.height };
  return { ok: true, width: px.width, height: px.height, distinctColours: seen.size };
}
