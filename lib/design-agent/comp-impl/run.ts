/**
 * The comp-to-site PoC run (DEV-082, docs/operations/comp-to-site.md): loads a
 * comp bundle and a page Claude wrote from it, renders the page in Chromium
 * with the network shut, runs every check and writes report.json plus a
 * desktop (1440) and a mobile (390) full-page screenshot to a new directory
 * outside the repository (0700 / 0600). Local only; no Codex, no model call,
 * no network, no database, nothing published.
 *
 * The report never claims a faithful reproduction: `fidelity_status` is
 * synthetic_only for a synthetic comp and real_comp_unverified for a real one
 * (a person compares the screenshots with the comp), and the similarity metric
 * never passes.
 */
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Browser } from "playwright";
import { factStrings } from "../compare/shops";
import { assetStoreRoot } from "../assets/store-root";
import { antiTemplateCheck, templateCss, type AntiTemplateResult, type ReferenceFingerprint } from "./anti-template";
import { CompImplError, loadCompBundle, type CompBundle } from "./bundle";
import {
  disclosureCheck,
  domProblems,
  factsCheck,
  geometryCheck,
  imagesCheck,
  legibilityCheck,
  linksCheck,
  pairsCheck,
  structureCheck,
  sweepCheck,
  mobileOrderCheck,
  overflowCheck,
  paletteCheck,
  requiredDisclosure,
  spacingCheck,
  textCheck,
  typeCheck,
  type CheckResult,
} from "./checks";
import { cssProblems, htmlSourceProblems, loadCompPage, type CompPage } from "./page";
import { FingerprintSchema } from "./page-scripts";
import { factValues } from "./spec";
import { compMeasure, DESKTOP, domAudit, fingerprintOf, fullPageShot, inBatches, legibilityPass, legibilitySweep, MOBILE, openCompPage, overflowSweep, pageWidths, type Viewport } from "./render";
import { compSimilarity, type Similarity } from "./similarity";

export const REPORT_SCHEMA = "comp-impl-report/1";
export const REFERENCES_PATH = "lib/design-agent/comp-impl/template-fingerprints.json";
export const FIDELITY_STATUSES = ["synthetic_only", "real_comp_unverified"] as const;

export type CompImplReport = {
  schema: typeof REPORT_SCHEMA;
  /** synthetic_only: a test comp; real_comp_unverified: a real comp, the likeness still needs a person. Never "faithful". */
  fidelity_status: (typeof FIDELITY_STATUSES)[number];
  faithful_reproduction_claimed: false;
  /** Every mechanical check passed (facts, disclosure, layout spec, soundness, anti-template). Not a design verdict. */
  mechanical_ok: boolean;
  failed: string[];
  bundle: { shop: string; comp_sha256: string; comp_kind: string; comp_approved: boolean; width: number; height: number; direction_version: string; eval_total: number | null; eval_human_confirmed: boolean };
  page: { html_sha256: string; css_sha256: string; assets: number; ai_assets: number; network_blocked: number };
  checks: Record<string, CheckResult>;
  anti_template: AntiTemplateResult;
  similarity: Similarity;
  screenshots: { desktop: string; mobile: string; desktop_px: [number, number]; mobile_css_px: [number, number] };
  notes: string[];
};

export type RunOptions = {
  bundleDir: string;
  pageDir: string;
  repoDir: string;
  factsSourcePath: string;
  browser: Browser;
  /** Reference fingerprints (default: the committed file). */
  references?: readonly ReferenceFingerprint[];
  pngLimits?: Parameters<typeof loadCompBundle>[1]["pngLimits"];
};

export type RunResult = { report: CompImplReport; desktop: Buffer; mobile: Buffer };

export async function loadReferences(repoDir: string): Promise<ReferenceFingerprint[]> {
  const raw = JSON.parse(await readFile(join(repoDir, REFERENCES_PATH), "utf8")) as { references: Array<{ id: string; fingerprint: unknown }> };
  return raw.references.map((r) => ({ id: String(r.id), fingerprint: FingerprintSchema.parse(r.fingerprint) }));
}

type AtWidth = { measure: Awaited<ReturnType<typeof compMeasure>>; shot: Buffer; blocked: number; dom?: CheckResult };

async function atViewport(browser: Browser, page: CompPage, v: Viewport, audit: boolean): Promise<AtWidth> {
  const a = await openCompPage(browser, page, v);
  try {
    const dom = audit ? domProblems(await domAudit(a.page)) : undefined;
    const measure = await compMeasure(a.page);
    const shot = await fullPageShot(a.page);
    return { measure, shot, blocked: a.blocked(), ...(dom ? { dom } : {}) };
  } finally {
    await a.context.close();
  }
}

/** Runs every check; throws CompImplError (a fixed code) when the bundle or the page is refused. */
export async function runCompImpl(o: RunOptions): Promise<RunResult> {
  const bundle: CompBundle = await loadCompBundle(o.bundleDir, { repoDir: o.repoDir, factsSourcePath: o.factsSourcePath, ...(o.pngLimits ? { pngLimits: o.pngLimits } : {}) });
  const page = await loadCompPage(o.pageDir);
  const source = [...htmlSourceProblems(page.html), ...cssProblems(page.css)];
  // a page whose source is refused is never rendered
  if (source.length > 0) throw Object.assign(new CompImplError("PAGE_SOURCE_REFUSED"), { problems: source });
  const references = o.references ?? (await loadReferences(o.repoDir));
  const facts = factStrings(bundle.demo).map((f) => f.text.replace(/\s+/g, ""));
  const spec = bundle.spec;

  const desktop = await atViewport(o.browser, page, DESKTOP, true);
  const mobile = await atViewport(o.browser, page, MOBILE, false);
  const widths = pageWidths(page.css);
  const sweep = await overflowSweep(o.browser, page, widths);
  const values = factValues(bundle.demo);
  const required = spec.required_facts.map((k) => (values.get(k) ?? "").replace(/\s+/g, ""));
  const fingerprint = await fingerprintOf(o.browser, page.html);
  const disclosure = requiredDisclosure(page.assets, desktop.measure);
  const factsInput = { spec, demo: bundle.demo, disclosure };
  const passes = await inBatches(widths, (width) => legibilityPass(o.browser, page, width, facts, required));
  const sweepRun = await legibilitySweep(o.browser, page, facts, required);
  const blocked = desktop.blocked + mobile.blocked + sweep.reduce((s, w) => s + w.blocked, 0) + passes.reduce((s, p) => s + p.blocked, 0) + sweepRun.blocked;

  const checks: Record<string, CheckResult> = {
    source: { ok: true, codes: [] },
    network: { ok: blocked === 0, codes: blocked === 0 ? [] : ["NETWORK_REQUEST_BLOCKED"], blocked },
    dom: desktop.dom!,
    facts_desktop: factsCheck(desktop.measure, factsInput),
    facts_mobile: factsCheck(mobile.measure, factsInput),
    disclosure_desktop: disclosureCheck(desktop.measure, spec, disclosure),
    disclosure_mobile: disclosureCheck(mobile.measure, spec, requiredDisclosure(page.assets, mobile.measure)),
    geometry_desktop: geometryCheck(desktop.measure, spec),
    order_mobile: mobileOrderCheck(mobile.measure, spec),
    palette: paletteCheck(desktop.measure, spec),
    palette_mobile: paletteCheck(mobile.measure, spec),
    type_desktop: typeCheck(desktop.measure, spec, { desktop: true }),
    type_mobile: typeCheck(mobile.measure, spec, { desktop: false }),
    spacing_desktop: spacingCheck(desktop.measure, spec),
    links: linksCheck(desktop.measure, spec),
    images_desktop: imagesCheck(desktop.measure, spec, page.assets),
    images_mobile: imagesCheck(mobile.measure, spec, page.assets),
    overflow: overflowCheck(sweep),
    ...Object.fromEntries(passes.flatMap((p) => [
      [`text_${p.width}`, textCheck(p.measure)],
      [`legibility_${p.width}`, legibilityCheck(p, { required, disclosure })],
      [`pairs_${p.width}`, pairsCheck(p.pairs)],
    ])),
    structure_desktop: structureCheck(desktop.measure),
    structure_mobile: structureCheck(mobile.measure),
    legibility_sweep: sweepCheck(sweepRun.widths, { required, disclosure }),
  };
  const anti = antiTemplateCheck({ html: page.html, css: page.css, fingerprint, references, templateCss: await templateCss(o.repoDir) });
  const similarity = compSimilarity(bundle.comp, bundle.compApproved, { bytes: desktop.shot, width: desktop.measure.width, height: desktop.measure.height });
  const failed = [...Object.entries(checks).filter(([, c]) => !c.ok).map(([k]) => k), ...(anti.ok ? [] : ["anti_template"])];
  const synthetic = bundle.comp.kind === "synthetic";
  const report: CompImplReport = {
    schema: REPORT_SCHEMA,
    fidelity_status: synthetic ? "synthetic_only" : "real_comp_unverified",
    faithful_reproduction_claimed: false,
    mechanical_ok: failed.length === 0,
    failed,
    bundle: {
      shop: bundle.shopKey,
      comp_sha256: bundle.comp.sha256,
      comp_kind: bundle.comp.kind,
      comp_approved: bundle.compApproved,
      width: bundle.comp.width,
      height: bundle.comp.height,
      direction_version: bundle.directionVersion,
      eval_total: bundle.evaluation.total,
      eval_human_confirmed: bundle.evaluation.human_confirmed,
    },
    page: { html_sha256: page.htmlSha256, css_sha256: page.cssSha256, assets: page.assets.length, ai_assets: page.assets.filter((a) => a.kind === "ai_concept_local").length, network_blocked: blocked },
    checks,
    anti_template: anti,
    similarity,
    screenshots: { desktop: "desktop.png", mobile: "mobile.png", desktop_px: [desktop.measure.width, desktop.measure.height], mobile_css_px: [mobile.measure.width, mobile.measure.height] },
    notes: [
      synthetic
        ? "SYNTHETIC COMP: the comp and the page were both made by hand for this PoC. Passing checks show the harness works; they say nothing about reproducing a real Codex comp."
        : "Real comp: the mechanical checks passed or failed as listed; whether the page reproduces the comp is for a person to judge from the screenshots next to the comp.",
      "Similarity is reported, never a pass.",
      "Facts come from the facts source of truth only; the comp's text was not read.",
      "Nothing here is published; AI concept images (if any) are local-preview only.",
    ],
  };
  return { report, desktop: desktop.shot, mobile: mobile.shot };
}

const inside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

async function writeNew(path: string, data: string | Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

/** The real path a (possibly missing) path would have: the nearest existing ancestor resolved, the rest appended. */
async function resolvedPath(path: string): Promise<string> {
  const rest: string[] = [];
  let at = resolve(path);
  for (;;) {
    try {
      return join(await realpath(at), ...rest.reverse());
    } catch {
      const parent = dirname(at);
      if (parent === at) return resolve(path);
      rest.push(basename(at));
      at = parent;
    }
  }
}

/** An existing output root must be this user's own private directory: a real directory (no link), owned by us, mode 0700. */
async function privateDirectory(path: string): Promise<boolean> {
  const info = await lstat(path);
  const uid = process.getuid?.();
  return info.isDirectory() && !info.isSymbolicLink() && (uid === undefined || info.uid === uid) && (info.mode & 0o777) === 0o700;
}

/**
 * Writes the outputs to a new <shop>-XXXXXX directory under outRoot (0700,
 * files 0600, never overwriting). The root must be absolute and outside the
 * repository, the asset store and the bundle / page directories — checked on
 * its resolved path BEFORE anything is created. The root is created alone
 * (not recursively): EEXIST means it already existed, and then it is used only
 * when it is already this user's private directory (it is never chmod-ed); a
 * root created here is set to 0700 through its own descriptor.
 */
export async function writeCompImplOutputs(outRoot: string, result: RunResult, o: { repoDir: string; env: Record<string, string | undefined>; inputs: string[] }): Promise<string> {
  if (!isAbsolute(outRoot)) throw new CompImplError("OUTPUT_UNSAFE");
  const root = await resolvedPath(outRoot);
  const forbidden = [o.repoDir, assetStoreRoot(o.env), ...o.inputs];
  for (const f of forbidden) {
    const real = await resolvedPath(f);
    if (inside(root, real) || inside(real, root)) throw new CompImplError("OUTPUT_UNSAFE");
  }
  // the parents may be created; the root itself is created alone, so an existing one (EEXIST) is never adopted unchecked
  await mkdir(dirname(outRoot), { recursive: true, mode: 0o700 });
  let created = true;
  try {
    await mkdir(outRoot, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    created = false;
  }
  if (created) {
    // the umask may have taken bits away: chmod through a descriptor of this very directory, never the path
    const handle = await open(outRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
  }
  // an existing root (or one swapped in meanwhile) must already be this user's private directory; it is never chmod-ed
  if (!(await privateDirectory(outRoot))) throw new CompImplError("OUTPUT_UNSAFE");
  if ((await realpath(outRoot)) !== root) throw new CompImplError("OUTPUT_UNSAFE"); // changed under us
  const dest = await mkdtemp(join(root, `${result.report.bundle.shop}-`)); // mkdtemp creates 0700
  await writeNew(join(dest, "report.json"), `${JSON.stringify(result.report, null, 2)}\n`);
  await writeNew(join(dest, "desktop.png"), result.desktop);
  await writeNew(join(dest, "mobile.png"), result.mobile);
  return dest;
}
