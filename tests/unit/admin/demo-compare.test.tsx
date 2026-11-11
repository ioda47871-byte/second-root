import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CompareVisual from "@/components/admin/demo/CompareVisual";
import { CopyDiffList, FilesDiffTable, MetaDiffTable, StructureDiffTable } from "@/components/admin/demo/CompareTables";
import { buildCompare, copyLines, factValues, visibleBodyText } from "@/lib/admin/demo-compare";
import { HIDDEN_EMAIL_LABEL } from "@/lib/sales/demo-version/admin-messages";
import { ARTIFACT_LIMITS } from "@/lib/sales/demo-version/manifest";
import type { DemoVersionsPage } from "@/lib/admin/demo-versions";
import type { FrameStore } from "@/lib/demo-frame/serve";
import { sha256Hex } from "@/lib/sales/demo-version/manifest";
import { buildDemoVersionsView, type QualityReviewDb, type VersionFileDb, type VersionRowDb } from "@/lib/sales/demo-version/view-model";

// DEV-196d-4: the compare page's data (which two versions, what changed, the page text line by line) and its tables.
// Storage is a stub injected here; the page itself uses the service-role store.

const NOW = new Date("2026-11-11T03:00:00Z");
const DEMO = "00000000-0000-4000-8000-0000000000d1";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const h = (c: string) => c.repeat(64);
const FACTS = h("f");
const CONTENT = { name: "架空の焼き菓子店", hours: "8:00〜17:00", menu_items: ["フィナンシェ"] };
const enc = (s: string) => new TextEncoder().encode(s);
const HTML: Record<number, Uint8Array> = {
  1: enc('<!doctype html><html><head><title>架空の焼き菓子店</title><link rel="stylesheet" href="style.css"></head><body><h1>架空の焼き菓子店</h1><p>朝の光と焼き色</p><p>8:00〜17:00</p></body></html>'),
  2: enc('<!doctype html><html><head><title>架空の焼き菓子店</title><link rel="stylesheet" href="style.css"></head><body><h1>架空の焼き菓子店</h1><p>静かな午後の一皿</p><p>8:00〜17:00</p><p>フィナンシェ</p></body></html>'),
  3: enc("<!doctype html><html><body><p>三</p></body></html>"),
};

const version = (n: number, over: Partial<VersionRowDb> = {}): VersionRowDb => ({
  id: id(n), demo_id: DEMO, version_no: n, parent_version_id: null, origin: "manual_import", worker_commit: `abcdef${n}`, facts_sha256: FACTS,
  bundle_sha256: h(String(n)), status: "draft", validator_result: { ok: true, codes: [] },
  structure_descriptor: { hero: { value: n === 1 ? "split_photo" : "full_bleed" }, flow: { value: ["story", "menu"] }, navigation: { value: "Free Text!" } },
  rights_summary: { by_status: n === 2 ? { owner_provided_internal: 1 } : {} }, expires_at: "2027-01-01T00:00:00Z", revoked_at: null, revoke_code: null,
  created_at: "2026-11-10T00:00:00Z", ...over,
});
const files = (n: number): VersionFileDb[] => [
  { version_id: id(n), path: "page/index.html", role: "html", sha256: sha256Hex(HTML[n]!), bytes: HTML[n]!.byteLength, content_type: "text/html", width: null, height: null, image_id: null },
  { version_id: id(n), path: "page/style.css", role: "css", sha256: h("c"), bytes: 10, content_type: "text/css", width: null, height: null, image_id: null },
  { version_id: id(n), path: "renders/desktop_1440.webp", role: "render", sha256: h(n === 1 ? "a" : "b"), bytes: 10, content_type: "image/webp", width: 1440, height: 4000, image_id: null },
  { version_id: id(n), path: "renders/mobile_390.webp", role: "render", sha256: h("d"), bytes: 10, content_type: "image/webp", width: 390, height: 4000, image_id: null },
];

function page(o: { versions?: VersionRowDb[]; approved?: string | null; disabled?: boolean } = {}): Extract<DemoVersionsPage, { kind: "ok" }> {
  const versions = o.versions ?? [version(2, { parent_version_id: id(1) }), version(1)];
  const fs = versions.flatMap((v) => files(v.version_no));
  const reviews: QualityReviewDb[] = [];
  const view = buildDemoVersionsView({ versions, files: fs, images: [], reviews, approvals: [], approvedVersionId: o.approved ?? null, demoDisabled: !!o.disabled, currentFactsSha256: FACTS, now: NOW });
  return { kind: "ok", prospectId: id(900), shopName: "架空", demoId: DEMO, demoDisabled: !!o.disabled, content: CONTENT, template: "bakery_v1", view, tokens: {}, previewUnavailable: null, truncated: false, rows: { versions, files: fs } };
}

function store(over: Record<string, Uint8Array | null> = {}) {
  const reads: string[] = [];
  let built = 0;
  const make = (): FrameStore => {
    built++;
    return {
      version: async () => null,
      demo: async () => null,
      files: async () => [],
      images: async () => [],
      object: async (key) => {
        reads.push(key);
        if (Object.hasOwn(over, key)) return over[key]!;
        const n = Number(key.match(/-0+(\d+)\/page\/index\.html$/)?.[1]);
        return HTML[n] ?? null;
      },
    };
  };
  return { make, reads, built: () => built };
}

describe("buildCompare: which two versions", () => {
  it("default: the candidate (newest) against its parent; an approved version is preferred as the base", async () => {
    const s = store();
    const r = await buildCompare(page(), { a: null, b: null }, { store: s.make });
    if (r.kind !== "ok") throw new Error(r.kind);
    expect([r.a.versionNo, r.b.versionNo]).toEqual([1, 2]);
    const withApproved = await buildCompare(page({ versions: [version(3, { parent_version_id: id(2) }), version(2, { status: "approved" }), version(1)], approved: id(2) }), { a: null, b: null }, { store: s.make });
    if (withApproved.kind !== "ok") throw new Error(withApproved.kind);
    expect([withApproved.a.versionNo, withApproved.b.versionNo]).toEqual([2, 3]);
  });

  it("explicit a / b of this demo are used; a = b, malformed or foreign ids fall back to the default", async () => {
    const s = store();
    const versions = [version(3), version(2, { parent_version_id: id(1) }), version(1)];
    const pick = async (a: string | null, b: string | null) => {
      const r = await buildCompare(page({ versions }), { a, b }, { store: s.make });
      return r.kind === "ok" ? [r.a.versionNo, r.b.versionNo] : r.kind;
    };
    expect(await pick(id(3), id(1))).toEqual([3, 1]);
    expect(await pick(id(2), id(2))).toEqual([1, 2]); // a = b → b's parent
    expect(await pick("x", id(2))).toEqual([1, 2]);
    expect(await pick(id(77), id(2))).toEqual([1, 2]);
    expect(await pick(null, id(77))).toBe("no_base"); // b falls back to the newest (v3, no parent, nothing approved)
  });

  it("one version without a base: no_base (choose one); no versions: no_candidate", async () => {
    expect((await buildCompare(page({ versions: [version(1)] }), { a: null, b: null })).kind).toBe("no_base");
    expect((await buildCompare(page({ versions: [] }), { a: null, b: null })).kind).toBe("no_candidate");
  });
});

describe("buildCompare: what changed", () => {
  it("meta, files and structure from the rows; the page text line by line with fact lines marked", async () => {
    const r = await buildCompare(page(), { a: null, b: null }, { store: store().make });
    if (r.kind !== "ok") throw new Error(r.kind);
    expect(r.meta.bundleChanged).toBe(true);
    expect(r.meta.factsChanged).toBe(false);
    expect(r.meta.rights).toEqual([{ status: "owner_provided_internal", a: 0, b: 1 }]);
    expect(r.files.counts).toEqual({ added: 0, removed: 0, changed: 2, same: 2 });
    expect(r.structure.find((e) => e.aspect === "hero")).toEqual({ aspect: "hero", a: "split_photo", b: "full_bleed", changed: true });
    expect(r.structure.find((e) => e.aspect === "navigation")).toMatchObject({ a: null, b: null }); // free text is never shown
    if (r.copy.kind !== "ok" || !r.copy.result.ok) throw new Error("copy");
    const ops = r.copy.result.ops.map((o) => `${o.op}:${o.kind}:${o.text}`);
    expect(ops).toContain("del:unknown:朝の光と焼き色");
    expect(ops).toContain("add:unknown:静かな午後の一皿");
    expect(ops).toContain("add:fact:フィナンシェ");
    expect(ops).toContain("same:fact:8:00〜17:00");
    expect(r.copy.result.ops.some((o) => (o.kind as string) === "creative")).toBe(false);
  });

  it("Storage is read only for previewable versions of a demo that is not disabled, and only index.html", async () => {
    const s = store();
    await buildCompare(page(), { a: null, b: null }, { store: s.make });
    expect(s.reads.sort()).toEqual([`v1/${DEMO}/${id(1)}/page/index.html`, `v1/${DEMO}/${id(2)}/page/index.html`]);
    const revoked = store();
    const r = await buildCompare(page({ versions: [version(2, { parent_version_id: id(1) }), version(1, { status: "revoked", revoked_at: "2026-11-10T00:00:00Z" })] }), { a: null, b: null }, { store: revoked.make });
    expect(r.kind === "ok" && r.copy).toEqual({ kind: "unavailable", side: "a" });
    expect(revoked.built()).toBe(0);
    const disabled = store();
    const d = await buildCompare(page({ disabled: true }), { a: null, b: null }, { store: disabled.make });
    expect(d.kind === "ok" && d.copy).toEqual({ kind: "unavailable", side: "both" });
    expect(disabled.built()).toBe(0);
  });

  it("bytes that are not the manifest's, or missing, are not used (unavailable)", async () => {
    const k = (n: number) => `v1/${DEMO}/${id(n)}/page/index.html`;
    for (const [over, side] of [
      [{ [k(1)]: enc("<p>差し替え</p>".padEnd(HTML[1]!.byteLength, " ")) }, "a"],
      [{ [k(2)]: null }, "b"],
      [{ [k(1)]: null, [k(2)]: null }, "both"],
    ] as const) {
      const r = await buildCompare(page(), { a: null, b: null }, { store: store(over as Record<string, Uint8Array | null>).make });
      expect(r.kind === "ok" && r.copy, side).toEqual({ kind: "unavailable", side });
    }
  });

  it("factValues / copyLines: exact stored facts only", () => {
    const f = factValues({ name: " 店 ", phone: 3, menu_items: ["a", ""], other: "x" });
    expect([...f].sort()).toEqual(["a", "店"]);
    expect(copyLines(["店", "店の朝"], f)).toEqual([{ text: "店", kind: "fact" }, { text: "店の朝", kind: "unknown" }]);
  });
});

describe("compare components (display only)", () => {
  it("tables say what changed in fixed words; unmeasured aspects never read as the same", async () => {
    const r = await buildCompare(page(), { a: null, b: null }, { store: store().make });
    if (r.kind !== "ok") throw new Error(r.kind);
    const meta = renderToStaticMarkup(<MetaDiffTable meta={r.meta} a="v1" b="v2" />);
    expect(meta).toContain("同じ事実から作られています");
    expect(meta).toContain("オーナー提供の写真");
    const filesHtml = renderToStaticMarkup(<FilesDiffTable entries={r.files.entries} counts={r.files.counts} />);
    expect(filesHtml).toContain('data-file="page/index.html" data-change="changed"');
    const structure = renderToStaticMarkup(<StructureDiffTable entries={r.structure} a="v1" b="v2" />);
    expect(structure).toContain("split_photo");
    expect(structure).toContain("計測なし");
    expect(structure).not.toContain("Free Text!");
    const copy = renderToStaticMarkup(<CopyDiffList copy={r.copy} />);
    expect(copy).toContain('data-op="add" data-kind="fact"');
    expect(copy).toContain("事実");
    expect(copy).not.toMatch(/<form|<button/);
    expect(renderToStaticMarkup(<CopyDiffList copy={{ kind: "unavailable", side: "a" }} />)).toContain("比べる元の版の頁を読めない");
    expect(renderToStaticMarkup(<CopyDiffList copy={{ kind: "ok", result: { ok: false, reason: "TOO_LARGE" } }} />)).toContain("文が多すぎる");
    // review round 1 L2: the unmarked lines are described neutrally
    expect(copy).toContain("店舗の事実と完全には一致しない行（創作・事実を含む文などを区別しません）");
    expect(copy).not.toContain("創作の見出しか");
  });

  it("the visual starts side by side with synced scrolling; a missing render says so", () => {
    const html = renderToStaticMarkup(
      <CompareVisual
        a={{ label: "v1", pc: { src: "/demo-frame/a/T1/renders/desktop_1440.webp", width: 1440, height: 4000 }, sp: null }}
        b={{ label: "v2", pc: null, sp: null }}
      />,
    );
    expect(html).toContain('data-compare-visual="side"');
    expect(html).toContain('data-compare-scroll="a"');
    expect(html).toContain('data-compare-scroll="b"');
    expect(html).toMatch(/type="checkbox" checked=""/);
    expect(html).toContain('src="/demo-frame/a/T1/renders/desktop_1440.webp"');
    expect(html).toContain("v2: 描画画像がありません");
    expect(html).toContain("画素の差分は出しません");
  });
});

// --- review of #249, round 1 -----------------------------------------------------------------------------------------

const page3 = (body: string, head = "<title>見出しだけの題</title>") =>
  enc(`<!doctype html><html><head>${head}<link rel="stylesheet" href="style.css"></head><body>${body}</body></html>`);

/** A page with these HTML bytes as v2 (v1 as before), for buildCompare. */
function withV2(bytes: Uint8Array, entryBytes = bytes.byteLength) {
  const p = page();
  const fs = p.rows.files.map((f) => (f.version_id === id(2) && f.path === "page/index.html" ? { ...f, sha256: sha256Hex(bytes), bytes: entryBytes } : f));
  return { ...p, rows: { ...p.rows, files: fs } };
}

describe("review round 1 L1: only the visible body text of a page that passes the server's check", () => {
  it("no <title>, svg title / desc, [hidden], script / style / template / noscript, comments or attribute text", () => {
    const t = visibleBodyText(
      '<!doctype html><html><head><title>題だけ</title></head><body><h1 title="属性">見出し</h1><!-- 注釈 --><p hidden>隠した文</p><div hidden><p>入れ子の隠した文</p></div>' +
        '<svg viewBox="0 0 1 1"><title>図の題</title><desc>図の説明</desc></svg><template><p>型</p></template><noscript>代わり</noscript><img alt="代替文"><p>本文</p></body></html>',
    );
    expect(t).toEqual(["見出し", "本文"]);
  });

  it("the diff never shows a <title>-only line, svg title / desc or [hidden] text", async () => {
    const v2 = page3('<h1>架空の焼き菓子店</h1><p hidden>隠した文</p><svg viewBox="0 0 1 1"><title>図の題</title><desc>図の説明</desc></svg><p>静かな午後の一皿</p>');
    const r = await buildCompare(withV2(v2), { a: null, b: null }, { store: store({ [`v1/${DEMO}/${id(2)}/page/index.html`]: v2 }).make });
    if (r.kind !== "ok" || r.copy.kind !== "ok" || !r.copy.result.ok) throw new Error(JSON.stringify(r.kind === "ok" ? r.copy : r.kind));
    const texts = r.copy.result.ops.map((o) => o.text);
    for (const hidden of ["見出しだけの題", "架空の焼き菓子店のtitle", "隠した文", "図の題", "図の説明"]) expect(texts).not.toContain(hidden);
    expect(texts).toContain("静かな午後の一皿");
  });

  it("a page that fails the server's HTML check gives no text at all (unavailable)", async () => {
    const bad = page3('<p>見える文</p><script>alert(1)</script>');
    const r = await buildCompare(withV2(bad), { a: null, b: null }, { store: store({ [`v1/${DEMO}/${id(2)}/page/index.html`]: bad }).make });
    expect(r.kind === "ok" && r.copy).toEqual({ kind: "unavailable", side: "b" });
  });

  it("an entry over the HTML size limit is refused before downloading; an oversize download is refused too", async () => {
    const s = store();
    const big = withV2(HTML[2]!, ARTIFACT_LIMITS.htmlBytes + 1);
    const r = await buildCompare(big, { a: null, b: null }, { store: s.make });
    expect(r.kind === "ok" && r.copy).toEqual({ kind: "unavailable", side: "b" });
    expect(s.reads).toEqual([`v1/${DEMO}/${id(1)}/page/index.html`]); // v2 was never downloaded
    const huge = new Uint8Array(ARTIFACT_LIMITS.htmlBytes + 10);
    const r2 = await buildCompare(page(), { a: null, b: null }, { store: store({ [`v1/${DEMO}/${id(2)}/page/index.html`]: huge }).make });
    expect(r2.kind === "ok" && r2.copy).toEqual({ kind: "unavailable", side: "b" });
  });
});

describe("review round 1 L3: email addresses are never shown and never a fact", () => {
  it("factValues leaves out email-holding facts; copyLines replaces an email line with the hidden label", () => {
    const f = factValues({ name: "店", phone: "連絡 info@example.com", menu_items: ["a@example.com", "パン"] });
    expect([...f].sort()).toEqual(["パン", "店"]);
    expect(copyLines(["連絡 info@example.com", "店"], new Set(["連絡 info@example.com", "店"]))).toEqual([
      { text: HIDDEN_EMAIL_LABEL, kind: "unknown" },
      { text: "店", kind: "fact" },
    ]);
  });

  it("an email line in a page never appears verbatim in the diff or the rendered list, and is never 「事実」", async () => {
    const v2 = page3("<h1>架空の焼き菓子店</h1><p>お問い合わせ info@example.com</p><p>8:00〜17:00</p>");
    const p = withV2(v2);
    const withEmailFact = { ...p, content: { ...CONTENT, phone: "お問い合わせ info@example.com" } };
    const r = await buildCompare(withEmailFact, { a: null, b: null }, { store: store({ [`v1/${DEMO}/${id(2)}/page/index.html`]: v2 }).make });
    if (r.kind !== "ok" || r.copy.kind !== "ok" || !r.copy.result.ok) throw new Error("copy");
    expect(JSON.stringify(r.copy)).not.toContain("info@example.com");
    const line = r.copy.result.ops.find((o) => o.text === HIDDEN_EMAIL_LABEL)!;
    expect(line).toMatchObject({ op: "add", kind: "unknown" });
    const html = renderToStaticMarkup(<CopyDiffList copy={r.copy} />);
    expect(html).not.toContain("info@example.com");
    expect(html).toContain(HIDDEN_EMAIL_LABEL);
  });
});

