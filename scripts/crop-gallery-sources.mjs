import sharp from "sharp";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, "..", "public", "screenshots-source");

// Straight rectangular crops that trim each capture down to just the
// photographed content — excluding the site header/footer chrome and a
// floating demo-tool badge baked into the pixels near each photo's edge.
// No content inside the kept region is touched, resized, or redrawn.
const jobs = [
  { in: "exterior-photo.png", out: "exterior-photo-crop.png", left: 100, top: 95, width: 825, height: 625 },
  { in: "entrance-photo.png", out: "entrance-photo-crop.png", left: 95, top: 95, width: 830, height: 640 },
  { in: "interior-photo.jpeg", out: "interior-photo-crop.jpeg", left: 40, top: 322, width: 608, height: 833 },
];

for (const job of jobs) {
  await sharp(join(srcDir, job.in))
    .extract({ left: job.left, top: job.top, width: job.width, height: job.height })
    .toFile(join(srcDir, job.out));
  console.log("cropped", job.out, job.width, "x", job.height);
}
