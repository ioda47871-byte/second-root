import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, truncateSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { FactsPack } from "@/lib/design-agent/artifact/schema";
import { checkPrototype, PrototypeUnsafe } from "@/lib/design-agent/phase2f/prototype-safety";
import { buildDesignPrompt, promptVariantOf } from "@/lib/design-agent/phase2f/prompt";
import { runDesignCall } from "@/lib/design-agent/phase2f-live/design-call";
import { runDirectionCall } from "@/lib/design-agent/phase2f-live/direction-call";
import { runImageCall, type ImageRequest, type ImageTool, type PageDomCheck } from "@/lib/design-agent/phase2f-live/image-call";
import { openLedger } from "@/lib/design-agent/phase2f-live/ledger";
import { sha256 } from "@/lib/design-agent/phase2f-live/steps";
import { ThreeMethodBrief } from "@/lib/design-agent/three-methods/brief";
import { buildDirectionPrompt, directionJsonSchema } from "@/lib/design-agent/three-methods/direction";
import type { PageAssetRequest } from "@/lib/design-agent/three-methods/page-assets";
import { colourPng } from "../phase2f/fixtures";

// review L6: every temporary directory these tests make is removed afterwards
const temps: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

// DEV-150 (Issue #180): the three methods end to end with FAKE ports only (a fake Codex function, a fake image tool),
// the study's fictional shop and a temporary ledger: VISUAL_FIRST design → pre-render → image → package → lane;
// DIRECTION_FIRST direction → hand-off; a Claude page → measured request → page image → check; and the version check.
// Nothing here calls Codex, an image tool, the network or a paid API. Outputs go to new temporary directories only.

const REPO = resolve(__dirname, "../../../..");
const STUDY = "design-library/research/three-methods";
const MOCK = `${STUDY}/mock`;
const STEPS = resolve(REPO, "scripts/design-artifact/phase2f-steps.ts");
const TM = resolve(REPO, "scripts/design-artifact/three-methods-steps.ts");
const readRepo = (p: string) => readFileSync(resolve(REPO, p), "utf8");
const factsPath = resolve(REPO, STUDY, "facts-pack.json");
const briefPath = resolve(REPO, STUDY, "brief.json");
const facts = FactsPack.parse(JSON.parse(readRepo(`${STUDY}/facts-pack.json`)));
const tmBrief = ThreeMethodBrief.parse(JSON.parse(readRepo(`${STUDY}/brief.json`)));
const COMMIT = "f".repeat(40);
const META = { threadId: "00000000-0000-4000-8000-000000000000", cliVersion: "0.200.0", modelReported: "gpt-fictional-5", redactions: [] };
const clean = async () => ({ head: COMMIT, base: COMMIT, clean: true });
const ALT = "石窯の前に並ぶ焼きたてのパンを描いた絵。";
const saved = (model = "gpt-fictional-5"): ImageTool => async () => ({ png: colourPng(1024, 1024), width: 1024, height: 1024, outcome: "IMAGE_SAVED", stopCode: null, cliVersion: "0.200.0", model, threadId: null });
const DIRECTION = {
  schema: "three_method_direction_v0",
  concept: "朝の石窯の火から始まるページ。",
  dna: Object.fromEntries(["hero", "typography", "palette", "product_visual", "section_rhythm", "navigation", "mobile", "implementation"].map((p) => [p, { choice: `${p} の選択`, fact_refs: ["F1"] }])),
  avoid: ["カードの並び"],
};

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
});
afterAll(async () => {
  await browser?.close();
});

let n = 0;
function world() {
  const base = tmp("dev150-tm-steps-");
  const state = join(base, "state");
  const runs = join(base, "runs");
  mkdirSync(runs);
  const ledger = openLedger(state);
  const spawn = (script: string, args: string[]) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", script, ...args], { encoding: "utf8", env: { ...process.env, SR_PHASE2F_STATE: state } });
    const out = JSON.parse(r.stdout || "{}") as Record<string, unknown>;
    if (out.status === "stopped" || out.status === "refused") console.log(`${script.split("/").pop()} ${args[0]}: ${String(out.status)} ${String(out.code)}${out.detail ? ` (${String(out.detail)})` : ""}`);
    return { status: r.status, out, stderr: r.stderr };
  };
  const steps = (args: string[]) => spawn(STEPS, args);
  const tm = (args: string[]) => spawn(TM, args);
  const dir = (name: string) => join(runs, `${name}-${++n}`);
  return { base, state, runs, ledger, steps, tm, dir };
}

/** The study's MOCK prototype with one picture in its story section (route C needs exactly one). */
function routeCAnswer() {
  const html = readRepo(`${MOCK}/visual-first/codex-prototype/index.html`).replace('<section data-section="story">', `<section data-section="story"><img src="assets/A1.png" alt="${ALT}" style="display:block;width:320px;height:200px">`);
  const answer = JSON.parse(readRepo(`${MOCK}/visual-first/codex-answer.json`));
  for (const s of answer.structure_spec.sections) if (s.id === "story") s.asset_refs = ["A1"];
  return { ...answer, prototype: { html, css: readRepo(`${MOCK}/visual-first/codex-prototype/style.css`) } };
}

/** A MOCK page "Claude wrote", kept to the lane's allowlisted markup (a charset meta only, no table / svg), in a study-like root. */
const PAGE_HTML = [
  '<!doctype html>',
  '<html lang="ja">',
  '<head><meta charset="utf-8"><title>MOCK</title><link rel="stylesheet" href="style.css"></head>',
  "<body>",
  '<header class="bar" data-section="header"><span>こむぎ灯</span></header>',
  '<section class="morning" data-section="hero"><h1>架空パン工房 こむぎ灯</h1><figure class="morning__photo"><img src="assets/A1.png" alt="石窯の前に並ぶ焼きたてのパンを描いた絵。"></figure><p>毎朝5時から石窯に火を入れています</p></section>',
  '<section class="shelf" data-section="products"><h2>パン</h2><ul><li>架空カンパーニュ</li><li>架空塩バターパン</li></ul></section>',
  '<section class="info" data-section="info"><dl><dt>営業時間</dt><dd>7:00〜18:00</dd></dl></section>',
  '<footer class="foot" data-section="footer">架空パン工房 こむぎ灯</footer>',
  "</body>",
  "</html>",
].join("\n");
const PAGE_CSS = "body{margin:0;font-family:serif}section,header,footer{padding:24px}.morning__photo{margin:0}.morning__photo img{display:block;width:100%;max-width:960px;height:360px}";
function claudePage(root: string, o: { html?: (h: string) => string; css?: string } = {}) {
  const dir = join(root, "layout-first");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), o.html ? o.html(PAGE_HTML) : PAGE_HTML);
  writeFileSync(join(dir, "style.css"), o.css ?? PAGE_CSS);
  return join(dir, "index.html");
}

const pageDom: PageDomCheck = async (page, assetPaths) => {
  try {
    return { ok: true, alts: (await checkPrototype(browser, page, assetPaths)).alts };
  } catch (e) {
    if (e instanceof PrototypeUnsafe) return { ok: false, code: "PROTOTYPE_UNSAFE" };
    throw e;
  }
};
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));

describe("VISUAL_FIRST (route_c_prototype): tm0 design → pre-render → one image → package → lane", () => {
  it("reaches render_pair_complete with the tm0 prompt rebuilt from the same brief, and the lane carries no prototype", async () => {
    const w = world();
    const v = promptVariantOf({ route: "C_hybrid", version: "tm0", research: undefined, tmBrief });
    if (!v.ok) throw new Error(v.code);
    const built = buildDesignPrompt({ route: "C_hybrid", facts, maxAssets: 1, variant: v.variant });
    expect([built.sha256, built.chars]).toEqual(["f6632d283bbb1ed59941cd2064dd286b31968799d0f91c3c7b179967dbc0e0ac", 4415]);
    const designDir = w.dir("design");
    const d = await runDesignCall(
      { route: "C_hybrid", prompt: built.prompt, schema: {}, humanApprovalConfirmed: true, approvalId: "fictional-tm-vf-design-01", planId: "plan-fictional-tm-vf", retryOf: null, expected: { promptSha256: built.sha256, promptChars: built.chars, commit: COMMIT }, outDir: designDir },
      { ledger: w.ledger, commit: clean, codex: async () => ({ answer: routeCAnswer(), meta: META }) },
    );
    expect(d.status).toBe("succeeded");
    const preDir = w.dir("pre");
    const pre = w.steps(["--prerender", "--route", "C", "--design", designDir, "--facts", factsPath, "--out", preDir]);
    expect(pre.status, JSON.stringify(pre.out)).toBe(0);
    const request = json(join(preDir, "image-request-A1.json")) as ImageRequest;
    const imageDir = w.dir("image");
    const img = await runImageCall({ route: "C_hybrid", request, common: { humanApprovalConfirmed: true, approvalId: "fictional-tm-vf-image-01", planId: "plan-fictional-tm-vf", retryOf: null, expected: { promptSha256: request.prompt_sha256, promptChars: request.prompt_chars, commit: COMMIT }, outDir: imageDir } }, { ledger: w.ledger, commit: clean, image: saved() });
    expect(img.status).toBe("succeeded");
    const pkgDir = w.dir("pkg");
    const pkg = ["--package", "--route", "C", "--facts", factsPath, "--design", designDir, "--image", imageDir, "--artifact-id", "DA-20261101-tm0001", "--shop-id", facts.shop_id, "--shop-name", "架空パン工房 こむぎ灯", "--out", pkgDir, "--result", join(w.runs, "result.json")];
    // packaging rebuilds the prompt: only the same version and brief give the recorded SHA
    expect(w.steps([...pkg.slice(0, -4), "--out", w.dir("pkg"), "--result", join(w.runs, "r0.json"), "--prompt-version", "tm0"]).out).toMatchObject({ code: "TM_BRIEF_REQUIRED" });
    const r = w.steps([...pkg, "--prompt-version", "tm0", "--tm-brief", briefPath]);
    expect(r.status, JSON.stringify(r.out)).toBe(0);
    expect(r.out).toMatchObject({ status: "done", record: { route: "C_hybrid", verification_state: "render_pair_complete" } });
    const laneDir = w.dir("lane");
    const lane = w.tm(["--lane", "--package", pkgDir, "--facts", factsPath, "--out", laneDir]);
    expect(lane.status, JSON.stringify(lane.out)).toBe(0);
    expect(existsSync(join(laneDir, "lane.json"))).toBe(true);
    const files = (lane.out.files as string[]).join(" ");
    expect(files).toContain("originals/");
    expect(files).not.toMatch(/quarantine|index\.html|style\.css/);
    // a second lane into the same place is refused
    expect(w.tm(["--lane", "--package", pkgDir, "--facts", factsPath, "--out", laneDir]).status).toBe(2);

    // review M1 (owner decision 4): Claude's implementation uses the lane's generated picture from its own assets/.
    // Without a recorded visual inspection of exactly that picture the check is HOLD (the method stops for the owner);
    // with one, the audit decides. Never PASS on the page text alone.
    const lanePicture = (lane.out.files as string[]).find((f) => /^assets\/A1\.png$/.test(f));
    expect(lanePicture).toBeDefined();
    const impl = claudePage(join(w.base, "impl"), { html: (h) => h.replace(/<figure class="morning__photo">.*?<\/figure>/, "").replace('data-section="info">', `data-section="info"><img src="assets/A1.png" alt="${ALT}">`) });
    mkdirSync(join(impl, "..", "assets"));
    const picture = readFileSync(join(laneDir, lanePicture!));
    writeFileSync(join(impl, "..", "assets", "A1.png"), picture);
    const held = w.dir("check");
    const h = w.tm(["--check", "--page", impl, "--facts", factsPath, "--out", held]);
    expect(h.status).toBe(2);
    expect(h.out).toMatchObject({ status: "stopped", code: "IDENTITY_NOT_PASSED", identity: "HOLD" });
    expect(json(join(held, "check.json")).identity).toMatchObject({ status: "HOLD", page: { desktop_1440: { status: "PASS_IDENTITY_ONLY" } }, images: [{ path: "assets/A1.png", source: "page_assets", sha256: sha256(picture), identity: { status: "HOLD", pending: expect.arrayContaining(["VISUAL_INSPECTION_REQUIRED"]) } }] });
    const record = join(w.base, "vf-inspection.json");
    writeFileSync(record, JSON.stringify({ status: "completed", method: "assistant_visual", inspected_image_sha256: sha256(picture), reviewer_note: "MOCK note", visible_site_identity_labels: ["こむぎ灯"], category_code: "bakery", unreadable_site_identity: false, image_looks_like_unrelated_shop: false }));
    const passed = w.dir("check");
    const p = w.tm(["--check", "--page", impl, "--facts", factsPath, "--out", passed, "--visual-inspection", record]);
    expect(p.status, JSON.stringify(p.out)).toBe(0);
    expect(json(join(passed, "check.json")).identity).toMatchObject({ status: "PASS_IDENTITY_ONLY", images: [{ source: "page_assets", identity: { status: "PASS_IDENTITY_ONLY" } }] });
  }, 180_000);
});

describe("DIRECTION_FIRST (direction_text): direction call → hand-off", () => {
  it("hands over only the checked direction (concept, DNA, avoid) with the call's ids; a failed call is never handed over", async () => {
    const w = world();
    const built = buildDirectionPrompt({ facts, brief: tmBrief });
    const call = (answer: unknown, id: string) => {
      const outDir = w.dir("direction");
      return runDirectionCall(
        { prompt: built.prompt, schema: directionJsonSchema(), facts, humanApprovalConfirmed: true, approvalId: id, planId: "plan-fictional-tm-df", retryOf: null, expected: { promptSha256: built.sha256, promptChars: built.chars, commit: COMMIT }, outDir },
        { ledger: w.ledger, commit: clean, codex: async () => ({ answer, meta: META }) },
      ).then((r) => ({ r, outDir }));
    };
    const ok = await call(DIRECTION, "fictional-tm-df-direction-01");
    expect(ok.r.status).toBe("succeeded");
    const out = w.dir("handoff");
    const h = w.tm(["--direction", "--step", ok.outDir, "--facts", factsPath, "--out", out]);
    expect(h.status, JSON.stringify(h.out)).toBe(0);
    const record = json(join(out, "direction.json"));
    expect(record).toMatchObject({ schema: "three_method_direction_handoff_v0", method: "DIRECTION_FIRST", condition: "direction_text", direction: { concept: DIRECTION.concept, dna: DIRECTION.dna, avoid: DIRECTION.avoid }, call: { approval_id: "fictional-tm-df-direction-01", commit: COMMIT, tool_version: "0.200.0", model_reported: "gpt-fictional-5" } });
    expect(readdirSync(out)).toEqual(["direction.json"]);
    const bad = await call({ schema: "codex_design_v1" }, "fictional-tm-df-direction-02");
    expect(bad.r).toMatchObject({ status: "stopped", code: "DIRECTION_ANSWER_INVALID", stage: "call" });
    expect(w.tm(["--direction", "--step", bad.outDir, "--facts", factsPath, "--out", w.dir("handoff")]).out).toMatchObject({ status: "stopped", code: "DIRECTION_RUN_NOT_SUCCEEDED" });
    // the hand-off reads only a direction step (never a design step's folder)
    expect(w.tm(["--direction", "--step", w.runs, "--facts", factsPath, "--out", w.dir("handoff")]).out).toMatchObject({ status: "stopped", code: "RECORD_MISSING" });
  }, 120_000);
});

describe("LAYOUT_FIRST / DIRECTION_FIRST page: measured request → page image → check", () => {
  it("a page with one picture: a measured, essential request; the image bound to the page; the check records everything", async () => {
    const w = world();
    const root = join(w.base, "pilot");
    const page = claudePage(root);
    const reqDir = w.dir("page-request");
    const pr = w.tm(["--page-request", "--method", "LAYOUT_FIRST", "--page-root", root, "--page", page, "--hero", "hero", "--facts", factsPath, "--out", reqDir]);
    expect(pr.status, JSON.stringify(pr.out)).toBe(0);
    const request = json(join(reqDir, "asset-request-A1.json")) as PageAssetRequest;
    expect(request).toMatchObject({ schema: "three_method_asset_request_v0", method: "LAYOUT_FIRST", page: { path: "layout-first/index.html", html_sha256: sha256(readFileSync(page, "utf8")) }, asset_id: "A1", essential: true });
    expect(request.placement!.desktop_1440.sections).toEqual(["hero"]);
    const md = readFileSync(join(reqDir, "prerender.md"), "utf8");
    for (const s of [request.prompt, request.prompt_sha256, "layout-first/index.html", "主役画像: はい"]) expect(md).toContain(s);

    const imageDir = w.dir("page-image");
    const img = await runImageCall(
      { route: "claude_page", request, page: { root }, facts, common: { humanApprovalConfirmed: true, approvalId: "fictional-tm-lf-image-01", planId: "plan-fictional-tm-lf", retryOf: null, expected: { promptSha256: request.prompt_sha256, promptChars: request.prompt_chars, commit: COMMIT }, outDir: imageDir } },
      { ledger: w.ledger, commit: clean, image: saved(), pageDom, tracked: async () => true },
    );
    expect(img.status).toBe("succeeded");

    // the page alone (placeholder picture): identity of the page text passes, nothing overflows; recorded, exit 0
    const c1 = w.dir("check");
    const plain = w.tm(["--check", "--page", page, "--facts", factsPath, "--out", c1]);
    expect(plain.status, JSON.stringify(plain.out)).toBe(0);
    const r1 = json(join(c1, "check.json"));
    expect(r1).toMatchObject({ schema: "three_method_check_v0", scope: "offline_report_only", assets: [{ path: "assets/A1.png", source: "placeholder" }], horizontal_overflow: { desktop_1440: false, mobile_390: false }, identity: { status: "PASS_IDENTITY_ONLY", images: [] }, image: null, structure_observation: { schema: "structure_observation_v0" } });
    expect(r1.mobile_quality).toMatchObject({ viewport: "mobile_390", advisory: true });
    expect(readdirSync(c1).sort()).toEqual(["check.json", "pc1440.png", "sp390.png"]);

    // with the picture and no recorded visual inspection: HOLD (never proven from the picture), record written, exit 2
    const c2 = w.dir("check");
    const held = w.tm(["--check", "--page", page, "--facts", factsPath, "--out", c2, "--image", imageDir]);
    expect(held.status).toBe(2);
    expect(held.out).toMatchObject({ status: "stopped", code: "IDENTITY_NOT_PASSED", identity: "HOLD" });
    const r2 = json(join(c2, "check.json"));
    expect(r2.identity.images).toMatchObject([{ source: "image_step", identity: { status: "HOLD", pending: expect.arrayContaining(["VISUAL_INSPECTION_REQUIRED"]) } }]);
    expect(r2.assets).toEqual([{ path: "assets/A1.png", sha256: sha256(readFileSync(join(imageDir, "image.png"))), source: "image_step" }]);
    expect(existsSync(join(c2, "assets", "A1.png"))).toBe(true);

    // with a recorded inspection of exactly that picture: the audit decides; an inspection of another picture is REJECT
    const png = sha256(readFileSync(join(imageDir, "image.png")));
    const inspection = (sha: string) => {
      const p = join(w.base, `inspection-${++n}.json`);
      writeFileSync(p, JSON.stringify({ status: "completed", method: "assistant_visual", inspected_image_sha256: sha, reviewer_note: "MOCK note", visible_site_identity_labels: ["こむぎ灯"], category_code: "bakery", unreadable_site_identity: false, image_looks_like_unrelated_shop: false }));
      return p;
    };
    const c3 = w.dir("check");
    const passed = w.tm(["--check", "--page", page, "--facts", factsPath, "--out", c3, "--image", imageDir, "--visual-inspection", inspection(png)]);
    expect(passed.status, JSON.stringify(passed.out)).toBe(0);
    expect(json(join(c3, "check.json")).identity).toMatchObject({ status: "PASS_IDENTITY_ONLY", images: [{ source: "image_step", identity: { status: "PASS_IDENTITY_ONLY" } }] });
    const wrong = w.tm(["--check", "--page", page, "--facts", factsPath, "--out", w.dir("check"), "--image", imageDir, "--visual-inspection", inspection("0".repeat(64))]);
    expect(wrong.out).toMatchObject({ code: "IDENTITY_NOT_PASSED", identity: "REJECT" });

    // a picture made for another page (other bytes) is never placed
    const other = claudePage(join(w.base, "other"), { html: (h) => h.replace("パン</h2>", "パン </h2>") });
    expect(w.tm(["--check", "--page", other, "--facts", factsPath, "--out", w.dir("check"), "--image", imageDir]).out).toMatchObject({ status: "stopped", code: "IMAGE_PAGE_MISMATCH" });
    // review M1: the same picture placed in the page's own assets/ (not through --image) is held without an inspection too
    const own = claudePage(join(w.base, "own"));
    mkdirSync(join(own, "..", "assets"));
    writeFileSync(join(own, "..", "assets", "A1.png"), readFileSync(join(imageDir, "image.png")));
    const ownHeld = w.tm(["--check", "--page", own, "--facts", factsPath, "--out", w.dir("check")]);
    expect(ownHeld.out).toMatchObject({ status: "stopped", code: "IDENTITY_NOT_PASSED", identity: "HOLD" });
    const ownOk = w.dir("check");
    expect(w.tm(["--check", "--page", own, "--facts", factsPath, "--out", ownOk, "--visual-inspection", inspection(png)]).status).toBe(0);
    expect(json(join(ownOk, "check.json")).identity).toMatchObject({ status: "PASS_IDENTITY_ONLY", images: [{ source: "page_assets", identity: { status: "PASS_IDENTITY_ONLY" } }] });
  }, 180_000);

  it("another shop's name on the page is REJECT (stops the method); a horizontal overflow is recorded, never a stop", async () => {
    const w = world();
    const wrongShop = claudePage(join(w.base, "a"), { html: (h) => h.replace("</footer>", " 架空菓庵</footer>") });
    const rej = w.tm(["--check", "--page", wrongShop, "--facts", factsPath, "--out", w.dir("check")]);
    expect(rej.out).toMatchObject({ status: "stopped", code: "IDENTITY_NOT_PASSED", identity: "REJECT" });
    const wide = claudePage(join(w.base, "b"), { css: `${PAGE_CSS}\n.foot{width:2000px}` });
    const out = w.dir("check");
    const ov = w.tm(["--check", "--page", wide, "--facts", factsPath, "--out", out]);
    expect(ov.status, JSON.stringify(ov.out)).toBe(0);
    expect(json(join(out, "check.json")).horizontal_overflow).toEqual({ desktop_1440: true, mobile_390: true });
    // an unsafe page is refused before anything is drawn
    const unsafe = claudePage(join(w.base, "c"), { css: "@import url(x.css);" });
    expect(w.tm(["--check", "--page", unsafe, "--facts", factsPath, "--out", w.dir("check")]).out).toMatchObject({ status: "stopped", code: "PROTOTYPE_UNSAFE" });
  }, 120_000);

  it("a page with no picture records why it needs none (owner decision 3); a reason is required, and refused with a picture", () => {
    const w = world();
    const root = join(w.base, "pilot");
    const page = claudePage(root, { html: (h) => h.replace(/<figure class="morning__photo">.*?<\/figure>/, "") });
    const base = ["--page-request", "--method", "DIRECTION_FIRST", "--page-root", root, "--page", page, "--hero", "hero", "--facts", factsPath];
    expect(w.tm([...base, "--out", w.dir("pr")]).out).toEqual({ status: "refused", code: "NO_IMAGE_REASON_REQUIRED" });
    const out = w.dir("pr");
    const r = w.tm([...base, "--out", out, "--no-image-reason", "文字と色だけで構成した"]);
    expect(r.status, JSON.stringify(r.out)).toBe(0);
    expect(json(join(out, "no-image.json"))).toMatchObject({ schema: "three_method_no_image_v0", method: "DIRECTION_FIRST", images_requested: 0, reason: "文字と色だけで構成した", budget_note: expect.stringContaining("condition difference") });
    const withPicture = claudePage(join(w.base, "p2"));
    expect(w.tm(["--page-request", "--method", "LAYOUT_FIRST", "--page-root", join(w.base, "p2"), "--page", withPicture, "--hero", "hero", "--facts", factsPath, "--out", w.dir("pr"), "--no-image-reason", "x"]).out).toEqual({ status: "refused", code: "USAGE" });
    // the page must be under the root, and the hero must be one of its sections
    expect(w.tm(["--page-request", "--method", "LAYOUT_FIRST", "--page-root", join(w.base, "p2", "layout-first", "x"), "--page", withPicture, "--hero", "hero", "--facts", factsPath, "--out", w.dir("pr")]).out).toEqual({ status: "refused", code: "PAGE_OUTSIDE_ROOT" });
    expect(w.tm(["--page-request", "--method", "LAYOUT_FIRST", "--page-root", join(w.base, "p2"), "--page", withPicture, "--hero", "nope", "--facts", factsPath, "--out", w.dir("pr")]).out).toEqual({ status: "refused", code: "HERO_SECTION_UNKNOWN" });
    // markup the lane's reader does not understand is refused (here: the viewport meta)
    const viewport = claudePage(join(w.base, "p3"), { html: (h) => h.replace("<title>", '<meta name="viewport" content="width=device-width"><title>') });
    expect(w.tm(["--page-request", "--method", "LAYOUT_FIRST", "--page-root", join(w.base, "p3"), "--page", viewport, "--hero", "hero", "--facts", factsPath, "--out", w.dir("pr")]).out).toMatchObject({ status: "stopped", code: "PAGE_MARKUP_UNSUPPORTED" });
  }, 120_000);
});

describe("review round 2: a real picture can never pass as a placeholder (decision 4)", () => {
  it("a placeholder only where nothing exists; a linked file, a linked assets/, a non-regular or oversized file stops the check", () => {
    const w = world();
    const png = colourPng(64, 48);
    const elsewhere = join(w.base, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "A1.png"), png);
    const check = (page: string) => w.tm(["--check", "--page", page, "--facts", factsPath, "--out", w.dir("check")]);
    // control: assets/ exists but holds no A1.png (ENOENT) → the neutral placeholder, recorded as such
    const empty = claudePage(join(w.base, "empty"));
    mkdirSync(join(empty, "..", "assets"));
    const ok = check(empty);
    expect(ok.status, JSON.stringify(ok.out)).toBe(0);
    expect(ok.out).toMatchObject({ status: "recorded", identity: "PASS_IDENTITY_ONLY" });
    // a link to a real picture
    const linkedFile = claudePage(join(w.base, "linked-file"));
    mkdirSync(join(linkedFile, "..", "assets"));
    symlinkSync(join(elsewhere, "A1.png"), join(linkedFile, "..", "assets", "A1.png"));
    expect([check(linkedFile).status, check(linkedFile).out]).toEqual([2, { status: "stopped", code: "ASSET_FILE_INVALID", path: "assets/A1.png" }]);
    // assets/ itself a link
    const linkedDir = claudePage(join(w.base, "linked-dir"));
    symlinkSync(elsewhere, join(linkedDir, "..", "assets"));
    expect(check(linkedDir).out).toEqual({ status: "stopped", code: "ASSET_FILE_INVALID", path: "assets" });
    // assets/ not a directory
    const fileDir = claudePage(join(w.base, "file-dir"));
    writeFileSync(join(fileDir, "..", "assets"), "x");
    expect(check(fileDir).out).toEqual({ status: "stopped", code: "ASSET_FILE_INVALID", path: "assets" });
    // a non-regular entry (a directory named A1.png) and an oversized file (sparse, over 16 MB)
    const notFile = claudePage(join(w.base, "not-file"));
    mkdirSync(join(notFile, "..", "assets", "A1.png"), { recursive: true });
    expect(check(notFile).out).toEqual({ status: "stopped", code: "ASSET_FILE_INVALID", path: "assets/A1.png" });
    const big = claudePage(join(w.base, "big"));
    mkdirSync(join(big, "..", "assets"));
    writeFileSync(join(big, "..", "assets", "A1.png"), png);
    truncateSync(join(big, "..", "assets", "A1.png"), 16 * 1024 * 1024 + 1);
    expect(check(big).out).toEqual({ status: "stopped", code: "ASSET_FILE_INVALID", path: "assets/A1.png" });
  }, 120_000);

  it("an inspection record on a page with no real picture is refused (INSPECTION_UNUSED); with real pictures a record naming none is REJECT", () => {
    const w = world();
    const record = join(w.base, "inspection.json");
    writeFileSync(record, JSON.stringify({ status: "completed", method: "assistant_visual", inspected_image_sha256: "0".repeat(64), reviewer_note: "MOCK", visible_site_identity_labels: ["こむぎ灯"], category_code: "bakery", unreadable_site_identity: false, image_looks_like_unrelated_shop: false }));
    const placeholderOnly = claudePage(join(w.base, "p"));
    const r = w.tm(["--check", "--page", placeholderOnly, "--facts", factsPath, "--out", w.dir("check"), "--visual-inspection", record]);
    expect([r.status, r.out]).toEqual([2, { status: "refused", code: "INSPECTION_UNUSED" }]);
    const withPicture = claudePage(join(w.base, "q"));
    mkdirSync(join(withPicture, "..", "assets"));
    writeFileSync(join(withPicture, "..", "assets", "A1.png"), colourPng(64, 48));
    expect(w.tm(["--check", "--page", withPicture, "--facts", factsPath, "--out", w.dir("check"), "--visual-inspection", record]).out).toMatchObject({ status: "stopped", code: "IDENTITY_NOT_PASSED", identity: "REJECT" });
  }, 120_000);
});

describe("owner decision 5: the Codex CLI version and model stay the same between the pilot's calls", () => {
  it("same → 0; another model or version → GENERATION_CHANGED; an unknown one → GENERATION_FACTS_UNKNOWN (stop before the next call)", async () => {
    const w = world();
    const built = buildDirectionPrompt({ facts, brief: tmBrief });
    const direction = async (meta: typeof META | (Omit<typeof META, "modelReported"> & { modelReported: string | null }), answer: unknown = DIRECTION) => {
      const outDir = w.dir("direction");
      await runDirectionCall(
        { prompt: built.prompt, schema: directionJsonSchema(), facts, humanApprovalConfirmed: true, approvalId: `fictional-tm-ver-${++n}`, planId: `plan-fictional-ver-${n}`, retryOf: null, expected: { promptSha256: built.sha256, promptChars: built.chars, commit: COMMIT }, outDir },
        { ledger: w.ledger, commit: clean, codex: async () => ({ answer, meta }) },
      );
      return outDir;
    };
    const a = await direction(META);
    const b = await direction(META);
    const failedSame = await direction(META, { schema: "x" });
    const same = w.tm(["--versions", "--steps", [a, b, failedSame].join(",")]);
    expect(same.status, JSON.stringify(same.out)).toBe(0);
    expect(same.out).toMatchObject({ status: "same", tool_version: "0.200.0", model_reported: "gpt-fictional-5" });
    const otherModel = await direction({ ...META, modelReported: "gpt-fictional-6" });
    expect(w.tm(["--versions", "--steps", [a, otherModel].join(",")]).out).toMatchObject({ status: "stopped", code: "GENERATION_CHANGED" });
    const otherVersion = await direction({ ...META, cliVersion: "0.201.0" });
    expect(w.tm(["--versions", "--steps", [a, otherVersion].join(",")]).out).toMatchObject({ status: "stopped", code: "GENERATION_CHANGED" });
    const unknown = await direction({ ...META, modelReported: null });
    expect(w.tm(["--versions", "--steps", [a, unknown].join(",")]).out).toMatchObject({ status: "stopped", code: "GENERATION_FACTS_UNKNOWN" });
    expect(w.tm(["--versions", "--steps", w.runs]).out).toMatchObject({ status: "stopped", code: "RECORD_MISSING" });
  }, 120_000);
});

describe("the offline steps CLI refuses unclear usage", () => {
  it("exactly one mode and only its flags", () => {
    const w = world();
    for (const args of [[], ["--lane", "--check"], ["--lane", "--package", "x", "--facts", factsPath, "--out", "y", "--image", "z"], ["--check", "--page", "x", "--facts", factsPath, "--out", "y", "--approval-id", "a"], ["--versions"], ["--page-request", "--method", "VISUAL_FIRST", "--page-root", "a", "--page", "b", "--hero", "hero", "--facts", factsPath, "--out", "c"]]) {
      const r = w.tm(args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.out, args.join(" ")).toEqual({ status: "refused", code: "USAGE" });
    }
    expect(existsSync(w.state)).toBe(false);
  }, 120_000);
});
