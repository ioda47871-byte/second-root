/**
 * DEV-139: ほし窯 (bakery, a FICTIONAL bakery) — the whole photo path OFFLINE, ending in the real package CLI:
 *
 *   stub batch (3 plain PNGs made here) → bundle writer → intake (upscale ≤2×, lanczos3) → photo swap of the committed
 *   fidelity page d2-v2 (rights, crops, PC 1440 / SP 390 renders) → package-local.ts --page … --facts …
 *   → a sales_demo_version_package_v2 holding BOTH the copy (facts pack, copy record, copy review) AND the photos
 *   (WebP, image records from the rights and the owner's depiction confirmation).
 *
 * No model, no image generation, no network, no database. The pictures are plain images with ai_generated_demo
 * provenance STUBS, written under a STUB run approval id and the stub generator (tests/support/hoshigama-approval-stub.ts).
 *
 * DEV-139 (owner approval 2026-11-18, one run): the committed SWAP_SHOP_SPECS (frozen) now allow ほし窯's AI demo
 * pictures of the approved prompt, so the real CLI (a separate process, no seams) writes the v2 package itself; a spec
 * handed in with aiDemoAllowed false shows the refusal. The import takes AI demo pictures into ほし窯's S0 prospect (and
 * 輪's) only, for ai_demo_internal pictures only; the database still refuses them unless the owner's local-only patch
 * is applied (tests/integration/hoshigama-local-patch.test.ts).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COPY_FACTS_NAME, COPY_RECORD_NAME, COPY_REVIEW_NAME } from "@/lib/demo-version-package/copy";
import { AI_DEMO_PROSPECT_IDS, ImportError, importPackage, type PackageStore } from "@/lib/demo-version-package/import";
import { RIN_PROSPECT_ID } from "@/lib/demo-version-package/seed-rin";
import { checkPackageCopy, PACKAGE_FORMAT, PACKAGE_FORMAT_COPY, readPackage, swapCopyInput } from "@/lib/demo-version-package/package";
import { S0_FACTS_PATH, S0_PROSPECT_ID } from "@/lib/demo-version-package/seed-s0";
import { DEPICTION_CONFIRMATION_STATEMENT } from "@/lib/demo-version-package/swap-rights";
import { writeHoshigamaPhotos } from "@/lib/design-agent/design-image/hoshigama-photos";
import { buildHoshigamaRunPromptCandidate, HOSHIGAMA_OFFLINE_STUB_GENERATOR, HOSHIGAMA_PROMPT_DRAFT_SHA256, HOSHIGAMA_PROMPT_FILE } from "@/lib/design-agent/quality-pipeline/hoshigama-ai-photos";
import { loadForbiddenSha256 } from "@/lib/design-agent/quality-pipeline/photo-rights";
import { SWAP_SHOP_SPECS } from "@/lib/design-agent/quality-pipeline/photo-swap-shops";
import { importHoshigamaAiPhotos } from "../../../scripts/design-artifact/hoshigama-ai-intake";
import { swapPage } from "../../../scripts/design-artifact/photo-swap";
import { main as packageLocal } from "../../../scripts/sales/demo-version/package-local";
import { approvedBakerySpec, approvedSpecFor, STUB_APPROVAL, STUB_RUN_APPROVAL_ID } from "../../support/hoshigama-approval-stub";

const REPO = resolve(__dirname, "../../..");
const PAGE = "design-library/research/quality-pipeline/poc/bakery/fidelity/d2-v2";
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
  const swap = (out: string, spec?: ReturnType<typeof approvedBakerySpec>) => swapPage({ pageDir: PAGE, manifest: manifest(), out, pipelineRoot: pipeline, now: "2026-11-17", forbiddenSha256: loadForbiddenSha256(REPO), browser, ...(spec ? { spec } : {}) });

  it("a spec handed in without the AI demo approval refuses the AI demo pictures (AI_DEMO_NOT_ALLOWED), nothing written", async () => {
    const res = await swap(join(root, "swap-refused"), { ...SWAP_SHOP_SPECS.bakery, aiDemoAllowed: false });
    expect(res.ok ? [] : res.refusals.map((r) => [r.slot_id, r.photo, r.codes])).toEqual([["ph-mouth", "pc", ["AI_DEMO_NOT_ALLOWED"]], ["ph-mouth", "sp", ["AI_DEMO_NOT_ALLOWED"]], ["ph-loaf", "pc", ["AI_DEMO_NOT_ALLOWED"]]]);
    expect(readdirSync(root)).not.toContain("swap-refused");
  }, 60_000);

  it("the committed specs are frozen: nothing can change ほし窯's AI demo approval at run time (approved prompt pinned)", () => {
    expect(Object.isFrozen(SWAP_SHOP_SPECS)).toBe(true);
    expect(Object.isFrozen(SWAP_SHOP_SPECS.bakery)).toBe(true);
    expect(Object.isFrozen(SWAP_SHOP_SPECS.bakery.ranges)).toBe(true);
    expect(() => {
      (SWAP_SHOP_SPECS.bakery as { aiDemoPromptSha256: string }).aiDemoPromptSha256 = "0".repeat(64);
    }).toThrow(TypeError);
    expect(SWAP_SHOP_SPECS.bakery.aiDemoAllowed).toBe(true);
    expect(SWAP_SHOP_SPECS.bakery.aiDemoPromptSha256).toBe(HOSHIGAMA_PROMPT_DRAFT_SHA256);
    // the stub's approved-state spec is now the committed one
    expect(approvedBakerySpec()).toEqual(SWAP_SHOP_SPECS.bakery);
  });

  it("with the committed spec (the owner's approval): the swap renders PC 1440 and SP 390 with both photos", async () => {
    swapOut = join(root, "swap");
    const res = await swap(swapOut);
    if (!res.ok) throw new Error(JSON.stringify(res.refusals));
    expect(res.renders.map((r) => [r.viewport, r.images_loaded, r.boards_intact, r.caption_text_left, r.horizontal_overflow])).toEqual([["desktop_1440", 2, 2, false, false], ["mobile_390", 2, 2, false, false]]);
    const slots = res.summary.slots as Array<{ slot_id: string; photos: Array<{ which: string; source_kind: string }> }>;
    expect(slots.flatMap((s) => s.photos.map((p) => [s.slot_id, p.which, p.source_kind]))).toEqual([["ph-mouth", "pc", "ai_generated_demo"], ["ph-mouth", "sp", "ai_generated_demo"], ["ph-loaf", "pc", "ai_generated_demo"]]);
    // a spec of another shop is refused
    const wrong = await swap(join(root, "swap-wrong"), { ...SWAP_SHOP_SPECS.bicycle } as unknown as ReturnType<typeof approvedBakerySpec>);
    expect(wrong.ok ? [] : wrong.refusals.flatMap((r) => r.codes)).toEqual(["SPEC_OF_ANOTHER_SHOP"]);
  }, 120_000);

  /** package-local's main in THIS process with the approved-state resolver (the only way to hand it one); its output captured */
  const approved = async (argv: string[]) => {
    let stdout = "";
    let stderr = "";
    const status = await packageLocal(argv, { aiDemoSpecFor: approvedSpecFor, write: (t) => void (stdout += t), writeErr: (t) => void (stderr += t) });
    return { status, stdout, stderr };
  };
  const args = (swapDir: string, out: string, facts = true) => ["--out", out, "--page", join(swapDir, "page"), "--rights", join(swapDir, "rights.private.json"), "--originals", join(pipeline, ".intake", "photos"), "--depiction-confirmation", depictionPath, ...(facts ? ["--facts", FACTS] : [])];

  it("DEV-139: a direct CLI run with ほし窯's photos (a separate process, no seams) writes the v2 package (committed approval)", () => {
    const cli = node("scripts/sales/demo-version/package-local.ts", args(swapOut, join(root, "pkg-cli")));
    expect(cli.status, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout)).toMatchObject({ status: "OK", format: PACKAGE_FORMAT_COPY, source: "swap-copy" });
    expect(readPackage(join(root, "pkg-cli")).images).toHaveLength(5);
  }, 300_000);

  it("in-process with a resolver that withholds the AI demo approval: refused (SUMMARY_NOT_RIN); with the committed one, the photos alone make a v1 package", async () => {
    let printed = "";
    const withheld = (shop: string) => (shop === "bakery" ? { ...SWAP_SHOP_SPECS.bakery, aiDemoAllowed: false } : null);
    expect(await packageLocal(args(swapOut, join(root, "pkg-withheld")), { aiDemoSpecFor: withheld, write: (t) => void (printed += t), writeErr: () => {} })).toBe(1);
    expect(JSON.parse(printed)).toMatchObject({ status: "FAIL", code: "SUMMARY_NOT_RIN" });
    expect(readdirSync(root)).not.toContain("pkg-withheld");
    // the photos alone (no --facts): a v1 package, every photo check passed
    const v1 = await approved(args(swapOut, join(root, "pkg-v1"), false));
    expect(v1.status, `${v1.stdout}\n${v1.stderr}`).toBe(0);
    const v1pkg = readPackage(join(root, "pkg-v1"));
    expect(v1pkg.format).toBe(PACKAGE_FORMAT);
    expect(v1pkg.images).toHaveLength(5);
  }, 300_000);

  it("the committed d2-v2 (no <wbr>): package-local (in-process, approved resolver) writes a v2 package with copy AND photos, through the unchanged copy check", async () => {
    // the page the swap copied is the committed one, byte for byte (no test-only variant)
    expect(readFileSync(join(swapOut, "page", "copy.json"))).toEqual(readFileSync(join(REPO, PAGE, "copy.json")));
    expect(readFileSync(join(REPO, PAGE, "index.html"), "utf8")).not.toContain("<wbr");
    const out = join(root, "pkg");
    const r = await approved(args(swapOut, out));
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

    // DEV-139 (owner approval 2026-11-18): the import takes AI demo pictures into the fictional 輪's and ほし窯's S0
    // prospect only. Any other prospect is refused before anything is written; the S0 prospect goes on to the ingest
    // (stubbed here to stop; the database itself refuses unless the owner's local patch is applied)
    const store: PackageStore = { download: async () => null, upload: async () => { throw new Error("must not upload"); } };
    const clientFor = (prospectId: string, calls: string[]) =>
      ({
        from: (table: string) => ({
          select: () => {
            const q = {
              eq: () => q,
              in: () => q,
              order: () => Object.assign(Promise.resolve({ data: [], error: null }), { limit: async () => ({ data: [], error: null }) }),
              maybeSingle: async () => ({ data: table === "sales_demos" ? { prospect_id: prospectId } : null, error: null }),
            };
            return q;
          },
        }),
        rpc: async (name: string) => {
          calls.push(name);
          return { data: null, error: { message: "stop" } };
        },
      }) as never;
    const demoId = "11111111-1111-4111-8111-111111111111";
    for (const other of ["22222222-2222-4222-8222-222222222222", "13900000-5e00-4d00-8a00-000000000002"]) {
      const calls: string[] = [];
      await expect(importPackage(pkg, { client: clientFor(other, calls), store, demoId, trustedFactsPack: facts })).rejects.toThrow(new ImportError("AI_DEMO_NOT_ALLOWED"));
      expect(calls).toEqual([]);
    }
    const s0calls: string[] = [];
    await expect(importPackage(pkg, { client: clientFor(S0_PROSPECT_ID, s0calls), store, demoId, trustedFactsPack: facts })).rejects.toThrow(/INGEST_REFUSED/);
    expect(s0calls).toEqual(["sales_ingest_demo_version"]);
    expect(AI_DEMO_PROSPECT_IDS).toEqual([RIN_PROSPECT_ID, S0_PROSPECT_ID]);
    // only internal AI demo pictures: a package whose picture claims anything else is refused for S0 before the ingest
    const tampered = { ...pkg, images: pkg.images.map((i, n) => (n === 0 ? { ...i, rights_status: "share_cleared" } : i)) } as unknown as typeof pkg;
    const tcalls: string[] = [];
    await expect(importPackage(tampered, { client: clientFor(S0_PROSPECT_ID, tcalls), store, demoId, trustedFactsPack: facts })).rejects.toThrow(new ImportError("AI_DEMO_NOT_ALLOWED"));
    expect(tcalls).toEqual([]);
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
