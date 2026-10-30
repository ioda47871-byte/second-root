import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FactsPack } from "@/lib/design-agent/artifact/schema";
import { directionsDiffer, OpenDirection, resolveDirection, sheetColumns, type Reference } from "@/lib/design-agent/phase2f/open-direction";
import { buildDesignPrompt, DesignBrief, PromptVariantError, promptVariantOf, type PromptVariant } from "@/lib/design-agent/phase2f/prompt";
import { checkReferenceBytes, referenceSheet, ReferenceStop } from "@/lib/design-agent/phase2f/reference-sheet";

// DEV-124: the open-direction prompt (v2) and the success-case reference images. Offline: no Codex, no image tool.

const REPO = resolve(__dirname, "../../../..");
const REFS = "design-library/phase2f/references/success-references-v1.json";
const DIRS = ["design-library/phase2f/directions/wagashi-open-a.json", "design-library/phase2f/directions/wagashi-open-b.json"];
const read = (p: string) => JSON.parse(readFileSync(resolve(REPO, p), "utf8")) as Record<string, unknown>;
const facts = FactsPack.parse(read("design-library/phase2f/wagashi-facts-pack.json"));
const v2 = (dir: string): PromptVariant => {
  const r = resolveDirection(read(dir), read(REFS));
  if (!r.ok) throw new Error(r.code);
  return { version: "v2", direction: r.direction, references: r.references };
};
const build = (route: "B_html_prototype" | "C_hybrid", dir: string) => buildDesignPrompt({ route, facts, maxAssets: 1, variant: v2(dir) });
const codeOf = (f: () => unknown) => {
  try {
    f();
    return "ok";
  } catch (e) {
    return e instanceof PromptVariantError || e instanceof ReferenceStop ? e.code : String(e);
  }
};

describe("the v2 prompt: open direction, no brief", () => {
  it("is pinned for both directions on routes B and C", () => {
    expect([build("B_html_prototype", DIRS[0]!), build("C_hybrid", DIRS[0]!), build("B_html_prototype", DIRS[1]!), build("C_hybrid", DIRS[1]!)].map((b) => [b.sha256, b.chars])).toEqual([
      ["0ad56d85df1c713047d638664fa4872f710003c841f2f96db0fd5f397fc46070", 6996],
      ["9318345da131ef3bfab6531b0a06b1b702c8dbb11a61ef9e1fb2114a7fcdeb9d", 7442],
      ["20a2b19cba16486bcbc6695d5b207a2a805bbb438709ad46e9685c3257e31a23", 6878],
      ["0b64529c445c824d03a0d0f719a4038c4fb0facc48a0cf99dbb2881e2c27e647", 7324],
    ]);
  });

  it("fixes no palette, order or layout; names the references by SHA-256 and keeps the fact and technical rules", () => {
    const p = build("B_html_prototype", DIRS[0]!).prompt;
    expect(p).not.toMatch(/#[0-9A-Fa-f]{6}\b|Design DNA brief/);
    expect(p).toContain("on purpose left open: the composition, the palette, the typography, the section structure and the phone layout");
    expect(p).toContain("be8f9aaeb06f02d192a08ceaab640eb1121befe14daa59eaee2e4d59e3ee52b6");
    expect(p).toContain("Never copy their composition, words, colours, motifs, shop name or brand");
    expect(p).toMatch(/テスト/);
    expect(p).toContain("asset_refs is an empty list []");
    expect(p).toContain("no tel:, mailto:");
    // route C keeps the contact rule, not the "no images" rule
    const c = build("C_hybrid", DIRS[0]!).prompt;
    expect(c).not.toContain("asset_refs is an empty list []");
    expect(c).toContain("no tel:, mailto:");
    // the v4 brief's image honesty, kept per route: a generated picture is a captioned concept; no photo imitation on B
    expect(c).toContain("A generated image is a concept image: say so next to it in a short caption");
    expect(p).toContain("Do not imitate a photograph with CSS or SVG");
    expect(p).not.toContain("A generated image is a concept image");
    // the placeholder street is never shown: the address is the ward only
    expect(p).toContain("for the address show only 名古屋市東区");
  });

  it("the two wagashi directions are a real alternative (hero and flow both differ); a recolour is not", () => {
    const [a, b] = DIRS.map((d) => OpenDirection.parse(read(d)));
    expect(directionsDiffer(a!, b!)).toBe(true);
    expect(directionsDiffer(a!, { ...b!, composition: { ...b!.composition, hero: a!.composition.hero } })).toBe(false);
    expect(directionsDiffer(a!, { ...a!, direction_id: "wagashi-open-a-recolour" })).toBe(false);
  });

  it("v2 never takes a brief or research; a direction needs v2; references are checked against the manifest", () => {
    const brief = DesignBrief.parse(read("design-library/phase2f/wagashi-brief-v4.json"));
    expect(codeOf(() => buildDesignPrompt({ route: "B_html_prototype", facts, brief, maxAssets: 1, variant: v2(DIRS[0]!) }))).toBe("PROMPT_VARIANT_BRIEF");
    expect(codeOf(() => buildDesignPrompt({ route: "B_html_prototype", facts, maxAssets: 1 }))).toBe("PROMPT_VARIANT_BRIEF");
    const of = (o: Partial<Parameters<typeof promptVariantOf>[0]>) => {
      const r = promptVariantOf({ route: "B_html_prototype", version: "v2", research: undefined, direction: read(DIRS[0]!), references: read(REFS), ...o });
      return r.ok ? r.variant.version : r.code;
    };
    expect(of({})).toBe("v2");
    expect(of({ route: "C_hybrid" })).toBe("v2");
    expect(of({ direction: undefined })).toBe("DIRECTION_REQUIRED");
    expect(of({ research: read("design-library/phase2f/research/wagashi-b-research-v1.json") })).toBe("RESEARCH_NEEDS_V1_1");
    expect(of({ version: "v1.1" })).toBe("DIRECTION_NEEDS_V2");
    expect(of({ direction: { ...read(DIRS[0]!), reference_ids: ["CP-009-pc"] } })).toBe("REFERENCE_UNKNOWN");
    expect(of({ direction: { ...read(DIRS[0]!), reference_ids: ["CP-003-pc", "CP-003-sp", "CP-003-pc"] } })).toBe("REFERENCES_OVER_LIMIT");
    expect(of({ direction: { ...read(DIRS[0]!), concept: "use <script>" } })).toBe("DIRECTION_INVALID");
    expect(of({ references: { ...read(REFS), owner_scope: { status: "pending" } } })).toBe("REFERENCES_INVALID");
  });
});

describe("reference sheets (Chromium; the image is checked before anything is drawn)", () => {
  let browser: Browser;
  let webp: Buffer;
  const ref = (o: Partial<Reference> = {}): Reference => ({
    id: "CP-003-sp",
    case_id: "CP-003",
    view: "mobile",
    source: { commit: "e".repeat(40), path: "design-library/success-cases/assets/x.webp" },
    webp_sha256: createHash("sha256").update(webp).digest("hex"),
    width: 400,
    height: 1500,
    learn: "x",
    do_not_copy: ["x"],
    ...o,
  });
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    // a real WebP, 400 × 1500, made by Chromium itself (bands so the columns can be told apart)
    const page = await browser.newPage();
    const url = (await page.evaluate(`(() => { const c = document.createElement("canvas"); c.width = 400; c.height = 1500; const x = c.getContext("2d"); for (let i = 0; i < 15; i++) { x.fillStyle = i % 2 ? "#b33" : "#3b3"; x.fillRect(0, i * 100, 400, 100); } return c.toDataURL("image/webp"); })()`)) as string;
    webp = Buffer.from(url.split(",")[1]!, "base64");
    await page.close();
  });
  afterAll(async () => {
    await browser.close();
  });

  it("cuts a tall page into columns side by side, as a PNG", async () => {
    expect(sheetColumns(400, 1500)).toBe(2);
    expect([sheetColumns(1080, 3308), sheetColumns(390, 4502)]).toEqual([2, 3]);
    const s = await referenceSheet(browser, webp, ref());
    expect(s.columns).toBe(2);
    expect(s.sheet).toEqual({ width: 2 * 400 + 12, height: 750 });
    expect(s.png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect([s.png.readUInt32BE(16), s.png.readUInt32BE(20)]).toEqual([812, 750]);
  }, 60_000);

  it("refuses other bytes, a non-WebP with a matching SHA, and a size that is not the registered one", async () => {
    expect(codeOf(() => checkReferenceBytes(Buffer.concat([webp, Buffer.from([0])]), ref()))).toBe("REFERENCE_SHA_MISMATCH");
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    expect(codeOf(() => checkReferenceBytes(png, ref({ webp_sha256: createHash("sha256").update(png).digest("hex") })))).toBe("REFERENCE_NOT_WEBP");
    await expect(referenceSheet(browser, webp, ref({ height: 1400 }))).rejects.toMatchObject({ code: "REFERENCE_SIZE_MISMATCH" });
  }, 60_000);
});

describe("the design CLI with v2", () => {
  const CLI = resolve(REPO, "scripts/design-artifact/phase2f-design.ts");
  const run = (args: string[], state: string) => {
    const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { encoding: "utf8", env: { ...process.env, SR_PHASE2F_STATE: state } });
    return { status: r.status, out: JSON.parse(r.stdout || "{}") as Record<string, unknown> };
  };
  const base = ["--route", "B", "--facts", resolve(REPO, "design-library/phase2f/wagashi-facts-pack.json"), "--prompt-version", "v2", "--references", resolve(REPO, REFS), "--direction", resolve(REPO, DIRS[0]!)];

  it("prints the pin offline with the direction and the reference SHA-256; a brief is refused", () => {
    const state = mkdtempSync(join(tmpdir(), "dev124-pin-"));
    expect(run(["--print-pin", ...base], state).out).toMatchObject({
      prompt_version: "v2",
      direction: { direction_id: "wagashi-open-a-morning-axis", composition: { hero: "object_led", flow: "single_axis_scroll" } },
      references: [{ id: "CP-003-pc" }, { id: "CP-003-sp" }],
      prompt_sha256: "0ad56d85df1c713047d638664fa4872f710003c841f2f96db0fd5f397fc46070",
      prompt_chars: 6996,
    });
    expect(run(["--print-pin", ...base, "--brief", resolve(REPO, "design-library/phase2f/wagashi-brief-v4.json")], state).out).toMatchObject({ status: "refused", code: "USAGE" });
    expect(readdirSync(state)).toEqual([]);
  }, 60_000);

  it("a real run without the reference files, or with a wrong file, stops before anything is used", () => {
    const state = mkdtempSync(join(tmpdir(), "dev124-run-"));
    const runs = mkdtempSync(join(tmpdir(), "dev124-out-"));
    const refDir = mkdtempSync(join(tmpdir(), "dev124-refs-"));
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith("sr-p2f-refs-"));
    const real = [...base, "--plan-id", "plan-fictional-1", "--approval-id", "fictional-v2-1", "--expected-prompt-sha256", "0ad56d85df1c713047d638664fa4872f710003c841f2f96db0fd5f397fc46070", "--expected-prompt-chars", "6996", "--expected-commit", "d".repeat(40), "--human-approval-confirmed"];
    expect(run([...real, "--out", join(runs, "d1")], state)).toMatchObject({ status: 2, out: { status: "refused", code: "REFERENCE_DIR_REQUIRED" } });
    expect(run([...real, "--out", join(runs, "d2"), "--reference-dir", refDir], state)).toMatchObject({ status: 2, out: { status: "refused", code: "REFERENCE_FILE_MISSING" } });
    mkdirSync(join(refDir, "x"));
    writeFileSync(join(refDir, "CP-003_NagoyaBeans_v4_desktop.webp"), "not the registered file");
    expect(run([...real, "--out", join(runs, "d3"), "--reference-dir", refDir], state)).toMatchObject({ status: 2, out: { status: "refused", code: "REFERENCE_SHA_MISMATCH" } });
    expect(readdirSync(state)).toEqual([]);
    expect(readdirSync(runs)).toEqual([]);
    // the sheets' temporary directory is removed on every refusal
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith("sr-p2f-refs-")).filter((n) => !before.includes(n))).toEqual([]);
  }, 120_000);
});
