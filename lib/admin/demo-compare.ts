import "server-only";
/**
 * DEV-196d-4 (spec §4.1・§7.2・§7.5): what the admin compare page shows for two versions of one shop's demo.
 *
 *  - which two: `b` is the candidate (asked for, else the newest version); `a` is the base (asked for, else the
 *    demo's approved version, else the candidate's parent — compare.ts defaultBaseVersion). Only this demo's versions.
 *  - meta (hashes changed, facts changed, worker commit, validator codes, rights counts), files (added / removed /
 *    changed by sha256), structure descriptors (8 aspects, vocabulary words only): from the rows the admin's session
 *    read (lib/admin/demo-versions.ts).
 *  - the visible text of each version's page, line by line: read on the server from the private bucket (service role,
 *    spec §5.1・§6.8: only the server reads Storage), and only for a version the view model says is previewable now
 *    (not revoked, not expired, every photo's rights usable) of a demo that is not disabled, after the page's flag and
 *    admin checks. The bytes are checked against the manifest (size, sha256, UTF-8) before a word is used, and only
 *    the page's own visible text is passed on — what the admin already sees in the frame.
 *
 * DEV-196p: when BOTH versions have a copy record stored with them (DEV-199e: sales_demo_version_copy_links ->
 * sales_demo_copy_reviews, read through the admin's session), each line's kind comes from that record
 * (copy-lines.ts: fact / creative heading / unknown) and the server's copy check is re-run on the stored record, facts
 * pack and the page's texts, per side. Otherwise (a side has no stored record, or it cannot be read) the old rule
 * stays: a line is "fact" when it equals one of the shop's stored facts, every other line is "unknown", and no line is
 * ever called creative.
 *
 * Review of #249: a page whose HTML does not pass the server's own check (checkArtifactHtml) gives no text at all;
 * only the VISIBLE BODY TEXT is used (no <head> / <title>, no svg title / desc, nothing under [hidden], no script /
 * style / template / noscript / comments, no attribute text); the read is capped at the HTML size limit before and
 * after downloading; and a line holding an email address is replaced by the hidden label and never marked a fact.
 */
import type { DemoVersionsPage } from "@/lib/admin/demo-versions";
import { supabaseFrameStore } from "@/lib/demo-frame/store";
import type { FrameStore } from "@/lib/demo-frame/serve";
import { createAuthClient } from "@/lib/supabase/server";
import { classifyByCopyRecord, type CopyRecordCheck, type StoredCopyBasis } from "@/lib/sales/demo-version/copy-lines";
import { compareVersionMeta, defaultBaseVersion, diffLines, diffManifests, diffStructure, type CopyLine, type LineDiffResult, type StructureDiffEntry, type VersionMetaDiff, type FileDiffEntry, type FileChange } from "@/lib/sales/demo-version/compare";
import type { DefaultTreeAdapterTypes } from "parse5";
import { containsEmail, HIDDEN_EMAIL_LABEL } from "@/lib/sales/demo-version/admin-messages";
import { boundedParse } from "@/lib/sales/demo-version/bounded-parse";
import { OpBudget } from "@/lib/sales/demo-version/budget";
import { checkArtifactHtml, trimAsciiWs } from "@/lib/sales/demo-version/html-safety";
import { ARTIFACT_LIMITS, checkFileBytes, HTML_NAME, type ArtifactManifest, type ArtifactRole, type ArtifactContentType } from "@/lib/sales/demo-version/manifest";
import type { VersionFileDb, VersionRowDb, VersionView } from "@/lib/sales/demo-version/view-model";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** DEV-196p: what each side's stored copy record said. */
export type CopyRecordSide = { state: "checked"; check: CopyRecordCheck } | { state: "missing" } | { state: "unreadable" };

export type CopyDiff =
  | { kind: "ok"; result: LineDiffResult; basis: "copy_record" | "facts"; records: { a: CopyRecordSide; b: CopyRecordSide } }
  /** a side's page could not be read (no storage, not previewable, bytes not the manifest's) */
  | { kind: "unavailable"; side: "a" | "b" | "both" };

export type CompareData =
  | { kind: "no_candidate" }
  | { kind: "no_base"; b: VersionView; choices: VersionView[] }
  | {
      kind: "ok";
      a: VersionView;
      b: VersionView;
      choices: VersionView[];
      meta: VersionMetaDiff;
      files: { entries: FileDiffEntry[]; counts: Record<FileChange, number> };
      structure: StructureDiffEntry[];
      copy: CopyDiff;
    };

/** The manifest shape diffManifests needs, from the normalised file rows. */
function manifestOf(files: readonly VersionFileDb[]): ArtifactManifest {
  return {
    version: 1,
    files: files.map((f) => ({ name: f.path, role: f.role as ArtifactRole, sha256: f.sha256, bytes: f.bytes, content_type: f.content_type as ArtifactContentType })),
  };
}

/** The shop's stored fact values (the same fields the facts panel shows), for marking fact lines. Never one holding an email. */
export function factValues(content: unknown): Set<string> {
  const c = content && typeof content === "object" && !Array.isArray(content) ? (content as Record<string, unknown>) : {};
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim() && !containsEmail(v)) out.add(v.trim());
  };
  for (const k of ["name", "ward", "address", "hours", "closed_days", "access", "phone", "description"]) add(c[k]);
  if (Array.isArray(c.menu_items)) for (const m of c.menu_items) add(m);
  return out;
}

/** Lines for the diff: an email-holding line becomes the hidden label (never shown, never a fact). */
export function copyLines(texts: readonly string[], facts: ReadonlySet<string>): CopyLine[] {
  return texts.map((text) => (containsEmail(text) ? { text: HIDDEN_EMAIL_LABEL, kind: "unknown" } : { text, kind: facts.has(text) ? "fact" : "unknown" }));
}

const SKIPPED = new Set(["head", "title", "desc", "script", "style", "template", "noscript"]);

/**
 * The text a reader sees in the page's <body>, in document order: text nodes only, skipping head / title (also svg
 * title), svg desc, script / style / template / noscript, comments and every element with a `hidden` attribute.
 * Bounded by the same parser limits and operation budget as the server's HTML check. null when it cannot be parsed.
 */
export function visibleBodyText(html: string): string[] | null {
  const parsed = boundedParse(html, new OpBudget());
  if (!parsed.ok) return null;
  type Node = DefaultTreeAdapterTypes.ChildNode | DefaultTreeAdapterTypes.Document;
  const htmlEl = parsed.document.childNodes.find((n) => n.nodeName === "html") as DefaultTreeAdapterTypes.Element | undefined;
  const body = htmlEl?.childNodes.find((n) => n.nodeName === "body");
  if (!body) return [];
  const out: string[] = [];
  const stack: Node[] = [body];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.nodeName === "#text") {
      const t = trimAsciiWs((node as DefaultTreeAdapterTypes.TextNode).value).trim();
      if (t) out.push(t);
      continue;
    }
    if (!("tagName" in node)) {
      if (node.nodeName === "#document" && "childNodes" in node) for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]!);
      continue; // comments and other non-elements
    }
    const el = node as DefaultTreeAdapterTypes.Element;
    if (SKIPPED.has(el.tagName.toLowerCase()) || el.attrs.some((a) => a.name.toLowerCase() === "hidden")) continue;
    for (let i = el.childNodes.length - 1; i >= 0; i--) stack.push(el.childNodes[i]!);
  }
  return out;
}

/** The visible text lines of one version's page (and the HTML check's texts), or null. Never throws. */
async function pageTexts(store: FrameStore, v: VersionRowDb, files: readonly VersionFileDb[]): Promise<{ lines: string[]; checked: string[] } | null> {
  try {
    const entry = files.find((f) => f.path === HTML_NAME && f.role === "html");
    // the prefix is fixed by the table's check (sales_demo_versions_prefix): v1/<demo>/<version>/
    if (!entry || !UUID.test(v.id) || !UUID.test(v.demo_id)) return null;
    // the HTML size limit, before downloading and again on what came back
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > ARTIFACT_LIMITS.htmlBytes) return null;
    const bytes = await store.object(`v1/${v.demo_id}/${v.id}/${HTML_NAME}`, entry.bytes);
    if (!bytes || bytes.byteLength > ARTIFACT_LIMITS.htmlBytes) return null;
    const checked = checkFileBytes({ name: HTML_NAME, role: "html", sha256: entry.sha256, bytes: entry.bytes, content_type: "text/html" }, bytes);
    if (!checked.ok) return null;
    const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const photos = new Set(files.filter((f) => f.role === "photo").map((f) => f.path.slice("page/".length)));
    // a page the server's own HTML check refuses gives no text at all
    const safety = checkArtifactHtml(html, "", photos);
    if (!safety.ok) return null;
    const lines = visibleBodyText(html);
    return lines ? { lines, checked: safety.texts } : null;
  } catch {
    return null;
  }
}

export type CopyBasisRead = StoredCopyBasis | "missing" | "unreadable";

/** The copy record stored with a version (DEV-199e), through the admin's own session (RLS). Never throws. */
export async function readStoredCopyBasis(client: Awaited<ReturnType<typeof createAuthClient>>, versionId: string): Promise<CopyBasisRead> {
  try {
    if (!UUID.test(versionId)) return "unreadable";
    const link = await client.from("sales_demo_version_copy_links").select("review_id").eq("version_id", versionId).maybeSingle();
    if (link.error) return "unreadable";
    const reviewId = (link.data as { review_id?: unknown } | null)?.review_id;
    if (reviewId === undefined || reviewId === null) return "missing";
    if (typeof reviewId !== "string" || !UUID.test(reviewId)) return "unreadable";
    const q = await client.from("sales_demo_copy_reviews").select("copy_record_text, facts_pack_text, facts_sha256").eq("id", reviewId).maybeSingle();
    const r = q.data as { copy_record_text?: unknown; facts_pack_text?: unknown; facts_sha256?: unknown } | null;
    if (q.error || !r || typeof r.copy_record_text !== "string" || typeof r.facts_pack_text !== "string" || typeof r.facts_sha256 !== "string") return "unreadable";
    return { copyRecordText: r.copy_record_text, factsPackText: r.facts_pack_text, factsSha256: r.facts_sha256 };
  } catch {
    return "unreadable";
  }
}

/**
 * The comparison of two versions of the page's demo. `page` must be the loader's ok result (the flag and the admin
 * were checked before it was read). `store` is injected by tests; the page uses the service-role store.
 */
export async function buildCompare(
  page: Extract<DemoVersionsPage, { kind: "ok" }>,
  ask: { a: string | null; b: string | null },
  o: { store?: () => FrameStore; copyBasis?: (versionId: string) => Promise<CopyBasisRead> } = {},
): Promise<CompareData> {
  const { view, rows } = page;
  const byId = new Map(view.versions.map((v) => [v.id, v]));
  const rowById = new Map(rows.versions.map((v) => [v.id, v]));
  const choices = view.versions;
  const b = (ask.b && UUID.test(ask.b) ? byId.get(ask.b) : undefined) ?? view.versions[0];
  if (!b) return { kind: "no_candidate" };
  const aId =
    ask.a && UUID.test(ask.a) && byId.has(ask.a) && ask.a !== b.id
      ? ask.a
      : defaultBaseVersion({ candidateId: b.id, approvedVersionId: view.approvedVersionId, versions: rows.versions.map((v) => ({ id: v.id, parent_version_id: v.parent_version_id })) });
  const a = aId ? byId.get(aId) : undefined;
  if (!a) return { kind: "no_base", b, choices };

  const ra = rowById.get(a.id)!;
  const rb = rowById.get(b.id)!;
  const fa = rows.files.filter((f) => f.version_id === a.id);
  const fb = rows.files.filter((f) => f.version_id === b.id);

  // Storage only for what may be previewed now (the same rule as the view tokens), of a demo that is not disabled
  const readable = (v: VersionView) => v.previewable && !page.demoDisabled;
  let copy: CopyDiff;
  if (!readable(a) && !readable(b)) copy = { kind: "unavailable", side: "both" };
  else if (!readable(a) || !readable(b)) copy = { kind: "unavailable", side: readable(a) ? "b" : "a" };
  else {
    const store = (o.store ?? (() => supabaseFrameStore()))();
    const [ta, tb] = await Promise.all([pageTexts(store, ra, fa), pageTexts(store, rb, fb)]);
    if (!ta || !tb) copy = { kind: "unavailable", side: !ta && !tb ? "both" : !ta ? "a" : "b" };
    else {
      const read = o.copyBasis ?? (async (id: string): Promise<CopyBasisRead> => createAuthClient().then((c) => readStoredCopyBasis(c, id), () => "unreadable" as const));
      const [ba, bb] = await Promise.all([read(a.id), read(b.id)]);
      const side = (basis: CopyBasisRead, t: { lines: string[]; checked: string[] }): { side: CopyRecordSide; lines: CopyLine[] | null } => {
        if (basis === "missing" || basis === "unreadable") return { side: { state: basis }, lines: null };
        const c = classifyByCopyRecord({ lines: t.lines, checkedTexts: t.checked, basis });
        return c ? { side: { state: "checked", check: c.check }, lines: c.lines } : { side: { state: "unreadable" }, lines: null };
      };
      const sa = side(ba, ta);
      const sb = side(bb, tb);
      const records = { a: sa.side, b: sb.side };
      if (sa.lines && sb.lines) copy = { kind: "ok", result: diffLines(sa.lines, sb.lines), basis: "copy_record", records };
      else {
        const facts = factValues(page.content);
        copy = { kind: "ok", result: diffLines(copyLines(ta.lines, facts), copyLines(tb.lines, facts)), basis: "facts", records };
      }
    }
  }

  return {
    kind: "ok",
    a,
    b,
    choices,
    meta: compareVersionMeta(ra, rb),
    files: diffManifests(manifestOf(fa), manifestOf(fb)),
    structure: diffStructure(ra.structure_descriptor, rb.structure_descriptor),
    copy,
  };
}
