import { describe, expect, it } from "vitest";
import {
  ARTIFACT_LIMITS,
  bundleSha256,
  checkFileBytes,
  hasImageMetadata,
  manifestNameToUrlPath,
  manifestRenders,
  photoUrlPaths,
  roleOfName,
  urlPathToManifestName,
  validateManifest,
  type ArtifactManifest,
  type ManifestFile,
} from "@/lib/sales/demo-artifact/manifest";
import { jpeg, sha, webp } from "./fixtures";

const html = new TextEncoder().encode("<!doctype html><title>x</title>");
const css = new TextEncoder().encode("body{color:#000}");
const photo = webp(800, 600);
const render = webp(1440, 4000);

const file = (name: string, role: ManifestFile["role"], bytes: Uint8Array, content_type: ManifestFile["content_type"], dims?: [number, number]): ManifestFile => ({
  name,
  role,
  sha256: sha(bytes),
  bytes: bytes.byteLength,
  content_type,
  ...(dims ? { width: dims[0], height: dims[1] } : {}),
});

const manifest = (): ArtifactManifest => ({
  version: 1,
  files: [
    file("page/index.html", "html", html, "text/html"),
    file("page/style.css", "css", css, "text/css"),
    file("page/photos/hero-desktop.webp", "photo", photo, "image/webp", [800, 600]),
    file("renders/desktop_1440.webp", "render", render, "image/webp", [1440, 4000]),
    file("renders/mobile_390.webp", "render", webp(390, 3000), "image/webp", [390, 3000]),
  ],
});

describe("URL path ↔ manifest name (§5.2)", () => {
  it("drops page/ for the page's files and keeps renders admin-only", () => {
    expect(urlPathToManifestName("a", "index.html")).toBe("page/index.html");
    expect(urlPathToManifestName("p", "index.html")).toBe("page/index.html");
    expect(urlPathToManifestName("p", "style.css")).toBe("page/style.css");
    expect(urlPathToManifestName("p", "photos/hero-desktop.webp")).toBe("page/photos/hero-desktop.webp");
    expect(urlPathToManifestName("a", "renders/desktop_1440.webp")).toBe("renders/desktop_1440.webp");
    expect(urlPathToManifestName("p", "renders/desktop_1440.webp")).toBeNull();
  });

  it.each([
    "page/index.html",
    "page/style.css",
    "../index.html",
    "photos/../index.html",
    "photos/%2e%2e/x.webp",
    "index.html?x=1",
    "Index.html",
    "photos/hero-desktop.png",
    "photos/hero-desktop.svg",
    "photos/hero.webp",
    "photos/a/b-mobile.webp",
    "renders/desktop_1440.png",
    "copy.json",
    "",
    "/index.html",
    "photos\\x-mobile.webp",
  ])("refuses %j (T11)", (p) => {
    expect(urlPathToManifestName("a", p)).toBeNull();
  });

  it("maps names back to URL paths", () => {
    expect(manifestNameToUrlPath("p", "page/photos/hero-mobile.jpg")).toBe("photos/hero-mobile.jpg");
    expect(manifestNameToUrlPath("p", "renders/mobile_390.webp")).toBeNull();
    expect(manifestNameToUrlPath("a", "renders/mobile_390.webp")).toBe("renders/mobile_390.webp");
    expect(manifestNameToUrlPath("a", "rights.private.json")).toBeNull();
  });

  it("knows only the §5.2 names", () => {
    expect(roleOfName("page/photos/a_b-tablet.jpg")).toEqual({ role: "photo", contentType: "image/jpeg" });
    for (const n of ["rights.private.json", "page/copy.json", "swap-manifest.json", ".intake/x.webp", "page/photos/x-mobile.svg", "renders/desktop_1440.png", "page/index.htm"]) expect(roleOfName(n)).toBeNull();
  });
});

describe("validateManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(validateManifest(manifest())).toEqual({ ok: true, manifest: manifest() });
  });

  it("refuses unknown keys, names outside §5.2, mismatched roles and types, duplicates", () => {
    expect(validateManifest({ ...manifest(), owner: "x" })).toEqual({ ok: false, codes: ["MANIFEST_SCHEMA"] });
    const m = manifest();
    m.files.push(file("rights.private.json", "html", html, "text/html"));
    expect(validateManifest(m)).toMatchObject({ ok: false, codes: expect.arrayContaining(["MANIFEST_NAME_NOT_ALLOWED"]) });
    const m2 = manifest();
    m2.files[2] = { ...m2.files[2]!, role: "render" };
    m2.files[3] = { ...m2.files[3]!, content_type: "image/jpeg" };
    m2.files.push(m2.files[0]!);
    const r = validateManifest(m2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codes).toEqual(expect.arrayContaining(["MANIFEST_ROLE_MISMATCH", "MANIFEST_CONTENT_TYPE_MISMATCH", "MANIFEST_DUPLICATE_NAME", "MANIFEST_HTML_COUNT"]));
  });

  it("needs exactly one HTML and one CSS, and dimensions on images only", () => {
    const m = manifest();
    m.files = m.files.filter((f) => f.role !== "css");
    m.files[1] = { ...m.files[1]!, width: undefined } as ManifestFile;
    delete (m.files[1] as Partial<ManifestFile>).width;
    m.files[0] = { ...m.files[0]!, width: 10, height: 10 };
    const r = validateManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.codes).toEqual(expect.arrayContaining(["MANIFEST_CSS_COUNT", "MANIFEST_IMAGE_DIMENSIONS_MISSING", "MANIFEST_DIMENSIONS_ON_TEXT"]));
  });

  it("applies the size limits (HTML 384KiB, CSS 256KiB, photo 2MB, file 4MiB, 40 files, 15MiB total)", () => {
    const m = manifest();
    m.files[0] = { ...m.files[0]!, bytes: ARTIFACT_LIMITS.htmlBytes + 1 };
    m.files[1] = { ...m.files[1]!, bytes: ARTIFACT_LIMITS.cssBytes + 1 };
    m.files[2] = { ...m.files[2]!, bytes: ARTIFACT_LIMITS.photoBytes + 1 };
    const r = validateManifest(m);
    expect(r).toEqual({ ok: false, codes: ["MANIFEST_FILE_TOO_LARGE"] });
    const big = manifest();
    big.files[3] = { ...big.files[3]!, bytes: ARTIFACT_LIMITS.fileBytes + 1 };
    expect(validateManifest(big)).toEqual({ ok: false, codes: ["MANIFEST_SCHEMA"] });
    const many = manifest();
    for (let i = 0; i < 6; i++) many.files.push({ ...file(`page/photos/p${i}-mobile.jpg`, "photo", photo, "image/jpeg", [1, 1]), bytes: ARTIFACT_LIMITS.photoBytes });
    many.files[3] = { ...many.files[3]!, bytes: ARTIFACT_LIMITS.fileBytes };
    many.files[4] = { ...many.files[4]!, bytes: ARTIFACT_LIMITS.fileBytes };
    expect(validateManifest(many)).toEqual({ ok: false, codes: ["MANIFEST_TOTAL_TOO_LARGE"] });
    const tooMany = { version: 1, files: Array.from({ length: 41 }, () => manifest().files[0]) };
    expect(validateManifest(tooMany)).toEqual({ ok: false, codes: ["MANIFEST_SCHEMA"] });
  });

  it("refuses non-objects", () => {
    for (const x of [null, 1, "x", [], { version: 1 }]) expect(validateManifest(x).ok).toBe(false);
  });
});

describe("bundleSha256", () => {
  it("is stable under file order and dimensions, and changes with any file's bytes", () => {
    const a = manifest();
    const b = { ...manifest(), files: [...manifest().files].reverse() };
    expect(bundleSha256(a)).toBe(bundleSha256(b));
    expect(bundleSha256(a)).toMatch(/^[0-9a-f]{64}$/);
    const c = manifest();
    c.files[1] = file("page/style.css", "css", new TextEncoder().encode("body{color:#111}"), "text/css");
    expect(bundleSha256(c)).not.toBe(bundleSha256(a));
  });
});

describe("renders and photos", () => {
  it("reports the required renders (PC 1440, SP 390)", () => {
    expect(manifestRenders(manifest())).toEqual({ present: ["desktop_1440", "mobile_390"], missingRequired: [] });
    const m = manifest();
    m.files = m.files.filter((f) => f.name !== "renders/mobile_390.webp");
    expect(manifestRenders(m).missingRequired).toEqual(["mobile_390"]);
    expect([...photoUrlPaths(manifest())]).toEqual(["photos/hero-desktop.webp"]);
  });
});

describe("checkFileBytes (T9・T10)", () => {
  it("accepts matching bytes", () => {
    const m = manifest();
    expect(checkFileBytes(m.files[0]!, html)).toEqual({ ok: true });
    expect(checkFileBytes(m.files[2]!, photo)).toEqual({ ok: true });
    const j = jpeg(640, 480);
    expect(checkFileBytes(file("page/photos/a-mobile.jpg", "photo", j, "image/jpeg", [640, 480]), j)).toEqual({ ok: true });
  });

  it("refuses a hash or size mismatch", () => {
    const r = checkFileBytes(manifest().files[0]!, new TextEncoder().encode("<p>other</p>"));
    expect(r).toEqual({ ok: false, codes: ["FILE_SIZE_MISMATCH", "FILE_HASH_MISMATCH"] });
  });

  it("refuses HTML pretending to be an image, a format mismatch and wrong dimensions", () => {
    const fake = new TextEncoder().encode("<script>alert(1)</script>");
    expect(checkFileBytes(file("page/photos/a-mobile.webp", "photo", fake, "image/webp", [1, 1]), fake)).toEqual({ ok: false, codes: ["FILE_NOT_AN_IMAGE"] });
    const j = jpeg(10, 10);
    expect(checkFileBytes(file("page/photos/a-mobile.webp", "photo", j, "image/webp", [10, 10]), j)).toEqual({ ok: false, codes: ["FILE_FORMAT_MISMATCH"] });
    expect(checkFileBytes(file("page/photos/a-mobile.webp", "photo", photo, "image/webp", [801, 600]), photo)).toEqual({ ok: false, codes: ["FILE_DIMENSIONS_MISMATCH"] });
    const huge = webp(5000, 10);
    expect(checkFileBytes(file("renders/desktop_1440.webp", "render", huge, "image/webp", [4096, 10]), huge).ok).toBe(false);
  });

  it("refuses invalid UTF-8 text and image metadata", () => {
    const bad = new Uint8Array([0x3c, 0xff, 0xfe, 0x3e]);
    expect(checkFileBytes(file("page/index.html", "html", bad, "text/html"), bad)).toEqual({ ok: false, codes: ["FILE_NOT_UTF8"] });
    const exif = jpeg(10, 10, { exif: true });
    expect(hasImageMetadata(exif)).toBe(true);
    expect(checkFileBytes(file("page/photos/a-mobile.jpg", "photo", exif, "image/jpeg", [10, 10]), exif)).toEqual({ ok: false, codes: ["FILE_IMAGE_METADATA"] });
    expect(hasImageMetadata(webp(10, 10, 0x08))).toBe(true);
    expect(hasImageMetadata(webp(10, 10, 0x04))).toBe(true);
    expect(hasImageMetadata(webp(10, 10))).toBe(false);
    expect(hasImageMetadata(jpeg(10, 10))).toBe(false);
  });
});
