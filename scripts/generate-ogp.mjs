import sharp from "sharp";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, "..", "public");
const outPath = join(publicDir, "og-image.jpg");

const W = 1200, H = 630;

// same visual language as the site's own photo-band: a left-anchored
// warm scrim over the Hero photo, with the wordmark and tagline resting
// in the resulting whitespace — a placeholder until real photography
// replaces it (see task note in layout.tsx metadata).
const overlay = `
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="scrim" x1="0%" y1="0%" x2="75%" y2="10%">
      <stop offset="0%" stop-color="#FBFAF6" stop-opacity="0.97"/>
      <stop offset="34%" stop-color="#FBFAF6" stop-opacity="0.9"/>
      <stop offset="58%" stop-color="#FBFAF6" stop-opacity="0.5"/>
      <stop offset="80%" stop-color="#FBFAF6" stop-opacity="0.05"/>
      <stop offset="100%" stop-color="#FBFAF6" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#scrim)"/>
  <text x="72" y="330" font-family="'Zen Old Mincho','Yu Mincho','Hiragino Mincho ProN','Noto Serif JP',serif" font-size="30" letter-spacing="6" fill="#6F675E">SECOND ROOT</text>
  <text x="70" y="400" font-family="'Zen Old Mincho','Yu Mincho','Hiragino Mincho ProN','Noto Serif JP',serif" font-size="64" font-weight="500" fill="#1F1A16">事業に、もう一つの根を。</text>
  <text x="72" y="450" font-family="'Noto Sans JP','Hiragino Sans','Yu Gothic',sans-serif" font-size="24" fill="#6F675E">地域のお店のホームページ制作 — Second Root</text>
</svg>`;

await sharp(join(publicDir, "brand-photos", "desk-laptop-back-daylight.jpg"))
  .resize(W, H, { fit: "cover", position: "right" })
  .composite([{ input: Buffer.from(overlay), top: 0, left: 0 }])
  .jpeg({ quality: 88 })
  .toFile(outPath);

console.log("done:", outPath);
