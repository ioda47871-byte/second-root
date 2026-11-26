/**
 * DEV-303 (owner goal 2026-11-26): a SYNTHETIC whole_page request-mode bundle for rehearsing stages 3 → 6 of the
 * production flow (docs/design/image-first-production-flow.md §1) on disk, before the first real generation:
 * delivery to the review inbox → design review page → a fictional approval → the materials request's --validate-request
 * → impl-compare-approved. Nothing here generates anything: no Codex, no model, no image tool, no network, no process.
 *
 *   seal:     a fresh private rehearsal home (outside the repository, never the real home) gets
 *               <home>/rehearsal-work/runs/<id>-<UTC>/            the synthetic "run": parts/pc-1.png + sp-1.png drawn here
 *                                                                (flat bands and diagonal hatching; no text, no shop content)
 *               <home>/rehearsal-work/runs/<id>-<UTC>.receipt.json  in the worker's receipt shape, mode request, kind
 *                                                                fictional, design_layout whole_page, synthetic: true,
 *                                                                commit 000…0 (no real commit made it)
 *             → packBundle (bundle.ts seals `synthetic: true` into the manifest; only a fictional request run may carry it)
 *             → handOffToLocalInbox (the existing local transport: the receiver re-verifies, previews + INDEX)
 *               <home>/sr-runs/review-inbox/<id>/
 *             plus the fictional shop's private folder, as a real shop's would be:
 *               <home>/second-root-shops/<shop>/facts-pack.json    the committed fictional pack's bytes
 *               <home>/second-root-shops/<shop>/design-reviews/<id>.review.json   a synthetic review (advice shape only)
 *               <home>/second-root-shops/<shop>/site-rehearsal/    index.html + style.css for impl-compare-approved
 *   approve:  only for a bundle that verifies AND is synthetic: the fictional approval record (decision approve, bound to
 *             the review and the page_sha256 the owner's --page printed) and a fictional photo-materials request naming it,
 *             <home>/rehearsal-requests/<id>-materials.json, for `imagefirst-worker.ts --validate-request` (run with
 *             HOME=<home>).
 *
 * The marker refuses it as a real result: bundle.ts (synthetic only on a fictional request run), the research log
 * (SYNTHETIC_NOT_LOGGED), the worker's review delivery (RECEIPT_SYNTHETIC), and a materials run from it (the worker's
 * cycle and the entry: APPROVED_DESIGN_SYNTHETIC; --validate-request says rehearsal_only). The review page shows it.
 * Failures throw RehearsalStop with a fixed code (no path, no content).
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { packBundle, verifyBundleDir } from "./bundle";
import { checkDesignApproval, DESIGN_APPROVAL_SCHEMA, DESIGN_AXES, DESIGN_REVIEW_SCHEMA } from "./design-approval";
import { handOffToLocalInbox, REVIEW_INBOX } from "./local-inbox";

/** A listed fictional shop (research-log/shops.ts FICTIONAL_SHOPS) and its committed pack. */
export const REHEARSAL_SHOP = "cafe";
export const REHEARSAL_FACTS = "design-library/research/quality-pipeline/poc/cafe/facts-pack.json";
export const REHEARSAL_ID = "req-synthetic-rehearsal-wp-1";
export const REHEARSAL_ID_RE = /^req-synthetic-rehearsal-[a-z0-9][a-z0-9-]{0,30}$/;
/** No real commit made a synthetic run. */
export const REHEARSAL_COMMIT = "0".repeat(40);
/** The whole-page frame (portrait 2:3, the image tool's tallest), as a real whole_page run's pictures. */
export const REHEARSAL_SIZE = { width: 1024, height: 1536 } as const;
export const SITE_DIR = "site-rehearsal";
export const REQUESTS_DIR = "rehearsal-requests";

export class RehearsalStop extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RehearsalStop";
  }
}
const stop = (code: string): never => {
  throw new RehearsalStop(code);
};
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const within = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

// ---- the synthetic pictures (a minimal PNG encoder: 8-bit RGB, no filter) ------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC_TABLE[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
export function encodePng(width: number, height: number, rgb: (x: number, y: number) => readonly [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgb(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

type Rgb = readonly [number, number, number];
/** The page's bands, top to bottom (fractions of the height): header, hero, three content bands, footer. */
const BANDS: readonly { to: number; colour: Rgb }[] = [
  { to: 0.06, colour: [40, 44, 52] },
  { to: 0.34, colour: [196, 120, 74] },
  { to: 0.52, colour: [246, 241, 232] },
  { to: 0.7, colour: [226, 232, 222] },
  { to: 0.9, colour: [246, 241, 232] },
  { to: 1, colour: [40, 44, 52] },
];
/**
 * One synthetic whole-page picture: the bands, content blocks (PC: two columns, SP: one) and diagonal hatching in the
 * top-left corner (the visible synthetic mark). No text, no photo, nothing from any shop.
 */
export function syntheticPage(view: "pc" | "sp"): Buffer {
  const { width: w, height: h } = REHEARSAL_SIZE;
  const block: Rgb = [120, 128, 140];
  return encodePng(w, h, (x, y) => {
    const fy = y / h;
    const band = BANDS.findIndex((b) => fy < b.to);
    if (x < 160 && y < 160 && (x + y) % 24 < 6) return [220, 30, 60];
    if (band >= 2 && band <= 4) {
      const top = BANDS[band - 1]!.to * h;
      const bottom = BANDS[band]!.to * h;
      const inRow = y > top + 36 && y < bottom - 36;
      const cols = view === "pc" ? [[64, 480], [544, 960]] : [[64, 960]];
      if (inRow && cols.some(([a, b]) => x > a! && x < b!) && (y - top) % 48 < 30) return block;
    }
    return BANDS[Math.max(0, band)]!.colour;
  });
}

const SITE_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>リハーサル用の合成ページ</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header class="head">リハーサル用の合成ページ</header>
<section class="hero"><h1>合成</h1></section>
<section class="band a"><div class="col"></div><div class="col"></div></section>
<section class="band b"><div class="col"></div><div class="col"></div></section>
<section class="band a"><div class="col"></div><div class="col"></div></section>
<footer class="foot">生成の結果ではない</footer>
</body>
</html>
`;
const SITE_CSS = `* { box-sizing: border-box; margin: 0; }
body { font-family: sans-serif; background: #f6f1e8; color: #282c34; }
.head { height: 90px; background: #282c34; color: #fff; padding: 30px 64px; }
.hero { height: 420px; background: #c4784a; color: #fff; padding: 120px 64px; }
.band { min-height: 270px; display: flex; gap: 64px; padding: 36px 64px; }
.band.a { background: #f6f1e8; } .band.b { background: #e2e8de; }
.col { flex: 1; background: repeating-linear-gradient(#78808c 0 30px, transparent 30px 48px); }
.foot { height: 150px; background: #282c34; color: #fff; padding: 60px 64px; }
@media (max-width: 600px) { .band { flex-direction: column; } .band .col + .col { display: none; } }
`;

// ---- places ---------------------------------------------------------------------------------------------------------

async function writeNew(path: string, bytes: Buffer | string): Promise<void> {
  const h = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600).catch(() => stop("REHEARSAL_WRITE_FAILED"));
  try {
    await h.writeFile(bytes);
  } finally {
    await h.close();
  }
}
async function privateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) stop("REHEARSAL_HOME_UNSAFE");
}
/** The rehearsal home: absolute, outside the repository, not the real home (whose inbox the jailed Claude reads). */
async function rehearsalHome(home: string, repo: string, fresh: boolean): Promise<string> {
  if (!isAbsolute(home)) return stop("REHEARSAL_HOME_INVALID");
  const real = await realpath(home).catch(() => null);
  if (real === null) return stop("REHEARSAL_HOME_MISSING");
  const realHome = await realpath(homedir()).catch(() => homedir());
  if (real === realHome) stop("REHEARSAL_HOME_IS_REAL_HOME");
  const realRepo = await realpath(repo).catch(() => resolve(repo));
  if (within(real, realRepo) || within(realRepo, real)) stop("REHEARSAL_HOME_IN_REPO");
  const info = await lstat(real);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) stop("REHEARSAL_HOME_UNSAFE");
  if (fresh && (await readdir(real)).length > 0) stop("REHEARSAL_HOME_NOT_EMPTY");
  return real;
}
const shopDirOf = (home: string) => join(home, "second-root-shops", REHEARSAL_SHOP);
const reviewsDirOf = (home: string) => join(shopDirOf(home), "design-reviews");
const bundleDirOf = (home: string, id: string) => join(home, "sr-runs", REVIEW_INBOX, id);

export type SealResult = {
  request_id: string;
  shop: string;
  bundle_sha256: string;
  bundle_dir: string;
  previews_dir: string | null;
  review: string;
  site: string;
  facts_pack: string;
  synthetic: true;
};

/** Seals the synthetic bundle into the rehearsal home's review inbox (see the header). */
export async function sealRehearsal(o: { home: string; repo: string; id?: string; now?: () => number }): Promise<SealResult> {
  const id = o.id ?? REHEARSAL_ID;
  if (!REHEARSAL_ID_RE.test(id)) stop("REHEARSAL_ID_INVALID");
  const now = o.now ?? Date.now;
  const home = await rehearsalHome(o.home, o.repo, true);
  const facts = await readFile(join(o.repo, REHEARSAL_FACTS)).catch(() => stop("REHEARSAL_FACTS_MISSING"));

  const work = join(home, "rehearsal-work");
  const runs = join(work, "runs");
  for (const d of [join(home, "sr-runs"), work, runs, join(work, "state")]) await privateDir(d);
  const t = new Date(now());
  const stamp = t.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const runDir = join(runs, `${id}-${stamp}`);
  await privateDir(join(runDir, "parts"));
  const images: { file: string; sha256: string; bytes: number }[] = [];
  for (const view of ["pc", "sp"] as const) {
    const png = syntheticPage(view);
    await writeNew(join(runDir, "parts", `${view}-1.png`), png);
    images.push({ file: `parts/${view}-1.png`, sha256: sha256(png), bytes: png.length });
  }
  // a whole_page receipt lists its references by id, case and SHA-256; none was attached here, so the SHA-256 is of a
  // fixed sentence (never a picture's)
  const references = [{ id: "ref-1", case_id: "CP-001", sha256: sha256("synthetic rehearsal: no reference picture was attached") }];
  await writeNew(join(runDir, "reference-inputs.json"), `${JSON.stringify({ schema: "image_first_reference_inputs_v0", layout: "whole_page", references }, null, 2)}\n`);
  const request = sha256(`synthetic rehearsal request ${id}`);
  const receipt = {
    schema: "imagefirst_worker_receipt_v1",
    status: "succeeded",
    stop_code: null,
    stage: null,
    interrupted: false,
    cli_exit: 0,
    cli_timed_out: false,
    shop: REHEARSAL_SHOP,
    direction: "request",
    approval_id: id,
    plan_id: id,
    commit: REHEARSAL_COMMIT,
    packet_sha256: request,
    plan_sha256: sha256(`synthetic rehearsal plan ${id}`),
    prompt_sha256: sha256("synthetic rehearsal: no prompt"),
    prompt_chars: 0,
    run_dir: runDir,
    images,
    stopped_images: [],
    counts: { pc: 1, sp: 1, total: 2, stopped: 0 },
    verified: true,
    timings: { started_at: t.toISOString(), finished_at: t.toISOString(), elapsed_ms: 0 },
    mode: "request",
    kind: "fictional",
    request_id: id,
    request_sha256: request,
    facts_sha256: sha256(facts),
    images_total: 2,
    design_layout: "whole_page",
    reference_images: references,
    synthetic: true,
  };
  const receiptPath = `${runDir}.receipt.json`;
  await writeNew(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const sealed = await packBundle({ runDir, receiptPath, bundlesDir: join(work, "bundles"), now });
  const expected = { approval_id: id, plan_id: id, commit: REHEARSAL_COMMIT };
  const h = await handOffToLocalInbox({ sealed, stateDir: join(work, "state"), inboxDir: join(home, "sr-runs", REVIEW_INBOX), expected, now });
  if (h.delivery.state !== "delivered" || !h.bundleDir) stop("REHEARSAL_NOT_DELIVERED");

  // the fictional shop's private folder: its pack, the synthetic review, the rehearsal site
  await privateDir(reviewsDirOf(home));
  const factsPath = join(shopDirOf(home), "facts-pack.json");
  await writeNew(factsPath, facts);
  const evidence = (image: "pc" | "sp", note: string) => ({ image, region: "ページ全体（合成）", note });
  const review = {
    schema: DESIGN_REVIEW_SCHEMA,
    request_id: id,
    bundle_sha256: sealed.bundle_sha256,
    images: { pc: [images[0]!].map((i) => ({ file: i.file, sha256: i.sha256 })), sp: [images[1]!].map((i) => ({ file: i.file, sha256: i.sha256 })) },
    axes: Object.fromEntries(DESIGN_AXES.map((a) => [a, { verdict: a === "japanese" ? "revise" : "pass", evidence: [evidence("pc", "リハーサル用の合成の審査。生成の結果ではなく、判定に意味はない。"), evidence("sp", "合成の帯と斜線だけの画像。")] }])),
    reviewer: "synthetic-rehearsal",
    reviewed_at: t.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  const reviewPath = join(reviewsDirOf(home), `${id}.review.json`);
  await writeNew(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
  const site = join(shopDirOf(home), SITE_DIR);
  await privateDir(site);
  await writeNew(join(site, "index.html"), SITE_HTML);
  await writeNew(join(site, "style.css"), SITE_CSS);
  return { request_id: id, shop: REHEARSAL_SHOP, bundle_sha256: sealed.bundle_sha256, bundle_dir: h.bundleDir!, previews_dir: h.previews?.dir ?? null, review: reviewPath, site, facts_pack: factsPath, synthetic: true };
}

export type ApproveResult = { request_id: string; approval: string; approval_sha256: string; materials_request: string; materials_request_id: string };

/**
 * The fictional approval of the synthetic run (only a bundle that verifies and is synthetic; bound to the review and the
 * page_sha256 that `design-approval-check --page` printed) and a fictional photo-materials request naming it.
 */
export async function approveRehearsal(o: { home: string; repo: string; id?: string; pageSha256: string; now?: () => number }): Promise<ApproveResult> {
  const id = o.id ?? REHEARSAL_ID;
  if (!REHEARSAL_ID_RE.test(id)) stop("REHEARSAL_ID_INVALID");
  if (!/^[0-9a-f]{64}$/.test(o.pageSha256)) stop("REHEARSAL_PAGE_SHA_INVALID");
  const now = o.now ?? Date.now;
  const home = await rehearsalHome(o.home, o.repo, false);
  const bundleDir = bundleDirOf(home, id);
  const v = await verifyBundleDir(bundleDir).catch(() => stop("REHEARSAL_BUNDLE_INVALID"));
  if (v.manifest.synthetic !== true || v.manifest.kind !== "fictional" || v.manifest.shop !== REHEARSAL_SHOP) stop("REHEARSAL_BUNDLE_NOT_SYNTHETIC");
  const reviewPath = join(reviewsDirOf(home), `${id}.review.json`);
  const draft = await checkDesignApproval({ bundleDir, reviewPath, repo: o.repo, mode: "draft" }).catch((e: { code?: string }) => stop(e.code ?? "REHEARSAL_REVIEW_INVALID"));
  if (draft.page_sha256 !== o.pageSha256) stop("REHEARSAL_PAGE_SHA_MISMATCH");
  const decided = new Date(Math.max(now(), Date.parse(draft.review.reviewed_at))).toISOString().replace(/\.\d{3}Z$/, "Z");
  const approval = {
    schema: DESIGN_APPROVAL_SCHEMA,
    request_id: id,
    bundle_sha256: draft.bundle_sha256,
    approved_images: draft.review.images,
    review_sha256: draft.review_sha256,
    page_sha256: draft.page_sha256,
    decision: "approve",
    decided_at: decided,
    note: "リハーサル用の架空の承認。合成の run に対するもので、オーナーのデザインの判断ではない。",
  };
  const approvalPath = join(reviewsDirOf(home), `${id}.approval.json`);
  const approvalText = `${JSON.stringify(approval, null, 2)}\n`;
  await writeNew(approvalPath, approvalText);
  const facts = await readFile(join(shopDirOf(home), "facts-pack.json")).catch(() => stop("REHEARSAL_FACTS_MISSING"));
  const materialsId = `${id}-materials`;
  const request = {
    schema: "sr_imagefirst_request_v1",
    id: materialsId,
    shop_id: REHEARSAL_SHOP,
    kind: "fictional",
    created_at: decided,
    stage: "photo_materials",
    facts_ref: { root: "second-root-shops", shop_id: REHEARSAL_SHOP },
    facts_sha256: sha256(facts),
    approved_design: { bundle_id: id, bundle_sha256: draft.bundle_sha256, review_file: `${id}.review.json`, approval_file: `${id}.approval.json` },
    materials: [{ id: "hero-texture", kind: "background", aspect: "landscape_3x2", placement: "PC と SP の最初の画面の帯の背景", note: "淡い紙の質感。文字・人・店の物は入れない。" }],
    mood: "静かで明るい朝の光。",
    avoid: "文字、ロゴ、人の顔、店の物に見えるもの。",
    max_images: 1,
    codex_runs: 1,
  };
  const dir = join(home, REQUESTS_DIR);
  await privateDir(dir);
  const requestPath = join(dir, `${materialsId}.json`);
  await writeNew(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  return { request_id: id, approval: approvalPath, approval_sha256: sha256(approvalText), materials_request: requestPath, materials_request_id: materialsId };
}
