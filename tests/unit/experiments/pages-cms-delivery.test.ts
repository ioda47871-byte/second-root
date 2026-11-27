import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { exportDelivery, listFiles, NODE_VERSION, SITE_DIRS, SITE_FILES, TEMPLATE_FILES } from "@/experiments/pages-cms/export-delivery";
import { pagesYaml } from "@/experiments/pages-cms/pages-config";
import { AUTO_SITE } from "@/experiments/pages-cms/shop-site";
import { writeSyntheticDesign } from "./synthetic-design";

// Issue #380 PR 3: the standalone delivery-repo template, written by export-delivery.ts. No install and no build here
// (its dependencies are not Second Root's): this checks what is written. The repository's own tests
// (delivery-template/tests/template.test.mjs, node --test after npm ci in an exported copy) cover the build itself.

const temps: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "sr-pcms-export-")));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const HERE = join(__dirname, "../../../experiments/pages-cms");
// PR #390: no design picture is committed — the exports here take SYNTHETIC pictures and a test-only record
const DESIGN = (() => {
  const d = join(tmp(), "design");
  writeSyntheticDesign(d);
  return { designDir: d, testOnlyDesignRecordDir: d };
})();
const shaOf = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("Issue #380 PR 3: the standalone delivery repository (export)", () => {
  it("is deterministic: two exports write the same files with the same bytes", async () => {
    const a = join(tmp(), "a");
    const b = join(tmp(), "b");
    const fa = await exportDelivery({ outDir: a, ...DESIGN });
    const fb = await exportDelivery({ outDir: b, ...DESIGN });
    expect(fa).toEqual(fb);
    for (const f of fa) expect(shaOf(join(a, f)), f).toBe(shaOf(join(b, f)));
  });

  it("holds the build, the page code copied verbatim, the generated .pages.yml, the sample, the settings — and nothing of Second Root's private records", async () => {
    const out = join(tmp(), "repo");
    const files = await exportDelivery({ outDir: out, ...DESIGN });
    for (const f of [".gitignore", ".node-version", ".pages.yml", "README.md", "build.mjs", "package-lock.json", "package.json", "photo-prep.mjs", "site.config.json", "tests/template.test.mjs"]) expect(files, f).toContain(f);
    for (const f of SITE_FILES) expect(readFileSync(join(out, "site", f), "utf8"), f).toBe(readFileSync(join(HERE, f), "utf8"));
    // the page code, plus its static design folder (Issue #380 SORAIRO), copied byte for byte
    // the design folder: Second Root holds its record only; the export adds the pictures from the outside folder,
    // under the record's names, and the record it checked them against
    expect((await Promise.all(SITE_DIRS.map(async (d) => listFiles(join(HERE, d))))).flat()).toEqual(["sorairo/generated-materials.json"]);
    const designFiles = ["site/design/sorairo/generated-materials.json", "site/design/sorairo/sorairo-matte-black.jpg", "site/design/sorairo/sorairo-silver.jpg"];
    expect(files.filter((f) => f.startsWith("site/"))).toEqual([...SITE_FILES.map((f) => `site/${f}`), ...designFiles].sort());
    for (const f of designFiles) expect(shaOf(join(out, f)), f).toBe(shaOf(join(DESIGN.designDir, f.replace(/^site\/design\/sorairo\//, ""))));
    expect(readFileSync(join(out, ".pages.yml"), "utf8")).toBe(pagesYaml({ extensions: AUTO_SITE.profile.extensions, collections: AUTO_SITE.profile.collections }));
    expect(JSON.parse(readFileSync(join(out, "site.config.json"), "utf8"))).toEqual({ site: "auto" });
    expect(readFileSync(join(out, ".node-version"), "utf8")).toBe(`${NODE_VERSION}\n`);
    // the sample: fictional content and synthetic PNGs only; the B index may be there, the private rights records not
    expect(files.filter((f) => f.startsWith("media/")).every((f) => f.endsWith(".png"))).toBe(true);
    for (const f of files.filter((f) => f.startsWith("media/"))) expect(readFileSync(join(out, f)).subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(files.some((f) => /provenance\/|[0-9a-f]{64}\.json$/.test(f))).toBe(false);
    expect(readFileSync(join(out, "content", "shop.json"), "utf8")).toContain("架空のカーケア工房 そらいろ");
    // the template files are copied as they are
    for (const [from, to] of Object.entries(TEMPLATE_FILES)) expect(shaOf(join(out, to)), to).toBe(shaOf(join(HERE, "delivery-template", from)));
  });

  it("pins every dependency exactly in its own package.json and lockfile (none added to Second Root); no secret, no network call, no model in the build", async () => {
    const out = join(tmp(), "repo");
    await exportDelivery({ outDir: out, ...DESIGN });
    const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf8")) as { dependencies: Record<string, string>; devDependencies?: unknown; scripts: Record<string, string>; private: boolean };
    expect(pkg.private).toBe(true);
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["sharp", "tsx", "zod"]);
    for (const [name, v] of Object.entries(pkg.dependencies)) expect(v, name).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies).toBeUndefined();
    const lock = JSON.parse(readFileSync(join(out, "package-lock.json"), "utf8")) as { lockfileVersion: number; packages: Record<string, { version?: string; resolved?: string; integrity?: string }> };
    expect(lock.lockfileVersion).toBeGreaterThanOrEqual(3);
    for (const [name, v] of Object.entries(pkg.dependencies)) expect(lock.packages[`node_modules/${name}`]?.version, name).toBe(v);
    for (const [path, p] of Object.entries(lock.packages)) if (path) expect(p.resolved ?? "", path).toMatch(/^(https:\/\/registry\.npmjs\.org\/|$)/);
    // Second Root's own manifest is untouched by the template
    const root = JSON.parse(readFileSync(join(__dirname, "../../../package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(Object.keys({ ...root.dependencies, ...root.devDependencies })).not.toContain("sharp");
    for (const f of ["build.mjs", "photo-prep.mjs", "tests/template.test.mjs"]) {
      const text = readFileSync(join(out, f), "utf8");
      expect(text, f).not.toMatch(/\bfetch\(|https?:\/\/(?!developers\.cloudflare)|process\.env\.[A-Z_]*(TOKEN|KEY|SECRET)|anthropic|openai|codex/i);
    }
    const all = (await listFiles(out)).filter((f) => !f.startsWith("media/"));
    for (const f of all) expect(readFileSync(join(out, f), "utf8"), f).not.toMatch(/(api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']+/i);
  });

  it("the README names the Cloudflare Pages settings (build command, output directory, install switch, Node version) and the HEIC advice; the owner sheet says the same", () => {
    const readme = readFileSync(join(HERE, "delivery-template", "README.md"), "utf8");
    expect(NODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const settings = ["`npm ci && npm run build`", "`dist`", "`SKIP_DEPENDENCY_INSTALL`", "`1`", `\`${NODE_VERSION}\``];
    expect(readme).toMatch(/Build command \| `npm ci && npm run build`/);
    expect(readme).toMatch(/Build output directory \| `dist`/);
    expect(readme).toMatch(/`SKIP_DEPENDENCY_INSTALL` = `1`/);
    expect(readme).toContain(`\`.node-version\` (\`${NODE_VERSION}\``);
    expect(readme).toContain("互換性優先");
    // review (template, 6c02096d) M: the owner's live-trial sheet follows the README (the single source of truth)
    const sheet = readFileSync(join(__dirname, "../../../docs/design/cms-live-trial-owner-sheet.md"), "utf8");
    const section = sheet.slice(sheet.indexOf("### 1.3"), sheet.indexOf("### 1.4"));
    for (const v of settings) expect(section, v).toContain(v);
    expect(section).toMatch(/\| Build command \| `npm ci && npm run build`/);
    expect(section).toContain("delivery-template/README.md");
    expect(sheet).not.toMatch(/`node build\.mjs`|依存の無い納品用の入口/);
  });

  it("refuses an output folder inside Second Root, a non-empty one, an unknown site or fixture", async () => {
    // #390 review: the output folder is checked before the design pictures (a deterministic order)
    await expect(exportDelivery({ outDir: join(__dirname, "export-here"), ...DESIGN })).rejects.toMatchObject({ code: "EXPORT_OUT_UNSAFE" });
    await expect(exportDelivery({ outDir: join(__dirname, "export-here"), designDir: join(tmp(), "no-such-folder") })).rejects.toMatchObject({ code: "EXPORT_OUT_UNSAFE" });
    const full = tmp();
    await expect(exportDelivery({ outDir: full, site: "auto", ...DESIGN }).then(() => exportDelivery({ outDir: full, ...DESIGN }))).rejects.toMatchObject({ code: "EXPORT_OUT_UNSAFE" });
    await expect(exportDelivery({ outDir: join(tmp(), "x"), site: "garage", ...DESIGN })).rejects.toMatchObject({ code: "EXPORT_SITE_UNKNOWN" });
    await expect(exportDelivery({ outDir: join(tmp(), "y"), fixture: "nope", ...DESIGN })).rejects.toMatchObject({ code: "EXPORT_FIXTURE_UNKNOWN" });
    // the test-only record override is refused outside vitest
    const saved = process.env.VITEST;
    process.env.VITEST = "false";
    try {
      await expect(exportDelivery({ outDir: join(tmp(), "w"), ...DESIGN })).rejects.toMatchObject({ code: "EXPORT_TEST_ONLY" });
    } finally {
      process.env.VITEST = saved;
    }
    // PR #390: design pictures missing, or not the recorded bytes (the committed record with synthetic pictures), refuse
    // before anything is written
    const noDesign = join(tmp(), "z");
    await expect(exportDelivery({ outDir: noDesign, designDir: join(tmp(), "no-such-folder") })).rejects.toMatchObject({ code: "EXPORT_DESIGN_MISSING" });
    await expect(exportDelivery({ outDir: noDesign, designDir: DESIGN.designDir })).rejects.toMatchObject({ code: "EXPORT_DESIGN_MISSING" });
    expect(existsSync(noDesign)).toBe(false);
    // a site without design pictures exports without them
    expect((await exportDelivery({ outDir: join(tmp(), "bakery"), site: "bakery", designDir: join(tmp(), "no-such-folder") })).filter((f) => f.endsWith(".jpg"))).toEqual([]);
  });
});
