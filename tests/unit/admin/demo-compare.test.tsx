import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CompareVisual from "@/components/admin/demo/CompareVisual";
import { CopyDiffList, FilesDiffTable, MetaDiffTable, StructureDiffTable } from "@/components/admin/demo/CompareTables";
import { buildCompare, copyLines, factValues } from "@/lib/admin/demo-compare";
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
