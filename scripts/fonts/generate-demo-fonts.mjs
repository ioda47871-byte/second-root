// Self-hosted display faces for design profiles (DEV-303, PR A): the font files
// next/font/google used to download at build time, committed to the repository
// so the build needs no network.
//
// The files are the exact bytes next/font/google downloaded: the same Google
// Fonts CSS2 request (URL and User-Agent as in next/font) and the woff2
// unicode-range subsets it lists, unmodified. Each file's sha256 is in
// fonts/manifest.json, and a regeneration that gets other bytes fails. (Fontsource
// republishes the same glyphs, but its variable-font files carry a hinting
// `prep` table that Google's do not, which changes how Chromium rasterizes them,
// so they are not a drop-in replacement.)
//
// The license text and copyright notice of each family (SIL Open Font License
// 1.1) come from a pinned @fontsource tarball (`npm pack <package>@<version>`),
// checked against its sha256 and npm integrity.
//
//   node scripts/fonts/generate-demo-fonts.mjs --packs <dir with the .tgz files>
//       network: fetches the CSS and files from Google Fonts, copies each LICENSE,
//       and writes fonts/manifest.json and fonts.generated.ts
//   node scripts/fonts/generate-demo-fonts.mjs --check
//       offline: fonts.generated.ts is what the manifest renders to, and every
//       committed font file matches the manifest (also a unit test)
//
// fonts.generated.ts has one next/font/local call per unicode-range subset, in
// Google's order and with Google's descriptors (family, weight, style, stretch),
// so a page downloads only the subsets of the characters it shows, as before.
// Preloads are as next/font/google made them for subsets: ["latin"]: the latin
// subset of Playfair Display and Archivo; the Japanese faces are not preloaded.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PROFILE_DIR = join(REPO, "components", "demo", "profile");
export const FONTS_DIR = join(PROFILE_DIR, "fonts");
export const MANIFEST_PATH = join(FONTS_DIR, "manifest.json");
export const MODULE_PATH = join(PROFILE_DIR, "fonts.generated.ts");

/** The User-Agent next/font/google sends (next/dist/compiled/@next/font/dist/google/fetch-resource.js): it selects woff2. */
export const NEXT_FONT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.0.0 Safari/537.36";

/** The families, in the order of the old fonts.ts, with the CSS2 request next/font/google made for its options. */
export const FAMILIES = [
  {
    dir: "playfair-display",
    family: "Playfair Display",
    exportName: "editorial",
    variable: "--font-editorial",
    google: "https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400..900;1,400..900&display=swap",
    preloadLatin: true,
    license: { package: "@fontsource-variable/playfair-display", version: "5.3.0", tgz: "fontsource-variable-playfair-display-5.3.0.tgz", tgzSha256: "5d9a6609ccc3c3bcba68c5b66981cce7d731bf5bb6e64a2ca6045ab05e527788", integrity: "sha512-IHdzTvE8eGIXHteZql7KXoqdc3Gfm+Zs1u4XlSC3MeplkwviT3sx/P6gI0tLwg/xIYLF4ZJYveZ5V+bl9cnDwA==" },
  },
  {
    dir: "archivo",
    family: "Archivo",
    exportName: "grotesk",
    variable: "--font-grotesk",
    google: "https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&display=swap",
    preloadLatin: true,
    license: { package: "@fontsource-variable/archivo", version: "5.3.0", tgz: "fontsource-variable-archivo-5.3.0.tgz", tgzSha256: "20c4384ed6219fc792761ad56fd578a70ba8758374b307f2f8da3db2009924a9", integrity: "sha512-HogK8FJelrD1o7TlZlkIVtHgc20bO5PZRWE7mUeUTdMN055alznQV6/00J00IBeu8FQAH4s3zW9UJNvKExXf+g==" },
  },
  {
    dir: "zen-old-mincho",
    family: "Zen Old Mincho",
    exportName: "editorialJa",
    variable: "--font-ja-editorial",
    google: "https://fonts.googleapis.com/css2?family=Zen+Old+Mincho:wght@400;900&display=swap",
    preloadLatin: false,
    license: { package: "@fontsource/zen-old-mincho", version: "5.3.1", tgz: "fontsource-zen-old-mincho-5.3.1.tgz", tgzSha256: "c299c3d6be0ea6b8c415e18d3fe620d95df2a8f979935a34cb6a766f076542f3", integrity: "sha512-wahFUlw1s0zKkxiTRj9jJiyVrdNT5uHNYWakr6cDEIgp91YoP/LOvfD2+JVIKiXIwTChDM1oW1yqXJbdtlI56w==" },
  },
  {
    dir: "zen-kaku-gothic-new",
    family: "Zen Kaku Gothic New",
    exportName: "condensedJa",
    variable: "--font-ja-condensed",
    google: "https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@400;900&display=swap",
    preloadLatin: false,
    license: { package: "@fontsource/zen-kaku-gothic-new", version: "5.3.1", tgz: "fontsource-zen-kaku-gothic-new-5.3.1.tgz", tgzSha256: "4be769463585cf231ace87d2da71ea45ab3ce8223f59700405a7b9ac403b6028", integrity: "sha512-L69mE6bkzeVK3UdTenxOmCIWvTwMxohJRNm1dAj+W+UiCULQ91b7M77ENVw+pjGmFL6zKPFYFeH3g8x2ugAJNw==" },
  },
  {
    dir: "m-plus-1",
    family: "M PLUS 1",
    exportName: "lightJa",
    variable: "--font-ja-light",
    google: "https://fonts.googleapis.com/css2?family=M+PLUS+1:wght@100..900&display=swap",
    preloadLatin: false,
    license: { package: "@fontsource-variable/m-plus-1", version: "5.3.1", tgz: "fontsource-variable-m-plus-1-5.3.1.tgz", tgzSha256: "24629d1132364b1ad7c361baf6f3d64da3cdc8136e5b2333f5d2a5b23645240d", integrity: "sha512-PWa0cJ5X/gnwkVhMgRXSpi2+I8kRIb7gRHL2lld4TuxumNbZ+9Ef6lUnX+P51ixSl8MEUD5HHp7E62dmGML1wA==" },
  },
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const integrityOf = (buf) => `sha512-${createHash("sha512").update(buf).digest("base64")}`;

/** The @font-face rules of a Google Fonts CSS2 response, in order, with the subset comment above each (as next/font reads it). */
export function parseGoogleCss(css) {
  const faces = [];
  let subset = "";
  for (const m of css.matchAll(/(?:\/\*\s*([^*]+?)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g)) {
    if (m[1]) subset = m[1];
    const get = (prop) => m[2].match(new RegExp(`${prop}:\\s*([^;]+);`))?.[1]?.trim();
    const url = m[2].match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/)?.[1];
    const face = { subset, url, family: get("font-family")?.replace(/^'|'$/g, ""), weight: get("font-weight"), style: get("font-style"), stretch: get("font-stretch") ?? null, unicodeRange: get("unicode-range") };
    if (!face.url || !face.weight || !face.style || !face.unicodeRange) throw new Error(`unexpected @font-face: ${m[2].slice(0, 160)}`);
    faces.push(face);
  }
  return faces;
}

/** fonts.generated.ts for a manifest. Pure: the unit test renders the committed manifest and compares. */
export function renderModule(manifest) {
  const lines = [
    "// GENERATED by scripts/fonts/generate-demo-fonts.mjs from fonts/manifest.json. Do not edit:",
    "// change the generator and run it again (see components/demo/profile/fonts/PROVENANCE.md).",
    "//",
    "// One next/font/local call per unicode-range subset, with the descriptors and order Google",
    "// Fonts served, so a page downloads only the subsets of the characters it shows. Every call",
    "// is kept by the build (its @font-face is global); only the first call of a family defines",
    "// the CSS variable.",
    "/* eslint-disable @typescript-eslint/no-unused-vars */",
    'import localFont from "next/font/local";',
    "",
  ];
  for (const fam of manifest.families) {
    lines.push(`// ${fam.family}: SIL Open Font License 1.1 (fonts/${fam.dir}/LICENSE)`);
    fam.faces.forEach((face, i) => {
      const name = i === 0 ? `export const ${fam.exportName}` : `const ${fam.exportName}${i}`;
      const declarations = [
        { prop: "font-family", value: `'${fam.family}'` },
        ...(face.stretch ? [{ prop: "font-stretch", value: face.stretch }] : []),
        { prop: "unicode-range", value: face.unicodeRange },
      ];
      const opts = [
        `src: [{ path: ${JSON.stringify(`./fonts/${fam.dir}/${face.file}`)}, weight: ${JSON.stringify(face.weight)}, style: ${JSON.stringify(face.style)} }]`,
        `display: "swap"`,
        `preload: ${face.preload}`,
        `adjustFontFallback: false`,
        ...(i === 0 ? [`variable: ${JSON.stringify(fam.variable)}`, `fallback: [${JSON.stringify(`"${fam.family} Fallback"`)}]`] : []),
        `declarations: [${declarations.map((d) => `{ prop: ${JSON.stringify(d.prop)}, value: ${JSON.stringify(d.value)} }`).join(", ")}]`,
      ];
      lines.push(`${name} = localFont({ ${opts.join(", ")} });`);
    });
    lines.push("");
  }
  return lines.join("\n");
}

/** The manifest as committed: one face per line, so a change shows as a small diff. */
export function formatManifest(manifest) {
  const faces = [];
  const placeholders = { ...manifest, families: manifest.families.map((f) => ({ ...f, faces: f.faces.map((x) => `@@face${faces.push(x) - 1}@@`) })) };
  return `${JSON.stringify(placeholders, null, 2).replace(/"@@face(\d+)@@"/g, (_, i) => JSON.stringify(faces[Number(i)]))}\n`;
}

/** Problems with the committed files (empty when all is well). */
export function checkCommitted() {
  const problems = [];
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  if (readFileSync(MODULE_PATH, "utf8") !== renderModule(manifest)) problems.push("fonts.generated.ts is not what manifest.json renders to");
  if (readFileSync(MANIFEST_PATH, "utf8") !== formatManifest(manifest)) problems.push("manifest.json is not in its generated format");
  const listed = new Set();
  for (const fam of manifest.families) {
    listed.add(`${fam.dir}/LICENSE`);
    const license = join(FONTS_DIR, fam.dir, "LICENSE");
    if (!existsSync(license) || sha256(readFileSync(license)) !== fam.license.sha256) problems.push(`${fam.dir}/LICENSE does not match the manifest`);
    for (const face of fam.faces) {
      const rel = `${fam.dir}/${face.file}`;
      listed.add(rel);
      const path = join(FONTS_DIR, rel);
      if (!existsSync(path)) { problems.push(`missing ${rel}`); continue; }
      const buf = readFileSync(path);
      if (buf.length !== face.bytes || sha256(buf) !== face.sha256) problems.push(`${rel} does not match the manifest`);
    }
  }
  for (const d of readdirSync(FONTS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of readdirSync(join(FONTS_DIR, d.name))) if (!listed.has(`${d.name}/${f}`)) problems.push(`unlisted file ${d.name}/${f}`);
  }
  return problems;
}

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: { "User-Agent": NEXT_FONT_USER_AGENT } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** LICENSE (OFL text with the copyright notice) and the copyright line, from the pinned fontsource tarball. */
function readLicense(packsDir, lic, work) {
  const tgz = readFileSync(join(packsDir, lic.tgz));
  if (sha256(tgz) !== lic.tgzSha256) throw new Error(`${lic.tgz}: sha256 mismatch`);
  if (integrityOf(tgz) !== lic.integrity) throw new Error(`${lic.tgz}: integrity mismatch`);
  const dir = mkdtempSync(join(work, "pkg-"));
  execFileSync("tar", ["-xzf", join(packsDir, lic.tgz), "-C", dir, "package/LICENSE", "package/metadata.json"]);
  const meta = JSON.parse(readFileSync(join(dir, "package", "metadata.json"), "utf8"));
  if (meta.license?.type !== "OFL-1.1") throw new Error(`${lic.package}: not OFL-1.1`);
  const text = readFileSync(join(dir, "package", "LICENSE"), "utf8");
  if (!text.includes("SIL OPEN FONT LICENSE Version 1.1")) throw new Error(`${lic.package}: LICENSE has no OFL 1.1 text`);
  return { path: join(dir, "package", "LICENSE"), copyright: meta.license.attribution, sha256: sha256(readFileSync(join(dir, "package", "LICENSE"))) };
}

async function generate(packsDir) {
  const work = mkdtempSync(join(tmpdir(), "sr-demo-fonts-"));
  const manifest = {
    generator: "scripts/fonts/generate-demo-fonts.mjs",
    fonts: "Google Fonts CSS2 API, requested as next/font/google requests it; the woff2 subsets it lists, unmodified",
    license: "SIL Open Font License 1.1: each family's LICENSE (copyright notice and license text), from the pinned @fontsource package",
    families: [],
  };
  try {
    for (const fam of FAMILIES) {
      const license = readLicense(packsDir, fam.license, work);
      const css = (await fetchBuffer(fam.google)).toString("utf8");
      const parsed = parseGoogleCss(css);
      const out = join(FONTS_DIR, fam.dir);
      rmSync(out, { recursive: true, force: true });
      mkdirSync(out, { recursive: true });
      copyFileSync(license.path, join(out, "LICENSE"));
      const faces = [];
      for (const [i, f] of parsed.entries()) {
        if (f.family !== fam.family) throw new Error(`${fam.google}: unexpected family ${f.family}`);
        const buf = await fetchBuffer(f.url);
        const file = `${fam.dir}-${String(i).padStart(3, "0")}-${f.weight.replace(" ", "-")}-${f.style}.woff2`;
        writeFileSync(join(out, file), buf);
        faces.push({ file, weight: f.weight, style: f.style, stretch: f.stretch, unicodeRange: f.unicodeRange, subset: f.subset || null, preload: fam.preloadLatin && f.subset === "latin", bytes: buf.length, sha256: sha256(buf), source: f.url });
      }
      const { license: lic, preloadLatin, ...rest } = fam;
      void preloadLatin;
      manifest.families.push({ ...rest, license: { ...lic, sha256: license.sha256, copyright: license.copyright }, faces });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  writeFileSync(MANIFEST_PATH, formatManifest(manifest));
  writeFileSync(MODULE_PATH, renderModule(manifest));
  const files = manifest.families.flatMap((f) => f.faces);
  const bytes = files.reduce((s, f) => s + f.bytes, 0);
  console.log(`${files.length} woff2 files, ${(bytes / 1048576).toFixed(2)} MiB -> ${relative(REPO, FONTS_DIR)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf("--packs");
  if (i > 0 && process.argv[i + 1]) await generate(process.argv[i + 1]);
  else if (process.argv.includes("--check")) {
    const problems = checkCommitted();
    for (const p of problems) console.error(p);
    if (problems.length) process.exit(1);
    console.log("demo fonts: generated module and files match the manifest");
  } else {
    console.error("usage: generate-demo-fonts.mjs --packs <dir> | --check");
    process.exit(2);
  }
}
