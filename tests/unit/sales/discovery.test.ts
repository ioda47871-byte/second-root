import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { dedupeKeys } from "@/lib/sales/dedupe";
import { DURABLE_REJECTIONS, discoveryKeys, isDurableRejection, isValidMemoryKey, rejectionMemoryEntry, screenableStubs, validMemoryEntries, type RejectionMemoryEntry } from "@/lib/sales/discovery";
import { handleIngest, toView } from "@/lib/sales/ingest";
import { ingestRequest, type IngestRequest } from "@/lib/sales/ingest-schema";
import { prepareCandidate, type RejectionReason } from "@/lib/sales/prepare";
import { verifiedEmailInput, verifiedInput } from "./ingest-fixtures";

// DEV-054: discovery-stage screening ("known" marks) and the memory of
// durable rejections. Fictional shops only.

const runId = "8b4a5f5e-3c1d-4a9b-9a51-2d0f6c1e7a10";

describe("discoveryKeys", () => {
  it("uses the ingest normalisation for the Instagram handle and website key", () => {
    expect(discoveryKeys({ key: "c01", instagramUrl: "https://instagram.com/Test_Pan/", websiteUrl: "https://www.Pan.example.com/menu" })).toEqual({
      key: "c01",
      instagram_handle: "test_pan",
      website_domain: "pan.example.com",
    });
    expect(discoveryKeys({ key: "c02", websiteUrl: "https://ameblo.jp/test-pan/entry-1.html" }).website_domain).toBe("ameblo.jp/test-pan");
  });

  it("gives no key for URLs that do not identify one shop", () => {
    for (const websiteUrl of ["https://tabelog.com/aichi/A2301/1/", "https://www.instagram.com/test_pan/", "https://linktr.ee/test_pan", "https://sites.google.com/view"]) {
      expect(discoveryKeys({ key: "c01", websiteUrl }).website_domain, websiteUrl).toBeNull();
    }
    for (const instagramUrl of ["https://www.instagram.com/p/abc/", "https://www.instagram.com/explore/", "http://www.instagram.com/test_pan/", "https://example.com/test_pan"]) {
      expect(discoveryKeys({ key: "c01", instagramUrl }).instagram_handle, instagramUrl).toBeNull();
    }
    expect(discoveryKeys({ key: "c01" })).toEqual({ key: "c01", instagram_handle: null, website_domain: null });
  });

  it("never screens on the name or ward (no name + ward matching)", () => {
    const keys = discoveryKeys({ key: "c01", name: "テストパン工房", ward: "中区" } as never);
    expect(Object.keys(keys).sort()).toEqual(["instagram_handle", "key", "website_domain"]);
  });

  it("matches the dedupe keys of the verified shop", () => {
    const shop = verifiedInput({ website: { status: "present", url: "https://pan-x.example.com/", checks: 1 } });
    const dk = dedupeKeys({ name: shop.name, address: shop.address, websiteUrl: shop.website.url, instagramUrl: shop.instagramUrl });
    const sk = discoveryKeys({ key: shop.key, websiteUrl: shop.website.url, instagramUrl: shop.instagramUrl });
    expect(sk.instagram_handle).toBe(dk.instagram);
    expect(sk.website_domain).toBe(dk.website);
  });

  it("only asks about stubs that have a key", () => {
    const keys = [discoveryKeys({ key: "a" }), discoveryKeys({ key: "b", instagramUrl: "https://www.instagram.com/b_pan/" })];
    expect(screenableStubs(keys).map((k) => k.key)).toEqual(["b"]);
  });
});

describe("rejectionMemoryEntry", () => {
  it("treats only shop-caused rejections as durable", () => {
    expect([...DURABLE_REJECTIONS]).toEqual(["site_without_email"]);
    for (const transient of ["daily_cap", "excluded", "do_not_contact", "duplicate", "persist_failed", "dedupe_unavailable", "no_eligible_channel"]) {
      expect(isDurableRejection(transient), transient).toBe(false);
    }
    const notDurable: RejectionReason[] = [
      "outside_nagoya", "unsupported_category", "missing_source", "invalid_website", "invalid_instagram", "no_eligible_channel",
      "website_not_rechecked", "website_unknown_without_email", "unsourced_name_or_address", "message_contains_url", "unsafe_content",
    ];
    for (const reason of notDurable) expect(rejectionMemoryEntry(verifiedInput(), reason), reason).toBeNull();
  });

  it("remembers a site without email by handle and website key only", () => {
    const input = verifiedInput({ website: { status: "present", url: "https://www.pan-site.example.com/about", checks: 1 } });
    expect(prepareCandidate(input)).toEqual({ stage: "rejected", reason: "site_without_email" });
    const entry = rejectionMemoryEntry(input, "site_without_email");
    const dk = dedupeKeys({ name: input.name, address: input.address, websiteUrl: input.website.url, instagramUrl: input.instagramUrl });
    expect(entry).toEqual({
      key: input.key,
      reason: "site_without_email",
      keys: [
        { type: "instagram_handle", value: dk.instagram },
        { type: "website_domain", value: "pan-site.example.com" },
      ],
    });
    // No name / address: screening never matches on it.
    expect(JSON.stringify(entry)).not.toContain(input.address);
  });

  it("does not remember a shop with no channel (it has no screening key)", () => {
    const input = verifiedInput({ instagramUrl: null });
    expect(prepareCandidate(input)).toEqual({ stage: "rejected", reason: "no_eligible_channel" });
    expect(rejectionMemoryEntry(input, "no_eligible_channel")).toBeNull();
  });

  it("does not remember a site without email when any email was submitted (a submission mistake)", () => {
    const at = (address: string, sourceUrl: string, sourceType: "other" | "official_contact" | "official_site") => ({ address, sourceUrl, sourceType });
    for (const email of [
      at("owner@pan.example.com", "https://linktr.ee/x", "other"), // wrong source type
      at("info@pan-typo.example.com", "https://pan-typo.example.com/contact", "official_contact"), // other site
      at("info@shop.pan-site.example.com", "https://shop.pan-site.example.com/", "official_site"), // other subdomain
    ]) {
      const input = verifiedEmailInput({ instagramUrl: "https://www.instagram.com/typo_pan/", website: { status: "present", url: "https://pan-site.example.com/", checks: 1 }, email });
      expect(prepareCandidate(input), email.address).toEqual({ stage: "rejected", reason: "site_without_email" });
      expect(rejectionMemoryEntry(input, "site_without_email"), email.address).toBeNull();
    }
    const none = verifiedEmailInput({ instagramUrl: "https://www.instagram.com/typo_pan/", website: { status: "present", url: "https://pan-site.example.com/", checks: 1 }, email: null });
    expect(rejectionMemoryEntry(none, "site_without_email")?.keys.map((k) => k.type)).toEqual(["instagram_handle", "website_domain"]);
    const absent = { ...none } as Partial<typeof none>;
    delete absent.email;
    expect(rejectionMemoryEntry(absent as typeof none, "site_without_email")).not.toBeNull();
  });

  it("never stores an email, plain or as part of a key", () => {
    const input = verifiedInput({ website: { status: "present", url: "https://owner-pan.example.com/", checks: 1 } });
    const json = JSON.stringify(rejectionMemoryEntry(input, "site_without_email"));
    expect(json).not.toContain("@");
  });
});

describe("memory key validation (same rules as the table)", () => {
  it("accepts the keys the table accepts", () => {
    for (const k of [
      { type: "instagram_handle", value: "test_pan.2" },
      { type: "website_domain", value: "pan.example.com" },
      { type: "website_domain", value: "ameblo.jp/test-pan" },
    ]) expect(isValidMemoryKey(k), k.value).toBe(true);
  });

  it("refuses bad types, shapes, lengths, whitespace and emails", () => {
    for (const k of [
      { type: "name_address", value: "店|愛知県名古屋市中区1-1" },
      { type: "email", value: "x" },
      { type: "instagram_handle", value: "Bad_Handle" },
      { type: "instagram_handle", value: "a".repeat(31) },
      { type: "instagram_handle", value: "" },
      { type: "website_domain", value: "Pan.example.com" },
      { type: "website_domain", value: "ab" },
      { type: "website_domain", value: `${"a".repeat(509)}.com` },
      { type: "website_domain", value: "pan example.com" },
      { type: "website_domain", value: "note.com/owner@pan.example.com" },
      { type: "instagram_handle", value: 42 },
    ]) expect(isValidMemoryKey(k), String(k.value)).toBe(false);
  });

  it("drops bad keys and keyless or non-durable entries before sending", () => {
    const entries = [
      { key: "a", reason: "site_without_email", keys: [{ type: "instagram_handle", value: "Bad Handle" }, { type: "website_domain", value: "a.example.com" }] },
      { key: "b", reason: "site_without_email", keys: [{ type: "website_domain", value: "owner@b.example.com" }] },
      { key: "c", reason: "no_eligible_channel", keys: [{ type: "instagram_handle", value: "c_pan" }] },
      { key: "", reason: "site_without_email", keys: [{ type: "instagram_handle", value: "d_pan" }] },
    ] as unknown as RejectionMemoryEntry[];
    expect(validMemoryEntries(entries)).toEqual([{ key: "a", reason: "site_without_email", keys: [{ type: "website_domain", value: "a.example.com" }] }]);
    const many = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, reason: "site_without_email" as const, keys: [{ type: "instagram_handle" as const, value: `k${i}_pan` }] }));
    expect(validMemoryEntries(many)).toHaveLength(10);
  });
});

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;

function fakeDb(rpc: Rpc) {
  const spy = vi.fn(rpc);
  return { db: { rpc: spy } as unknown as SupabaseClient, spy };
}

function runState(over: Record<string, unknown> = {}) {
  return {
    run_id: runId,
    status: "running",
    phase: "discovered",
    checkpoint_at: new Date().toISOString(),
    persist_attempts: 0,
    error_code: null,
    error_summary: null,
    discovered_keys: [],
    verified_order: [],
    candidates: {},
    replayed: false,
    ...over,
  };
}

const parse = (body: unknown) => ingestRequest.parse(body) as IngestRequest;

const discoveredRequest = () =>
  parse({
    action: "checkpoint",
    runId,
    phase: "discovered",
    candidates: [
      { key: "c01", name: "テスト店A", category: "bakery", ward: "中区", instagramUrl: "https://www.instagram.com/known_pan/" },
      { key: "c02", name: "テスト店B", category: "cafe", ward: "東区", websiteUrl: "https://new-cafe.example.com/" },
      { key: "c03", name: "テスト店C", category: "baked_goods", ward: null },
    ],
  });

describe("discovered checkpoint screening", () => {
  it("marks known stubs and returns only that they are known", async () => {
    let stored: { candidates: Array<Record<string, unknown>> } | null = null;
    const { db, spy } = fakeDb(async (fn, args) => {
      if (fn === "sales_discovery_known_keys") return { data: ["c01", "zz"], error: null };
      if (fn === "sales_run_checkpoint") {
        stored = args.p_payload as typeof stored;
        return { data: runState({ discovered_keys: ["c01", "c02", "c03"], known_keys: ["c01"], discovered: stored!.candidates }), error: null };
      }
      throw new Error(`unexpected ${fn}`);
    });
    const result = await handleIngest(db, discoveredRequest());
    expect(result.status).toBe(200);

    // Only the keys the server derived are asked about: no name, ward or category.
    const screen = spy.mock.calls.find(([fn]) => fn === "sales_discovery_known_keys")!;
    expect(screen[1]).toEqual({
      p_stubs: [
        { key: "c01", instagram_handle: "known_pan", website_domain: null },
        { key: "c02", instagram_handle: null, website_domain: "new-cafe.example.com" },
      ],
    });
    // The mark is stored with the stub (a key not asked about is ignored).
    expect(stored!.candidates.map((c) => c.known ?? false)).toEqual([true, false, false]);

    const run = (result.body as { run: ReturnType<typeof toView> }).run;
    expect(run.knownKeys).toEqual(["c01"]);
    expect(run.discovered.map((c) => [c.key, c.known])).toEqual([["c01", true], ["c02", false], ["c03", false]]);
    const text = JSON.stringify(result.body);
    for (const leak of ["exclusion", "excluded", "prospect_id", "do_not_contact", "rejected_candidates", "reason"]) expect(text).not.toContain(leak);
  });

  it("fails open: a screening error marks nothing and the checkpoint is still saved", async () => {
    for (const failure of [
      async () => ({ data: null, error: { message: "function public.sales_discovery_known_keys does not exist" } }),
      async () => {
        throw new Error("network");
      },
    ]) {
      let stored: { candidates: Array<Record<string, unknown>> } | null = null;
      const { db } = fakeDb(async (fn, args) => {
        if (fn === "sales_discovery_known_keys") return failure();
        stored = args.p_payload as typeof stored;
        return { data: runState({ discovered: stored!.candidates }), error: null };
      });
      const result = await handleIngest(db, discoveredRequest());
      expect(result.status).toBe(200);
      expect(stored!.candidates.some((c) => "known" in c)).toBe(false);
      expect((result.body as { run: ReturnType<typeof toView> }).run.knownKeys).toEqual([]);
    }
  });

  it("does not call the screen when no stub has a key", async () => {
    const { db, spy } = fakeDb(async () => ({ data: runState(), error: null }));
    await handleIngest(db, parse({ action: "checkpoint", runId, phase: "discovered", candidates: [{ key: "c01", name: "店", category: "cafe" }] }));
    expect(spy.mock.calls.map(([fn]) => fn)).toEqual(["sales_run_checkpoint"]);
  });

  it("does not let Op Claude set the mark itself (strict schema)", () => {
    const body = { action: "checkpoint", runId, phase: "discovered", candidates: [{ key: "c01", name: "店", category: "cafe", known: false }] };
    expect(ingestRequest.safeParse(body).success).toBe(false);
  });
});

describe("verified checkpoint memory", () => {
  const site = () => verifiedInput({ key: "s01", website: { status: "present", url: "https://memo-site.example.com/", checks: 1 } });

  it("remembers only durable rejections after the checkpoint is saved", async () => {
    const order: string[] = [];
    const { db, spy } = fakeDb(async (fn) => {
      order.push(fn);
      if (fn === "sales_run_checkpoint") return { data: runState({ phase: "verified" }), error: null };
      return { data: 1, error: null };
    });
    const unsourced = verifiedInput({ key: "u01", facts: [] }); // missing_source: not durable
    const daily = verifiedInput({ key: "ok01" }); // pending
    await handleIngest(db, parse({ action: "checkpoint", runId, phase: "verified", candidates: [site(), unsourced, daily] }));
    expect(order).toEqual(["sales_run_checkpoint", "sales_remember_rejections"]);
    const args = spy.mock.calls[1][1] as { p_run_id: string; p_entries: Array<{ key: string; reason: string }> };
    expect(args.p_run_id).toBe(runId);
    expect(args.p_entries.map((e) => [e.key, e.reason])).toEqual([["s01", "site_without_email"]]);
  });

  it("does not remember for a replayed, finished or failed run, and ignores memory errors", async () => {
    for (const state of [runState({ phase: "verified", replayed: true }), runState({ status: "completed", phase: "completed", replayed: true }), runState({ status: "failed", phase: "discovered" })]) {
      const { db, spy } = fakeDb(async () => ({ data: state, error: null }));
      await handleIngest(db, parse({ action: "checkpoint", runId, phase: "verified", candidates: [site()] }));
      expect(spy.mock.calls.map(([fn]) => fn)).toEqual(["sales_run_checkpoint"]);
    }
    const { db } = fakeDb(async (fn) => {
      if (fn === "sales_run_checkpoint") return { data: runState({ phase: "verified" }), error: null };
      throw new Error("memory down");
    });
    const result = await handleIngest(db, parse({ action: "checkpoint", runId, phase: "verified", candidates: [site()] }));
    expect(result.status).toBe(200);
  });

  it("does not call the memory when nothing durable was rejected", async () => {
    const { db, spy } = fakeDb(async () => ({ data: runState({ phase: "verified" }), error: null }));
    await handleIngest(db, parse({ action: "checkpoint", runId, phase: "verified", candidates: [verifiedInput()] }));
    expect(spy.mock.calls.map(([fn]) => fn)).toEqual(["sales_run_checkpoint"]);
  });
});

describe("toView (backward compatible)", () => {
  it("keeps every existing field and adds knownKeys / discovered[].known", () => {
    const view = toView(runState({ discovered_keys: ["c01"], discovered: [{ key: "c01", name: "店", category: "cafe", ward: null, website_url: null, instagram_url: null }] }) as never);
    expect(Object.keys(view).sort()).toEqual(
      ["candidates", "checkpointAt", "discovered", "discoveredKeys", "errorCode", "errorSummary", "knownKeys", "nextAction", "persistAttempts", "phase", "replayed", "runId", "status"].sort(),
    );
    expect(view.knownKeys).toEqual([]);
    expect(view.discovered[0]).toEqual({ key: "c01", name: "店", category: "cafe", ward: null, websiteUrl: null, instagramUrl: null, known: false });
  });

  it("derives knownKeys from the stubs when the database does not return them yet", () => {
    const view = toView(runState({ discovered: [{ key: "c09", name: "店", category: "cafe", ward: null, website_url: null, instagram_url: null, known: true }] }) as never);
    expect(view.knownKeys).toEqual(["c09"]);
  });
});
