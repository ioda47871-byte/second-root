import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = join(__dirname, "..", "app");
const iconsDir = join(__dirname, "..", "public", "icons");

// A slightly heavier stroke than the on-page nav mark, since the thin
// 2.5px line reads as a blur at favicon sizes — this is a raster-only
// adjustment; the live site's SVG mark (app/icon.svg) is untouched.
const svg = `<svg width="256" height="256" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <rect width="64" height="64" fill="#FAFAF8"/>
  <line x1="32" y1="8" x2="32" y2="42" stroke="#355E4C" stroke-width="4.5" stroke-linecap="round"/>
  <circle cx="32" cy="50" r="6.5" fill="#355E4C"/>
</svg>`;
const svgBuffer = Buffer.from(svg);

function pngToIco(pngBuffer, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count

  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
  entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
  entry.writeUInt8(0, 2); // color palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuffer.length, 8); // image data size
  entry.writeUInt32LE(22, 12); // offset (6 header + 16 entry)

  return Buffer.concat([header, entry, pngBuffer]);
}

// favicon.ico — a 32x32 PNG embedded in a minimal single-image ICO
// container (the modern, widely-supported approach; sharp itself has
// no ICO encoder so the container is built by hand here).
const favicon32 = await sharp(svgBuffer).resize(32, 32).png().toBuffer();
await writeFile(join(appDir, "favicon.ico"), pngToIco(favicon32, 32));

// apple-touch-icon — 180x180 PNG, Apple explicitly wants no transparency
await sharp(svgBuffer).resize(180, 180).flatten({ background: "#FAFAF8" }).png().toFile(join(appDir, "apple-icon.png"));

// manifest icons — must live under public/ to be fetchable by URL,
// unlike favicon.ico/apple-icon.png/icon.svg which Next.js serves
// directly from app/ via its special file-name conventions
import { mkdir } from "node:fs/promises";
await mkdir(iconsDir, { recursive: true });
await sharp(svgBuffer).resize(192, 192).png().toFile(join(iconsDir, "icon-192.png"));
await sharp(svgBuffer).resize(512, 512).png().toFile(join(iconsDir, "icon-512.png"));

console.log("done");
