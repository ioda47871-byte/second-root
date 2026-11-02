/**
 * DEV-155 (Issue #193): the read-only image reference lane for success-case originals. Offline: no Codex, no model, no
 * network (Chromium, when used, only decodes a local WebP with requests refused).
 *
 *   --intake --case <CP-NNN> --key <manifest SHA key> --file <picture> --out <new record.json>
 *       The picture's SHA-256 must equal the one the manifest records under that key (else SHA_MISMATCH: nothing is
 *       written). PNG is decoded here; WebP (the in-repo previews) is decoded by drawing it once in Chromium at its own
 *       size. Writes only a record (SHA, size, view, provenance, measured features): never the picture. The repository is
 *       public: supplied originals stay outside it.
 *
 *   --check-observation --record <record.json> --observation <observation.json>
 *       The written observation must be of exactly that picture (SHA, case, view) and every box must lie inside it.
 *
 * Exit: 0 done, 2 refused.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { chromium } from "playwright";
import { decodePng } from "../../lib/design-agent/worker/png-paint";
import { measureOriginal } from "../../lib/design-agent/reference-originals/features";
import { inventoryCase, type ManifestRecord } from "../../lib/design-agent/reference-originals/inventory";
import { checkObservation, ReferenceRecord } from "../../lib/design-agent/reference-originals/observation";

process.umask(0o077);
const REPO = resolve(__dirname, "../..");
const MANIFEST = "design-library/success-cases/manifest.json";
const say = (o: object) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
const refuse = (code: string, extra: object = {}) => (say({ status: "refused", code, ...extra }), 2);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const MODES = new Set(["--intake", "--check-observation"]);
const VALUES = new Set(["--case", "--key", "--file", "--out", "--record", "--observation"]);
function args(argv: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (MODES.has(a)) m.set(a, "");
    else if (VALUES.has(a) && i + 1 < argv.length && !argv[i + 1]!.startsWith("--") && !m.has(a)) m.set(a, argv[++i]!);
    else return new Map([["--bad", a]]);
  }
  return m;
}
const readOr = (path: string): Buffer | null => {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
};

/**
 * Draws a WebP once at its own size in Chromium and returns PNG bytes. Every request is refused. A first page (with
 * JavaScript, about:blank, running only this file's own evaluate) reads the picture's size; the drawing page has
 * JavaScript off. Playwright starts Chromium without its OS sandbox; only pictures whose SHA-256 the manifest records
 * ever reach this function (the SHA is checked first).
 */
async function webpToPng(bytes: Buffer): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  try {
    const probe = await browser.newPage({ javaScriptEnabled: true });
    await probe.route("**/*", (r) => r.abort());
    const size = await probe.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/webp;base64,${b64}`;
      await img.decode();
      return { w: img.naturalWidth, h: img.naturalHeight };
    }, bytes.toString("base64"));
    await probe.close();
    const page = await browser.newPage({ viewport: { width: size.w, height: size.h }, deviceScaleFactor: 1, javaScriptEnabled: false });
    await page.route("**/*", (r) => r.abort());
    await page.setContent(`<!doctype html><html><body style="margin:0"><img style="display:block" src="data:image/webp;base64,${bytes.toString("base64")}"></body></html>`);
    return await page.screenshot({ fullPage: true, clip: { x: 0, y: 0, width: size.w, height: size.h } });
  } finally {
    await browser.close();
  }
}

async function intake(a: Map<string, string>): Promise<number> {
  const id = a.get("--case");
  const key = a.get("--key");
  const file = a.get("--file");
  const out = a.get("--out");
  if (!id || !key || !file || !out) return refuse("USAGE");
  const manifest = JSON.parse(readFileSync(resolve(REPO, MANIFEST), "utf8")) as { records: ManifestRecord[] };
  const record = manifest.records.find((r) => r.id === id);
  if (!record) return refuse("CASE_UNKNOWN");
  const expected = record[key];
  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected) || !/sha256$/.test(key)) return refuse("KEY_UNKNOWN");
  // only the adopted picture (or its registered preview) is a success reference; comparisons, earlier and rejected
  // versions are counter-examples
  const ref = inventoryCase(record, []).originals.find((o) => o.key === key);
  if (!ref || (ref.kind !== "original" && ref.kind !== "registered_preview")) return refuse("NOT_A_SUCCESS_PICTURE", { kind: ref?.kind ?? null });
  if (existsSync(resolve(out))) return refuse("OUT_EXISTS");
  const bytes = readOr(resolve(file));
  if (!bytes) return refuse("FILE_UNREADABLE");
  const actual = sha(bytes);
  if (actual !== expected) return refuse("SHA_MISMATCH", { expected, actual });
  let png: Buffer;
  let format: "png" | "webp";
  if (bytes.readUInt32BE(0) === 0x89504e47) [png, format] = [bytes, "png"];
  else if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") [png, format] = [await webpToPng(bytes), "webp"];
  else return refuse("FORMAT_UNSUPPORTED");
  const px = decodePng(png);
  const rel = relative(REPO, resolve(file));
  const inRepo = !rel.startsWith("..") && rel.startsWith("design-library/success-cases/assets/") ? rel : null;
  const doc = {
    schema: "reference_original_record_v0",
    case_id: id,
    key,
    kind: ref.kind,
    view: ref.view,
    image_sha256: actual,
    recorded_sha256_matches: true,
    format,
    decoded_via: format === "png" ? "png_decoder" : "chromium_draw_at_natural_size",
    width: px.width,
    height: px.height,
    provenance: { status: String(record.status ?? ""), source_kind: String(record.source_kind ?? ""), view: String(record.view ?? ""), in_repo_path: inRepo, picture_committed_by_this_lane: false },
    features: measureOriginal(png, px),
  };
  writeFileSync(resolve(out), `${JSON.stringify(doc, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  say({ status: "recorded", out: resolve(out), case_id: id, view: ref.view, width: px.width, height: px.height, bands: doc.features.bands.length });
  return 0;
}

function checkObs(a: Map<string, string>): number {
  const rec = a.get("--record");
  const obs = a.get("--observation");
  if (!rec || !obs) return refuse("USAGE");
  const recText = readOr(resolve(rec));
  const obsText = readOr(resolve(obs));
  if (!recText || !obsText) return refuse("FILE_UNREADABLE");
  let parsedRecord: unknown;
  let parsedObservation: unknown;
  try {
    parsedRecord = JSON.parse(recText.toString("utf8"));
    parsedObservation = JSON.parse(obsText.toString("utf8"));
  } catch {
    return refuse("JSON_INVALID");
  }
  const record = ReferenceRecord.safeParse(parsedRecord);
  if (!record.success) return refuse("RECORD_INVALID");
  // the record's picture must still be the one the manifest records under its key
  const manifest = JSON.parse(readFileSync(resolve(REPO, MANIFEST), "utf8")) as { records: ManifestRecord[] };
  const entry = manifest.records.find((x) => x.id === record.data.case_id);
  if (!entry || entry[record.data.key] !== record.data.image_sha256) return refuse("RECORD_NOT_IN_MANIFEST");
  // kind and view are derived from the manifest key again, never taken from the record as written
  const ref = inventoryCase(entry, []).originals.find((o) => o.key === record.data.key);
  if (!ref || (ref.kind !== "original" && ref.kind !== "registered_preview") || ref.kind !== record.data.kind || ref.view !== record.data.view)
    return refuse("RECORD_NOT_A_SUCCESS_PICTURE", { kind: ref?.kind ?? null, view: ref?.view ?? null });
  const r = checkObservation(parsedObservation, record.data);
  if (!r.ok) return refuse("OBSERVATION_INVALID", { codes: r.codes });
  say({ status: "ok" });
  return 0;
}

async function main(): Promise<number> {
  const a = args(process.argv.slice(2));
  if (a.has("--bad")) return refuse("USAGE");
  if (a.has("--intake") === a.has("--check-observation")) return refuse("USAGE");
  return a.has("--intake") ? intake(a) : checkObs(a);
}

if (require.main === module)
  main().then(
    (c) => process.exit(c),
    () => {
      say({ status: "refused", code: "REFUSED" });
      process.exit(2);
    },
  );
