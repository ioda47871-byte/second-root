import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { photoAnalysesJsonSchema, type PhotoAnalysis } from "@/lib/design-agent/assets/analysis";
import { imageDirectionJsonSchema, NO_IMAGES, type ImageDirection } from "@/lib/design-agent/assets/direction";
import { analyzePhotos, checkPhotoAnalyses, directImages, loadPhotoInputs, orientationsFor, sandboxPhotoCall, type CodexPhotoCall, type PhotoInput } from "@/lib/design-agent/assets/photo-codex";
import { resolvePhotos } from "@/lib/design-agent/assets/resolve";
import { assetStoreRoot } from "@/lib/design-agent/assets/store-root";
import { CodexError, runCodexJson } from "@/lib/design-agent/codex";
import { buildBriefPrompt, buildReviewPrompt } from "@/lib/design-agent/prompts";
import { designProfileJsonSchema } from "@/lib/design-agent/profile";
import { workerProtectedPaths } from "@/lib/design-agent/protected-paths";
import { visualReviewJsonSchema } from "@/lib/design-agent/review";
import { prepareCodexSandbox } from "@/lib/design-agent/sandbox";
import { passthroughSandbox } from "../../support/passthrough-sandbox";
import { AMERICAN_EDITORIAL, MINIMAL_SHOP, SHOP } from "./fixtures";
import { fakeAnalysis, fakeManifest, fakePng, writeStore, type FakeAsset } from "./photo-fixtures";

// DEV-029 stage 3: Codex's photo analysis and image direction calls, with
// fake Codex answers (no network, no real photos: every PNG is drawn here).

vi.setConfig({ testTimeout: 120_000 });

const A = "asset-aaaaaaaaaaaaaaaaaaaaaaaa"; // portrait
const B = "asset-bbbbbbbbbbbbbbbbbbbbbbbb"; // landscape
const C = "asset-cccccccccccccccccccccccc"; // square
const ASSETS: FakeAsset[] = [
  { id: A, png: fakePng(360, 450, { seed: 1 }), sourceKind: "generated_concept" },
  { id: B, png: fakePng(480, 320, { seed: 2, busy: true }), sourceKind: "approved_real" },
  { id: C, png: fakePng(400, 400, { seed: 3 }), sourceKind: "generated_concept" },
];
const MARKERS = { store: "STOREMARKER", job: "job-secret-7", consent: "consent-secret-777", approver: "approver-x9" };
const manifestFor = (assets: FakeAsset[], jobId = MARKERS.job) => {
  const m = fakeManifest(jobId, assets);
  for (const a of m.assets) {
    if (a.sourceKind === "approved_real") a.consent = { ...a.consent, consentId: MARKERS.consent, approvedBy: MARKERS.approver };
  }
  return m;
};
const ANALYSIS: Record<string, PhotoAnalysis> = {
  [A]: fakeAnalysis(A, { orientation: "portrait" }),
  [B]: fakeAnalysis(B, { orientation: "landscape", busy: "busy" }),
  [C]: fakeAnalysis(C, { orientation: "square" }),
};

let base: string;
let store: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "photo-codex-"));
  store = join(base, MARKERS.store);
  await writeStore(store, MARKERS.job, ASSETS, manifestFor(ASSETS));
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const inputsOf = async (n: number): Promise<PhotoInput[]> => {
  const r = await loadPhotoInputs({ store, jobId: MARKERS.job, manifest: manifestFor(ASSETS.slice(0, n)) });
  if (!r.ok) throw new Error(r.code);
  return r.value;
};

/** A fake Codex call that records each request and answers from a list. */
function fakeCall(...answers: unknown[]): CodexPhotoCall & { requests: Array<{ prompt: string; schema: object; imageBytes: readonly Buffer[] }> } {
  const requests: Array<{ prompt: string; schema: object; imageBytes: readonly Buffer[] }> = [];
  const call = (async (r) => {
    requests.push(r);
    const answer = answers[requests.length - 1];
    if (answer instanceof Error) throw answer;
    return answer;
  }) as CodexPhotoCall & { requests: typeof requests };
  call.requests = requests;
  return call;
}

const noLeak = (prompt: string) => {
  for (const marker of [MARKERS.store, MARKERS.job, MARKERS.consent, MARKERS.approver, "designer", "sales-admin", base, store, ".png", "sha256", "manifest", ...ASSETS.map((a) => createHash("sha256").update(a.png).digest("hex"))]) {
    expect(prompt.includes(marker), marker).toBe(false);
  }
};

// ---------------------------------------------------------------- inputs

describe("photo inputs: checked bytes from the store, nothing else", () => {
  it("reads 1, 2 and 3 photos as the exact PNGs of the manifest, in manifest order", async () => {
    for (const n of [1, 2, 3]) {
      const inputs = await inputsOf(n);
      expect(inputs.map((i) => i.assetId)).toEqual(ASSETS.slice(0, n).map((a) => a.id));
      inputs.forEach((input, i) => expect(input.png.equals(ASSETS[i].png)).toBe(true));
    }
  });

  it("refuses the whole set for one photo that is changed, a link, not allowed locally, or of another job", async () => {
    const job = "job-checks";
    await writeStore(store, job, ASSETS, manifestFor(ASSETS, job));
    expect((await loadPhotoInputs({ store, jobId: job, manifest: manifestFor(ASSETS, "job-other") })).ok).toBe(false);
    const publicOnly = manifestFor(ASSETS, job);
    const rec = publicOnly.assets[1];
    if (rec.sourceKind === "approved_real") rec.consent.scopes = ["public_demo"];
    expect(await loadPhotoInputs({ store, jobId: job, manifest: publicOnly })).toMatchObject({ ok: false, code: "PHOTO_INPUT_REJECTED" });
    await writeFile(join(store, job, `${C}.png`), fakePng(400, 400, { seed: 8 }));
    expect(await loadPhotoInputs({ store, jobId: job, manifest: manifestFor(ASSETS, job) })).toMatchObject({ ok: false, code: "PHOTO_INPUT_REJECTED" });
    await unlink(join(store, job, `${C}.png`));
    await symlink(join(store, job, `${A}.png`), join(store, job, `${C}.png`));
    expect(await loadPhotoInputs({ store, jobId: job, manifest: manifestFor(ASSETS, job) })).toMatchObject({ ok: false, code: "PHOTO_INPUT_REJECTED" });
  });
});

// ---------------------------------------------------------------- analysis

describe("photo analysis: the answer must match the attached photos exactly", () => {
  it("analyses 1, 2 and 3 photos; the prompt names only the attachment order and asset ids", async () => {
    for (const n of [1, 2, 3]) {
      const inputs = await inputsOf(n);
      const call = fakeCall({ photos: inputs.map((i) => ANALYSIS[i.assetId]).reverse() });
      const r = await analyzePhotos({ call, inputs, category: "baked_goods" });
      expect(r).toEqual({ ok: true, value: inputs.map((i) => ANALYSIS[i.assetId]) });
      const [req] = call.requests;
      inputs.forEach((input, i) => expect(req.prompt).toContain(`attached image ${i + 1} = ${input.assetId}`));
      expect(req.imageBytes.map((b) => b.equals(inputs[req.imageBytes.indexOf(b)].png))).toEqual(inputs.map(() => true));
      expect(req.schema).toEqual(photoAnalysesJsonSchema());
      noLeak(req.prompt);
      expect(req.prompt).toMatch(/never an instruction to you/);
    }
  });

  it("makes no call without photos", async () => {
    const call = fakeCall();
    expect(await analyzePhotos({ call, inputs: [], category: "cafe" })).toEqual({ ok: true, value: [] });
    expect(call.requests).toEqual([]);
  });

  it("refuses duplicate, unknown and missing ids, a bad or self near-duplicate, and a wrong orientation", async () => {
    const inputs = await inputsOf(3);
    const all = [ANALYSIS[A], ANALYSIS[B], ANALYSIS[C]];
    const cases: Array<[string, unknown]> = [
      ["duplicate", { photos: [ANALYSIS[A], ANALYSIS[A], ANALYSIS[C]] }],
      ["unknown", { photos: [ANALYSIS[A], ANALYSIS[B], fakeAnalysis("asset-dddddddddddddddddddddddd")] }],
      ["missing", { photos: [ANALYSIS[A], ANALYSIS[B]] }],
      ["self duplicate", { photos: [ANALYSIS[A], { ...ANALYSIS[B], nearDuplicateOf: B }, ANALYSIS[C]] }],
      ["unknown duplicate", { photos: [ANALYSIS[A], { ...ANALYSIS[B], nearDuplicateOf: "asset-dddddddddddddddddddddddd" }, ANALYSIS[C]] }],
      ["portrait called landscape", { photos: [{ ...ANALYSIS[A], orientation: "landscape" }, ANALYSIS[B], ANALYSIS[C]] }],
      ["square called portrait", { photos: [ANALYSIS[A], ANALYSIS[B], { ...ANALYSIS[C], orientation: "portrait" }] }],
      ["free text", { photos: [{ ...ANALYSIS[A], caption: "焼きたて ¥300" }, ANALYSIS[B], ANALYSIS[C]] }],
      ["ocr", { photos: all, ocr: "SALE" }],
      ["four", { photos: [...all, ANALYSIS[A]] }],
    ];
    for (const [what, answer] of cases) expect(checkPhotoAnalyses(answer, inputs), what).toMatchObject({ ok: false, code: "PHOTO_ANALYSIS_INVALID" });
    expect(checkPhotoAnalyses({ photos: [ANALYSIS[A], { ...ANALYSIS[B], nearDuplicateOf: A }, ANALYSIS[C]] }, inputs).ok).toBe(true);
    expect(orientationsFor(1000, 1000)).toEqual(["square"]);
    expect(orientationsFor(1080, 1000)).toEqual(["square", "landscape"]);
    expect(orientationsFor(1200, 1000)).toEqual(["landscape"]);
  });

  it("turns a Codex failure into its fixed code", async () => {
    const r = await analyzePhotos({ call: fakeCall(new CodexError("CODEX_QUOTA", "x")), inputs: await inputsOf(1), category: "bakery" });
    expect(r).toEqual({ ok: false, code: "CODEX_QUOTA", problems: [] });
  });
});

// ---------------------------------------------------------------- direction

const place = (assetId: string, over: Record<string, unknown> = {}) => ({
  assetId,
  fit: "cover",
  focal: { x: 0.5, y: 0.4 },
  mobileFocal: { x: 0.5, y: 0.45 },
  aspect: { desktop: "4:5", mobile: "1:1" },
  treatment: "natural",
  ...over,
});
const VALID: ImageDirection = {
  version: 1,
  layout: "split_hero",
  hero: place(A) as ImageDirection["hero"],
  features: [{ ...(place(B, { aspect: { desktop: "3:2", mobile: "4:3" } }) as NonNullable<ImageDirection["hero"]>), slot: "visit", side: "right" }],
  rejected: [{ assetId: C, reason: "not_needed" }],
  paletteFit: 4,
};

describe("image direction: checked like any input, else no photos", () => {
  const direct = async (answer: unknown, over: Partial<{ analyses: PhotoAnalysis[]; demo: typeof SHOP }> = {}) => {
    const inputs = await inputsOf(3);
    const call = fakeCall(answer);
    const r = await directImages({ call, inputs, analyses: over.analyses ?? [ANALYSIS[A], ANALYSIS[B], ANALYSIS[C]], manifest: manifestFor(ASSETS), profile: AMERICAN_EDITORIAL, demo: over.demo ?? SHOP });
    return { r, call };
  };

  it("accepts a valid direction (it passes checkImageDirection) and shows Codex the photos, the analyses and the profile", async () => {
    const { r, call } = await direct(VALID);
    expect(r).toEqual({ ok: true, value: VALID });
    const [req] = call.requests;
    expect(req.imageBytes.length).toBe(3);
    expect(req.schema).toEqual(imageDirectionJsonSchema());
    expect(req.prompt).toContain(`attached image 2 = ${B} (480 x 320 px)`);
    expect(req.prompt).toContain("about section: present; visit section: present");
    expect(req.prompt).toContain('"palette"');
    expect(req.prompt).not.toContain("fixture"); // the profile's rationale stays out
    expect(req.prompt).not.toContain(SHOP.name);
    noLeak(req.prompt);
  });

  it("refuses people, near duplicates together, a missing section, the menu, free text and undecided photos", async () => {
    const people = [fakeAnalysis(A, { people: true }), ANALYSIS[B], ANALYSIS[C]];
    expect((await direct(VALID, { analyses: people })).r).toMatchObject({ ok: false, code: "IMAGE_DIRECTION_INVALID", problems: [`${A} shows people`] });
    const twins = [ANALYSIS[A], { ...ANALYSIS[B], nearDuplicateOf: A }, ANALYSIS[C]];
    expect((await direct(VALID, { analyses: twins })).r).toMatchObject({ ok: false, code: "IMAGE_DIRECTION_INVALID" });
    expect((await direct(VALID, { demo: MINIMAL_SHOP })).r).toMatchObject({ ok: false, problems: ["slot visit has no section"] });
    for (const bad of [
      { ...VALID, features: [{ ...VALID.features[0], slot: "menu" }] },
      { ...VALID, caption: "焼きたて" },
      { ...VALID, hero: { ...VALID.hero, alt: "焼きたて" } },
      { ...VALID, layout: "gallery_grid" },
      { ...VALID, rejected: [] },
    ]) expect((await direct(bad)).r).toMatchObject({ ok: false, code: "IMAGE_DIRECTION_INVALID" });
  });

  it("makes no call without photos, and an invalid direction leaves the page without photos", async () => {
    const call = fakeCall();
    expect(await directImages({ call, inputs: [], analyses: [], manifest: manifestFor([]), profile: AMERICAN_EDITORIAL, demo: SHOP })).toEqual({ ok: true, value: NO_IMAGES });
    expect(call.requests).toEqual([]);
    const { r } = await direct({ ...VALID, layout: "split_hero", hero: null });
    expect(r.ok).toBe(false);
    // what a caller does with a failure: no direction, so no photos (the DEV-028 page)
    expect(resolvePhotos({ demo: SHOP, manifest: manifestFor(ASSETS), analyses: { photos: [ANALYSIS[A], ANALYSIS[B], ANALYSIS[C]] }, direction: r.ok ? r.value : null, src: String }).photos).toBeNull();
  });

  it("has no free-text field anywhere in either answer schema", () => {
    const freeStrings = (schema: unknown, path = "$"): string[] => {
      if (!schema || typeof schema !== "object") return [];
      const s = schema as Record<string, unknown>;
      const here = s.type === "string" && !s.enum && !s.pattern && s.const === undefined ? [path] : [];
      return [...here, ...Object.entries(s).flatMap(([k, v]) => (typeof v === "object" ? freeStrings(v, `${path}.${k}`) : []))];
    };
    expect(freeStrings(photoAnalysesJsonSchema())).toEqual([]);
    expect(freeStrings(imageDirectionJsonSchema())).toEqual([]);
  });
});

// ---------------------------------------------------------------- through the real Codex wrapper (fake CLI)

describe("photo calls through runCodexJson", () => {
  const FAKE = join(process.cwd(), "tests/support/fake-codex.mjs");

  it("gives Codex work-dir copies only, keeps API keys out and removes the session log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "photo-fake-codex-"));
    const codexHome = join(dir, ".codex");
    const inputs = await inputsOf(3);
    await writeFile(join(dir, "steps.json"), JSON.stringify([{ answer: { photos: inputs.map((i) => ANALYSIS[i.assetId]) } }, { answer: VALID }]));
    const env = {
      PATH: process.env.PATH,
      HOME: dir,
      CODEX_HOME: codexHome,
      FAKE_CODEX_STEPS: join(dir, "steps.json"),
      FAKE_CODEX_STATE: join(dir, "state"),
      FAKE_CODEX_RECORD: join(dir, "record.jsonl"),
      FAKE_CODEX_PROMPTS: join(dir, "prompts.jsonl"),
      OPENAI_API_KEY: "sk-never",
      CODEX_API_KEY: "never",
    };
    const call = sandboxPhotoCall(passthroughSandbox(FAKE, env));
    const analysis = await analyzePhotos({ call, inputs, category: "baked_goods" });
    expect(analysis.ok).toBe(true);
    const direction = await directImages({ call, inputs, analyses: analysis.ok ? analysis.value : [], manifest: manifestFor(ASSETS), profile: AMERICAN_EDITORIAL, demo: SHOP });
    expect(direction).toEqual({ ok: true, value: VALID });

    const prompts = (await readFile(join(dir, "prompts.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { cwd: string; stdin: string; images: { path: string; sha256: string }[] });
    expect(prompts).toHaveLength(2);
    for (const p of prompts) {
      expect(p.images.map((i) => i.path)).toEqual([1, 2, 3].map((n) => join(p.cwd, "inputs", `photo-${n}.png`)));
      expect(p.images.map((i) => i.sha256)).toEqual(ASSETS.map((a) => createHash("sha256").update(a.png).digest("hex")));
      noLeak(p.stdin);
    }
    const record = (await readFile(join(dir, "record.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; apiKeyVars: string[] });
    for (const r of record) {
      expect(r.apiKeyVars).toEqual([]);
      expect(r.args.join(" ")).not.toContain(store);
      expect(r.args.join(" ")).not.toContain(MARKERS.store);
    }
    // the CLI's session log of each call is removed (the unrelated older one stays)
    const sessions = await readdir(join(codexHome, "sessions", "2026", "09", "29"));
    expect(sessions.some((n) => n.includes("00000000-0000-4000-8000-000000000000"))).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- the store is hidden from Codex

describe("the asset store is a protected path", () => {
  it("is in workerProtectedPaths, default or custom", () => {
    const opts = { stateDir: "/s", queueRoot: "/q", outRoot: "/o" };
    expect(workerProtectedPaths({ ...opts, env: { HOME: "/home/w" } })).toContain("/home/w/.local/share/second-root-design-assets");
    expect(workerProtectedPaths({ ...opts, env: { HOME: "/home/w", SR_DESIGN_ASSETS_ROOT: "/srv/design-assets" } })).toContain("/srv/design-assets");
    expect(assetStoreRoot({ HOME: "/home/w", SR_DESIGN_ASSETS_ROOT: "relative" })).toBe("/home/w/.local/share/second-root-design-assets");
  });

  const bwrapWorks = spawnSync("bwrap", ["--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--unshare-pid", "/bin/true"]).status === 0;
  if (!bwrapWorks && process.env.SR_REQUIRE_BWRAP === "1") throw new Error("bubblewrap is required here (SR_REQUIRE_BWRAP=1) but does not work");

  it.skipIf(!bwrapWorks)("is invisible inside the real sandbox, default or custom, while the attached copies are readable", async () => {
    const root = mkdtempSync(join(tmpdir(), "sr-photo-sandbox-"));
    chmodSync(root, 0o755);
    const home = join(root, "home", "worker");
    const defaultStore = join(home, ".local", "share", "second-root-design-assets");
    mkdirSync(join(defaultStore, "job-1"), { recursive: true, mode: 0o700 });
    writeFileSync(join(defaultStore, "job-1", "canary.txt"), "CANARY-ASSET-DEFAULT");
    mkdirSync(join(home, ".codex"), { recursive: true, mode: 0o700 });
    // a custom store outside every area the sandbox hides by default
    let custom = "";
    for (const b of ["/var/lib", "/run/lock", "/var/lock"]) {
      try {
        custom = mkdtempSync(join(b, "sr-asset-store-"));
        break;
      } catch {
        /* next */
      }
    }
    if (custom) writeFileSync(join(custom, "canary.txt"), "CANARY-ASSET-CUSTOM");
    const codexBin = join(root, "codex-install", "codex");
    mkdirSync(join(root, "codex-install"), { recursive: true });
    writeFileSync(
      codexBin,
      `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
if (args[0] === "login") { process.stdout.write("Logged in using ChatGPT\\n"); process.exit(0); }
const T = JSON.parse(fs.readFileSync(path.join(process.cwd(), "targets.json"), "utf8"));
const seen = (p) => { try { return fs.readdirSync(p).length > 0 || fs.statSync(p).isFile(); } catch { return false; } };
const r = { defaultStore: seen(T.defaultStore), customStore: T.custom ? seen(T.custom) : false };
r.images = args.filter((a) => a.startsWith("--image=")).map((a) => a.slice(8));
r.imagesInWorkDir = r.images.every((p) => p.startsWith(path.join(process.cwd(), "inputs") + "/"));
r.imagesReadable = r.images.every((p) => { try { return fs.readFileSync(p).subarray(1, 4).toString() === "PNG"; } catch { return false; } });
fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify(r));
`,
      { mode: 0o755 },
    );
    try {
      const env = { PATH: `/usr/local/bin:/usr/bin:/bin:${process.execPath.replace(/\/node$/, "")}`, HOME: home, LANG: "C.UTF-8", ...(custom ? { SR_DESIGN_ASSETS_ROOT: custom } : {}) };
      const protectedPaths = [...workerProtectedPaths({ env, stateDir: join(home, ".local", "state", "sr-design-worker"), queueRoot: join(home, "sr-design-jobs"), outRoot: join(home, ".local", "share", "second-root-design") }), defaultStore];
      if (custom) expect(protectedPaths).toContain(custom);
      const sandbox = await prepareCodexSandbox({ env, codexBin, protectedPaths });
      const withTargets = {
        env: sandbox.env,
        run: async (a: readonly string[], o: { workDir: string; input?: string; timeoutMs: number }) => {
          writeFileSync(join(o.workDir, "targets.json"), JSON.stringify({ defaultStore, custom }));
          return sandbox.run(a, o);
        },
      };
      const seen = (await runCodexJson({ sandbox: withTargets, prompt: "p", schema: {}, imageBytes: ASSETS.map((a) => a.png), timeoutMs: 60_000 })) as Record<string, unknown>;
      expect(seen).toMatchObject({ defaultStore: false, customStore: false, imagesInWorkDir: true, imagesReadable: true });
      expect((seen.images as string[]).length).toBe(3);
    } finally {
      spawnSync("rm", ["-rf", root, ...(custom ? [custom] : [])]);
    }
  });
});

// ---------------------------------------------------------------- DEV-028 without photos is unchanged

describe("DEV-028 prompts and schemas (pages without photos)", () => {
  it("are unchanged", () => {
    expect(buildBriefPrompt({ demo: SHOP, referenceCount: 3, referenceKind: "instagram", currentDemoCount: 2, hint: "American Editorial" })).toMatchSnapshot("brief");
    expect(buildBriefPrompt({ demo: MINIMAL_SHOP, referenceCount: 2, referenceKind: "website", currentDemoCount: 2 })).toMatchSnapshot("brief-minimal");
    expect(buildReviewPrompt({ demo: SHOP, profile: AMERICAN_EDITORIAL, referenceCount: 3, referenceKind: "instagram", round: 1, maxRevisions: 2 })).toMatchSnapshot("review");
    expect(designProfileJsonSchema()).toMatchSnapshot("profile-schema");
    expect(visualReviewJsonSchema()).toMatchSnapshot("review-schema");
    expect(buildBriefPrompt({ demo: SHOP, referenceCount: 1, currentDemoCount: 2 })).toContain("There are no photographs, logos or illustrations of food, and there never will be.");
  });
});
