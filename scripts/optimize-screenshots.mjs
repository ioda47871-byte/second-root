import sharp from "sharp";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = join(__dirname, "..", "public", "screenshots-source");

// These are real, unedited Brot Yanagi captures — this step only
// changes delivery encoding (PNG -> JPEG, or a lighter JPEG quality),
// which the project's standing rule explicitly allows ("OK: 縮小").
// No crop, no resize beyond what's already there, no content change.
const pngToJpeg = [
  { in: "exterior-photo-crop.png", out: "exterior-photo-crop.jpg" },
  { in: "entrance-photo-crop.png", out: "entrance-photo-crop.jpg" },
  { in: "menu-desktop.png", out: "menu-desktop.jpg" },
];

for (const job of pngToJpeg) {
  await sharp(join(dir, job.in)).jpeg({ quality: 88 }).toFile(join(dir, job.out));
  console.log("converted", job.in, "->", job.out);
}

// already JPEG, just re-encode at a slightly leaner quality
const reencode = ["access-mobile-portrait.jpeg", "home-mobile.jpeg"];
for (const f of reencode) {
  const tmp = join(dir, f + ".tmp");
  await sharp(join(dir, f)).jpeg({ quality: 85, mozjpeg: true }).toFile(tmp);
  const { rename } = await import("node:fs/promises");
  await rename(tmp, join(dir, f));
  console.log("re-encoded", f);
}

console.log("done");
