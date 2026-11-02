/**
 * DEV-154 (Issue #193): write the success-originals inventory (offline, read-only on the manifest and images).
 *
 *   npx tsx scripts/design-artifact/reference-inventory.ts [--check]
 *
 * Writes design-library/research/quality-pipeline/originals-inventory.json. With --check, writes nothing and exits 1
 * when the committed file differs from what the manifest and the images give now.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildInventory, type ManifestRecord } from "../../lib/design-agent/reference-originals/inventory";

const REPO = resolve(__dirname, "../..");
const MANIFEST = "design-library/success-cases/manifest.json";
const ASSETS = "design-library/success-cases/assets";
const OUT = "design-library/research/quality-pipeline/originals-inventory.json";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export function currentInventoryText(): string {
  const raw = readFileSync(join(REPO, MANIFEST));
  const manifest = JSON.parse(raw.toString("utf8")) as { records: ManifestRecord[] };
  const files = readdirSync(join(REPO, ASSETS))
    .filter((f) => /\.(png|webp|jpe?g)$/i.test(f))
    .map((f) => ({ path: `${ASSETS}/${f}`, sha256: sha(readFileSync(join(REPO, ASSETS, f))) }));
  return `${JSON.stringify(buildInventory({ manifestSha256: sha(raw), records: manifest.records, files }), null, 2)}\n`;
}

if (require.main === module) {
  const text = currentInventoryText();
  if (process.argv.includes("--check")) {
    let committed = "";
    try {
      committed = readFileSync(join(REPO, OUT), "utf8");
    } catch {
      /* missing counts as different */
    }
    if (committed !== text) {
      process.stdout.write("INVENTORY_STALE: run npx tsx scripts/design-artifact/reference-inventory.ts\n");
      process.exit(1);
    }
    process.stdout.write("INVENTORY_OK\n");
  } else {
    mkdirSync(join(REPO, "design-library/research/quality-pipeline"), { recursive: true });
    writeFileSync(join(REPO, OUT), text);
    process.stdout.write(`${OUT}\n`);
  }
}
