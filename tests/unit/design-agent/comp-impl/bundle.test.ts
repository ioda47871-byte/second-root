import { readFileSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompImplError, loadCompBundle, sha256 } from "@/lib/design-agent/comp-impl/bundle";
import { loadCompPage } from "@/lib/design-agent/comp-impl/page";
import { parseShop } from "@/lib/design-agent/compare/shops";
import { loadPocInputs } from "@/lib/design-agent/design-image/prompt";
import { FACTS_SOURCE, FIXTURE, flatPng, pageCopy, privateTemp, removeDir, REPO } from "./support";

// DEV-082: the comp bundle and page loaders refuse anything unsafe or
// inconsistent, and take facts only from the source of truth.

const PNG = flatPng(720, 1025, [244, 238, 227]);
const SHA = sha256(PNG);
const shop = parseShop(JSON.parse(readFileSync(FACTS_SOURCE, "utf8")) as unknown)!;
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const fixtureJson = (name: string) => JSON.parse(readFileSync(join(FIXTURE, name), "utf8")) as Record<string, unknown>;

let dir: string;
async function writeBundle(over: { report?: Record<string, unknown>; facts?: unknown; evaluation?: Record<string, unknown>; spec?: Record<string, unknown>; direction?: unknown } = {}) {
  await writeFile(join(dir, "mockup.png"), PNG);
  await writeFile(join(dir, "report.json"), json({ status: "IMAGE_GENERATED_NOT_IMPLEMENTED", shop: "wagashi", direction_version: "v2", width: 720, height: 1025, png_sha256: SHA, synthetic: true, ...over.report }));
  await writeFile(join(dir, "shop-facts.json"), json(over.facts ?? shop.facts));
  await writeFile(join(dir, "design-spec.json"), json(over.direction ?? (await loadPocInputs(REPO, "v2")).direction));
  await writeFile(join(dir, "evaluation.json"), json({ ...fixtureJson("evaluation.json"), comp_sha256: SHA, ...over.evaluation }));
  await writeFile(join(dir, "layout-spec.json"), json({ ...fixtureJson("layout-spec.json"), comp_sha256: SHA, ...over.spec }));
}
const load = () => loadCompBundle(dir, { repoDir: REPO, factsSourcePath: FACTS_SOURCE });
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "LOADED";
  } catch (error) {
    if (error instanceof CompImplError) return error.code;
    throw error;
  }
};

beforeEach(async () => {
  dir = await privateTemp("bundle-");
});
afterEach(async () => {
  await removeDir(dir);
});

const REAL_EVAL = { comp_kind: "real", scores: { beauty: 5, fit: 5, originality: 4, structure: 5, implementability: 4 }, total: 23, human_confirmed: true, confirmed_by: "owner", confirmed_at: "2026-10-22T09:00:00+09:00" };

describe("loadCompBundle", () => {
  it("loads a synthetic bundle: facts from the source of truth, the spec checked, never approved as a design", async () => {
    await writeBundle();
    const b = await load();
    expect(b).toMatchObject({ shopKey: "wagashi", directionVersion: "v2", compApproved: false, comp: { kind: "synthetic", width: 720, height: 1025, sha256: SHA } });
    expect(b.demo.name).toBe("架空菓庵");
    expect(b.facts).toEqual(shop.facts);
  });

  it("loads a real comp only after a human-confirmed passing evaluation", async () => {
    await writeBundle({ report: { synthetic: undefined }, evaluation: REAL_EVAL });
    expect((await load()).compApproved).toBe(true);
  });

  it.each<[string, Parameters<typeof writeBundle>[0], string]>([
    ["a shop-facts.json with an invented price", { facts: { ...shop.facts, price: "どら焼き 280円" } }, "BUNDLE_FACTS_MISMATCH"],
    ["a shop-facts.json with a changed phone", { facts: { ...shop.facts, phone: "052-000-0000" } }, "BUNDLE_FACTS_MISMATCH"],
    ["a report for another image", { report: { png_sha256: "b".repeat(64) } }, "BUNDLE_REPORT_MISMATCH"],
    ["a report of the wrong size", { report: { width: 700 } }, "BUNDLE_REPORT_MISMATCH"],
    ["a changed art direction", { direction: { version: "0.3-poc" } }, "BUNDLE_DIRECTION_MISMATCH"],
    ["an evaluation of another comp", { evaluation: { comp_sha256: "c".repeat(64) } }, "EVAL_COMP_MISMATCH"],
    ["a synthetic image called real", { evaluation: REAL_EVAL }, "EVAL_KIND_MISMATCH"],
    ["a comp with a hard fail", { evaluation: { hard_fails: { invented_facts: true, store_or_people: false, disclosure: false, logo_or_realism: false, shop_facts: false } } }, "EVAL_HARD_FAIL"],
    ["a real comp nobody confirmed", { report: { synthetic: undefined }, evaluation: { ...REAL_EVAL, human_confirmed: false } }, "COMP_NOT_APPROVED"],
    ["a real comp under the pass mark", { report: { synthetic: undefined }, evaluation: { ...REAL_EVAL, scores: { beauty: 4, fit: 4, originality: 4, structure: 4, implementability: 4 }, total: 20 } }, "COMP_NOT_APPROVED"],
    ["a total that is not the sum", { report: { synthetic: undefined }, evaluation: { ...REAL_EVAL, total: 25 } }, "EVAL_TOTAL_MISMATCH"],
    ["a spec written from another comp", { spec: { comp_sha256: "d".repeat(64) } }, "SPEC_COMP_MISMATCH"],
    ["a spec of another artboard", { spec: { artboard: { width_px: 1024, height_px: 1536 } } }, "SPEC_ARTBOARD_MISMATCH"],
    ["a spec phrase that is no fact", { spec: { fact_phrases: ["創業百年の味"] } }, "SPEC_PHRASE_NOT_A_FACT"],
    ["a spec that does not parse", { spec: { version: 2 } }, "SPEC_SHAPE"],
  ])("refuses %s", async (_n, over, expected) => {
    await writeBundle(over);
    expect(await code(load())).toBe(expected);
  });

  it("refuses a broken PNG, a linked PNG, a missing directory and a facts source for another shop", async () => {
    await writeBundle();
    await writeFile(join(dir, "mockup.png"), PNG.subarray(0, PNG.length - 4));
    expect(await code(load())).toBe("COMP_PNG_INVALID");
    await rm(join(dir, "mockup.png"));
    await writeFile(join(dir, "real.png"), PNG);
    await symlink(join(dir, "real.png"), join(dir, "mockup.png"));
    expect(await code(load())).toBe("COMP_PNG_INVALID");
    expect(await code(loadCompBundle(join(dir, "nope"), { repoDir: REPO, factsSourcePath: FACTS_SOURCE }))).toBe("BUNDLE_MISSING");
    await rm(join(dir, "mockup.png"));
    await writeFile(join(dir, "mockup.png"), PNG);
    expect(await code(loadCompBundle(dir, { repoDir: REPO, factsSourcePath: join(REPO, "scripts/sales-design-worker/compare/shops/coffee.json") }))).toBe("FACTS_SOURCE_INVALID");
  });
});

describe("loadCompPage", () => {
  let page: string;
  beforeEach(async () => {
    page = await pageCopy("page-");
  });
  afterEach(async () => {
    await removeDir(page);
  });
  const asset = (over: Record<string, unknown> = {}) => ({ id: "hero", file: "assets/hero.png", sha256: sha256(flatPng(30, 20, [234, 225, 210])), kind: "placeholder", approval: null, published: false, ...over });
  const withAsset = async (entry: Record<string, unknown>, bytes = flatPng(30, 20, [234, 225, 210])) => {
    await mkdir(join(page, "assets"));
    await writeFile(join(page, "assets/hero.png"), bytes);
    await writeFile(join(page, "assets.json"), json({ version: 1, assets: [entry] }));
  };

  it("loads the synthetic page and a listed placeholder asset", async () => {
    const p = await loadCompPage(page);
    expect(p.assets).toEqual([]);
    await withAsset(asset());
    expect((await loadCompPage(page)).files.size).toBe(1);
  });

  it.each<[string, () => Promise<void>, string]>([
    ["an extra file", () => writeFile(join(page, "app.js"), "x"), "PAGE_FILE_UNEXPECTED"],
    ["an asset not in the list", async () => {
      await mkdir(join(page, "assets"));
      await writeFile(join(page, "assets/other.png"), flatPng(30, 20, [0, 0, 0]));
    }, "PAGE_ASSET_UNLISTED"],
    ["an asset whose hash differs", () => withAsset(asset({ sha256: "e".repeat(64) })), "PAGE_ASSET_HASH"],
    ["an AI concept image without a review record", () => withAsset(asset({ kind: "ai_concept_local" })), "PAGE_ASSET_APPROVAL"],
    ["an asset marked as published", () => withAsset(asset({ published: true })), "PAGE_ASSETS_INVALID"],
    ["a listed asset whose file is missing", () => writeFile(join(page, "assets.json"), json({ version: 1, assets: [asset()] })), "PAGE_ASSET_MISSING"],
    ["an asset that is no PNG", () => withAsset(asset(), Buffer.from("GIF89a")), "PAGE_ASSET_INVALID"],
    ["a linked stylesheet", async () => {
      await rm(join(page, "style.css"));
      await symlink(join(FIXTURE, "page/style.css"), join(page, "style.css"));
    }, "PAGE_CSS_INVALID"],
  ])("refuses %s", async (_n, change, expected) => {
    await change();
    expect(await code(loadCompPage(page))).toBe(expected);
  });
});
