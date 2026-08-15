import sharp from "sharp";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = join(__dirname, "..", "public", "brand-photos");

// desk-night-screen.png contains a laptop screen with a mismatched
// placeholder tagline in its pixels (x:940-1290, y:400-650). The only
// safe use is the clean left portion — crop that out as a real file,
// not just a CSS clip, so the full frame is never in the downloaded
// bytes at all.
await sharp(join(dir, "desk-night-screen.png"))
  .extract({ left: 0, top: 0, width: 750, height: 941 })
  .resize({ width: 840 })
  .jpeg({ quality: 82 })
  .toFile(join(dir, "desk-night-crop.jpg"));
console.log("cropped + optimized desk-night-crop.jpg");

const jobs = [
  { in: "desk-laptop-back-daylight.png", out: "desk-laptop-back-daylight.jpg", width: 1680 },
  { in: "wall-shadow-plant-a.png", out: "wall-shadow-plant-a.jpg", width: 1200 },
  { in: "table-shadow-empty.png", out: "table-shadow-empty.jpg", width: 1200 },
  { in: "office-room-wide.png", out: "office-room-wide.jpg", width: 1100 },
  { in: "notebook-wireframe-wide.png", out: "notebook-wireframe-wide.jpg", width: 1240 },
];

for (const job of jobs) {
  await sharp(join(dir, job.in))
    .resize({ width: job.width })
    .jpeg({ quality: 82 })
    .toFile(join(dir, job.out));
  console.log("optimized", job.out);
}
