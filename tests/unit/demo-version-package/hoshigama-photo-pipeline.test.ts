/**
 * DEV-139: ほし窯 (bakery, a FICTIONAL bakery) — the whole photo path OFFLINE, ending in the real package CLI:
 *
 *   stub batch (3 plain PNGs made here) → bundle writer → intake (upscale ≤2×, lanczos3) → photo swap of the committed
 *   fidelity page d2-v1 (rights, crops, PC 1440 / SP 390 renders) → package-local.ts --page … --facts …
 *   → a sales_demo_version_package_v2 holding BOTH the copy (facts pack, copy record, copy review) AND the photos
 *   (WebP, image records from the rights and the owner's depiction confirmation).
 *
 * No model, no image generation, no network, no database. The pictures are plain images with ai_generated_demo
 * provenance STUBS. Nothing here is an approval: the steps after the bundle use a STUB approval record and
 * simulateOwnerApproval() (in this process, or in the CLI's process through tests/support/
 * hoshigama-approved-package-local.ts) exactly where the owner's approval would change data; the repository keeps
 * aiDemoAllowed: false and HOSHIGAMA_APPROVAL null, and the plain CLI refuses (shown below).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COPY_FACTS_NAME, COPY_RECORD_NAME, COPY_REVIEW_NAME } from "@/lib/demo-version-package/copy";
import { ImportError, importPackage, type PackageStore } from "@/lib/demo-version-package/import";
import { checkPackageCopy, PACKAGE_FORMAT, PACKAGE_FORMAT_COPY, readPackage, swapCopyInput } from "@/lib/demo-version-package/package";
import { S0_FACTS_PATH, S0_PROSPECT_ID } from "@/lib/demo-version-package/seed-s0";
import { DEPICTION_CONFIRMATION_STATEMENT } from "@/lib/demo-version-package/swap-rights";
import { writeHoshigamaPhotos } from "@/lib/design-agent/design-image/hoshigama-photos";
import { buildHoshigamaRunPromptCandidate, HOSHIGAMA_OFFLINE_STUB_GENERATOR, HOSHIGAMA_PROMPT_DRAFT_SHA256, HOSHIGAMA_PROMPT_FILE } from "@/lib/design-agent/quality-pipeline/hoshigama-ai-photos";
import { loadForbiddenSha256 } from "@/lib/design-agent/quality-pipeline/photo-rights";
import { SWAP_SHOP_SPECS } from "@/lib/design-agent/quality-pipeline/photo-swap-shops";
import { importHoshigamaAiPhotos } from "../../../scripts/design-artifact/hoshigama-ai-intake";
import { swapPage } from "../../../scripts/design-artifact/photo-swap";
import { simulateOwnerApproval, STUB_APPROVAL, STUB_RUN_APPROVAL_ID } from "../../support/hoshigama-approval-stub";

const REPO = resolve(__dirname, "../../..");
const PAGE = "design-library/research/quality-pipeline/poc/bakery/fidelity/d2-v1";
const FACTS = join(REPO, S0_FACTS_PATH);
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const launch = () => chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const node = (script: string, args: string[]) => spawnSync(process.execPath, ["--import", "tsx", join(REPO, script), ...args], { cwd: REPO, encoding: "utf8", env: process.env, timeout: 180_000 });

describe("ほし窯: stub photos → intake → swap → render → package v2 with copy AND photos (real package CLI)", () => {
  let root: string;
  let pipeline: string;
  let browser: Browser;
  let swapOut: string;
  let depictionPath: string;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "dev139-pkg-"));
    pipeline = join(root, "pipeline");
    mkdirSync(join(pipeline, ".intake", "photos"), { recursive: true });
    browser = await launch();

    // 1. the run bundle from a STUB batch (no model, no tool): plain PNGs at the shapes a run would ask for
    const images = [];
    for (const [i, [w, h]] of ([[1536, 1536], [1024, 1536], [1536, 1024]] as const).entries()) {
      images.push({ png: await sharp({ create: { width: w, height: h, channels: 3, background: { r: 150 + i * 30, g: 80 + i * 10, b: 40 } } }).png().toBuffer(), width: w, height: h });
    }
    const draft = readFileSync(join(REPO, HOSHIGAMA_PROMPT_FILE), "utf8");
    const bundle = await writeHoshigamaPhotos({
      outRoot: root,
      batch: { images, outcome: "not_applicable", stopCode: null, imageCalls: 3, imageFailed: 0, threadId: null, cliVersion: "0.0.0-test", model: "fixture-image-model", codexMs: 1 },
      commit: "b".repeat(40),
      approvedPrompt: draft,
      runPrompt: buildHoshigamaRunPromptCandidate(draft),
      generatedAt: "2026-11-17T10:00:00+09:00",
      approvalId: STUB_RUN_APPROVAL_ID,
      generator: HOSHIGAMA_OFFLINE_STUB_GENERATOR,
      approval: STUB_APPROVAL,
    });
    // 2. the intake (the oven-mouth PC and the loaf enlarged ≤2×) → the swap manifest
    const intake = await importHoshigamaAiPhotos({ from: bundle.dir, manifestOut: join(root, "swap-manifest.json"), pipelineRoot: pipeline, approvalIds: [STUB_RUN_APPROVAL_ID], generators: [HOSHIGAMA_OFFLINE_STUB_GENERATOR], approval: STUB_APPROVAL });
    if (!intake.ok) throw new Error(intake.codes.join(","));
    // 3. the owner's depiction confirmation (written by the owner for real photos; here for the stubs)
    depictionPath = join(root, "depiction-confirmation.json");
    writeFileSync(
      depictionPath,
      JSON.stringify({ schema: "rin_depiction_confirmation_v0", photos: intake.provenance.map((p) => ({ sha256: p.sha256, depicts_real_product: false, depicts_real_interior: false, depicts_real_equipment: false, confirmation: DEPICTION_CONFIRMATION_STATEMENT })) }),
    );
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });
  const manifest = () => JSON.parse(readFileSync(join(root, "swap-manifest.json"), "utf8")) as unknown;
  const swap = (out: string) => swapPage({ pageDir: PAGE, manifest: manifest(), out, pipelineRoot: pipeline, now: "2026-11-17", forbiddenSha256: loadForbiddenSha256(REPO), browser });

  it("without the owner's approval the swap refuses the AI demo pictures (AI_DEMO_NOT_ALLOWED), nothing written", async () => {
    expect(SWAP_SHOP_SPECS.bakery.aiDemoAllowed).toBe(false);
    const res = await swap(join(root, "swap-refused"));
    expect(res.ok ? [] : res.refusals.map((r) => [r.slot_id, r.photo, r.codes])).toEqual([["ph-mouth", "pc", ["AI_DEMO_NOT_ALLOWED"]], ["ph-mouth", "sp", ["AI_DEMO_NOT_ALLOWED"]], ["ph-loaf", "pc", ["AI_DEMO_NOT_ALLOWED"]]]);
    expect(readdirSync(root)).not.toContain("swap-refused");
  }, 60_000);

  it("with the approval simulated: the swap renders PC 1440 and SP 390 with both photos", async () => {
    const restore = simulateOwnerApproval();
    try {
      swapOut = join(root, "swap");
      const res = await swap(swapOut);
      if (!res.ok) throw new Error(JSON.stringify(res.refusals));
      expect(res.renders.map((r) => [r.viewport, r.images_loaded, r.boards_intact, r.caption_text_left, r.horizontal_overflow])).toEqual([["desktop_1440", 2, 2, false, false], ["mobile_390", 2, 2, false, false]]);
      const slots = res.summary.slots as Array<{ slot_id: string; photos: Array<{ which: string; source_kind: string }> }>;
      expect(slots.flatMap((s) => s.photos.map((p) => [s.slot_id, p.which, p.source_kind]))).toEqual([["ph-mouth", "pc", "ai_generated_demo"], ["ph-mouth", "sp", "ai_generated_demo"], ["ph-loaf", "pc", "ai_generated_demo"]]);
    } finally {
      restore();
    }
    expect(SWAP_SHOP_SPECS.bakery.aiDemoAllowed).toBe(false);
  }, 120_000);

  const APPROVED_CLI = "tests/support/hoshigama-approved-package-local.ts";
  const args = (swapDir: string, out: string, facts = true) => ["--out", out, "--page", join(swapDir, "page"), "--rights", join(swapDir, "rights.private.json"), "--originals", join(pipeline, ".intake", "photos"), "--depiction-confirmation", depictionPath, ...(facts ? ["--facts", FACTS] : [])];

  it("the committed d2-v1: the plain CLI refuses its photos (not approved); approved, photos package (v1) but the copy is refused (<wbr>)", () => {
    const refused = node("scripts/sales/demo-version/package-local.ts", args(swapOut, join(root, "pkg-refused")));
    expect(refused.status, refused.stderr).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({ status: "FAIL", code: "SUMMARY_NOT_RIN" });
    expect(readdirSync(root)).not.toContain("pkg-refused");
    // the photos alone (no --facts): a v1 package, every photo check passed
    const v1 = node(APPROVED_CLI, args(swapOut, join(root, "pkg-v1"), false));
    expect(v1.status, `${v1.stdout}\n${v1.stderr}`).toBe(0);
    const v1pkg = readPackage(join(root, "pkg-v1"));
    expect(v1pkg.format).toBe(PACKAGE_FORMAT);
    expect(v1pkg.images).toHaveLength(5);
    // with --facts: the existing server copy check reads d2-v1's text nodes as the <wbr> splits them ("7:00〜16:00" …) —
    // the same refusal as the photo-less comp itself (docs/operations/step2-fictional-e2e.md: not loosened)
    const v2 = node(APPROVED_CLI, args(swapOut, join(root, "pkg-v2-wbr")));
    expect(v2.status).toBe(1);
    expect(JSON.parse(v2.stdout)).toEqual({ status: "FAIL", code: "COPY_INVALID", details: ["COPY_CHECK_FAILED", "UNVERIFIED_COPY", "JOINED_TEXT_LOOKS_LIKE_FACT"] });
    expect(readdirSync(root)).not.toContain("pkg-v2-wbr");
  }, 300_000);

  it("a <wbr>-free variant of the same swapped page (test only): the approved CLI writes a v2 package with copy AND photos", async () => {
    // TEST-ONLY variant: the swap's own output with every <wbr> taken out of its HTML and the summary's copy hash moved
    // with it, standing in for a future <wbr>-free page version. Photos, rights, crops and copy record are the swap's.
    const variant = join(root, "swap-nowbr");
    cpSync(swapOut, variant, { recursive: true });
    const html = readFileSync(join(variant, "page", "index.html"), "utf8").replace(/<wbr>/g, "");
    writeFileSync(join(variant, "page", "index.html"), html);
    const summary = JSON.parse(readFileSync(join(variant, "swap-summary.json"), "utf8")) as { copy_hashes: { html: string } };
    summary.copy_hashes.html = sha(html);
    writeFileSync(join(variant, "swap-summary.json"), JSON.stringify(summary));

    const out = join(root, "pkg");
    const r = node(APPROVED_CLI, args(variant, out));
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const printed = JSON.parse(r.stdout) as { status: string; format: string; source: string; photos: unknown[]; copy_files: Array<{ name: string; sha256: string }> };
    expect(printed).toMatchObject({ status: "OK", format: PACKAGE_FORMAT_COPY, source: "swap-copy" });
    // 5 distinct photo files: the loaf's mobile crop is its desktop crop (one shape everywhere), so they share a file
    expect(printed.photos).toHaveLength(5);

    // read back and verified again (re-hash, the server's checks, the image records, the copy)
    const pkg = readPackage(out);
    expect(pkg.format).toBe(PACKAGE_FORMAT_COPY);
    expect(pkg.manifest.files.filter((f) => f.role === "photo").map((f) => f.name).sort()).toEqual(["page/photos/ph_loaf-desktop.webp", "page/photos/ph_loaf-tablet.webp", "page/photos/ph_mouth-desktop.webp", "page/photos/ph_mouth-mobile.webp", "page/photos/ph_mouth-tablet.webp"]);
    expect(pkg.images).toHaveLength(5);
    expect(new TextDecoder().decode(pkg.files["page/index.html"]!)).toContain('<source media="(max-width: 600px)" srcset="photos/ph_loaf-desktop.webp">');
    for (const img of pkg.images) expect(img).toMatchObject({ source_kind: "ai_generated_demo", rights_status: "ai_demo_internal", depicts_real_shop: false, depicts_real_product: false, allowed_uses: { public_web: false }, provenance: { prompt_sha256: HOSHIGAMA_PROMPT_DRAFT_SHA256, admin_preview_only: true } });
    // the facts: the committed facts pack, byte for byte
    const facts = readFileSync(FACTS);
    expect(sha(pkg.copyFiles![COPY_FACTS_NAME]!)).toBe(sha(facts));
    expect(pkg.copy!.files.find((f) => f.name === COPY_FACTS_NAME)!.sha256).toBe(sha(facts));
    // the copy record: the page's, the two placeholder captions turned into the pictures' alt texts, nothing else
    const page = JSON.parse(readFileSync(join(REPO, PAGE, "copy.json"), "utf8")) as { items: Array<{ id: string; text: string }> };
    const stored = JSON.parse(new TextDecoder().decode(pkg.copyFiles![COPY_RECORD_NAME]!)) as { items: Array<{ id: string; text: string }> };
    expect(stored.items.map((i) => i.id)).toEqual(page.items.map((i) => i.id));
    expect(stored.items.filter((i, n) => i.text !== page.items[n]!.text).map((i) => [i.id, i.text])).toEqual([["ph-mouth", "石窯の口"], ["ph-loaf", "田舎パン"]]);
    expect(JSON.parse(new TextDecoder().decode(pkg.copyFiles![COPY_REVIEW_NAME]!))).toMatchObject({ round: 0, lane: "quality_research_fictional", shop_id: "fictional-bakery-hoshigama" });

    // the copy gate, as on import: never sendable; the facts path counts only with the trusted facts
    const untrusted = checkPackageCopy(pkg);
    expect(untrusted).toMatchObject({ status: "checked", sendable: false, verdict: "approve_candidate", next_step: "owner_review", facts_from_facts_path: false, facts_sha256: sha(facts) });
    expect((untrusted as { send_blockers: string[] }).send_blockers).toEqual(["FICTIONAL_RESEARCH_NOT_SENDABLE", "OWNER_APPROVAL_MISSING", "FACTS_NOT_FROM_FACTS_PATH"]);
    const trusted = checkPackageCopy(pkg, { trustedFactsPack: facts });
    expect(trusted).toMatchObject({ status: "checked", sendable: false, facts_from_facts_path: true });
    expect(() => checkPackageCopy(pkg, { trustedFactsPack: Buffer.concat([facts, Buffer.from("\n")]) })).toThrow(/COPY_FACTS_NOT_FROM_FACTS_PATH/);

    // the import keeps AI demo pictures to the fictional 輪: ほし窯's S0 prospect is refused before anything is written
    const calls: string[] = [];
    const store: PackageStore = { download: async () => null, upload: async () => { throw new Error("must not upload"); } };
    const client = {
      from: (table: string) => ({
        select: () => {
          const q = {
            eq: () => q,
            in: () => q,
            order: () => Object.assign(Promise.resolve({ data: [], error: null }), { limit: async () => ({ data: [], error: null }) }),
            maybeSingle: async () => ({ data: table === "sales_demos" ? { prospect_id: S0_PROSPECT_ID } : null, error: null }),
          };
          return q;
        },
      }),
      rpc: async (name: string) => {
        calls.push(name);
        return { data: null, error: { message: "stop" } };
      },
    } as never;
    await expect(importPackage(pkg, { client, store, demoId: "11111111-1111-4111-8111-111111111111", trustedFactsPack: facts })).rejects.toThrow(new ImportError("AI_DEMO_NOT_ALLOWED"));
    expect(calls).toEqual([]);
  }, 300_000);

  it("the copy derivation fails closed: a copy record that is not the page's, a custom alt, a caption left", () => {
    const html = readFileSync(join(swapOut, "page", "index.html"), "utf8");
    const css = readFileSync(join(swapOut, "page", "style.css"), "utf8");
    const summary = JSON.parse(readFileSync(join(swapOut, "swap-summary.json"), "utf8")) as { slots: Array<{ alt: string }> };
    const copyRecord = new Uint8Array(readFileSync(join(swapOut, "page", "copy.json")));
    const factsPack = new Uint8Array(readFileSync(FACTS));
    const base = { copyRecord, factsPack, summary, html, css, photoUrls: new Set<string>() };
    expect(swapCopyInput(base).replaced).toEqual(["ph-mouth", "ph-loaf"]);
    const edited = new TextEncoder().encode(new TextDecoder().decode(copyRecord).replace("架空田舎パン", "田舎パン"));
    expect(() => swapCopyInput({ ...base, copyRecord: edited })).toThrow(/COPY_INVALID: COPY_RECORD_NOT_THE_PAGE_COPY/);
    expect(() => swapCopyInput({ ...base, summary: { ...summary, slots: summary.slots.map((s, i) => (i === 0 ? { ...s, alt: "窯の火" } : s)) } })).toThrow(/COPY_INVALID: COPY_PLACEHOLDER_ITEM_NOT_FOUND,ph-mouth/);
    expect(() => swapCopyInput({ ...base, summary: { ...summary, slots: summary.slots.slice(0, 1) } })).toThrow(/COPY_INVALID: COPY_PLACEHOLDER_LEFT/);
  });
});
