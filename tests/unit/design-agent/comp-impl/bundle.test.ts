import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompImplError, EVAL_MIN_CRITERION, EVAL_PASS_TOTAL, evaluationVerdict, loadCompBundle, loadCompIntake, sha256, type CompNotApprovedError } from "@/lib/design-agent/comp-impl/bundle";
import { loadCompPage } from "@/lib/design-agent/comp-impl/page";
import { parseShop } from "@/lib/design-agent/compare/shops";
import { loadPocInputs } from "@/lib/design-agent/design-image/prompt";
import { FACTS_SOURCE, FIXTURE, flatPng, pageCopy, privateTemp, removeDir, REPO, stripedPng } from "./support";

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
const intake = () => loadCompIntake(dir, { repoDir: REPO, factsSourcePath: FACTS_SOURCE });
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "LOADED";
  } catch (error) {
    if (error instanceof CompImplError) return error.code;
    throw error;
  }
};
/** The refusal's code with the verdict attached to a COMP_NOT_APPROVED. */
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
    return { code: "LOADED" };
  } catch (error) {
    if (!(error instanceof CompImplError)) throw error;
    const e = error as Partial<CompNotApprovedError>;
    return { code: error.code, problems: e.problems, low: e.low_criteria };
  }
};
const scores = (beauty: number, fit: number, originality: number, structure: number, implementability: number) => ({ beauty, fit, originality, structure, implementability });

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

  // DEV-094: the human's policy (2026-10-22) 「22/25点以上、各項目4点以上を基本方針とする」
  it.each<[number[], number, string, string[], string[]]>([
    [[5, 5, 5, 5, 3], 23, "COMP_NOT_APPROVED", ["EVAL_CRITERION_BELOW_MIN"], ["implementability"]],
    [[5, 5, 5, 4, 3], 22, "COMP_NOT_APPROVED", ["EVAL_CRITERION_BELOW_MIN"], ["implementability"]],
    [[4, 4, 4, 5, 5], 22, "LOADED", [], []],
    [[4, 4, 4, 4, 5], 21, "COMP_NOT_APPROVED", ["EVAL_TOTAL_BELOW_PASS"], []],
  ])("a real comp scored %j (total %i): %s", async (s5, total, expected, problems, low) => {
    await writeBundle({ report: { synthetic: undefined }, evaluation: { ...REAL_EVAL, scores: scores(...(s5 as [number, number, number, number, number])), total } });
    if (expected === "LOADED") {
      expect((await load()).compApproved).toBe(true);
      expect((await intake()).compApproved).toBe(true);
    } else {
      expect(await refusal(load())).toEqual({ code: expected, problems, low });
      expect(await refusal(intake())).toEqual({ code: expected, problems, low });
    }
  });

  it("refuses an unconfirmed real comp with the verdict's reasons attached", async () => {
    await writeBundle({ report: { synthetic: undefined }, evaluation: { ...REAL_EVAL, human_confirmed: false } });
    expect(await refusal(load())).toEqual({ code: "COMP_NOT_APPROVED", problems: ["EVAL_NOT_CONFIRMED"], low: [] });
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

describe("evaluationVerdict (DEV-094)", () => {
  const real = { comp_kind: "real" as const, human_confirmed: true };
  it("keeps the policy's numbers", () => {
    expect([EVAL_PASS_TOTAL, EVAL_MIN_CRITERION]).toEqual([22, 4]);
  });
  it.each<[string, Parameters<typeof evaluationVerdict>[0], ReturnType<typeof evaluationVerdict>]>([
    ["the existing real sheet", { ...real, scores: scores(5, 5, 4, 5, 4), total: 23 }, { pass: true, reasons: [], low_criteria: [] }],
    ["all fives", { ...real, scores: scores(5, 5, 5, 5, 5), total: 25 }, { pass: true, reasons: [], low_criteria: [] }],
    ["the boundary 4,4,4,5,5", { ...real, scores: scores(4, 4, 4, 5, 5), total: 22 }, { pass: true, reasons: [], low_criteria: [] }],
    ["5,5,5,5,3 (total 23)", { ...real, scores: scores(5, 5, 5, 5, 3), total: 23 }, { pass: false, reasons: ["EVAL_CRITERION_BELOW_MIN"], low_criteria: ["implementability"] }],
    ["5,5,5,4,3 (total 22)", { ...real, scores: scores(5, 5, 5, 4, 3), total: 22 }, { pass: false, reasons: ["EVAL_CRITERION_BELOW_MIN"], low_criteria: ["implementability"] }],
    ["4,4,4,4,5 (total 21)", { ...real, scores: scores(4, 4, 4, 4, 5), total: 21 }, { pass: false, reasons: ["EVAL_TOTAL_BELOW_PASS"], low_criteria: [] }],
    ["3,5,5,5,3 (two weak criteria, total 21)", { ...real, scores: scores(3, 5, 5, 5, 3), total: 21 }, { pass: false, reasons: ["EVAL_CRITERION_BELOW_MIN", "EVAL_TOTAL_BELOW_PASS"], low_criteria: ["beauty", "implementability"] }],
    ["a missing total", { ...real, scores: scores(5, 5, 5, 5, 5), total: null }, { pass: false, reasons: ["EVAL_TOTAL_BELOW_PASS"], low_criteria: [] }],
    ["an unconfirmed sheet", { ...real, human_confirmed: false, scores: scores(5, 5, 5, 5, 5), total: 25 }, { pass: false, reasons: ["EVAL_NOT_CONFIRMED"], low_criteria: [] }],
    ["no scores", { ...real, human_confirmed: false, scores: null, total: null }, { pass: false, reasons: ["EVAL_NOT_CONFIRMED", "EVAL_NO_SCORES"], low_criteria: [] }],
    ["a synthetic comp, however scored", { comp_kind: "synthetic", human_confirmed: false, scores: scores(5, 5, 5, 5, 5), total: 25 }, { pass: false, reasons: ["EVAL_NOT_CONFIRMED", "EVAL_NOT_REAL"], low_criteria: [] }],
  ])("%s", (_n, ev, expected) => {
    expect(evaluationVerdict(ev)).toEqual(expected);
  });
});

describe("loadCompIntake (DEV-094)", () => {
  it("loads a bundle without layout-spec.json; loadCompBundle still refuses it with the existing code", async () => {
    await writeBundle({ report: { synthetic: undefined }, evaluation: REAL_EVAL });
    await rm(join(dir, "layout-spec.json"));
    const i = await intake();
    expect(i).toMatchObject({ compApproved: true, layoutSpecPresent: false, verdict: { pass: true, reasons: [], low_criteria: [] }, comp: { kind: "real", sha256: SHA } });
    expect(await code(load())).toBe("SPEC_INVALID");
  });

  it("loads the synthetic bundle as never approved and reports the spec as present", async () => {
    await writeBundle();
    expect(await intake()).toMatchObject({ compApproved: false, layoutSpecPresent: true, comp: { kind: "synthetic" } });
  });

  it("surfaces the provenance of report.json and refuses nothing for a missing or malformed field", async () => {
    await writeBundle({ report: { worker_commit: "25af489", prompt_chars: 4321 } });
    expect((await intake()).provenance).toEqual({ worker_commit: "25af489", prompt_chars: 4321, direction_version: "v2" });
    await writeBundle({ report: { worker_commit: "not a commit", prompt_chars: -1 } });
    expect((await intake()).provenance).toEqual({ worker_commit: null, prompt_chars: null, direction_version: "v2" });
    await writeBundle();
    expect((await intake()).provenance).toEqual({ worker_commit: null, prompt_chars: null, direction_version: "v2" });
  });

  it("keeps the refusal order of loadCompBundle up to the evaluation", async () => {
    await writeBundle({ facts: { ...shop.facts, phone: "052-000-0000" }, evaluation: { comp_sha256: "c".repeat(64) } });
    expect(await code(intake())).toBe("BUNDLE_FACTS_MISMATCH");
    expect(await code(load())).toBe("BUNDLE_FACTS_MISMATCH");
    await writeBundle({ evaluation: { comp_sha256: "c".repeat(64) }, spec: { version: 2 } });
    expect(await code(intake())).toBe("EVAL_COMP_MISMATCH");
    expect(await code(load())).toBe("EVAL_COMP_MISMATCH");
  });
});

describe("comp-impl-poc.ts --intake (DEV-094)", () => {
  /** Every entry under a directory: path, type, mode and bytes. */
  async function snapshot(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (d: string) => {
      for (const name of (await readdir(d)).sort()) {
        const p = join(d, name);
        const st = await lstat(p);
        out.push(`${p} ${st.mode.toString(8)} ${st.isFile() ? sha256(await readFile(p)) : st.isDirectory() ? "dir" : "other"}`);
        if (st.isDirectory()) await walk(p);
      }
    };
    await walk(root);
    return out;
  }
  const cli = (...argv: string[]) => {
    const r = spawnSync("npx", ["tsx", join(REPO, "scripts/sales-design-worker/comp-impl-poc.ts"), ...argv], {
      cwd: REPO,
      encoding: "utf8",
      // an output root that must never appear, and a Chromium that does not exist: --intake needs neither
      env: { ...process.env, SR_COMP_IMPL_POC_ROOT: join(dir, "out-root"), PLAYWRIGHT_CHROMIUM_EXECUTABLE: join(dir, "no-chromium") },
      timeout: 60_000,
    });
    return { status: r.status, stdout: r.stdout.trim() };
  };

  it("prints one fixed-code line, exits 0 / 1 / 2, and writes nothing", async () => {
    await writeBundle({ report: { synthetic: undefined, worker_commit: "25af489" }, evaluation: REAL_EVAL });
    await rm(join(dir, "layout-spec.json"));
    const before = await snapshot(dir);
    expect(cli("--intake", dir)).toEqual({ status: 0, stdout: `COMP_INTAKE ok=true comp_kind=real comp_approved=true reasons=none low=none sha=${SHA} size=720x1025 direction=v2 worker_commit=25af489 layout_spec_present=false` });
    expect(await snapshot(dir)).toEqual(before);

    await writeBundle();
    const beforeS = await snapshot(dir);
    expect(cli("--intake", dir)).toEqual({ status: 0, stdout: `COMP_INTAKE ok=true comp_kind=synthetic comp_approved=false reasons=EVAL_NOT_CONFIRMED,EVAL_NOT_REAL,EVAL_NO_SCORES low=none sha=${SHA} size=720x1025 direction=v2 worker_commit=none layout_spec_present=true` });
    expect(await snapshot(dir)).toEqual(beforeS);

    await writeBundle({ report: { synthetic: undefined }, evaluation: { ...REAL_EVAL, scores: scores(5, 5, 5, 5, 3), total: 23 } });
    const before1 = await snapshot(dir);
    expect(cli("--intake", dir, "--facts", FACTS_SOURCE)).toEqual({ status: 1, stdout: "COMP_INTAKE ok=false refused=COMP_NOT_APPROVED comp_kind=real comp_approved=false reasons=EVAL_CRITERION_BELOW_MIN low=implementability" });
    expect(await snapshot(dir)).toEqual(before1);

    await writeBundle({ evaluation: { hard_fails: { invented_facts: true, store_or_people: false, disclosure: false, logo_or_realism: false, shop_facts: false } } });
    const before2 = await snapshot(dir);
    expect(cli("--intake", dir)).toEqual({ status: 2, stdout: "COMP_INTAKE ok=false refused=EVAL_HARD_FAIL" });
    expect(cli("--intake", dir, "--synthetic").status).toBe(2);
    expect(cli("--intake", dir, "--page", dir).status).toBe(2);
    expect(await snapshot(dir)).toEqual(before2);
    await expect(lstat(join(dir, "out-root"))).rejects.toThrow();
  }, 180_000);
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
    // review of PR #96: the kind is the author's word; a "placeholder" with anything drawn in it is refused
    ["a placeholder that is not one flat colour", () => withAsset(asset({ sha256: sha256(stripedPng(30, 20, [234, 225, 210], [31, 29, 27])) }), stripedPng(30, 20, [234, 225, 210], [31, 29, 27])), "PAGE_ASSET_PLACEHOLDER_NOT_FLAT"],
    ["a linked stylesheet", async () => {
      await rm(join(page, "style.css"));
      await symlink(join(FIXTURE, "page/style.css"), join(page, "style.css"));
    }, "PAGE_CSS_INVALID"],
  ])("refuses %s", async (_n, change, expected) => {
    await change();
    expect(await code(loadCompPage(page))).toBe(expected);
  });
});
