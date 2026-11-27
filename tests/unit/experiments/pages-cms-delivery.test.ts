import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { exportDelivery, listFiles, NODE_VERSION, SITE_FILES, TEMPLATE_FILES } from "@/experiments/pages-cms/export-delivery";
import { pagesYaml } from "@/experiments/pages-cms/pages-config";
import { AUTO_SITE } from "@/experiments/pages-cms/shop-site";

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
const shaOf = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("Issue #380 PR 3: the standalone delivery repository (export)", () => {
  it("is deterministic: two exports write the same files with the same bytes", async () => {
    const a = join(tmp(), "a");
    const b = join(tmp(), "b");
    const fa = await exportDelivery({ outDir: a });
    const fb = await exportDelivery({ outDir: b });
    expect(fa).toEqual(fb);
    for (const f of fa) expect(shaOf(join(a, f)), f).toBe(shaOf(join(b, f)));
  });

  it("holds the build, the page code copied verbatim, the generated .pages.yml, the sample, the settings — and nothing of Second Root's private records", async () => {
    const out = join(tmp(), "repo");
    const files = await exportDelivery({ outDir: out });
    for (const f of [".gitignore", ".node-version", ".pages.yml", "README.md", "build.mjs", "package-lock.json", "package.json", "photo-prep.mjs", "site.config.json", "tests/template.test.mjs"]) expect(files, f).toContain(f);
    for (const f of SITE_FILES) expect(readFileSync(join(out, "site", f), "utf8"), f).toBe(readFileSync(join(HERE, f), "utf8"));
    expect(files.filter((f) => f.startsWith("site/"))).toEqual(SITE_FILES.map((f) => `site/${f}`));
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
    await exportDelivery({ outDir: out });
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

  it("the README names the Cloudflare Pages settings (build command, output directory, Node version) and the HEIC advice", () => {
    const readme = readFileSync(join(HERE, "delivery-template", "README.md"), "utf8");
    expect(readme).toContain("`npm ci && npm run build`");
    expect(readme).toMatch(/Build output directory \| `dist`/);
    expect(readme).toContain("`.node-version` (`22`)");
    expect(readme).toContain("互換性優先");
  });

  it("refuses an output folder inside Second Root, a non-empty one, an unknown site or fixture", async () => {
    await expect(exportDelivery({ outDir: join(__dirname, "export-here") })).rejects.toMatchObject({ code: "EXPORT_OUT_UNSAFE" });
    const full = tmp();
    await expect(exportDelivery({ outDir: full, site: "auto" }).then(() => exportDelivery({ outDir: full }))).rejects.toMatchObject({ code: "EXPORT_OUT_UNSAFE" });
    await expect(exportDelivery({ outDir: join(tmp(), "x"), site: "garage" })).rejects.toMatchObject({ code: "EXPORT_SITE_UNKNOWN" });
    await expect(exportDelivery({ outDir: join(tmp(), "y"), fixture: "nope" })).rejects.toMatchObject({ code: "EXPORT_FIXTURE_UNKNOWN" });
  });
});
