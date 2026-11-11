import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FactsPanel, { demoFacts } from "@/components/admin/demo/FactsPanel";
import LiveFrame from "@/components/admin/demo/LiveFrame";
import PreviewTabs from "@/components/admin/demo/PreviewTabs";
import RenderPane from "@/components/admin/demo/RenderPane";
import RightsPanel from "@/components/admin/demo/RightsPanel";
import VersionList from "@/components/admin/demo/VersionList";
import VersionNotices from "@/components/admin/demo/VersionNotices";
import { AI_CONCEPT_BADGE, APPROVAL_STOPS_SENDING_BEFORE, RIGHTS_BLOCKED_LABEL, SEND_BLOCK_LABEL } from "@/lib/sales/demo-version/admin-messages";
import { outerFrameSrc } from "@/lib/sales/demo-version/csp";
import { buildDemoVersionsView, type DemoImageDb, type VersionFileDb, type VersionRowDb } from "@/lib/sales/demo-version/view-model";
import nextConfig, { ADMIN_DEMO_PAGE_CSP } from "@/next.config";

// DEV-196d-3: the read-only admin demo version page — its components, the server loader's decisions, the page's
// headers in next.config.ts, and the guardrail that no frame anywhere gets allow-same-origin.

const NOW = new Date("2026-11-11T03:00:00Z");
const DEMO = "00000000-0000-4000-8000-0000000000d1";
const PROSPECT = "00000000-0000-4000-8000-0000000000c1";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const h = (c: string) => c.repeat(64);
const FACTS = h("f");

const version = (n: number, over: Partial<VersionRowDb> = {}): VersionRowDb => ({
  id: id(n), demo_id: DEMO, version_no: n, parent_version_id: null, origin: "manual_import", worker_commit: "abcdef1", facts_sha256: FACTS,
  bundle_sha256: h(String(n)), status: "draft", validator_result: { ok: true, codes: [] }, structure_descriptor: null, rights_summary: null,
  expires_at: "2027-01-01T00:00:00Z", revoked_at: null, revoke_code: null, created_at: "2026-11-10T00:00:00Z", ...over,
});
const file = (v: number, path: string, role: string, over: Partial<VersionFileDb> = {}): VersionFileDb => ({
  version_id: id(v), path, role, sha256: h("9"), bytes: 10, content_type: role === "html" ? "text/html" : role === "css" ? "text/css" : "image/webp",
  width: role === "photo" || role === "render" ? 1440 : null, height: role === "photo" || role === "render" ? 5000 : null, image_id: null, ...over,
});
const baseFiles = (v: number) => [
  file(v, "page/index.html", "html"),
  file(v, "page/style.css", "css"),
  file(v, "renders/desktop_1440.webp", "render", { sha256: h("a"), width: 1440, height: 5200 }),
  file(v, "renders/mobile_390.webp", "render", { sha256: h("b"), width: 390, height: 9100 }),
];
const image = (over: Partial<DemoImageDb> = {}): DemoImageDb => ({
  id: id(501), sha256: h("c"), width: 100, height: 100, format: "webp", source_kind: "ai_concept_internal", rights_status: "ai_concept_internal",
  depicts_real_shop: false, depicts_identifiable_person: false, depicts_real_product: false, depicts_real_interior: false, depicts_real_equipment: false,
  no_factual_impersonation_confirmed_at: "2026-11-10T00:00:00Z", rights_expiry: null,
  provenance: { generator: "free text never shown", model: "model-x", generated_at: "2026-11-09T10:00:00Z", prompt_sha256: h("e"), approval_id: "grant-1" }, revoked_at: null, ...over,
});
const view = (o: Partial<Parameters<typeof buildDemoVersionsView>[0]> = {}) =>
  buildDemoVersionsView({ versions: [version(1)], files: baseFiles(1), images: [], reviews: [], approvals: [], approvedVersionId: null, demoDisabled: false, currentFactsSha256: FACTS, now: NOW, ...o });

describe("RenderPane: full pages, nothing cropped, a sentinel per render", () => {
  const html = renderToStaticMarkup(
    <RenderPane
      renders={[
        { viewport: "desktop_1440", src: "/demo-frame/a/T/renders/desktop_1440.webp", width: 1440, height: 5200 },
        { viewport: "mobile_390", src: "/demo-frame/a/T/renders/mobile_390.webp", width: 390, height: 9100 },
      ]}
    />,
  );
  it("PC starts fitted to the box; SP is always 1:1 at 390 CSS px; images keep their full size and aspect", () => {
    expect(html).toMatch(/<img[^>]*src="\/demo-frame\/a\/T\/renders\/desktop_1440\.webp"[^>]*width="1440"[^>]*height="5200"[^>]*class="[^"]*fit/);
    expect(html).toMatch(/<img[^>]*src="\/demo-frame\/a\/T\/renders\/mobile_390\.webp"[^>]*width="390"[^>]*height="9100"[^>]*style="width:390px"/);
    expect(html).toContain("実寸で見る");
    expect(html).not.toMatch(/object-fit|max-height/);
  });
  it("each render scrolls in its own labelled box, ends with a sentinel, and starts as not viewed to the end", () => {
    for (const v of ["desktop_1440", "mobile_390"]) {
      expect(html).toContain(`data-scroll="${v}"`);
      expect(html).toContain(`data-sentinel="${v}"`);
      expect(html).toMatch(new RegExp(`data-render="${v}" data-viewed="false"`));
    }
    expect(html.match(/最後まで見ていません/g)).toHaveLength(2);
  });
});

describe("LiveFrame and PreviewTabs", () => {
  it("the frame is sandbox=\"\" exactly: no allow-* token, no allow attribute, no srcdoc, no referrer", () => {
    const html = renderToStaticMarkup(<LiveFrame src="/demo-frame/a/T/index.html" title="v1" />);
    const iframe = html.match(/<iframe[^>]*>/)![0];
    expect(iframe).toContain('sandbox=""');
    expect(iframe).toMatch(/referrerPolicy="no-referrer"/i);
    expect(iframe).toContain('loading="lazy"');
    expect(iframe).not.toMatch(/allow/i);
    expect(iframe).not.toMatch(/srcdoc/i);
    expect(iframe).toContain('src="/demo-frame/a/T/index.html"');
    expect(html).toContain("判断の基準は描画画像です");
  });
  it("the live page is not mounted until its tab is chosen (renders first)", () => {
    const html = renderToStaticMarkup(<PreviewTabs renders={<p>R</p>} live={<LiveFrame src="/x" title="t" />} />);
    expect(html).toContain("<p>R</p>");
    expect(html).not.toContain("<iframe");
    expect(html).toContain('aria-selected="true"');
  });
});

describe("FactsPanel: missing facts are 未確認, never filled in", () => {
  it("shows the stored facts and 未確認 for each missing one; drops email addresses", () => {
    const rows = demoFacts({ name: "架空の店", category: "bakery", hours: "8:00〜17:00", phone: "info@example.com", menu_items: ["食パン", 3, "  "] });
    expect(rows.find((r) => r.label === "店名")?.value).toBe("架空の店");
    expect(rows.find((r) => r.label === "業種")?.value).toBe("パン屋");
    expect(rows.find((r) => r.label === "電話")?.value).toBeNull();
    expect(rows.find((r) => r.label === "メニュー")?.value).toBe("食パン");
    const html = renderToStaticMarkup(<FactsPanel content={{ name: "架空の店" }} facts="unknown" />);
    expect(html.match(/未確認/g)!.length).toBeGreaterThanOrEqual(8);
    expect(html).toContain("同じとは扱いません");
    expect(renderToStaticMarkup(<FactsPanel content={null} facts="changed" />)).toContain("事実が変わりました");
  });
});

describe("RightsPanel: read only, AI badge, unknown rights blocked", () => {
  it("an AI concept image gets the red badge; provenance is a date, a yes/no and a prefix only", () => {
    const v = view({ files: [...baseFiles(1), file(1, "page/photos/hero-desktop.webp", "photo", { sha256: h("c"), image_id: id(501) })], images: [image()] }).versions[0]!;
    const html = renderToStaticMarkup(<RightsPanel images={v.images} photoBase="/demo-frame/a/T/" />);
    expect(html).toContain(AI_CONCEPT_BADGE);
    expect(html).toContain('data-ai-badge="true"');
    expect(html).toContain('src="/demo-frame/a/T/photos/hero-desktop.webp"');
    expect(html).toContain("2026-11-09");
    expect(html).toContain("eeeeeeee…");
    expect(html).not.toContain("model-x");
    expect(html).not.toContain("free text never shown");
  });
  it("unknown / revoked rights: 権利不明のため使用不可 and no image at all", () => {
    for (const over of [{ rights_status: "unknown" }, { revoked_at: "2026-11-10T00:00:00Z", rights_status: "revoked" }, { sha256: h("d") }]) {
      const v = view({ files: [...baseFiles(1), file(1, "page/photos/hero-desktop.webp", "photo", { sha256: h("c"), image_id: id(501) })], images: [image(over)] }).versions[0]!;
      const html = renderToStaticMarkup(<RightsPanel images={v.images} photoBase="/demo-frame/a/T/" />);
      expect(html).toContain(RIGHTS_BLOCKED_LABEL);
      expect(html).not.toContain("<img");
      expect(v.previewable).toBe(false);
    }
  });
});

describe("VersionNotices and VersionList (display only)", () => {
  it("a draft shows the approval-stops-sending warning; blockers are listed in the owner's words", () => {
    const v = view({ currentFactsSha256: null });
    const html = renderToStaticMarkup(<VersionNotices view={v} version={v.versions[0]!} />);
    expect(html).toContain(APPROVAL_STOPS_SENDING_BEFORE);
    expect(html).toContain('data-blockers="FACTS_UNKNOWN"');
    expect(html).not.toMatch(/<button|<form/);
  });
  it("an approved version shows why sending is stopped, with the reasons", () => {
    const v = view({
      versions: [version(1, { status: "approved" })],
      approvedVersionId: id(1),
      reviews: [{ id: id(700), version_id: id(1), decision: "approved", state: "active", checklist: {}, viewed_renders_sha256: {}, reviewed_at: "2026-11-10T00:00:00Z", withdrawn_at: null, invalidated_at: null, invalidated_reason: null, bundle_sha256: h("1"), facts_sha256: FACTS }],
    });
    const html = renderToStaticMarkup(<VersionNotices view={v} version={v.versions[0]!} />);
    expect(html).toContain(SEND_BLOCK_LABEL.demo_not_shareable);
    expect(html).toContain("版での共有がまだ無効です");
    expect(html).toContain('role="alert"');
  });
  it("lists versions in lineage order with the selected one marked; links stay on this page", () => {
    const v = view({ versions: [version(1), version(2, { parent_version_id: id(1) }), version(3, { status: "revoked", revoked_at: "2026-11-10T00:00:00Z" })], files: [] });
    const html = renderToStaticMarkup(<VersionList view={v} prospectId={PROSPECT} selectedId={id(2)} />);
    expect(html.indexOf('data-version="1"')).toBeLessThan(html.indexOf('data-version="2"'));
    const current = html.match(/<a[^>]*aria-current="page"[^>]*>/g)!;
    expect(current).toHaveLength(1);
    expect(current[0]).toContain(`href="/admin/sales/demos/${PROSPECT}?v=${id(2)}"`);
    expect(html).toContain("取り消し済み");
  });
});

describe("next.config.ts: the page's headers", () => {
  /** Next's rule: every matching rule applies in order; for the same key, the last one wins. */
  async function resolved(path: string) {
    const out: Record<string, string> = {};
    for (const r of await nextConfig.headers!()) {
      const prefix = r.source.replace(/\/:path\*$/, "");
      if (path === prefix || path.startsWith(`${prefix}/`)) for (const hd of r.headers) out[hd.key] = hd.value;
    }
    return out;
  }
  it("the demo page may frame only 'self' and is never framed; X-Frame-Options DENY and the rest stay", async () => {
    const page = await resolved(`/admin/sales/demos/${PROSPECT}`);
    expect(page["Content-Security-Policy"]).toBe("frame-ancestors 'none'; frame-src 'self'");
    expect(page["X-Frame-Options"]).toBe("DENY");
    expect(page["Cache-Control"]).toBe("private, no-store");
    expect(page["X-Robots-Tag"]).toBe("noindex, nofollow");
  });
  it("every other admin page is unchanged (frame-ancestors 'none', no frame-src)", async () => {
    for (const p of ["/admin/sales", "/admin/preview/x", "/admin/sales/history", "/admin/login"]) {
      const hd = await resolved(p);
      expect(hd["Content-Security-Policy"], p).toBe("frame-ancestors 'none'");
      expect(hd["X-Frame-Options"], p).toBe("DENY");
    }
  });
  it("the demos rule comes after /admin/:path* (last wins) and matches DEV-196b's outerFrameSrc for the interim", async () => {
    const sources = (await nextConfig.headers!()).map((r) => r.source);
    expect(sources.indexOf("/admin/sales/demos/:path*")).toBeGreaterThan(sources.indexOf("/admin/:path*"));
    expect(ADMIN_DEMO_PAGE_CSP).toBe(`frame-ancestors 'none'; ${outerFrameSrc({ page: "admin_preview", appOrigin: "https://app.example.com", artifactOrigin: null })}`);
  });
});

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

describe("guardrail: no frame anywhere may get allow-same-origin", () => {
  const sources = ["app", "components", "lib"].flatMap(filesUnder).filter((f) => /\.(tsx?|css)$/.test(f));
  it("allow-same-origin appears in no source file", () => {
    expect(sources.length).toBeGreaterThan(50);
    for (const f of sources) expect(readFileSync(f, "utf8"), f).not.toMatch(/allow-same-origin/);
  });
  it("every iframe in the admin demo components is sandbox=\"\" and none uses srcDoc or dangerouslySetInnerHTML", () => {
    for (const f of filesUnder("components/admin/demo").concat(filesUnder("app/admin/sales/demos"))) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\bsrcDoc=|\bsrcdoc=|dangerouslySetInnerHTML=/);
      for (const tag of src.match(/<iframe[\s\S]*?\/>/g) ?? []) {
        expect(tag, f).toMatch(/sandbox=""/);
        expect(tag, f).not.toMatch(/\ballow=/);
      }
    }
  });
});

// --- the server loader ---------------------------------------------------------------------------------------------

type Tables = Record<string, { data: unknown; error?: { message: string } | null }>;
const queries: string[] = [];
function fakeClient(tables: Tables) {
  return {
    from(table: string) {
      queries.push(table);
      const res = tables[table] ?? { data: [] };
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "limit"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data: res.data, error: res.error ?? null });
      b.then = (ok: (v: unknown) => unknown) => ok({ data: res.data, error: res.error ?? null });
      return b;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({ createAuthClient: vi.fn(async () => fakeClient({})) }));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: vi.fn(() => fakeClient({})) }));
const { loadDemoVersionsPage } = await import("@/lib/admin/demo-versions");

const KEY = Buffer.alloc(32, 7).toString("base64");
const ENV = { SALES_DEMO_VERSIONS_ENABLED: "true", SALES_DEMO_VIEW_SIGNING_KEY: KEY };
const tables = (over: Tables = {}): Tables => ({
  sales_prospects: { data: { id: PROSPECT, name: "架空の店" } },
  sales_demos: { data: { id: DEMO, template: "bakery_v1", content: { name: "架空の店" }, disabled_at: null, approved_version_id: null } },
  sales_demo_versions: { data: [version(2, { status: "revoked", revoked_at: "2026-11-10T00:00:00Z" }), version(1)] },
  sales_demo_version_files: { data: [...baseFiles(1), ...baseFiles(2)] },
  sales_demo_images: { data: [] },
  sales_demo_quality_reviews: { data: [] },
  sales_outreach_approvals: { data: [] },
  ...over,
});
const load = (env: Record<string, string | undefined> = ENV, t: Tables = tables(), facts: string | null = FACTS) =>
  loadDemoVersionsPage(PROSPECT, { env, now: NOW, client: fakeClient(t) as never, factsSha256: async () => facts });

beforeEach(() => {
  queries.length = 0;
});
afterEach(() => vi.clearAllMocks());

describe("loadDemoVersionsPage", () => {
  it("flag off or a malformed id: not found, and nothing is queried", async () => {
    expect(await load({ ...ENV, SALES_DEMO_VERSIONS_ENABLED: "TRUE" })).toEqual({ kind: "not_found" });
    expect(await loadDemoVersionsPage("not-a-uuid", { env: ENV, now: NOW, client: fakeClient(tables()) as never })).toEqual({ kind: "not_found" });
    expect(queries).toEqual([]);
  });

  it("signs a view token only for previewable versions (never a revoked one)", async () => {
    const r = await load();
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(Object.keys(r.tokens)).toEqual([id(1)]);
    expect(r.previewUnavailable).toBeNull();
    expect(r.view.versions.map((v) => v.versionNo)).toEqual([2, 1]);
  });

  it("no token at all without a usable key, with a configured artifact origin, or for a disabled demo", async () => {
    const cases: Array<[Record<string, string | undefined>, Tables, string | null]> = [
      [{ SALES_DEMO_VERSIONS_ENABLED: "true" }, tables(), "signing_key_missing"],
      [{ ...ENV, SALES_DEMO_VIEW_SIGNING_KEY: "short" }, tables(), "signing_key_invalid"],
      [{ ...ENV, SALES_DEMO_ARTIFACT_ORIGIN: "https://artifacts.example.com" }, tables(), "artifact_origin_configured"],
      [ENV, tables({ sales_demos: { data: { id: DEMO, template: "bakery_v1", content: {}, disabled_at: "2026-11-10T00:00:00Z", approved_version_id: null } } }), null],
    ];
    for (const [env, t, why] of cases) {
      const r = await load(env, t);
      if (r.kind !== "ok") throw new Error("expected ok");
      expect(r.tokens).toEqual({});
      expect(r.previewUnavailable).toBe(why);
    }
  });

  it("unknown facts stay unknown (approval blocked); a database error is an error, a missing row is not found", async () => {
    const r = await load(ENV, tables(), null);
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(r.view.versions[1]!.facts).toBe("unknown");
    expect(r.view.versions[1]!.approveBlockers).toContain("FACTS_UNKNOWN");
    expect(await load(ENV, tables({ sales_demo_versions: { data: null, error: { message: "boom" } } }))).toEqual({ kind: "error" });
    expect(await load(ENV, tables({ sales_prospects: { data: null } }))).toEqual({ kind: "not_found" });
    expect(await load(ENV, tables({ sales_demos: { data: null } }))).toEqual({ kind: "not_found" });
  });
});

describe("the service-role facts read (coordinator decision on #248)", () => {
  it("runs only after the flag and the admin's own RLS read found the demo, once, for that demo id only", async () => {
    const calls: string[] = [];
    const read = async (demoId: string) => {
      calls.push(demoId);
      return FACTS;
    };
    const run = (env: Record<string, string | undefined>, t: Tables) => loadDemoVersionsPage(PROSPECT, { env, now: NOW, client: fakeClient(t) as never, factsSha256: read });
    await run({ ...ENV, SALES_DEMO_VERSIONS_ENABLED: undefined }, tables());
    await run(ENV, tables({ sales_prospects: { data: null } })); // RLS: a non-admin sees no row
    await run(ENV, tables({ sales_demos: { data: null } }));
    await run(ENV, tables({ sales_demos: { data: null, error: { message: "x" } } }));
    await run(ENV, tables({ sales_demo_versions: { data: null, error: { message: "x" } } }));
    expect(calls).toEqual([]);
    await run(ENV, tables());
    expect(calls).toEqual([DEMO]);
  });

  it("any failure is unknown (approval blocked): a throw, an error (null) or a value that is not a sha256", async () => {
    for (const read of [async () => Promise.reject(new Error("boom")), async () => null, async () => "not-a-hash", async () => FACTS.toUpperCase()]) {
      const r = await loadDemoVersionsPage(PROSPECT, { env: ENV, now: NOW, client: fakeClient(tables()) as never, factsSha256: read as never });
      if (r.kind !== "ok") throw new Error("expected ok");
      const v = r.view.versions.find((x) => x.versionNo === 1)!;
      expect(v.facts).toBe("unknown");
      expect(v.approveBlockers).toContain("FACTS_UNKNOWN");
    }
  });

  it("the hash itself never reaches the page data: only same / changed / unknown", async () => {
    const r = await loadDemoVersionsPage(PROSPECT, { env: ENV, now: NOW, client: fakeClient(tables({ sales_demo_versions: { data: [version(1, { facts_sha256: h("0") })] } })) as never, factsSha256: async () => FACTS });
    if (r.kind !== "ok") throw new Error("expected ok");
    expect(JSON.stringify(r)).not.toContain(FACTS);
    expect(r.view.versions[0]!.facts).toBe("changed");
  });
});
