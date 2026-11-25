import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FAMILIES, MANIFEST_PATH, MODULE_PATH, checkCommitted, formatManifest, renderModule } from "../../scripts/fonts/generate-site-fonts.mjs";

// DEV-303 (PR B): the official site's faces are committed files loaded with
// next/font/local (no Google Fonts download at build time). The generated module
// must be exactly what the manifest renders to, every committed font file must
// match the manifest, the faces must be declared as next/font/google declared
// them, and only the Latin subsets used at first view are preloaded.

type Face = { file: string; weight: string; style: string; stretch: string | null; unicodeRange: string; subset: string | null; preload: boolean; bytes: number; sha256: string; source: string };
type Family = { dir: string; family: string; exportName: string; variable: string; google: string; notice?: string; license: { package: string; version: string; copyright: string }; faces: Face[] };
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { families: Family[] };
const byVar = new Map(manifest.families.map((f) => [f.variable, f]));
const fontsDir = join(MANIFEST_PATH, "..");

describe("official site fonts, self-hosted with next/font/local (DEV-303)", () => {
  it("regenerating from the manifest is byte-identical, and every committed file matches it", () => {
    expect(readFileSync(MODULE_PATH, "utf8")).toBe(renderModule(manifest));
    expect(readFileSync(MANIFEST_PATH, "utf8")).toBe(formatManifest(manifest));
    expect(checkCommitted()).toEqual([]);
  });

  it("the manifest is the generator's families: next/font/google's requests, pinned license packages", () => {
    type Source = { family: string; google: string; license: { package: string; version: string } };
    const key = (f: Source) => `${f.family} ${f.google} ${f.license.package}@${f.license.version}`;
    expect(manifest.families.map(key)).toEqual((FAMILIES as Source[]).map(key));
    for (const f of manifest.families) for (const x of f.faces) expect(x.source.startsWith("https://fonts.gstatic.com/"), x.file).toBe(true);
  });

  it("keeps the families, weights, styles and CSS variables of app/layout.tsx before", () => {
    const shape = (v: string) => {
      const f = byVar.get(v)!;
      return { family: f.family, faces: [...new Set(f.faces.map((x) => `${x.weight}/${x.style}/${x.stretch ?? "-"}`))] };
    };
    expect(shape("--font-display")).toEqual({ family: "Shippori Mincho", faces: ["400/normal/-", "600/normal/-"] });
    expect(shape("--font-body")).toEqual({ family: "Noto Sans JP", faces: ["400/normal/-", "500/normal/-", "600/normal/-"] });
    expect(shape("--font-label")).toEqual({ family: "Zen Maru Gothic", faces: ["500/normal/-", "700/normal/-"] });
    // Noto Sans JP: one variable file per subset, declared for each of the three weights
    const noto = byVar.get("--font-body")!;
    expect(noto.faces).toHaveLength(372);
    expect(new Set(noto.faces.map((x) => x.file)).size).toBe(124);
  });

  it("one face per unicode-range subset (as Google served them); the ranges cover sample kana and kanji at every weight", () => {
    const counts = Object.fromEntries(manifest.families.map((f) => [f.family, f.faces.length]));
    expect(counts).toEqual({ "Shippori Mincho": 244, "Noto Sans JP": 372, "Zen Maru Gothic": 244 });
    const has = (range: string, cp: number) => range.split(",").some((r) => {
      const [a, b] = r.trim().replace("U+", "").split("-").map((h) => parseInt(h, 16));
      return cp >= a! && cp <= (b ?? a)!;
    });
    for (const f of manifest.families) {
      for (const w of new Set(f.faces.map((x) => x.weight))) {
        for (const cp of [0x3042, 0x30a2, 0x5e97, 0x0041]) expect(f.faces.some((x) => x.weight === w && has(x.unicodeRange, cp)), `${f.family} ${w} U+${cp.toString(16)}`).toBe(true);
      }
    }
  });

  it("preloads only the Latin subsets used at first view (Shippori Mincho 600, Noto Sans JP), one file each", () => {
    const preloaded = manifest.families.flatMap((f) => f.faces.filter((x) => x.preload).map((x) => ({ family: f.family, weight: x.weight, subset: x.subset, file: x.file, bytes: x.bytes })));
    expect(preloaded.map((p) => `${p.family} ${p.weight} ${p.subset}`)).toEqual(["Shippori Mincho 600 latin", "Noto Sans JP 400 latin", "Noto Sans JP 500 latin", "Noto Sans JP 600 latin"]);
    const files = new Map(preloaded.map((p) => [p.file, p.bytes]));
    expect(files.size).toBe(2);
    expect([...files.values()].reduce((s, b) => s + b, 0)).toBeLessThan(64 * 1024);
    // a file shared by several faces is preloaded by all of them or none (else the build emits it twice)
    for (const f of manifest.families) {
      const flags = new Map<string, Set<boolean>>();
      for (const x of f.faces) flags.set(x.file, (flags.get(x.file) ?? new Set()).add(x.preload));
      for (const [file, s] of flags) expect(s.size, file).toBe(1);
    }
  });

  it("keeps the OFL license and copyright notice of every family", () => {
    for (const f of manifest.families) {
      const license = readFileSync(join(fontsDir, f.dir, "LICENSE"), "utf8");
      expect(license, f.family).toContain("SIL OPEN FONT LICENSE Version 1.1");
      expect(license.startsWith(f.license.copyright.slice(0, 20)), f.family).toBe(true);
    }
    expect(byVar.get("--font-display")!.license.copyright).toMatch(/^Copyright 2021 The Shippori Mincho Project Authors/);
    expect(byVar.get("--font-label")!.license.copyright).toMatch(/^Copyright 2021 The Zen Maru Gothic Authors/);
    // the Noto package names "Google Inc."; NOTICE keeps the notice embedded in the font files
    expect(readFileSync(join(fontsDir, "noto-sans-jp", "NOTICE"), "utf8")).toContain("(c) 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'.");
  });

  it("app/layout.tsx uses the generated faces, with the fallback faces copied from next/font/google", () => {
    const layout = readFileSync(join(process.cwd(), "app/layout.tsx"), "utf8");
    expect(layout).toContain('from "./_fonts/site-fonts.generated"');
    expect(layout).toContain('import "./_fonts/fallback.css"');
    expect(layout).toContain("${shipporiMincho.variable} ${notoSansJP.variable} ${zenMaruGothic.variable}");
    const generated = readFileSync(MODULE_PATH, "utf8");
    const fallback = readFileSync(join(fontsDir, "fallback.css"), "utf8");
    for (const f of manifest.families) {
      expect(generated).toContain(`export const ${f.exportName} = localFont(`);
      expect(generated).toContain(`variable: "${f.variable}", fallback: ["\\"${f.family} Fallback\\""]`);
      expect(fallback).toContain(`font-family:"${f.family} Fallback"`);
    }
  });
});

describe("no next/font/google anywhere (DEV-303)", () => {
  it("no source file imports next/font/google: the build fetches no font from Google", () => {
    const root = process.cwd();
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (["node_modules", ".next", ".git", ".claude"].includes(name)) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(m?[jt]sx?|cjs)$/.test(name)) {
          const text = readFileSync(path, "utf8");
          if (/(from\s+|import\s*\(\s*|require\s*\(\s*)["']next\/font\/google["']/.test(text)) offenders.push(path.slice(root.length + 1));
        }
      }
    };
    for (const dir of ["app", "components", "lib", "scripts", "tests"]) walk(join(root, dir));
    for (const file of readdirSync(root)) if (/\.(m?[jt]sx?|cjs)$/.test(file) && /(from\s+|require\s*\(\s*)["']next\/font\/google["']/.test(readFileSync(join(root, file), "utf8"))) offenders.push(file);
    expect(offenders).toEqual([]);
  });
});
