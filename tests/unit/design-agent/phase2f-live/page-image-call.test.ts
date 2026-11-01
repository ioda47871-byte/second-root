import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FactsPack } from "@/lib/design-agent/artifact/schema";
import { runImageCall, type ImageCallDeps, type ImageCallInput, type ImageTool, type PageDomCheck } from "@/lib/design-agent/phase2f-live/image-call";
import { openLedger } from "@/lib/design-agent/phase2f-live/ledger";
import { readStep, sha256 } from "@/lib/design-agent/phase2f-live/steps";
import { buildPageAssetRequests, type PageAssetRequest, type Placement } from "@/lib/design-agent/three-methods/page-assets";
import { trackedInRepo } from "../../../../scripts/design-artifact/phase2f-live-cli";
import { colourPng } from "../phase2f/fixtures";

// DEV-150 (Issue #180): a picture for a page CLAUDE wrote (route claude_page, kind page_image). Fake image tool, fake
// DOM check and tracked check (both injected, as the image CLI injects the real ones), the ledger in a temp directory.
// Every check 0-4 stops before the approval is used. Nothing calls Codex or an image tool.

const REPO = resolve(__dirname, "../../../..");
const facts = FactsPack.parse(JSON.parse(readFileSync(resolve(REPO, "design-library/research/three-methods/facts-pack.json"), "utf8")));
const COMMIT = "d".repeat(40);
const ALT = "石窯の前に並ぶ焼きたてのパンを描いた絵。";
const HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>こむぎ灯</title><link rel="stylesheet" href="style.css"></head><body><header data-section="header"><p>架空パン工房 こむぎ灯</p></header><section data-section="hero"><img src="assets/A1.png" alt="${ALT}"></section><section data-section="info"><p>毎朝5時から石窯に火を入れています</p></section></body></html>`;
const CSS = "body{margin:0}img{display:block;width:100%}";
const at = { sections: ["hero"], outside_sections: false, first_screen: true, shown: true };
const PLACEMENT: Placement = { desktop_1440: at, mobile_390: { ...at } };
let n = 0;

function world(o: { html?: string } = {}) {
  const base = mkdtempSync(join(tmpdir(), "dev150-page-image-"));
  const root = join(base, "pilot");
  mkdirSync(join(root, "layout-first"), { recursive: true });
  writeFileSync(join(root, "layout-first", "index.html"), o.html ?? HTML);
  writeFileSync(join(root, "layout-first", "style.css"), CSS);
  const runs = join(base, "runs");
  mkdirSync(runs);
  const ledger = openLedger(join(base, "state"));
  const built = buildPageAssetRequests({ method: "LAYOUT_FIRST", page: { path: "layout-first/index.html", html: o.html ?? HTML }, facts, placement: { A1: PLACEMENT }, heroSections: ["hero"] });
  if (!built.ok) throw new Error(built.code);
  const request = built.requests[0]!;
  const tool = Object.assign((async () => ((tool.calls += 1), { png: colourPng(1024, 1024), width: 1024, height: 1024, outcome: "IMAGE_SAVED", stopCode: null, cliVersion: "0.200.0", model: "gpt-fictional-image", threadId: null })) as ImageTool, { calls: 0 });
  const dom: PageDomCheck = async () => ({ ok: true, alts: { "assets/A1.png": ALT } });
  const call = (req: PageAssetRequest = request, d: Partial<ImageCallDeps> = {}, c: Partial<ImageCallInput["common"]> = {}) => {
    const outDir = join(runs, `image-${++n}`);
    const input: ImageCallInput = { route: "claude_page", request: req, page: { root }, facts, common: { humanApprovalConfirmed: true, approvalId: `fictional-tm-lf-image-${n}`, planId: "plan-fictional-tm-lf", retryOf: null, expected: { promptSha256: req.prompt_sha256, promptChars: req.prompt_chars, commit: COMMIT }, outDir, ...c } };
    return runImageCall(input, { ledger, image: tool, commit: async () => ({ head: COMMIT, base: COMMIT, clean: true }), pageDom: dom, tracked: async () => true, ...d }).then((r) => ({ r, outDir }));
  };
  const used = () => (existsSync(join(base, "state", "approvals")) ? readdirSync(join(base, "state", "approvals")) : []);
  return { base, root, ledger, request, tool, call, used };
}

describe("a page's picture: one approval, bound to the page", () => {
  it("a measured request for a tracked, safe page is called once and recorded as page_image × claude_page", async () => {
    const w = world();
    const { r, outDir } = await w.call();
    expect(r.status).toBe("succeeded");
    expect(w.tool.calls).toBe(1);
    const callJson = JSON.parse(readFileSync(join(outDir, "call.json"), "utf8"));
    expect(callJson).toMatchObject({ status: "succeeded", receipt: { kind: "page_image", route: "claude_page" }, request: { page_path: "layout-first/index.html", page_sha256: sha256(HTML), asset_id: "A1", essential: true } });
    const step = await readStep(outDir, w.ledger, { kind: "page_image", route: "claude_page" });
    expect(step.generation).toMatchObject({ tool_version: "0.200.0", model_reported: "gpt-fictional-image" });
  });

  it.each<[string, (w: ReturnType<typeof world>) => [PageAssetRequest, Partial<ImageCallDeps>], string]>([
    ["1. another schema", (w) => [{ ...w.request, schema: "phase2f_image_request_v1" } as never, {}], "IMAGE_REQUEST_INVALID"],
    ["1. a prompt that is not its own hash", (w) => [{ ...w.request, prompt: `${w.request.prompt} ` }, {}], "IMAGE_REQUEST_INVALID"],
    ["4. not measured (owner policy)", (w) => [{ ...w.request, placement: null }, {}], "ASSET_PLACEMENT_UNMEASURED"],
    ["4. no placement key at all (read back from JSON)", (w) => [{ ...w.request, placement: undefined } as never, {}], "ASSET_PLACEMENT_UNMEASURED"],
    ["the CLI gave no DOM or tracked check", (w) => [w.request, { pageDom: undefined, tracked: undefined }], "PAGE_CHECKS_NOT_GIVEN"],
    ["2. a page path that leaves the root", (w) => [{ ...w.request, page: { ...w.request.page, path: "../pilot/layout-first/index.html" } }, {}], "PAGE_FILE_INVALID"],
    ["2. an absolute page path", (w) => [{ ...w.request, page: { ...w.request.page, path: join(w.root, "layout-first/index.html") } }, {}], "PAGE_FILE_INVALID"],
    ["2. the page's bytes are not the request's", (w) => [{ ...w.request, page: { ...w.request.page, html_sha256: "0".repeat(64) } }, {}], "PAGE_SHA_MISMATCH"],
    ["2. the page is not tracked", (w) => [w.request, { tracked: async () => false }], "PAGE_NOT_TRACKED"],
    ["3. a hand-edited alt and prompt (self-consistent)", (w) => {
      const forged = buildPageAssetRequests({ method: "LAYOUT_FIRST", page: { path: "layout-first/index.html", html: HTML.replace(ALT, "別の絵。") }, facts, placement: { A1: PLACEMENT }, heroSections: ["hero"] });
      if (!forged.ok) throw new Error(forged.code);
      return [{ ...forged.requests[0]!, page: w.request.page }, {}];
    }, "IMAGE_REQUEST_MISMATCH"],
    ["3. an essential picture marked not essential", (w) => [{ ...w.request, essential: false }, {}], "IMAGE_REQUEST_MISMATCH"],
    ["0. the DOM safety check refuses the page", (w) => [w.request, { pageDom: async () => ({ ok: false, code: "PROTOTYPE_UNSAFE" }) }], "PROTOTYPE_UNSAFE"],
    ["0. the DOM check fails", (w) => [w.request, { pageDom: async () => Promise.reject(new Error("browser")) }], "PAGE_DOM_CHECK_FAILED"],
    ["0. the DOM reads another alt", (w) => [w.request, { pageDom: async () => ({ ok: true, alts: { "assets/A1.png": "別の絵。" } }) }], "ASSET_DOM_ALT_MISMATCH"],
  ])("%s: refused before the approval is used", async (_n, make, code) => {
    const w = world();
    const [req, d] = make(w);
    const { r } = await w.call(req, d);
    expect(r).toEqual({ status: "stopped", code, stage: "precheck", aborted: false });
    expect(w.tool.calls).toBe(0);
    expect(w.used()).toEqual([]);
  });

  it("2. a page reached through a link is refused", async () => {
    const w = world();
    const elsewhere = mkdtempSync(join(tmpdir(), "dev150-elsewhere-"));
    writeFileSync(join(elsewhere, "index.html"), HTML);
    writeFileSync(join(elsewhere, "style.css"), CSS);
    symlinkSync(elsewhere, join(w.root, "linked"));
    const { r } = await w.call({ ...w.request, page: { ...w.request.page, path: "linked/index.html" } });
    expect(r).toMatchObject({ code: "PAGE_FILE_INVALID", stage: "precheck" });
    expect(w.used()).toEqual([]);
  });

  it("the usual guards still come first and after: approval confirmation, prompt pin, commit pin, one use", async () => {
    const w = world();
    expect((await w.call(w.request, {}, { humanApprovalConfirmed: false })).r).toMatchObject({ code: "HUMAN_APPROVAL_REQUIRED" });
    expect((await w.call(w.request, {}, { expected: { promptSha256: "0".repeat(64), promptChars: w.request.prompt_chars, commit: COMMIT } })).r).toMatchObject({ code: "PROMPT_PIN_MISMATCH" });
    expect((await w.call(w.request, { commit: async () => ({ head: COMMIT, base: "e".repeat(40), clean: true }) })).r).toMatchObject({ code: "COMMIT_PIN_MISMATCH" });
    expect(w.used()).toEqual([]);
    const first = await w.call();
    if (first.r.status !== "succeeded") throw new Error(first.r.code);
    expect((await w.call(w.request, {}, { approvalId: first.r.receipt.approval_id })).r).toMatchObject({ code: "APPROVAL_ALREADY_USED", stage: "precheck" });
    expect(w.tool.calls).toBe(1);
  });
});

describe("the image CLI's route P (offline paths only)", () => {
  const cli = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ["--import", "tsx", resolve(REPO, "scripts/design-artifact/phase2f-image.ts"), ...args], { encoding: "utf8", env: { ...process.env, ...env } });

  it("P takes exactly its three flags; never with --request or --concept-v4; C and A never take them", () => {
    const w = world();
    const req = join(w.base, "req.json");
    writeFileSync(req, JSON.stringify(w.request));
    const page = ["--page-request", req, "--page-root", w.root, "--facts", resolve(REPO, "design-library/research/three-methods/facts-pack.json")];
    const call = ["--out", join(w.base, "out"), "--plan-id", "plan-fictional-tm-lf", "--approval-id", "fictional-tm-lf-cli-1", "--expected-prompt-sha256", w.request.prompt_sha256, "--expected-prompt-chars", String(w.request.prompt_chars), "--expected-commit", COMMIT, "--human-approval-confirmed"];
    const state = mkdtempSync(join(tmpdir(), "dev150-image-cli-"));
    for (const args of [
      ["--route", "P", ...page, "--request", req, ...call],
      ["--route", "P", ...page, "--concept-v4", ...call],
      ["--route", "P", ...page.slice(0, 4), ...call],
      ["--route", "C", "--request", req, "--page-root", w.root, ...call],
      ["--route", "A", "--concept-v4", "--facts", page[5]!, ...call],
      ["--print-pin", ...page.slice(0, 4)],
      ["--print-pin", "--concept-v4", ...page],
    ]) {
      const r = cli(args, { SR_PHASE2F_STATE: state });
      expect(r.status, args.join(" ")).toBe(2);
      expect(JSON.parse(r.stdout), args.join(" ")).toEqual({ status: "refused", code: "USAGE" });
    }
    expect(readdirSync(state)).toEqual([]);
  }, 120_000);

  it("--print-pin runs the same checks as a call: a page outside the repository is not tracked (real git), nothing used", () => {
    const w = world();
    const req = join(w.base, "req.json");
    writeFileSync(req, JSON.stringify(w.request));
    const r = cli(["--print-pin", "--page-request", req, "--page-root", w.root, "--facts", resolve(REPO, "design-library/research/three-methods/facts-pack.json")]);
    expect(r.status, r.stderr).toBe(2);
    expect(JSON.parse(r.stdout)).toEqual({ status: "refused", code: "PAGE_NOT_TRACKED" });
    const unmeasured = join(w.base, "req2.json");
    writeFileSync(unmeasured, JSON.stringify({ ...w.request, placement: null }));
    expect(JSON.parse(cli(["--print-pin", "--page-request", unmeasured, "--page-root", w.root, "--facts", resolve(REPO, "design-library/research/three-methods/facts-pack.json")]).stdout)).toEqual({ status: "refused", code: "ASSET_PLACEMENT_UNMEASURED" });
  }, 60_000);

  it("trackedInRepo: tracked files in the repository only (the same bounded git as the commit pin)", async () => {
    expect(await trackedInRepo([resolve(REPO, "package.json"), resolve(REPO, "design-library/research/three-methods/brief.json")])).toBe(true);
    const outside = mkdtempSync(join(tmpdir(), "dev150-tracked-"));
    writeFileSync(join(outside, "index.html"), HTML);
    expect(await trackedInRepo([join(outside, "index.html")])).toBe(false);
    expect(await trackedInRepo([resolve(REPO, "package.json"), join(outside, "index.html")])).toBe(false);
    expect(await trackedInRepo([resolve(REPO, "no-such-file-dev150.html")])).toBe(false);
    expect(await trackedInRepo([])).toBe(false);
  }, 60_000);
});
