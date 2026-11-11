// A real, decodable lossless WebP (VP8L) of one solid colour, for integration and e2e fixtures (DEV-196d). Each
// call with a different size or colour gives different bytes, so image hashes stay unique per test run.
//
// The image uses no transform, no colour cache and no meta prefix codes; each of the five prefix codes is a
// "simple" code with one symbol, so every pixel takes zero bits (the same shape libwebp writes for a flat image).
// The file holds only RIFF / WEBP / VP8L: no EXIF, XMP or ICC (it passes checkFileBytes' metadata allowlist).

class BitWriter {
  private bytes: number[] = [];
  private acc = 0;
  private n = 0;
  write(value: number, bits: number) {
    for (let i = 0; i < bits; i++) {
      this.acc |= ((value >>> i) & 1) << this.n;
      this.n++;
      if (this.n === 8) {
        this.bytes.push(this.acc);
        this.acc = 0;
        this.n = 0;
      }
    }
  }
  done(): number[] {
    if (this.n > 0) this.bytes.push(this.acc);
    return this.bytes;
  }
}

export function solidWebp(width: number, height: number, rgba: [number, number, number, number] = [200, 120, 40, 255]): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096) throw new Error("size");
  const w = new BitWriter();
  w.write(0x2f, 8); // VP8L signature
  w.write(width - 1, 14);
  w.write(height - 1, 14);
  w.write(rgba[3] === 255 ? 0 : 1, 1); // alpha_is_used (a hint)
  w.write(0, 3); // version
  w.write(0, 1); // no transform
  w.write(0, 1); // no colour cache
  w.write(0, 1); // no meta prefix codes
  const [r, g, b, a] = rgba;
  for (const symbol of [g, r, b, a]) {
    w.write(1, 1); // simple code
    w.write(0, 1); // one symbol
    w.write(1, 1); // the symbol takes 8 bits
    w.write(symbol, 8);
  }
  // distance code: one symbol (0) written with 1 bit
  w.write(1, 1);
  w.write(0, 1);
  w.write(0, 1);
  w.write(0, 1);
  const vp8l = w.done();
  const pad = vp8l.length & 1;
  const riffSize = 4 + 8 + vp8l.length + pad;
  const out = Buffer.alloc(8 + riffSize);
  out.write("RIFF", 0, "latin1");
  out.writeUInt32LE(riffSize, 4);
  out.write("WEBP", 8, "latin1");
  out.write("VP8L", 12, "latin1");
  out.writeUInt32LE(vp8l.length, 16);
  Buffer.from(vp8l).copy(out, 20);
  return new Uint8Array(out);
}
