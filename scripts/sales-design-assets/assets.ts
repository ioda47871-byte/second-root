/**
 * Put a photo into the design asset store of a job, or list a job's photos
 * (DEV-029). A person runs this; the worker and Codex never add assets.
 *
 *   npm run -s sales:design-assets -- add --job-id <id> --file <photo.png|jpg|webp> --people none \
 *     --source generated_concept --created-by <handle> --created-at <ISO time>
 *   npm run -s sales:design-assets -- add --job-id <id> --file <photo> --people none \
 *     --source approved_real --consent-id <id of your own record> --approved-by <handle> \
 *     --approved-at <ISO time> --scope local_preview[,public_demo]
 *   npm run -s sales:design-assets -- list --job-id <id>
 *
 * The photo is drawn again by Chromium into a new PNG (no metadata survives).
 * Reference screenshots (Instagram / website captures) are refused. MVP: no
 * people in any photo, at most 3 photos per job, PNG / JPEG / WebP only.
 * Output: codes and asset ids only.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { CONSENT_SCOPES, type ConsentScope } from "../../lib/design-agent/assets/manifest";
import { assetStoreRoot, chromiumNormalizer, intakeAsset, IntakeError, loadManifest, type IntakeSource } from "../../lib/design-agent/assets/intake";

const REPO = resolve(__dirname, "../..");
process.umask(0o077);
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
};
const expand = (p: string) => resolve(p.replace(/^~(?=$|\/)/, homedir()));
const say = (line: string) => process.stdout.write(`${line}\n`);
const USAGE = "usage: add --job-id <id> --file <photo> --people none --source generated_concept|approved_real [...] | list --job-id <id>";

function source(): IntakeSource | null {
  const kind = flag("source");
  if (kind === "generated_concept") {
    const createdBy = flag("created-by");
    const createdAt = flag("created-at");
    return createdBy && createdAt ? { sourceKind: kind, createdBy, createdAt } : null;
  }
  if (kind === "approved_real") {
    const consentId = flag("consent-id");
    const approvedBy = flag("approved-by");
    const approvedAt = flag("approved-at");
    const scopes = (flag("scope") ?? "").split(",").filter(Boolean);
    if (!consentId || !approvedBy || !approvedAt || scopes.length === 0) return null;
    if (!scopes.every((s) => (CONSENT_SCOPES as readonly string[]).includes(s))) return null;
    return { sourceKind: kind, consentId, approvedBy, approvedAt, scopes: scopes as ConsentScope[] };
  }
  return null;
}

async function main(): Promise<number> {
  const command = argv[0];
  const jobId = flag("job-id") ?? "";
  const env = { ...process.env };
  const store = assetStoreRoot(env);
  if (command === "list") {
    const manifest = await loadManifest(store, jobId);
    if (!manifest) {
      say("NO_MANIFEST");
      return 1;
    }
    for (const a of manifest.assets) say(`${a.assetId} ${a.sourceKind} ${a.width}x${a.height}${a.sourceKind === "approved_real" ? ` scopes=${a.consent.scopes.join(",")}` : ""}`);
    return 0;
  }
  if (command !== "add") {
    say(USAGE);
    return 2;
  }
  const file = flag("file");
  const src = source();
  if (!file || !src) {
    say(USAGE);
    return 2;
  }
  const browser = await chromium.launch({ headless: true, ...(env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const normalize = chromiumNormalizer(async () => {
      const context = await browser.newContext({ javaScriptEnabled: true, offline: true });
      const page = await context.newPage();
      return { page, close: () => context.close() };
    });
    const { assetId } = await intakeAsset({ storeRoot: store, repoDir: REPO, env, jobId, file: expand(file), source: src, peopleConfirmedNone: flag("people") === "none", normalize });
    say(`ASSET_ADDED ${assetId}`);
    return 0;
  } catch (error) {
    if (error instanceof IntakeError) {
      say(`REFUSED ${error.code}`);
      return 1;
    }
    say("INTAKE_ERROR");
    return 1;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  () => {
    say("INTAKE_ERROR");
    process.exit(1);
  },
);
