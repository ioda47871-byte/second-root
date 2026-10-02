import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import type { PhotoAnalysis } from "@/lib/design-agent/assets/analysis";
import { AssetManifestSchema, type AssetManifest, type AssetRecord, type SourceKind } from "@/lib/design-agent/assets/manifest";

// Fictional photos for the DEV-029 tests, encoded here as PNG: gradients with
// soft discs (quiet) or many small dots (busy). No real shop, product or
// person, and nothing is stored in the repository.

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

export function fakePng(width: number, height: number, options: { busy?: boolean; seed?: number } = {}): Buffer {
  const seed = options.seed ?? 1;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const discs = options.busy
    ? Array.from({ length: 90 }, (_, i) => ({ x: ((i * 97 + seed * 31) % 100) / 100, y: ((i * 61 + seed * 17) % 100) / 100, r: 0.02 + ((i * 13) % 5) / 200 }))
    : [{ x: 0.5, y: 0.45, r: 0.22 }];
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      let r = 200 - 80 * v + seed * 7;
      let g = 170 - 60 * u;
      let b = 140 - 50 * v + seed * 3;
      for (const d of discs) {
        const dx = (u - d.x) * (width / Math.max(width, height));
        const dy = (v - d.y) * (height / Math.max(width, height));
        if (dx * dx + dy * dy < d.r * d.r) {
          r = 120;
          g = 60 + seed * 5;
          b = 50;
        }
      }
      const at = row + 1 + x * 3;
      raw[at] = Math.max(0, Math.min(255, r));
      raw[at + 1] = Math.max(0, Math.min(255, g));
      raw[at + 2] = Math.max(0, Math.min(255, b));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}

export const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString("base64")}`;

export type FakeAsset = { id: string; png: Buffer; sourceKind: SourceKind; scopes?: ("local_preview" | "public_demo")[] };

export function fakeRecord(a: FakeAsset): AssetRecord {
  const width = a.png.readUInt32BE(16);
  const height = a.png.readUInt32BE(20);
  const common = {
    assetId: a.id,
    file: `${a.id}.png`,
    sha256: createHash("sha256").update(a.png).digest("hex"),
    width,
    height,
    bytes: a.png.length,
    intakeAt: "2026-10-02T09:00:00Z",
    people: "none" as const,
  };
  return a.sourceKind === "generated_concept"
    ? { ...common, sourceKind: "generated_concept", generation: { method: "human_upload", createdBy: "designer", createdAt: "2026-10-02T09:00:00Z" } }
    : { ...common, sourceKind: "approved_real", consent: { consentId: "consent-001", approvedBy: "sales-admin", approvedAt: "2026-10-02T09:00:00Z", scopes: a.scopes ?? ["local_preview"] } };
}

export function fakeManifest(jobId: string, assets: FakeAsset[]): AssetManifest {
  return AssetManifestSchema.parse({ version: 1, jobId, assets: assets.map(fakeRecord) });
}

export function fakeAnalysis(assetId: string, over: Partial<PhotoAnalysis> = {}): PhotoAnalysis {
  return {
    assetId,
    subject: "product_closeup",
    people: false,
    containsText: false,
    orientation: "portrait",
    quality: "ok",
    busy: "quiet",
    dominantColors: ["#F4E8D2", "#761D27", "#B08A5A"],
    focal: { x: 0.5, y: 0.45 },
    suitability: { hero: 5, feature: 4 },
    brandFit: 4,
    nearDuplicateOf: null,
    ...over,
  };
}

/** Writes a job's photos and manifest into an asset store (0700 / 0600, like intake). */
export async function writeStore(store: string, jobId: string, assets: FakeAsset[], manifest = fakeManifest(jobId, assets)): Promise<void> {
  const dir = join(store, jobId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const a of assets) await writeFile(join(dir, `${a.id}.png`), a.png, { mode: 0o600 });
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
}
