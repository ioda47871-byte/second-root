import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { renderDemo, renderDesignedDemo } from "@/components/demo/renderDemo";
import type { DesignProfile } from "@/lib/design-agent/profile";
import { FACT_KEYS } from "@/lib/design-agent/worker/queue";
import { loadPublicDemo } from "@/lib/sales/demo-data";
import {
  aiDesignEnabled,
  DESIGN_STATUSES,
  initialSendAllowed,
  renderableProfile,
  uploadableProfile,
  type DesignStatus,
} from "@/lib/sales/design";
import { authorizeBridge } from "@/lib/sales/design-bridge-auth";
import { factsFromView, jobSource } from "@/lib/sales/design-bridge";
import {
  ClaimResponseSchema,
  DESIGN_FACT_KEYS,
  designBridgeRequest,
  DesignJobSchema,
  workerJobIdFor,
} from "@/lib/sales/design-bridge-schema";
import { toDemoView } from "@/lib/sales/demo-content";
import { AMERICAN_EDITORIAL, SHOP } from "../design-agent/fixtures";

// DEV-030 (Sales Design Bridge): the feature flag, the rules for what may be
// drawn and sent, the strict bridge schema and its auth, and the public demo
// with and without a design profile. Database behaviour is covered by
// tests/integration/design-bridge*.test.ts.

const PROFILE: DesignProfile = { ...AMERICAN_EDITORIAL, rationale: [] };
const JOB_ID = "6f1c2e7a-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const TOKEN = "bridge-token-0123456789abcdef-0123456789";
const INGEST = "ingest-token-0123456789abcdef-0123456789";

describe("feature flag", () => {
  it("is on only for exactly 'true'", () => {
    expect(aiDesignEnabled({ SALES_AI_DESIGN_ENABLED: "true" })).toBe(true);
    for (const value of [undefined, "", "false", "TRUE", "1", "yes", " true"]) {
      expect(aiDesignEnabled({ SALES_AI_DESIGN_ENABLED: value })).toBe(false);
    }
  });
});

describe("renderableProfile (what reaches the renderer from the database)", () => {
  const ok = { enabled: true, status: "ready", profile: PROFILE };

  it("returns the checked profile only when enabled and ready", () => {
    expect(renderableProfile(ok)).toEqual(PROFILE);
    expect(renderableProfile({ ...ok, enabled: false })).toBeNull();
    for (const status of DESIGN_STATUSES.filter((s) => s !== "ready")) expect(renderableProfile({ ...ok, status })).toBeNull();
    expect(renderableProfile({ ...ok, status: null })).toBeNull();
  });

  it("re-validates the stored JSON: schema, contrast, repeated motifs, rationale, unknown keys", () => {
    expect(renderableProfile({ ...ok, profile: null })).toBeNull();
    expect(renderableProfile({ ...ok, profile: "{}" })).toBeNull();
    expect(renderableProfile({ ...ok, profile: { ...PROFILE, direction: "brutalist" } })).toBeNull();
    expect(renderableProfile({ ...ok, profile: { ...PROFILE, extra: "<script>" } })).toBeNull();
    expect(renderableProfile({ ...ok, profile: { ...PROFILE, palette: { ...PROFILE.palette, text: PROFILE.palette.background } } })).toBeNull();
    expect(renderableProfile({ ...ok, profile: { ...PROFILE, motifs: ["dot_grid", "dot_grid"] } })).toBeNull();
    expect(renderableProfile({ ...ok, profile: { ...PROFILE, rationale: ["Codex words"] } })).toBeNull();
  });

  it("an uploadable profile never carries the rationale", () => {
    expect(uploadableProfile(AMERICAN_EDITORIAL).rationale).toEqual([]);
  });
});

describe("initialSendAllowed", () => {
  it("off: always (legacy); on: not while pending or processing", () => {
    const all: (DesignStatus | null)[] = [null, ...DESIGN_STATUSES];
    for (const s of all) expect(initialSendAllowed(false, s)).toBe(true);
    expect(all.filter((s) => !initialSendAllowed(true, s))).toEqual(["pending", "processing"]);
  });
});

describe("bridge auth (the server holds only the token's SHA-256)", () => {
  const sha = (t: string) => createHash("sha256").update(t).digest("hex");
  const env = { SALES_AI_DESIGN_ENABLED: "true", SALES_DESIGN_BRIDGE_TOKEN_SHA256: sha(TOKEN), SALES_AGENT_INGEST_TOKEN: INGEST };

  it("accepts only the token whose SHA-256 is configured", () => {
    expect(authorizeBridge(`Bearer ${TOKEN}`, env)).toBe("ok");
    expect(authorizeBridge(`Bearer ${TOKEN}`, { ...env, SALES_DESIGN_BRIDGE_TOKEN_SHA256: sha(TOKEN).toUpperCase() })).toBe("ok");
    expect(authorizeBridge(`Bearer ${INGEST}`, env)).toBe("denied");
    expect(authorizeBridge(`Bearer ${TOKEN}x`, env)).toBe("denied");
    // the digest itself is not a credential
    expect(authorizeBridge(`Bearer ${sha(TOKEN)}`, env)).toBe("denied");
    expect(authorizeBridge(TOKEN, env)).toBe("denied");
    expect(authorizeBridge(null, env)).toBe("denied");
    // too short or with non-visible characters: refused before hashing
    const short = "s".repeat(31);
    expect(authorizeBridge(`Bearer ${short}`, { ...env, SALES_DESIGN_BRIDGE_TOKEN_SHA256: sha(short) })).toBe("denied");
  });

  it("fails closed: flag off, digest unset or malformed, a raw token on the server, the ingest token's digest", () => {
    expect(authorizeBridge(`Bearer ${TOKEN}`, { ...env, SALES_AI_DESIGN_ENABLED: undefined })).toBe("disabled");
    expect(authorizeBridge(`Bearer ${TOKEN}`, { ...env, SALES_AI_DESIGN_ENABLED: "false" })).toBe("disabled");
    for (const bad of [undefined, "", "abc", sha(TOKEN).slice(1), `${sha(TOKEN)}0`, sha(TOKEN).replace(/^./, "g"), `sha256:${sha(TOKEN)}`]) {
      expect(authorizeBridge(`Bearer ${TOKEN}`, { ...env, SALES_DESIGN_BRIDGE_TOKEN_SHA256: bad }), String(bad)).toBe("unconfigured");
    }
    // the raw token must never be configured on the server, even together with a valid digest
    expect(authorizeBridge(`Bearer ${TOKEN}`, { ...env, SALES_DESIGN_BRIDGE_TOKEN: TOKEN })).toBe("unconfigured");
    expect(authorizeBridge(`Bearer ${INGEST}`, { ...env, SALES_DESIGN_BRIDGE_TOKEN_SHA256: sha(INGEST) })).toBe("unconfigured");
    // a 64-hex token configured as if it were its own digest: the raw token is on the server
    const hexToken = sha("some seed");
    expect(authorizeBridge(`Bearer ${hexToken}`, { ...env, SALES_DESIGN_BRIDGE_TOKEN_SHA256: hexToken })).toBe("unconfigured");
    expect(authorizeBridge(`Bearer ${hexToken.toUpperCase()}`, { ...env, SALES_DESIGN_BRIDGE_TOKEN_SHA256: hexToken })).toBe("unconfigured");
  });
});

describe("bridge request schema (strict: nothing but the allowed fields)", () => {
  const submit = {
    action: "submit",
    jobId: JOB_ID,
    outcome: "ready",
    profile: PROFILE,
    errorCode: null,
    workerCommit: "0123abcd",
    lineage: { workerJobId: workerJobIdFor(JOB_ID) },
  };

  it("accepts claim and a well-formed submit", () => {
    expect(designBridgeRequest.safeParse({ action: "claim" }).success).toBe(true);
    expect(designBridgeRequest.safeParse(submit).success).toBe(true);
    expect(designBridgeRequest.safeParse({ ...submit, outcome: "blocked", profile: null, errorCode: "DESIGN_BLOCKED" }).success).toBe(true);
    expect(designBridgeRequest.safeParse({ ...submit, outcome: "failed", profile: null, errorCode: "WORKER_FAILED", workerCommit: null }).success).toBe(true);
  });

  it.each(["screenshot", "screenshots", "html", "raw_html", "cookie", "cookies", "session", "prompt", "codex_output", "stdout", "stderr", "reasoning", "rationale", "report", "image"])(
    "refuses an extra %s key anywhere",
    (key) => {
      expect(designBridgeRequest.safeParse({ ...submit, [key]: "x" }).success).toBe(false);
      expect(designBridgeRequest.safeParse({ ...submit, lineage: { ...submit.lineage, [key]: "x" } }).success).toBe(false);
      expect(designBridgeRequest.safeParse({ ...submit, profile: { ...PROFILE, [key]: "x" } }).success).toBe(false);
      expect(designBridgeRequest.safeParse({ action: "claim", [key]: "x" }).success).toBe(false);
    },
  );

  it("refuses inconsistent results, free text and a lineage mismatch", () => {
    const bad = [
      { ...submit, profile: null },
      { ...submit, errorCode: "DESIGN_BLOCKED" },
      { ...submit, outcome: "blocked", errorCode: "DESIGN_BLOCKED" },
      { ...submit, outcome: "failed", profile: null, errorCode: null },
      { ...submit, outcome: "failed", profile: null, errorCode: "something went wrong: see stderr" },
      { ...submit, profile: { ...PROFILE, rationale: ["I looked at the photos and"] } },
      { ...submit, workerCommit: "main" },
      { ...submit, lineage: { workerJobId: workerJobIdFor("7f1c2e7a-3b4d-4e5f-8a9b-0c1d2e3f4a5b") } },
      { ...submit, jobId: "not-a-uuid" },
      { ...submit, outcome: "done" },
      { action: "status" },
    ];
    for (const body of bad) expect(designBridgeRequest.safeParse(body).success, JSON.stringify(body).slice(0, 80)).toBe(false);
  });

  it("a claimed job carries facts and source URLs only", () => {
    const job = { jobId: JOB_ID, workerJobId: workerJobIdFor(JOB_ID), attempt: 1, facts: { name: "店", category: "cafe" }, source: { instagram_url: "https://www.instagram.com/x/" } };
    expect(DesignJobSchema.safeParse(job).success).toBe(true);
    expect(ClaimResponseSchema.safeParse({ job: null }).success).toBe(true);
    expect(DesignJobSchema.safeParse({ ...job, prospectId: JOB_ID }).success).toBe(false);
    expect(DesignJobSchema.safeParse({ ...job, facts: { ...job.facts, public_email: "a@example.com" } }).success).toBe(false);
    expect(DesignJobSchema.safeParse({ ...job, source: {} }).success).toBe(false);
    expect(DesignJobSchema.safeParse({ ...job, workerJobId: "b-other" }).success).toBe(false);
  });

  it("uses the same fact keys as the worker's job filter", () => {
    expect([...DESIGN_FACT_KEYS]).toEqual([...FACT_KEYS]);
  });
});

describe("job contents", () => {
  it("facts are the fact-only DemoView (emails and unknown keys dropped)", () => {
    const view = toDemoView("cafe_v1", { name: "テスト喫茶", category: "cafe", description: "連絡は info@example.com まで", menu_items: ["珈琲"], owner_note: "内部メモ" })!;
    expect(factsFromView(view)).toEqual({ name: "テスト喫茶", category: "cafe", menu_items: ["珈琲"] });
  });

  it("source: only a verified official site and a canonical Instagram profile", () => {
    expect(jobSource({ website_url: "https://shop.example.com/", instagram_url: "https://instagram.com/Test_Shop" })).toEqual({
      website_url: "https://shop.example.com/",
      instagram_url: "https://www.instagram.com/test_shop/",
    });
    expect(jobSource({ website_url: "https://tabelog.com/aichi/x/", instagram_url: null })).toBeNull();
    expect(jobSource({ website_url: "javascript:alert(1)", instagram_url: "https://www.instagram.com/p/abc/" })).toBeNull();
  });
});

describe("public demo with a design profile", () => {
  it("draws the profile renderer for a profile and the existing template otherwise, with the same notice and footer", () => {
    const designed = renderToStaticMarkup(renderDesignedDemo(SHOP, PROFILE));
    const legacy = renderToStaticMarkup(renderDesignedDemo(SHOP, null));
    expect(legacy).toBe(renderToStaticMarkup(renderDemo(SHOP)));
    expect(designed).toContain('data-direction="american_editorial"');
    expect(legacy).not.toContain("data-direction");
    for (const html of [designed, legacy]) {
      expect(html).toContain('role="note"');
      expect(html).toContain("様の公式サイトではありません。");
      expect(html).toContain("掲載内容は確認できた公開情報のみで、公式サイト・公式情報ではありません。");
      expect(html).not.toContain("<img");
    }
  });
});

describe("loadPublicDemo", () => {
  const token = "A".repeat(43);
  const sent = new Date(Date.now() + 86_400_000).toISOString();
  const content = { name: "EXAMPLE TEST", category: "baked_goods" };

  function fakeDb(row: Record<string, unknown> | null) {
    const select = vi.fn();
    const chain = { select, eq: () => chain, maybeSingle: async () => ({ data: row, error: null }) };
    select.mockReturnValue(chain);
    return { db: { from: () => chain } as never, select };
  }

  it("flag off: the legacy query and no profile, even for a ready row", async () => {
    const { db, select } = fakeDb({ template: "baked_goods_v1", content, expires_at: sent, disabled_at: null, keep_alive: false, design_status: "ready", design_profile: PROFILE });
    const demo = await loadPublicDemo(db, token, new Date(), {});
    expect(select).toHaveBeenCalledWith("template, content, expires_at, disabled_at, keep_alive");
    expect(demo).toMatchObject({ profile: null, view: { name: "EXAMPLE TEST" } });
  });

  it("flag on: a ready, valid profile is used; an invalid one falls back", async () => {
    const env = { SALES_AI_DESIGN_ENABLED: "true" };
    const ready = fakeDb({ template: "baked_goods_v1", content, expires_at: sent, disabled_at: null, keep_alive: false, design_status: "ready", design_profile: PROFILE });
    expect((await loadPublicDemo(ready.db, token, new Date(), env))?.profile).toEqual(PROFILE);
    expect(ready.select).toHaveBeenCalledWith("template, content, expires_at, disabled_at, keep_alive, design_status, design_profile");
    const broken = fakeDb({ template: "baked_goods_v1", content, expires_at: sent, disabled_at: null, keep_alive: false, design_status: "ready", design_profile: { ...PROFILE, version: 2 } });
    expect((await loadPublicDemo(broken.db, token, new Date(), env))?.profile).toBeNull();
    const pending = fakeDb({ template: "baked_goods_v1", content, expires_at: sent, disabled_at: null, keep_alive: false, design_status: "pending", design_profile: null });
    expect((await loadPublicDemo(pending.db, token, new Date(), env))?.profile).toBeNull();
  });

  it("visibility rules are unchanged: unsent and disabled stay hidden with a ready design", async () => {
    const env = { SALES_AI_DESIGN_ENABLED: "true" };
    const base = { template: "baked_goods_v1", content, keep_alive: false, design_status: "ready", design_profile: PROFILE };
    expect(await loadPublicDemo(fakeDb({ ...base, expires_at: null, disabled_at: null }).db, token, new Date(), env)).toBeNull();
    expect(await loadPublicDemo(fakeDb({ ...base, expires_at: sent, disabled_at: new Date().toISOString() }).db, token, new Date(), env)).toBeNull();
    expect(await loadPublicDemo(fakeDb({ ...base, expires_at: new Date(Date.now() - 1000).toISOString(), disabled_at: null }).db, token, new Date(), env)).toBeNull();
  });
});
