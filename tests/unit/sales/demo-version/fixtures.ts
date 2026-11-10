import { createHash } from "node:crypto";

export const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/** A minimal WebP (RIFF/WEBP/VP8X) header of the given size; `flags` sets VP8X flags (0x08 EXIF, 0x04 XMP). */
export function webp(width: number, height: number, flags = 0): Uint8Array {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8, "latin1");
  b.write("VP8X", 12, "latin1");
  b.writeUInt32LE(10, 16);
  b[20] = flags;
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return new Uint8Array(b);
}

/** A minimal JPEG: SOI, optional APP1 Exif, SOF0 with the size, EOI. */
export function jpeg(width: number, height: number, o: { exif?: boolean } = {}): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  if (o.exif) {
    // APP1 "Exif\0\0" + a little-endian TIFF header with no IFD entries
    const tiff = [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00];
    const body = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
    const len = body.length + 2;
    parts.push(0xff, 0xe1, len >> 8, len & 0xff, ...body);
  }
  parts.push(0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  parts.push(0xff, 0xd9);
  return new Uint8Array(parts);
}

export const VERSION_ID = "11111111-2222-4333-8444-555555555555";
export const DEMO_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
/** A test key (not a secret: fixed bytes for tests only). */
export const KEY = new Uint8Array(32).fill(7);
export const OTHER_KEY = new Uint8Array(32).fill(9);
