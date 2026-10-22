import { chmod, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { chromium, type Browser } from "playwright";

// DEV-082 test helpers: a flat-colour PNG encoder (no AI image, no photo),
// private temp dirs and Chromium. Fictional shop only; nothing is fetched.

const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
};

/** A flat RGB PNG of one colour (8-bit, non-interlaced). */
export function flatPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

export async function privateTemp(prefix: string): Promise<string> {
  const base = process.env.TMPDIR || tmpdir();
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, prefix));
  await chmod(dir, 0o700);
  return dir;
}

export const REPO = process.cwd();
export const FIXTURE = join(REPO, "scripts/sales-design-worker/comp-impl/synthetic-wagashi");
export const FACTS_SOURCE = join(REPO, "scripts/sales-design-worker/compare/shops/wagashi.json");

/** A copy of the synthetic page in a temp dir, to change for a failing case. */
export async function pageCopy(prefix: string): Promise<string> {
  const dir = await privateTemp(prefix);
  await cp(join(FIXTURE, "page"), dir, { recursive: true });
  return dir;
}

export const removeDir = (dir: string) => rm(dir, { recursive: true, force: true });

export function launch(): Promise<Browser> {
  return chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
}
