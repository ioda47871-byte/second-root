/**
 * DEV-150 (Issue #180): the OFFLINE steps of the three-method pilot (docs/design/three-methods-pilot-plan.md §3).
 * Never calls Codex or the image tool, starts no process other than Chromium (JavaScript off, every request outside
 * the page's own files refused) and opens no network: it reads what the real-call steps
 * recorded (only through readStep: the output folder AND the ledger must both say "succeeded"), draws pages in
 * Chromium with JavaScript off and only the page's own files served, and writes new files under a new --out.
 * It adds no check of its own: every check is an existing function, and every finding is recorded, never a threshold
 * or a gate. The one stop is the study's existing rule: an Identity REJECT / HOLD stops the method for the owner.
 *
 *   --lane --package <package dir> --facts <pack.json> --out <new lane dir>
 *       VISUAL_FIRST's hand-off: prepareImplementationLane (DEV-128) builds the lane (artifact record, PC / SP originals,
 *       assets; never Codex's prototype HTML / CSS). Refused unless the package is render_pair_complete.
 *
 *   --direction --step <direction call dir> --facts <pack.json> --out <new dir>
 *       DIRECTION_FIRST's hand-off: the recorded direction (readStep + checkDirection) as direction.json: the concept,
 *       the 8 DNA parts and the avoid list only, with the call's ids.
 *
 *   --page-request --method LAYOUT_FIRST|DIRECTION_FIRST --page-root <dir> --page <dir/…/index.html> --hero <ids>
 *   --facts <pack.json> --out <new dir> [--no-image-reason <text>]
 *       A page Claude wrote: the existing DOM prototype safety check, a render with placeholders (where each picture
 *       sits, measured), the three-method lane's request (buildPageAssetRequests → runnableAssetRequests), written as
 *       asset-request-<id>.json and prerender.md (what one page_image approval is for). The page's path is recorded
 *       relative to --page-root (the image CLI's --page-root). A page with no picture writes no-image.json instead,
 *       with the reason it needs none (--no-image-reason, required then) and the budget note (owner decision 3).
 *
 *   --check --page <dir/index.html> --facts <pack.json> --out <new dir> [--image <page image call dir>] [--asset-origin <dirs>] [--visual-inspection <json>]
 *       Claude's implementation (any method), REPORT-ONLY: PC 1440 / SP 390 PNGs, scrollWidth and the horizontal
 *       overflow (the study's only repair trigger), measureMobileQuality, auditPageText of the study's Identity Lock
 *       on each width's visible text, observeStructure. With --image, the picture of a page_image call (readStep; bound
 *       to this very page's SHA-256) is placed. EVERY real picture on the page (the image step's, or one in the page's
 *       own assets/, e.g. VISUAL_FIRST's generated picture from the lane) gets its own picture check (asset-image-audit, below)
 *       against a recorded visual inspection of exactly that picture (--visual-inspection naming its SHA-256; absent
 *       = HOLD), and the check's status includes it. Owner approval A′: a picture is checked with the three-method
 *       asset-image-audit (not the Lock's full-design image audit): its origin must be an approved image call, given
 *       by --image or --asset-origin <step dir>[,<step dir>] (readStep), and the inspection record is
 *       three_method_asset_inspection_v0 (PASS_ASSET_ONLY at best, never a site identity). Only a neutral placeholder (used only where nothing exists at
 *       assets/<name>) has none; a link, a non-regular or oversized file, or an assets/ that is a link stops the check
 *       (ASSET_FILE_INVALID). An inspection record on a page with no real picture is refused (INSPECTION_UNUSED). Nothing is ever proven from
 *       the picture automatically (owner decision 4, all three methods). Pictures the page names come from its own assets/ (VISUAL_FIRST:
 *       the lane's), else a neutral placeholder (recorded as such).
 *
 *   --versions --steps <call dir>,<call dir>,...
 *       Owner decision 5: before the next real call, the Codex CLI version and model of the pilot's earlier calls must
 *       be the same and known. A change (GENERATION_CHANGED) or an unknown value (GENERATION_FACTS_UNKNOWN) stops for
 *       the owner. Calls that did not succeed and recorded no facts are listed, not compared.
 *
 * Exit: 0 done, 2 stopped or refused (an Identity REJECT / HOLD after --check writes its record and exits 2).
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { auditPageText, type IdentityResult } from "../../lib/design-agent/identity/identity-lock";
import { LaneStop, prepareImplementationLane } from "../../lib/design-agent/impl-lane/handoff";
import { checkPrototype, PrototypeUnsafe } from "../../lib/design-agent/phase2f/prototype-safety";
import { RenderError, renderPrototype } from "../../lib/design-agent/phase2f/render-prototype";
import { placeholderPng } from "../../lib/design-agent/phase2f/runner";
import { defaultLedgerDir, openLedger, type CallKind, type Ledger, type Route } from "../../lib/design-agent/phase2f-live/ledger";
import { readStep, StepStop } from "../../lib/design-agent/phase2f-live/steps";
import { failedObservation, observeStructure } from "../../lib/design-agent/structure/observe";
import { ReferenceDescriptors } from "../../lib/design-agent/structure/references";
import { auditAssetImage, type AssetImageResult } from "../../lib/design-agent/three-methods/asset-image-audit";
import { FactsPack } from "../../lib/design-agent/three-methods/brief";
import { checkDirection } from "../../lib/design-agent/three-methods/direction";
import { buildPageAssetRequests, extractAssetMarkers, runnableAssetRequests, type PageMethod, type Placement } from "../../lib/design-agent/three-methods/page-assets";

process.umask(0o077);
const REPO = resolve(__dirname, "../..");
const LOCK = "design-library/research/three-methods/identity-lock.json";
const REFERENCES = "design-library/intelligence/v02/structure-descriptors-v0.json";
const MODES = ["--lane", "--direction", "--page-request", "--check", "--versions"] as const;
const VALUES = new Set(["--package", "--facts", "--out", "--step", "--method", "--page", "--page-root", "--hero", "--no-image-reason", "--image", "--visual-inspection", "--asset-origin", "--steps"]);
const MAX_BYTES = { html: 384 * 1024, css: 256 * 1024, asset: 16 * 1024 * 1024 } as const;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const say = (o: object) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);
const refuse = (code: string) => (say({ status: "refused", code }), 2);
const stopped = (code: string, extra: object = {}) => (say({ status: "stopped", code, ...extra }), 2);
const writeNew = (path: string, data: string | Buffer) => writeFile(path, data, { mode: 0o600, flag: "wx" });
const json = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;
const launch = () => chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });

function parseArgs(argv: string[]): Map<string, string> | null {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if ((MODES as readonly string[]).includes(a) && !out.has(a)) out.set(a, "1");
    else if (VALUES.has(a) && !out.has(a) && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) out.set(a, argv[++i]!);
    else return null;
  }
  return MODES.filter((m) => out.has(m)).length === 1 ? out : null;
}

/** Exactly these flags (besides the mode), the required ones present. */
const only = (args: Map<string, string>, required: readonly string[], optional: readonly string[] = []) => required.every((f) => args.has(f)) && [...args.keys()].every((k) => (MODES as readonly string[]).includes(k) || required.includes(k) || optional.includes(k));

/** A regular file (never a link), at most `max` bytes; else null. */
async function readRegular(path: string, max: number): Promise<Buffer | null> {
  const st = await lstat(path).catch(() => null);
  if (!st || !st.isFile() || st.size > max) return null;
  return readFile(path);
}

async function readFacts(path: string): Promise<FactsPack | null> {
  const parsed = await readFile(resolve(path), "utf8").then((t) => FactsPack.safeParse(JSON.parse(t)), () => null);
  return parsed?.success ? parsed.data : null;
}

/** A page Claude wrote: index.html and the style.css next to it (both regular files). */
async function readPage(htmlPath: string): Promise<{ html: string; css: string } | null> {
  const html = await readRegular(htmlPath, MAX_BYTES.html);
  const css = await readRegular(join(dirname(htmlPath), "style.css"), MAX_BYTES.css);
  return html && css ? { html: html.toString("utf8"), css: css.toString("utf8") } : null;
}

const sectionIdsOf = (html: string) => [...new Set([...html.matchAll(/\bdata-section\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]!))];
const assetPathsOf = (page: { html: string; css: string }) => [...new Set([...`${page.html}\n${page.css}`.matchAll(/assets\/A\d{1,2}\.png/g)].map((m) => m[0]))].sort();
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** The page's visible text (innerText) at one width: its own files only, JavaScript off, every other request refused. */
async function visibleText(browser: Browser, page: { html: string; css: string }, assets: ReadonlyMap<string, Buffer>, width: number): Promise<string> {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, javaScriptEnabled: false, serviceWorkers: "block" });
  try {
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://three-methods.invalid") return route.abort();
      const path = url.pathname.slice(1);
      if (path === "index.html") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: page.html });
      if (path === "style.css") return route.fulfill({ status: 200, contentType: "text/css; charset=utf-8", body: page.css });
      const file = assets.get(path);
      return file ? route.fulfill({ status: 200, contentType: "image/png", body: file }) : route.abort();
    });
    const p = await context.newPage();
    await p.goto("http://three-methods.invalid/index.html", { waitUntil: "load" });
    return (await p.evaluate("document.body.innerText")) as string;
  } finally {
    await context.close();
  }
}

// ---- --lane ---------------------------------------------------------------------------------------

async function lane(args: Map<string, string>): Promise<number> {
  if (!only(args, ["--package", "--facts", "--out"])) return refuse("USAGE");
  try {
    const m = await prepareImplementationLane({ packageDir: resolve(args.get("--package")!), factsPath: resolve(args.get("--facts")!), laneDir: resolve(args.get("--out")!) });
    say({ status: "ready", lane: resolve(args.get("--out")!), artifact_id: m.artifact_id, files: m.files.map((f) => f.path), excluded_roles: m.excluded_roles });
    return 0;
  } catch (e) {
    if (e instanceof LaneStop) return stopped(e.code);
    throw e;
  }
}

// ---- --direction ----------------------------------------------------------------------------------

async function direction(args: Map<string, string>, ledger: Ledger): Promise<number> {
  if (!only(args, ["--step", "--facts", "--out"])) return refuse("USAGE");
  const facts = await readFacts(args.get("--facts")!);
  if (!facts) return refuse("FACTS_INVALID");
  const step = await readStep(resolve(args.get("--step")!), ledger, { kind: "direction", route: "direction_text" });
  if (step.call.status !== "succeeded" || !step.generation) return stopped("DIRECTION_RUN_NOT_SUCCEEDED", { call_code: step.call.code });
  const answer = await readFile(join(step.dir, "answer.json"), "utf8").then((t) => JSON.parse(t) as unknown, () => undefined);
  const c = checkDirection(answer, facts);
  if (!c.ok) return stopped(c.code);
  const out = resolve(args.get("--out")!);
  await mkdir(out, { recursive: false, mode: 0o700 });
  const record = {
    schema: "three_method_direction_handoff_v0",
    method: "DIRECTION_FIRST",
    condition: "direction_text",
    direction: { concept: c.direction.concept, dna: c.direction.dna, avoid: c.direction.avoid },
    call: { approval_id: step.receipt.approval_id, plan_id: step.receipt.plan_id, run_id: step.receipt.run_id, prompt_sha256: step.receipt.prompt_sha256, commit: step.receipt.commit, tool_version: step.generation.tool_version, model_reported: step.generation.model_reported },
  };
  await writeNew(join(out, "direction.json"), json(record));
  say({ status: "ready", out: join(out, "direction.json"), approval_id: step.receipt.approval_id });
  return 0;
}

// ---- --page-request -------------------------------------------------------------------------------

async function pageRequest(args: Map<string, string>): Promise<number> {
  if (!only(args, ["--method", "--page-root", "--page", "--hero", "--facts", "--out"], ["--no-image-reason"])) return refuse("USAGE");
  const method = args.get("--method") as PageMethod;
  if (method !== "LAYOUT_FIRST" && method !== "DIRECTION_FIRST") return refuse("USAGE");
  const facts = await readFacts(args.get("--facts")!);
  if (!facts) return refuse("FACTS_INVALID");
  const root = await realpath(resolve(args.get("--page-root")!)).catch(() => null);
  const htmlPath = await realpath(resolve(args.get("--page")!)).catch(() => null);
  const rel = root && htmlPath ? relative(root, htmlPath) : "";
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return refuse("PAGE_OUTSIDE_ROOT");
  const page = await readPage(htmlPath!);
  if (!page) return refuse("PAGE_FILES_MISSING");
  const markers = extractAssetMarkers(page.html);
  if (!markers.ok) return stopped(markers.code);
  const reason = args.get("--no-image-reason");
  const out = resolve(args.get("--out")!);
  const pageRecord = { path: rel, html_sha256: sha256(page.html), css_sha256: sha256(page.css) };
  if (markers.markers.length === 0) {
    // owner decision 3: 0 pictures is allowed when the design needs none; the reason and the budget difference are recorded
    if (!reason?.trim()) return refuse("NO_IMAGE_REASON_REQUIRED");
    await mkdir(out, { recursive: false, mode: 0o700 });
    await writeNew(join(out, "no-image.json"), json({ schema: "three_method_no_image_v0", method, page: pageRecord, images_requested: 0, reason: reason.trim(), budget_note: "This method used 0 of its 1 image call; VISUAL_FIRST route C always asks for exactly 1. A condition difference, recorded for the comparison." }));
    say({ status: "no_image", method, out: join(out, "no-image.json") });
    return 0;
  }
  if (reason !== undefined) return refuse("USAGE");
  const heroSections = args.get("--hero")!.split(",").filter(Boolean);
  const sectionIds = sectionIdsOf(page.html);
  if (heroSections.length === 0 || heroSections.some((h) => !sectionIds.includes(h))) return refuse("HERO_SECTION_UNKNOWN");
  const assetPaths = markers.markers.map((m) => `assets/${m.asset_id}.png`);
  const browser = await launch();
  let placement: Record<string, Placement>;
  try {
    let alts: Record<string, string>;
    try {
      ({ alts } = await checkPrototype(browser, page, assetPaths));
    } catch (e) {
      if (e instanceof PrototypeUnsafe) return stopped("PROTOTYPE_UNSAFE", { detail: e.message.slice("PROTOTYPE_UNSAFE: ".length) });
      throw e;
    }
    // the picture's description as the DOM reads it must be the one the request is built from
    if (markers.markers.some((m) => collapse(alts[`assets/${m.asset_id}.png`] ?? "") !== m.alt)) return stopped("ASSET_DOM_ALT_MISMATCH");
    let rendered;
    try {
      rendered = await renderPrototype(browser, page, new Map(assetPaths.map((p) => [p, placeholderPng()] as const)), sectionIds);
    } catch (e) {
      if (e instanceof RenderError) return stopped(e.code, e.detail ? { detail: e.detail } : {});
      throw e;
    }
    if (rendered.desktop_1440.blocked + rendered.mobile_390.blocked > 0) return stopped("PAGE_NETWORK_ATTEMPT");
    placement = Object.fromEntries(
      markers.markers.map((m) => {
        const at = (k: "desktop_1440" | "mobile_390") => {
          const p = rendered[k].assets[`assets/${m.asset_id}.png`];
          return { sections: [...(p?.sections ?? [])].sort(), outside_sections: p?.outsideSections ?? false, first_screen: p?.firstScreen ?? false, shown: p?.shown ?? false };
        };
        return [m.asset_id, { desktop_1440: at("desktop_1440"), mobile_390: at("mobile_390") }];
      }),
    );
  } finally {
    await browser.close();
  }
  const built = buildPageAssetRequests({ method, page: { path: rel, html: page.html }, facts, placement, heroSections });
  if (!built.ok) return stopped(built.code);
  const runnable = runnableAssetRequests(built.requests);
  if (!runnable.ok) return stopped(runnable.code);
  await mkdir(out, { recursive: false, mode: 0o700 });
  const files: string[] = [];
  for (const r of runnable.requests) {
    const file = join(out, `asset-request-${r.asset_id}.json`);
    await writeNew(file, json(r));
    files.push(file);
  }
  const md = [
    "# 画像生成の承認依頼（Claude のページ、1枚ごと）",
    "",
    `- 方式: ${method}（kind page_image・route claude_page）`,
    `- ページ: ${rel}（--page-root からの位置）`,
    `- ページの SHA-256: ${pageRecord.html_sha256}（style.css ${pageRecord.css_sha256}）`,
    "- 実行時の条件: ページと style.css がリポジトリで追跡され、承認した commit（--expected-commit）で同じバイト列であること",
    "",
    ...runnable.requests.flatMap((r, i) => [
      `## 画像 ${r.asset_id}`,
      "",
      `- 使用位置: PC ${r.placement!.desktop_1440.sections.join(", ") || "区画外"}（最初の画面: ${r.placement!.desktop_1440.first_screen ? "入る" : "入らない"}）／ SP ${r.placement!.mobile_390.sections.join(", ") || "区画外"}（最初の画面: ${r.placement!.mobile_390.first_screen ? "入る" : "入らない"}）`,
      `- 主役画像: ${r.essential ? "はい（失敗したらオーナー確認で停止。勝手に外さない）" : "いいえ"}`,
      `- 絵の説明（alt）: ${r.alt}`,
      `- 指示文SHA-256: ${r.prompt_sha256}（${r.prompt_chars}文字）`,
      `- 依頼ファイル: ${files[i]}`,
      "- 画像の承認ID: （オーナーが決める。1回だけ使用）",
      "",
      "指示文（全文）:",
      "",
      "```",
      r.prompt,
      "```",
      "",
    ]),
  ].join("\n");
  await writeNew(join(out, "prerender.md"), `${md}\n`);
  say({ status: "ready", method, page: pageRecord, requests: runnable.requests.map((r, i) => ({ asset_id: r.asset_id, essential: r.essential, prompt_sha256: r.prompt_sha256, prompt_chars: r.prompt_chars, file: files[i] })), presentation: join(out, "prerender.md") });
  return 0;
}

// ---- --check --------------------------------------------------------------------------------------

/** Whether the method goes on: the worst of the page text's identity and each picture's own check. "PASS" names no identity. */
const worst = (a: (IdentityResult["status"] | AssetImageResult["status"])[]) => (a.includes("REJECT") ? "REJECT" : a.includes("HOLD") ? "HOLD" : "PASS");

async function check(args: Map<string, string>, ledger: Ledger): Promise<number> {
  if (!only(args, ["--page", "--facts", "--out"], ["--image", "--visual-inspection", "--asset-origin"])) return refuse("USAGE");
  const facts = await readFacts(args.get("--facts")!);
  if (!facts) return refuse("FACTS_INVALID");
  const htmlPath = resolve(args.get("--page")!);
  const page = await readPage(htmlPath);
  if (!page) return refuse("PAGE_FILES_MISSING");
  const lock = JSON.parse(await readFile(resolve(REPO, LOCK), "utf8")) as Record<string, unknown>;
  const refsText = await readFile(resolve(REPO, REFERENCES), "utf8");
  const refs = ReferenceDescriptors.parse(JSON.parse(refsText));

  // the pictures the page names: the page's own assets/ (VISUAL_FIRST: the lane's), the checked image step, or a placeholder
  const assets = new Map<string, Buffer>();
  const sources: { path: string; sha256: string; source: "page_assets" | "image_step" | "placeholder" }[] = [];
  let image: { asset_id: string; png_sha256: string; approval_id: string; run_id: string } | null = null;
  // owner approval A′: where each real picture came from. A picture is tied to an approved image call only through a
  // recorded step (readStep: output folder and ledger agree, succeeded, its PNG's SHA-256): the --image step, and each
  // --asset-origin step (VISUAL_FIRST: the C1-c image step, image × C_hybrid; a page's: page_image × claude_page)
  const origins = new Map<string, { approval_id: string; kind: string; dir: string }>();
  const inspection = args.has("--visual-inspection") ? await readFile(resolve(args.get("--visual-inspection")!), "utf8").then((t) => JSON.parse(t) as unknown, () => null) : undefined;
  if (inspection === null) return refuse("VISUAL_INSPECTION_UNREADABLE");
  if (args.has("--image")) {
    const step = await readStep(resolve(args.get("--image")!), ledger, { kind: "page_image", route: "claude_page" });
    if (step.call.status !== "succeeded" || !step.generation) return stopped("IMAGE_RUN_NOT_SUCCEEDED", { call_code: step.call.code });
    const link = (step.call.request ?? {}) as { page_sha256?: string; asset_id?: string };
    // the picture was asked for by this very page (its bytes), for a picture this page names
    if (link.page_sha256 !== sha256(page.html) || typeof link.asset_id !== "string" || !assetPathsOf(page).includes(`assets/${link.asset_id}.png`)) return stopped("IMAGE_PAGE_MISMATCH");
    const png = await readRegular(join(step.dir, "image.png"), MAX_BYTES.asset);
    if (!png || sha256(png) !== step.call.png_sha256) return stopped("RECORD_MISMATCH");
    image = { asset_id: link.asset_id, png_sha256: sha256(png), approval_id: step.receipt.approval_id, run_id: step.receipt.run_id };
    origins.set(sha256(png), { approval_id: step.receipt.approval_id, kind: step.receipt.kind, dir: step.dir });
    assets.set(`assets/${link.asset_id}.png`, png);
  }
  for (const d of (args.get("--asset-origin") ?? "").split(",").filter(Boolean)) {
    const dir = resolve(d);
    const call = await readFile(join(dir, "call.json"), "utf8").then((t) => JSON.parse(t) as { receipt?: { kind?: CallKind; route?: Route } }, () => null);
    const need = call?.receipt?.kind === "image" ? ({ kind: "image", route: "C_hybrid" } as const) : call?.receipt?.kind === "page_image" ? ({ kind: "page_image", route: "claude_page" } as const) : null;
    if (!need) return stopped("ASSET_ORIGIN_INVALID", { origin: dir });
    const step = await readStep(dir, ledger, need);
    if (step.call.status !== "succeeded" || !step.generation) return stopped("ASSET_ORIGIN_INVALID", { origin: dir });
    // a page's picture belongs to this very page
    if (need.kind === "page_image" && (step.call.request as { page_sha256?: string } | undefined)?.page_sha256 !== sha256(page.html)) return stopped("IMAGE_PAGE_MISMATCH", { origin: dir });
    const png = await readRegular(join(step.dir, "image.png"), MAX_BYTES.asset);
    if (!png || sha256(png) !== step.call.png_sha256) return stopped("RECORD_MISMATCH", { origin: dir });
    origins.set(sha256(png), { approval_id: step.receipt.approval_id, kind: step.receipt.kind, dir: step.dir });
  }
  // a placeholder only where NOTHING exists (review round 2 M2): a link, a non-regular or oversized file, or an
  // assets/ that is a link or not a directory stops the check, so no real picture can slip past its identity audit
  const pageDir = dirname(htmlPath);
  const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";
  const dirStat = await lstat(join(pageDir, "assets")).then((st) => st, (e: unknown) => (missing(e) ? null : "invalid" as const));
  if (dirStat === "invalid" || (dirStat !== null && (!dirStat.isDirectory() || dirStat.isSymbolicLink()))) return stopped("ASSET_FILE_INVALID", { path: "assets" });
  for (const path of assetPathsOf(page)) {
    if (assets.has(path)) {
      sources.push({ path, sha256: sha256(assets.get(path)!), source: "image_step" });
      continue;
    }
    const st = dirStat === null ? null : await lstat(join(pageDir, path)).then((x) => x, (e: unknown) => (missing(e) ? null : "invalid" as const));
    if (st === null) {
      const data = placeholderPng();
      assets.set(path, data);
      sources.push({ path, sha256: sha256(data), source: "placeholder" });
      continue;
    }
    const bytes = st !== "invalid" && st.isFile() && !st.isSymbolicLink() ? await readRegular(join(pageDir, path), MAX_BYTES.asset) : null;
    if (!bytes) return stopped("ASSET_FILE_INVALID", { path });
    assets.set(path, bytes);
    sources.push({ path, sha256: sha256(bytes), source: "page_assets" });
  }
  // review round 2 L7: an inspection record must be about a real picture on this page. With real pictures, a record
  // naming none of them is checked against each (REJECT, below); with no real picture at all it is refused here.
  if (inspection !== undefined && !sources.some((x) => x.source !== "placeholder")) return refuse("INSPECTION_UNUSED");

  const sectionIds = sectionIdsOf(page.html);
  const shopName = facts.facts.find((f) => f.key === "name")?.value ?? null;
  const browser = await launch();
  let rendered, text, structure;
  try {
    try {
      await checkPrototype(browser, page, [...assets.keys()]);
    } catch (e) {
      if (e instanceof PrototypeUnsafe) return stopped("PROTOTYPE_UNSAFE", { detail: e.message.slice("PROTOTYPE_UNSAFE: ".length) });
      throw e;
    }
    try {
      rendered = await renderPrototype(browser, page, assets, sectionIds, { facts: facts.facts.map((f) => f.value), shopName });
    } catch (e) {
      if (e instanceof RenderError) return stopped(e.code, e.detail ? { detail: e.detail } : {});
      throw e;
    }
    text = { desktop_1440: await visibleText(browser, page, assets, 1440), mobile_390: await visibleText(browser, page, assets, 390) };
    structure = await observeStructure(browser, { ...page, assets: Object.fromEntries(assets) }, refs).catch((e: unknown) => failedObservation("MEASURE_FAILED", e));
  } finally {
    await browser.close();
  }
  const identity = { desktop_1440: auditPageText(lock, text.desktop_1440), mobile_390: auditPageText(lock, text.mobile_390) };
  // owner decision 4 (all three methods): every real picture's identity rests on a recorded visual inspection of exactly
  // that picture; without one it is HOLD. An inspection that names none of the pictures is checked against each (REJECT);
  // one given for a page with no real picture was refused above (INSPECTION_UNUSED).
  const named = (inspection as { inspected_image_sha256?: unknown } | undefined)?.inspected_image_sha256;
  const real = sources.filter((x) => x.source !== "placeholder");
  const matched = real.some((x) => x.sha256 === named);
  // owner approval A′: the picture's own check (asset-image-audit), never the Lock's full-design image audit
  const images: { path: string; sha256: string; source: string; origin: { approval_id: string; kind: string } | null; identity: AssetImageResult }[] = real.map((x) => {
    const origin = origins.get(x.sha256);
    const o = origin ? { approval_id: origin.approval_id, kind: origin.kind } : null;
    return { ...x, origin: o, identity: auditAssetImage({ lock, facts, image: { sha256: x.sha256, origin: o }, inspection: inspection !== undefined && (!matched || x.sha256 === named) ? inspection : undefined }) };
  });
  const out = resolve(args.get("--out")!);
  await mkdir(out, { recursive: false, mode: 0o700 });
  await writeNew(join(out, "pc1440.png"), rendered.desktop_1440.png);
  await writeNew(join(out, "sp390.png"), rendered.mobile_390.png);
  if (image) {
    await mkdir(join(out, "assets"), { mode: 0o700 });
    await writeNew(join(out, "assets", `${image.asset_id}.png`), assets.get(`assets/${image.asset_id}.png`)!);
  }
  const status = worst([identity.desktop_1440.status, identity.mobile_390.status, ...images.map((x) => x.identity.status)]);
  const record = {
    schema: "three_method_check_v0",
    scope: "offline_report_only",
    page: { path: htmlPath, html_sha256: sha256(page.html), css_sha256: sha256(page.css) },
    assets: sources,
    renders: { desktop_1440: { png: "pc1440.png", sha256: sha256(rendered.desktop_1440.png) }, mobile_390: { png: "sp390.png", sha256: sha256(rendered.mobile_390.png) } },
    implementation_scroll_width: { desktop_1440: rendered.desktop_1440.scrollWidth, mobile_390: rendered.mobile_390.scrollWidth },
    // the study's one repair trigger (Claude fixes it by hand, within the loop's LIMITS); recorded here, never a gate
    horizontal_overflow: { desktop_1440: rendered.desktop_1440.scrollWidth > 1440, mobile_390: rendered.mobile_390.scrollWidth > 390 },
    blocked_requests: rendered.desktop_1440.blocked + rendered.mobile_390.blocked,
    mobile_quality: rendered.mobile_390.mobileQuality ?? null,
    // status: whether the method goes on (REJECT / HOLD stop it). The site's identity is page only (auditPageText);
    // a picture's check (PASS_ASSET_ONLY at best) is never a site identity
    identity: { status, page: identity, images },
    image: image ? { asset_id: image.asset_id, png_sha256: image.png_sha256, approval_id: image.approval_id, run_id: image.run_id } : null,
    structure_observation: structure,
    reference_set: { path: REFERENCES, sha256: sha256(refsText) },
    notes: [
      "Report only: nothing here is a quality score, a threshold or an approval.",
      "PASS_IDENTITY_ONLY means only 'the right shop'. A REJECT or HOLD stops this method for the owner (study §4); it is never repaired here.",
      "A generated picture is checked on its own (asset-image-audit: its origin and a recorded visual inspection of exactly that picture); PASS_ASSET_ONLY is never a site identity, and nothing is proven from the picture automatically.",
    ],
  };
  await writeNew(join(out, "check.json"), json(record));
  if (status !== "PASS") return stopped("IDENTITY_NOT_PASSED", { identity: status, out: join(out, "check.json") });
  say({ status: "recorded", out: join(out, "check.json"), identity: status, horizontal_overflow: record.horizontal_overflow });
  return 0;
}

// ---- --versions -----------------------------------------------------------------------------------

async function versions(args: Map<string, string>, ledger: Ledger): Promise<number> {
  if (!only(args, ["--steps"])) return refuse("USAGE");
  const dirs = args.get("--steps")!.split(",").filter(Boolean);
  if (dirs.length === 0) return refuse("USAGE");
  const calls: { dir: string; approval_id: string; kind: string; status: string; tool_version: string | null; model_reported: string | null; compared: boolean }[] = [];
  for (const d of dirs) {
    const dir = resolve(d);
    const call = await readFile(join(dir, "call.json"), "utf8").then((t) => JSON.parse(t) as { receipt?: { kind?: CallKind; route?: Route } }, () => null);
    if (!call?.receipt?.kind || !call.receipt.route) throw new StepStop("RECORD_MISSING");
    const step = await readStep(dir, ledger, { kind: call.receipt.kind, route: call.receipt.route });
    // a succeeded call has generation.json (readStep checked it); a failed one may have recorded the facts in call.json
    const recorded = step.call as { cli_version?: string | null; model_reported?: string | null };
    const tool = step.generation ? step.generation.tool_version : (recorded.cli_version ?? null);
    const model = step.generation ? step.generation.model_reported : (recorded.model_reported ?? null);
    const compared = step.generation !== null || (recorded.cli_version !== undefined && recorded.model_reported !== undefined);
    calls.push({ dir, approval_id: step.receipt.approval_id, kind: step.receipt.kind, status: step.call.status, tool_version: tool, model_reported: model, compared });
  }
  const seen = calls.filter((c) => c.compared);
  const record = { mode: "versions", calls };
  if (seen.length === 0) return stopped("GENERATION_FACTS_UNKNOWN", record);
  if (seen.some((c) => c.tool_version === null || c.model_reported === null)) return stopped("GENERATION_FACTS_UNKNOWN", record);
  const pairs = new Set(seen.map((c) => `${c.tool_version}\u0000${c.model_reported}`));
  if (pairs.size !== 1) return stopped("GENERATION_CHANGED", record);
  say({ status: "same", tool_version: seen[0]!.tool_version, model_reported: seen[0]!.model_reported, ...record });
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) return refuse("USAGE");
  const ledger = openLedger(resolve(defaultLedgerDir(process.env, homedir())));
  try {
    if (args.has("--lane")) return await lane(args);
    if (args.has("--direction")) return await direction(args, ledger);
    if (args.has("--page-request")) return await pageRequest(args);
    if (args.has("--check")) return await check(args, ledger);
    return await versions(args, ledger);
  } catch (error) {
    if (error instanceof StepStop) return stopped(error.code);
    throw error;
  }
}

main().then(
  (code) => process.exit(code),
  () => {
    say({ status: "refused", code: "REFUSED" });
    process.exit(2);
  },
);
