/**
 * DEV-303 §6.1 change 7 (docs/design/image-first-production-flow.md §1 stage 5, MVP_SPEC §7.1 limited revision): the
 * implemented static site may show only the owner-approved image materials (materials-approval.ts approvedMaterials),
 * matched by SHA-256. OFFLINE and READ-ONLY: no browser, no network, nothing written anywhere.
 *
 * The site folder is outside the repository (links resolved; no link anywhere inside it). Every file is walked:
 *  - a picture (by name: png / jpg / jpeg / webp / gif / avif / bmp / svg / ico / tif / tiff / heic, or by its first
 *    bytes: PNG, JPEG, GIF, WebP, AVIF/HEIC) must sit directly in assets/ and its bytes' SHA-256 must be an approved
 *    material's (MATERIALS_IMPL_IMAGE_OUTSIDE_ASSETS / MATERIALS_IMPL_IMAGE_NOT_APPROVED). A converted, resized or
 *    re-encoded copy has another SHA-256 and is refused: the approved file is used as it is;
 *  - index.html and style.css: every <img src>, <img srcset>, <source srcset> and CSS url() must name such an approved
 *    file in assets/ (MATERIALS_IMPL_IMAGE_REF_NOT_APPROVED); an http(s) or protocol-relative URL is
 *    MATERIALS_IMPL_EXTERNAL_IMAGE (a data: or other scheme is not approved either). A url() in any other attribute
 *    (an SVG mask, fill, filter …) is MATERIALS_IMPL_IMAGE_IN_ATTRIBUTE, so every use of a material is counted. The demo version's own HTML/CSS
 *    check (lib/sales/demo-version/html-safety.ts checkArtifactHtml, with the approved files as its only pictures) runs
 *    as well, fail closed: any finding of it is MATERIALS_IMPL_HTML_UNSAFE (with its code), so nothing it would refuse
 *    — a style element, a script, an unlisted element, another stylesheet — can carry a picture past this check;
 *  - the §7.1 label: each <img> showing an approved material must sit in a <figure> whose <figcaption> contains
 *    「イメージ」 (MATERIALS_IMPL_LABEL_MISSING), and neither the figcaption nor the figure or an ancestor carries
 *    `hidden` or aria-hidden="true" (CSS that hides it is not checked). A material used from CSS (a background or a decoration) is reported as
 *    `label: "not_checked"`: whether its frame says イメージ where it is a photo frame needs the reviewer's eye.
 *    NOT checked here: that the frame is a simple (rounded) rectangle that can be replaced (§7.1 condition 5), the
 *    「提案用デモ」 notice (condition 4), and what the picture shows (the materials review).
 *
 * Input problems (a missing, linked, in-repository, incomplete or too large site) throw MaterialsImplStop. Problems in
 * the site are collected: the result is "refused" with every problem, or "ok". Codes are fixed (no path or content
 * beyond the site-relative file names and URLs, which are the implementer's own).
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { checkArtifactHtml } from "@/lib/sales/demo-version/html-safety";
import { cssUrls, decodeEscapes } from "@/lib/sales/demo-version/rule-core";
import type { ApprovedMaterials } from "./materials-approval";

export const MATERIALS_IMPL_LIMITS = { html: 384 * 1024, css: 256 * 1024, file: 16 * 1024 * 1024, files: 500, depth: 6, total: 64 * 1024 * 1024 } as const;
export const IMAGE_LABEL = "イメージ";

export const MATERIALS_IMPL_STOPS = ["MATERIALS_IMPL_SITE_MISSING", "MATERIALS_IMPL_SITE_IN_REPO", "MATERIALS_IMPL_SITE_UNSAFE", "MATERIALS_IMPL_SITE_INVALID", "MATERIALS_IMPL_SITE_TOO_LARGE"] as const;
export const MATERIALS_IMPL_PROBLEMS = [
  "MATERIALS_IMPL_IMAGE_NOT_APPROVED",
  "MATERIALS_IMPL_IMAGE_OUTSIDE_ASSETS",
  "MATERIALS_IMPL_IMAGE_REF_NOT_APPROVED",
  "MATERIALS_IMPL_EXTERNAL_IMAGE",
  "MATERIALS_IMPL_IMAGE_IN_ATTRIBUTE",
  "MATERIALS_IMPL_LABEL_MISSING",
  "MATERIALS_IMPL_HTML_UNSAFE",
] as const;
export type MaterialsImplProblem = { code: (typeof MATERIALS_IMPL_PROBLEMS)[number]; detail: string };

export class MaterialsImplStop extends Error {
  constructor(readonly code: (typeof MATERIALS_IMPL_STOPS)[number]) {
    super(code);
    this.name = "MaterialsImplStop";
  }
}
const stop = (code: (typeof MATERIALS_IMPL_STOPS)[number]): never => {
  throw new MaterialsImplStop(code);
};

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const within = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const IMAGE_NAME = /\.(png|jpe?g|webp|gif|avif|bmp|svg|ico|tiff?|heic)$/i;
function imageBytes(b: Buffer): boolean {
  const at = (s: string, o = 0) => b.length >= o + s.length && b.subarray(o, o + s.length).toString("latin1") === s;
  return at("\x89PNG") || (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || at("GIF8") || (at("RIFF") && at("WEBP", 8)) || at("ftyp", 4);
}

async function readNoFollow(path: string, max: number): Promise<Buffer> {
  let h;
  try {
    h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return stop("MATERIALS_IMPL_SITE_UNSAFE");
  }
  try {
    const st = await h.stat();
    // review L3: a hard link is refused too (as the private records are): every file is the site's own
    if (!st.isFile() || st.nlink !== 1) stop("MATERIALS_IMPL_SITE_UNSAFE");
    if (st.size > max) stop("MATERIALS_IMPL_SITE_TOO_LARGE");
    const b = await h.readFile();
    if (b.length > max) stop("MATERIALS_IMPL_SITE_TOO_LARGE");
    return b;
  } finally {
    await h.close();
  }
}

type SiteFile = { path: string; bytes: Buffer };

/** Every file of the site (site-relative paths with "/"): no link, no special file, within the limits. */
async function walkSite(dir: string): Promise<SiteFile[]> {
  const out: SiteFile[] = [];
  let total = 0;
  const visit = async (rel: string, depth: number): Promise<void> => {
    if (depth > MATERIALS_IMPL_LIMITS.depth) stop("MATERIALS_IMPL_SITE_TOO_LARGE");
    const entries = await readdir(join(dir, rel), { withFileTypes: true });
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) stop("MATERIALS_IMPL_SITE_UNSAFE");
      if (e.isDirectory()) {
        await visit(path, depth + 1);
        continue;
      }
      if (!e.isFile()) stop("MATERIALS_IMPL_SITE_UNSAFE");
      if (out.length >= MATERIALS_IMPL_LIMITS.files) stop("MATERIALS_IMPL_SITE_TOO_LARGE");
      const max = path === "index.html" ? MATERIALS_IMPL_LIMITS.html : path === "style.css" ? MATERIALS_IMPL_LIMITS.css : MATERIALS_IMPL_LIMITS.file;
      const bytes = await readNoFollow(join(dir, path), max);
      total += bytes.length;
      if (total > MATERIALS_IMPL_LIMITS.total) stop("MATERIALS_IMPL_SITE_TOO_LARGE");
      out.push({ path, bytes });
    }
  };
  await visit("", 0);
  return out;
}

type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;
const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value;
const children = (n: Node): Node[] => ("childNodes" in n ? (n as DefaultTreeAdapterTypes.ParentNode).childNodes : []);
/** A hidden element (the `hidden` attribute or aria-hidden="true") shows no text. */
const isHidden = (n: Node) => "tagName" in n && (attr(n as Element, "hidden") !== undefined || attr(n as Element, "aria-hidden")?.trim().toLowerCase() === "true");
/** The text a reader sees: hidden descendants are skipped (#350 review Low: <figcaption><span hidden>イメージ</span></figcaption> is no label). */
const textOf = (n: Node): string => (n.nodeName === "#text" ? (n as DefaultTreeAdapterTypes.TextNode).value : isHidden(n) ? "" : children(n).map(textOf).join(""));
const srcsetUrls = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim().split(/[\t\n\f\r ]+/)[0] ?? "")
    .filter(Boolean);

export type MaterialUse = { id: string; file: string; sha256: string; asset: string; via: ("img" | "css")[]; label: "present" | "missing" | "not_checked" };
export type MaterialsImplResult = {
  status: "ok" | "refused";
  materials_request_id: string;
  materials_approval_sha256: string;
  site_files: { path: string; sha256: string; bytes: number }[];
  used: MaterialUse[];
  unused: { id: string; file: string; sha256: string }[];
  problems: MaterialsImplProblem[];
  not_checked: string[];
};

export const NOT_CHECKED = [
  "whether a material used from CSS is shown with イメージ where it is a photo frame (the reviewer looks)",
  "that each picture frame is a simple (rounded) rectangle that can be replaced (MVP_SPEC §7.1 condition 5)",
  "the 提案用デモ notice (condition 4) and what the pictures show (the materials review)",
  "whether CSS hides a figcaption or its picture (display, visibility, opacity, clipping): only the hidden and aria-hidden attributes are checked",
];

/** The site against the approved materials. Throws MaterialsImplStop for input problems; never writes. */
export async function checkMaterialsInSite(o: { approved: ApprovedMaterials; siteDir: string; repo: string }): Promise<MaterialsImplResult> {
  const dir = resolve(o.siteDir);
  const real = await realpath(dir).catch(() => null);
  if (real === null) return stop("MATERIALS_IMPL_SITE_MISSING");
  const realRepo = await realpath(o.repo).catch(() => resolve(o.repo));
  if (within(real, realRepo) || within(dir, resolve(o.repo))) stop("MATERIALS_IMPL_SITE_IN_REPO");
  if (real !== dir) stop("MATERIALS_IMPL_SITE_UNSAFE");
  let dh;
  try {
    dh = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    return stop("MATERIALS_IMPL_SITE_INVALID");
  }
  await dh.close();
  const files = await walkSite(dir);
  const html = files.find((f) => f.path === "index.html");
  const css = files.find((f) => f.path === "style.css");
  if (!html || !css) return stop("MATERIALS_IMPL_SITE_INVALID");

  const problems: MaterialsImplProblem[] = [];
  const add = (code: MaterialsImplProblem["code"], detail: string) => {
    if (!problems.some((p) => p.code === code && p.detail === detail)) problems.push({ code, detail });
  };
  const bySha = new Map(o.approved.materials.map((m) => [m.sha256, m]));
  // the approved pictures present in assets/: their page path -> the material
  const assets = new Map<string, ApprovedMaterials["materials"][number]>();
  for (const f of files) {
    if (!IMAGE_NAME.test(f.path) && !imageBytes(f.bytes)) continue;
    if (!/^assets\/[^/]+$/.test(f.path)) {
      add("MATERIALS_IMPL_IMAGE_OUTSIDE_ASSETS", f.path);
      continue;
    }
    const m = bySha.get(sha256(f.bytes));
    if (!m) add("MATERIALS_IMPL_IMAGE_NOT_APPROVED", f.path);
    else assets.set(f.path, m);
  }

  const htmlText = html.bytes.toString("utf8");
  const cssText = css.bytes.toString("utf8");
  const via = new Map<string, Set<"img" | "css">>();
  const label = new Map<string, boolean>();
  const ref = (url: string, from: "img" | "css"): string | null => {
    if (/^#[A-Za-z0-9_-]+$/.test(url) && from === "css") return null;
    if (/^(?:https?:)?\/\//i.test(url)) return (add("MATERIALS_IMPL_EXTERNAL_IMAGE", url), null);
    const path = url.replace(/^\.\//, "");
    if (!assets.has(path)) return (add("MATERIALS_IMPL_IMAGE_REF_NOT_APPROVED", url), null);
    (via.get(path) ?? via.set(path, new Set()).get(path)!).add(from);
    return path;
  };
  const hiddenAttr = (el: Element) => isHidden(el);
  // the HTML: every picture element, with the figure / figcaption around an <img>, and whether an ancestor is hidden
  const stack: { node: Node; figure: Element | null; hidden: boolean }[] = [{ node: parse(htmlText), figure: null, hidden: false }];
  while (stack.length) {
    const { node, figure, hidden: hiddenAbove } = stack.pop()!;
    let hidden = hiddenAbove;
    let fig = figure;
    if ("tagName" in node) {
      const el = node as Element;
      if (hiddenAttr(el)) hidden = true;
      if (el.tagName === "figure") fig = el;
      // review M1: a picture may come only from <img src / srcset> and <source srcset>; a url() in any other attribute
      // (an SVG mask, fill, filter …) is refused, so every use of a material is counted and labelled
      for (const a of el.attrs) {
        if ((el.tagName === "img" && (a.name === "src" || a.name === "srcset")) || (el.tagName === "source" && a.name === "srcset")) continue;
        for (const u of cssUrls(decodeEscapes(a.value))) if (!/^#[A-Za-z0-9_-]+$/.test(u)) add("MATERIALS_IMPL_IMAGE_IN_ATTRIBUTE", `${el.tagName} ${a.name}: ${u}`);
      }
      if (el.tagName === "img" || el.tagName === "source") {
        const urls = [...(el.tagName === "img" && attr(el, "src") !== undefined ? [attr(el, "src")!.trim()] : []), ...srcsetUrls(attr(el, "srcset") ?? "")];
        for (const u of urls) {
          const path = ref(u, "img");
          if (path === null) continue;
          const caption = fig ? children(fig).find((c) => c.nodeName === "figcaption") : undefined;
          // review L1: a hidden figcaption, or a hidden figure or ancestor, shows no label
          const labelled = !!caption && !hidden && !hiddenAttr(caption as Element) && textOf(caption).includes(IMAGE_LABEL);
          label.set(path, (label.get(path) ?? true) && labelled);
          if (!labelled) add("MATERIALS_IMPL_LABEL_MISSING", u);
        }
      }
      if (el.tagName === "template") stack.push({ node: (el as DefaultTreeAdapterTypes.Template).content, figure: fig, hidden });
    }
    for (const c of children(node)) stack.push({ node: c, figure: fig, hidden });
  }
  for (const u of cssUrls(decodeEscapes(cssText))) ref(u, "css");
  // the demo version's own check, fail closed (the approved files are its only pictures)
  const safety = checkArtifactHtml(htmlText, cssText, new Set(assets.keys()));
  for (const f of safety.findings) add("MATERIALS_IMPL_HTML_UNSAFE", f.code);

  const used: MaterialUse[] = [...via.entries()]
    .map(([asset, v]) => {
      const m = assets.get(asset)!;
      const ways = [...v].sort();
      return { id: m.id, file: m.file, sha256: m.sha256, asset, via: ways, label: label.has(asset) ? (label.get(asset) ? ("present" as const) : ("missing" as const)) : ("not_checked" as const) };
    })
    .sort((a, b) => (a.asset < b.asset ? -1 : 1));
  const usedSha = new Set(used.map((u) => u.sha256));
  return {
    status: problems.length === 0 ? "ok" : "refused",
    materials_request_id: o.approved.request_id,
    materials_approval_sha256: o.approved.approval_sha256,
    site_files: files.map((f) => ({ path: f.path, sha256: sha256(f.bytes), bytes: f.bytes.length })),
    used,
    unused: o.approved.materials.filter((m) => !usedSha.has(m.sha256)).map((m) => ({ id: m.id, file: m.file, sha256: m.sha256 })),
    problems,
    not_checked: NOT_CHECKED,
  };
}
