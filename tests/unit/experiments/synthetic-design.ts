import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUTO_DESIGN_PICTURES } from "@/experiments/pages-cms/auto-site";
import { DESIGN_RECORD } from "@/experiments/pages-cms/photos";
import { AUTO_SITE, type ShopSite } from "@/experiments/pages-cms/shop-site";

// PR #390 (the repository's image lock): no design picture is committed. The tests make SYNTHETIC stand-ins on the fly
// — a JPEG start-of-frame header (1086×724, the owner's pictures' size) padded with a per-file byte, so each has its own
// SHA-256 — and a test-only record in the same schema and with the same `source` shape as the committed one.

/** A header-only JPEG (the photo checks read the header and the byte count; nothing decodes it). */
export function syntheticJpeg(fill: number, w = 1086, h = 724, bytes = 4096): Buffer {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03]);
  return Buffer.concat([head, Buffer.alloc(bytes - head.length, fill)]);
}

export const SYNTHETIC_SOURCE = { supplied_by: "owner", made_with: "ChatGPT (owner side)", model: null, prompt: null, received_on: "2026-11-28" } as const;

/** Writes the synthetic design pictures (under the record's names) and their record into <dir>; returns the file → bytes. */
export function writeSyntheticDesign(dir: string): Record<string, Buffer> {
  mkdirSync(dir, { recursive: true });
  const files = [...new Set(AUTO_DESIGN_PICTURES.map((p) => p.file))].sort();
  const bytes = Object.fromEntries(files.map((f, k) => [f, syntheticJpeg(0x10 + k)]));
  for (const [f, b] of Object.entries(bytes)) writeFileSync(join(dir, f), b);
  const record = { schema: "generated_materials_v1", files: files.map((f) => ({ file: f, sha256: createHash("sha256").update(bytes[f]!).digest("hex"), source: SYNTHETIC_SOURCE })) };
  writeFileSync(join(dir, DESIGN_RECORD), `${JSON.stringify(record, null, 2)}\n`);
  return bytes;
}

/** The car-care site with its design record and pictures in <dir> (synthetic). */
export const autoSiteWithDesign = (dir: string): ShopSite => ({ ...AUTO_SITE, design: { ...AUTO_SITE.design!, dir } });
