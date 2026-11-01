import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { auditIdentity, auditPageText, cleanName, cleanPageName } from "@/lib/design-agent/identity/identity-lock";

// DEV-126 (Phase 2c, Issue #159): Identity Lock ported from the research script identity-audit.mjs (PR #142).
// The image cases are the research script's own tests, with the same verdicts and codes. Offline, fictional or
// research-recorded names only.

const sha = "a".repeat(64);
const base = () => ({
  schema_version: 1,
  case_id: "CP-015",
  attempt_id: "cp015-imairo-v1",
  target: { official_name: "imairo.", allowed_aliases: ["spice & cafe imairo", "imairo"], category_code: "spice_cafe_patisserie", official_source_url: "https://example.invalid/research/cp-015" },
  prompt: { shop_name: "imairo.", category_code: "spice_cafe_patisserie", is_research_only: true },
  output: { image_sha256: sha },
  visual_inspection: {
    status: "completed",
    method: "assistant_visual",
    inspected_image_sha256: sha,
    visible_site_identity_labels: ["imairo."],
    category_code: "spice_cafe_patisserie",
    unreadable_site_identity: false,
    image_looks_like_unrelated_shop: false,
    reviewer_note: "Site header imairo.; spice, cake, coffee sections visible.",
  } as Record<string, unknown>,
});

describe("generated images (the research script's cases, same verdicts)", () => {
  it("a matching output passes identity only, and never counts as owner success", () => {
    const r = auditIdentity(base());
    expect([r.status, r.can_show_as_target_design, r.counts_as_owner_success]).toEqual(["PASS_IDENTITY_ONLY", true, false]);
  });

  it("CP-015: the cobaco bookshop swap fails name AND category; CP-014: the KOALA bakery swap is rejected", () => {
    const a = base();
    a.visual_inspection.visible_site_identity_labels = ["cobaco"];
    a.visual_inspection.category_code = "bookshop_zine";
    expect(auditIdentity(a)).toMatchObject({ status: "REJECT", errors: expect.arrayContaining(["VISIBLE_WRONG_OR_EXTRA_SHOP_NAME", "VISUAL_WRONG_CATEGORY"]) });
    const b = base();
    b.case_id = "CP-014";
    b.target = { official_name: "CAN BUY RECORDS", allowed_aliases: [], category_code: "record_shop", official_source_url: "https://example.invalid/research/cp-014" };
    b.prompt = { shop_name: "CAN BUY RECORDS", category_code: "record_shop", is_research_only: true };
    b.visual_inspection.visible_site_identity_labels = ["KOALA"];
    b.visual_inspection.category_code = "bakery_cafe";
    expect(auditIdentity(b).status).toBe("REJECT");
  });

  it("blocks prompt contamination, an uninspected image, another image's inspection, a second name, an unreadable brand", () => {
    const p = base();
    p.prompt.shop_name = "cobaco";
    expect(auditIdentity(p).errors).toContain("PROMPT_WRONG_SHOP");
    const u = base();
    u.visual_inspection = { status: "pending" };
    expect(auditIdentity(u)).toMatchObject({ status: "HOLD", can_show_as_target_design: false });
    const o = base();
    o.visual_inspection.inspected_image_sha256 = "b".repeat(64);
    expect(auditIdentity(o)).toMatchObject({ status: "REJECT", errors: expect.arrayContaining(["INSPECTION_IMAGE_NOT_MATCHED"]) });
    const two = base();
    two.visual_inspection.visible_site_identity_labels = ["imairo.", "cobaco"];
    expect(auditIdentity(two).status).toBe("REJECT");
    const unreadable = base();
    unreadable.visual_inspection.unreadable_site_identity = true;
    expect(auditIdentity(unreadable).status).toBe("HOLD");
  });

  it("a missing source, an empty category, no research flag, or missing determinations never pass", () => {
    const a = base() as Record<string, unknown> & ReturnType<typeof base>;
    delete (a.target as Record<string, unknown>).official_source_url;
    a.prompt.is_research_only = false as never;
    a.target.category_code = "";
    expect(auditIdentity(a)).toMatchObject({ status: "REJECT", errors: expect.arrayContaining(["TARGET_IDENTITY_INCOMPLETE", "NOT_MARKED_RESEARCH_ONLY"]) });
    const m = base();
    delete m.visual_inspection.unreadable_site_identity;
    delete m.visual_inspection.image_looks_like_unrelated_shop;
    expect(auditIdentity(m)).toMatchObject({ status: "HOLD", pending: expect.arrayContaining(["BRAND_READABILITY_NOT_RECORDED", "UNRELATED_SHOP_CHECK_MISSING"]) });
    // anything that is not an object fails closed, without throwing
    for (const bad of [null, undefined, 42, "x", []]) expect(auditIdentity(bad).status).toBe("REJECT");
  });
});

describe("review fixes (DEV-126 Fresh Review)", () => {
  it("M1: only the exact method strings count as a completed inspection (as in the research script)", () => {
    for (const method of [["assistant_visual"], { toString: () => "assistant_visual" }, Object.create(null)]) {
      const a = base();
      a.visual_inspection.method = method;
      expect(auditIdentity(a).status).toBe("HOLD");
    }
  });

  it("L1: a name that cleans to nothing never matches (missing shop name, symbol-only labels)", () => {
    const a = base();
    a.target.allowed_aliases = ["♪"];
    a.prompt.shop_name = undefined as never;
    expect(auditIdentity(a).errors).toContain("PROMPT_WRONG_SHOP");
    for (const labels of [["☆☆"], [null]]) {
      const b = base();
      b.target.allowed_aliases = ["♪"];
      b.visual_inspection.visible_site_identity_labels = labels;
      expect(auditIdentity(b).status).toBe("REJECT");
    }
  });
});

describe("generated HTML pages (visible text)", () => {
  // the fictional wagashi shop, with the shops of the references it is shown (they must never appear on its page)
  const wagashi = (o: Record<string, unknown> = {}) => ({
    schema_version: 1,
    case_id: "CP-900",
    attempt_id: "fictional-wagashi-v2-a",
    target: { official_name: "架空菓庵", allowed_aliases: [], category_code: "wagashi", official_source_url: "design-library/phase2f/wagashi-facts-pack.json" },
    prompt: { shop_name: "架空菓庵", category_code: "wagashi", is_research_only: true },
    other_shop_names: ["NAGOYA BEANS", "なごやビーンズ", "豆＊豆", "ズールー工作所"],
    ...o,
  });

  it("the target's name on the page and no other shop passes identity only", () => {
    expect(auditPageText(wagashi(), "架空菓庵　毎朝炊く粒あん　実在の店舗ではありません").status).toBe("PASS_IDENTITY_ONLY");
  });

  it("a reference shop's name copied into the page is rejected, in any width or case", () => {
    expect(auditPageText(wagashi(), "架空菓庵 ／ Ｎａｇｏｙａ　Ｂｅａｎｓ").errors).toContain("VISIBLE_WRONG_OR_EXTRA_SHOP_NAME");
    expect(auditPageText(wagashi(), "架空菓庵 豆*豆").errors).toContain("VISIBLE_WRONG_OR_EXTRA_SHOP_NAME");
  });

  it("a page without the target's name, an empty page, or no list of other shops never passes", () => {
    expect(auditPageText(wagashi(), "毎朝炊く粒あん").errors).toContain("TARGET_NAME_NOT_ON_PAGE");
    expect(auditPageText(wagashi(), "").status).toBe("HOLD");
    expect(auditPageText(wagashi({ other_shop_names: undefined }), "架空菓庵").pending).toContain("OTHER_SHOP_NAMES_NOT_GIVEN");
  });

  it("M2: a malformed list of other shops is an error; an empty one leaves the page unconfirmed", () => {
    expect(auditPageText(wagashi({ other_shop_names: [null, 42] }), "架空菓庵 NAGOYA BEANS").errors).toContain("OTHER_SHOP_NAMES_INVALID");
    expect(auditPageText(wagashi({ other_shop_names: "NAGOYA BEANS" }), "架空菓庵").errors).toContain("OTHER_SHOP_NAMES_INVALID");
    expect(auditPageText(wagashi({ other_shop_names: [] }), "架空菓庵")).toMatchObject({ status: "HOLD", pending: ["OTHER_SHOP_NAMES_NOT_GIVEN"] });
  });

  it("re-review: kana folding is for the page check only (the image check keeps the research comparison); a sparse list is invalid", () => {
    const img = base();
    img.target.official_name = "いまいろ";
    img.target.allowed_aliases = [];
    img.prompt.shop_name = "いまいろ";
    img.visual_inspection.visible_site_identity_labels = ["イマイロ"];
    expect(auditIdentity(img).status).toBe("REJECT");
    expect(auditPageText(wagashi({ target: { official_name: "かくうかあん", allowed_aliases: [], category_code: "wagashi", official_source_url: "x" }, prompt: { shop_name: "かくうかあん", category_code: "wagashi", is_research_only: true } }), "カクウカアン").errors).not.toContain("TARGET_NAME_NOT_ON_PAGE");
    expect(auditPageText(wagashi({ other_shop_names: new Array(2) }), "架空菓庵 NAGOYA BEANS").errors).toContain("OTHER_SHOP_NAMES_INVALID");
  });

  it("M3: hiragana and katakana spellings of a listed name are the same name", () => {
    expect(auditPageText(wagashi(), "架空菓庵 ナゴヤビーンズ").errors).toContain("VISIBLE_WRONG_OR_EXTRA_SHOP_NAME");
    expect(cleanPageName("なごや")).toBe(cleanPageName("ナゴヤ"));
  });

  it("names too short to search for, or overlapping the target, are refused as input", () => {
    expect(auditPageText(wagashi({ other_shop_names: ["豆"] }), "架空菓庵").errors).toContain("OTHER_NAME_TOO_SHORT");
    expect(auditPageText(wagashi({ other_shop_names: ["菓庵"] }), "架空菓庵").errors).toContain("OTHER_NAME_OVERLAPS_TARGET");
    expect(auditPageText(wagashi({ target: { official_name: "庵", allowed_aliases: [], category_code: "wagashi", official_source_url: "x" }, prompt: { shop_name: "庵", category_code: "wagashi", is_research_only: true } }), "庵").errors).toContain("TARGET_NAME_TOO_SHORT");
  });

  it("names compare after NFKC and without punctuation", () => {
    expect([cleanName("imairo."), cleanName("ＩＭＡＩＲＯ"), cleanName("豆＊豆")]).toEqual(["imairo", "imairo", "豆豆"]);
  });
});

describe("isolation", () => {
  it("is pure (no I/O) and imported only by its tests until a separate approval wires it in", () => {
    const repo = resolve(__dirname, "../../../..");
    const src = readFileSync(resolve(repo, "lib/design-agent/identity/identity-lock.ts"), "utf8");
    expect(src).not.toMatch(/\bimport\b|require\(|\bfetch\(|process\./);
    // any importer, absolute or relative (L2); git grep exits 1 when nothing matches (an error is 128, never a pass)
    const g = spawnSync("git", ["grep", "--untracked", "-lE", "identity/identity-lock|from [\"'`]\\./identity-lock", "--", ".", ":!lib/design-agent/identity/identity-lock.ts", ":!tests/unit/design-agent/identity/**", ":!.ai/**", ":!docs/**",
      // DEV-131: the one offline experiment test that wires the real modules together (a test, never lib)
      ":!tests/unit/design-agent/offline-integration/phase2-offline-experiment.test.ts",
      // DEV-141 (Issue #180): the three-method study's test checks its fictional shop's lock (a test, never lib)
      ":!tests/unit/design-agent/research/three-methods.test.ts"], { cwd: repo, encoding: "utf8" });
    expect([g.status, g.stdout.trim()]).toEqual([1, ""]);
  });
});
