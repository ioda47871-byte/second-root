import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emailDigest } from "@/lib/sales/email-digest";
import {
  buildTodayEvidence,
  storedEmails,
  contactVerdict,
  formatJstDate,
  mapSources,
  matchExclusions,
  UNCONFIRMED,
  type EvidenceInput,
  type ExclusionRow,
} from "@/lib/sales/evidence";
import { eligibleEmailInput, eligibleInstagramInput } from "./today-evidence-fixture";

// DEV-194: the today card's evidence view model. Missing data reads 未確認,
// the verdict is never sendable where a server rule would refuse, sources map
// field by field, and dates are JST calendar dates.

const stateOf = (input: EvidenceInput, id: string) => contactVerdict(input).checks.find((c) => c.id === id)?.state;

describe("contact verdict: server-rule parity", () => {
  it("an eligible Instagram draft and an eligible email draft are sendable", () => {
    for (const input of [eligibleInstagramInput(), eligibleEmailInput()]) {
      const v = contactVerdict(input);
      expect(v.checks.filter((c) => c.state !== "ok")).toEqual([]);
      expect(v.sendable).toBe(true);
      expect(v.badge).toBe("送信できます");
      expect(v.blockers).toEqual([]);
    }
  });

  // Each case breaks exactly one rule sales_mark_sent / the eligibility
  // trigger / markSent enforces (or one of the UI's stricter checks).
  const refusals: Array<[string, string, EvidenceInput]> = [
    ["sales_mark_sent: not a drafted initial", "outreach_state", eligibleInstagramInput({ outreachStatus: "sent" })],
    ["trigger: do_not_contact", "dnc", eligibleInstagramInput({ doNotContact: true })],
    ["trigger: instagram needs website not_found (present)", "channel_rule", eligibleInstagramInput({ websiteStatus: "present", websiteDomain: "x.example.com" })],
    ["trigger: instagram needs website not_found (unknown)", "channel_rule", eligibleInstagramInput({ websiteStatus: "unknown" })],
    ["trigger: instagram needs a handle", "channel_rule", eligibleInstagramInput({ instagramHandle: null, instagramUrl: null })],
    ["trigger: instagram needs no public email", "channel_rule", eligibleInstagramInput({ publicEmail: "info@x.example.com" })],
    ["trigger: email needs a public email", "channel_rule", eligibleEmailInput({ publicEmail: null })],
    [
      "trigger: email needs a first-party source (map listing only)",
      "channel_rule",
      eligibleEmailInput({
        sources: [{ field: "email", value: "info@test-shop.example.com", source_url: "https://maps.example.com/p/1", source_type: "map_listing", verified_at: "2026-10-01T00:00:00Z" }],
      }),
    ],
    [
      "trigger: email source must be for the same address",
      "channel_rule",
      eligibleEmailInput({
        sources: [{ field: "email", value: "other@test-shop.example.com", source_url: "https://test-shop.example.com/contact", source_type: "official_contact", verified_at: "2026-10-01T00:00:00Z" }],
      }),
    ],
    ["trigger: recommended_channel differs", "recommended_channel", eligibleInstagramInput({ recommendedChannel: "email" })],
    ["trigger: recommended_channel null (is distinct from)", "recommended_channel", eligibleInstagramInput({ recommendedChannel: null })],
    ["markSent: AI design pending", "design", eligibleInstagramInput({ designEnabled: true, designStatus: "pending" })],
    ["markSent: AI design processing", "design", eligibleInstagramInput({ designEnabled: true, designStatus: "processing" })],
    ["follow-up: only email", "outreach_state", eligibleInstagramInput({ kind: "follow_up", outreachStatus: "sent" })],
    ["UI: no usable demo link", "demo_link", eligibleInstagramInput({ demoAvailable: false })],
    ["UI: exclusion added after the draft", "exclusion", eligibleInstagramInput({ exclusion: { state: "match", reasons: ["existing_customer"] } })],
  ];
  it.each(refusals)("%s → not sendable (%s)", (_name, check, input) => {
    const v = contactVerdict(input);
    expect(v.sendable).toBe(false);
    expect(v.badge).toBe("送信できません");
    expect(stateOf(input, check)).toBe("ng");
    expect(v.blockers.length).toBeGreaterThan(0);
  });

  it("unknown values fail closed as 未確認, never sendable", () => {
    const cases: Array<[string, EvidenceInput]> = [
      ["dnc", eligibleInstagramInput({ doNotContact: null })],
      ["exclusion", eligibleInstagramInput({ exclusion: { state: "unchecked" } })],
      ["target", eligibleInstagramInput({ address: null })],
      ["target", eligibleInstagramInput({ category: null })],
      ["channel_rule", eligibleInstagramInput({ websiteStatus: null })],
      ["channel_rule", eligibleEmailInput({ sources: null })],
    ];
    for (const [check, input] of cases) {
      expect(stateOf(input, check)).toBe("unconfirmed");
      expect(contactVerdict(input).sendable).toBe(false);
      expect(contactVerdict(input).blockers.join()).toContain(UNCONFIRMED);
    }
  });

  it("a ready / blocked / failed or legacy design does not stop sending, as markSent", () => {
    for (const s of ["ready", "blocked", "failed", null] as const) {
      expect(contactVerdict(eligibleInstagramInput({ designEnabled: true, designStatus: s })).sendable).toBe(true);
    }
    // Step off: no design check at all (legacy).
    expect(contactVerdict(eligibleInstagramInput({ designStatus: "pending" })).checks.some((c) => c.id === "design")).toBe(false);
  });

  it("a due email follow-up is sendable; the design gate and recommended channel do not apply to it", () => {
    const v = contactVerdict(eligibleEmailInput({ kind: "follow_up", outreachStatus: "sent", designEnabled: true, designStatus: "pending", recommendedChannel: null }));
    expect(v.sendable).toBe(true);
    expect(v.checks.map((c) => c.id)).not.toContain("design");
    expect(v.checks.map((c) => c.id)).not.toContain("recommended_channel");
  });

  it("a follow-up still needs DNC off and first-party email provenance (the follow-up insert re-runs the trigger)", () => {
    expect(contactVerdict(eligibleEmailInput({ kind: "follow_up", outreachStatus: "sent", doNotContact: true })).sendable).toBe(false);
    expect(contactVerdict(eligibleEmailInput({ kind: "follow_up", outreachStatus: "sent", sources: [] })).sendable).toBe(false);
  });

  it("the email match is case-insensitive on the stored source value, as SQL lower(value) = public_email", () => {
    const input = eligibleEmailInput({
      sources: [{ field: "email", value: "Info@Test-Shop.example.com", source_url: "https://test-shop.example.com/contact", source_type: "official_site", verified_at: "2026-10-01T00:00:00Z" }],
    });
    expect(contactVerdict(input).sendable).toBe(true);
  });

  it("marks only the UI's own checks as not server-enforced (DEV-195: the exclusion list and the initial demo are enforced by the database)", () => {
    const ids = contactVerdict(eligibleInstagramInput({ designEnabled: true })).checks.filter((c) => !c.serverEnforced).map((c) => c.id);
    expect(ids).toEqual([]);
    const followUp = contactVerdict(eligibleEmailInput({ kind: "follow_up", outreachStatus: "sent" })).checks.filter((c) => !c.serverEnforced).map((c) => c.id);
    expect(followUp).toEqual(["demo_link"]);
  });

  it("always lists the manual pre-send check of the channel as unconfirmed, without changing sendable", () => {
    expect(contactVerdict(eligibleInstagramInput()).unconfirmed.join()).toContain("DM不可");
    expect(contactVerdict(eligibleEmailInput()).unconfirmed.join()).toContain("営業お断り");
  });

  it("reports email provenance and Instagram", () => {
    const email = contactVerdict(eligibleEmailInput());
    expect(email.emailProvenance).toMatchObject({ state: "first_party", source: { sourceType: "official_contact", sourceUrl: "https://test-shop.example.com/contact" } });
    expect(email.instagram).toBeNull();
    const ig = contactVerdict(eligibleInstagramInput());
    expect(ig.emailProvenance).toEqual({ state: "not_applicable" });
    expect(ig.instagram).toEqual({ handle: "test_shop", url: "https://www.instagram.com/test_shop/" });
    expect(contactVerdict(eligibleEmailInput({ sources: [] })).emailProvenance).toEqual({ state: "missing" });
  });
});

describe("the database rules this mirrors are still the ones in the migrations", () => {
  const sql = (f: string) => readFileSync(new URL(`../../../supabase/migrations/${f}`, import.meta.url), "utf8");
  it("sales_assert_outreach_eligible and sales_has_first_party_email", () => {
    const core = sql("20260927000000_sales_agent_core.sql");
    expect(core).toContain("if p.do_not_contact then");
    expect(core).toContain("not (p.website_status = 'not_found' and p.instagram_handle is not null and p.public_email is null)");
    expect(core).toContain("not (p.public_email is not null and public.sales_has_first_party_email(p.id, p.public_email))");
    expect(core).toContain("if p_kind = 'initial' and p.recommended_channel is distinct from p_channel then");
    expect(core).toContain("and s.source_type in ('official_site', 'official_contact', 'official_profile')");
    expect(core).toContain("and lower(s.value) = p_email");
  });
  it("sales_mark_sent accepts only a drafted initial", () => {
    expect(sql("20260927000200_sales_admin_mark_sent.sql")).toContain("if o.kind <> 'initial' or o.status <> 'drafted' then");
    expect(sql("20261107000000_sales_send_approval.sql")).toContain("if o.kind <> 'initial' or o.status <> 'drafted' then");
  });
  it("DEV-195: the eligibility check refuses an excluded shop, and the send guards refuse a missing demo and a pending design", () => {
    const m = sql("20261107000000_sales_send_approval.sql");
    const eligible = m.slice(m.indexOf("create or replace function public.sales_assert_outreach_eligible"), m.indexOf("create function public.sales_outreach_recipient"));
    expect(eligible).toContain("if p.do_not_contact then");
    expect(eligible).toContain("not (p.website_status = 'not_found' and p.instagram_handle is not null and p.public_email is null)");
    expect(eligible).toContain("not (p.public_email is not null and public.sales_has_first_party_email(p.id, p.public_email))");
    expect(eligible).toContain("if p_kind = 'initial' and p.recommended_channel is distinct from p_channel then");
    expect(eligible).toContain("if public.sales_prospect_excluded(p.id) then");
    expect(m).toContain("if not found or d.disabled_at is not null then");
    expect(m).toContain("if coalesce(p_design_enabled, false) and d.design_status in ('pending', 'processing') then");
  });
});

describe("missing data reads 未確認", () => {
  it("formatJstDate", () => {
    expect(formatJstDate("2026-10-01T15:30:00Z")).toBe("2026/10/02"); // 00:30 JST
    expect(formatJstDate("2026-10-01T14:59:59Z")).toBe("2026/10/01");
    expect(formatJstDate(null)).toBe(UNCONFIRMED);
    expect(formatJstDate("")).toBe(UNCONFIRMED);
    expect(formatJstDate("not a date")).toBe(UNCONFIRMED);
  });

  it("a shop with nothing stored beyond the draft: every selection line, the dates and the sources are 未確認", () => {
    const e = buildTodayEvidence(
      eligibleInstagramInput({ ward: null, category: null, websiteStatus: null, recommendedChannel: null, registeredAt: null, sources: null }),
    );
    const byLabel = Object.fromEntries(e.lines.map((l) => [l.label, l]));
    expect(byLabel["地域"]).toMatchObject({ value: `名古屋市（区は${UNCONFIRMED}）`, unconfirmed: true });
    expect(byLabel["業種"]).toMatchObject({ value: UNCONFIRMED, unconfirmed: true });
    expect(byLabel["公式サイト"]).toMatchObject({ value: UNCONFIRMED, unconfirmed: true });
    expect(byLabel["推奨チャネル"]).toMatchObject({ value: UNCONFIRMED, unconfirmed: true });
    expect(e.researchedDate).toBe(UNCONFIRMED);
    expect(e.registeredDate).toBe(UNCONFIRMED);
    expect(e.sources).toEqual([]);
    expect(e.missingSources.map((m) => m.field)).toEqual(["name", "address", "category", "instagram_url"]);
    expect(e.summary).toContain(UNCONFIRMED);
    expect(e.contact.sendable).toBe(false);
  });

  it("no stored hypothesis is ever invented", () => {
    expect(buildTodayEvidence(eligibleInstagramInput()).hypothesis).toBeNull();
    expect(buildTodayEvidence(eligibleEmailInput()).hypothesis).toBeNull();
  });

  it("the summary restates stored fields only", () => {
    expect(buildTodayEvidence(eligibleInstagramInput()).summary).toBe("名古屋市中区のパン屋。公式サイトが見つからず、推奨チャネルはInstagramの候補。");
    expect(buildTodayEvidence(eligibleEmailInput({ category: "cafe", ward: "東区" })).summary).toBe("名古屋市東区のカフェ。公式サイトはあり、推奨チャネルはメールの候補。");
    expect(buildTodayEvidence(eligibleEmailInput({ websiteStatus: "unknown", websiteDomain: null })).summary).toContain(`公式サイトの有無は${UNCONFIRMED}`);
    expect(buildTodayEvidence(eligibleEmailInput({ recommendedChannel: null })).summary).toContain(`推奨チャネルが${UNCONFIRMED}の候補`);
  });

  it("review L3: the summary never claims the shop can be contacted when the verdict says it cannot", () => {
    const blocked = buildTodayEvidence(eligibleEmailInput({ sources: [] }));
    expect(blocked.contact.sendable).toBe(false);
    expect(blocked.summary).not.toMatch(/連絡できる/);
    expect(blocked.summary).toContain("推奨チャネルはメールの候補");
  });

  it("an email without a first-party source reads 出典未確認", () => {
    const e = buildTodayEvidence(eligibleEmailInput({ sources: [] }));
    expect(e.lines.find((l) => l.label === "メールの出所")).toMatchObject({ value: `出典${UNCONFIRMED}`, unconfirmed: true });
  });
});

describe("sources", () => {
  it("maps each stored row to its field and source type, in field order, with JST dates", () => {
    const rows = [
      { field: "hours", value: "9:00-17:00", source_url: "https://test-shop.example.com/", source_type: "official_site", verified_at: "2026-10-01T15:00:00Z" },
      { field: "name", value: "テスト工房", source_url: "https://www.instagram.com/test_shop/", source_type: "instagram_profile", verified_at: "2026-10-01T03:00:00Z" },
    ];
    const s = mapSources(rows);
    expect(s.map((r) => [r.field, r.fieldLabel, r.sourceType, r.sourceTypeLabel, r.firstParty, r.verifiedDate])).toEqual([
      ["name", "店名", "instagram_profile", "Instagram プロフィール", false, "2026/10/01"],
      ["hours", "営業時間", "official_site", "公式サイト", true, "2026/10/02"],
    ]);
  });

  it("drops rows of unknown shape and never links an unsafe URL", () => {
    const s = mapSources([
      { field: "secret", value: "x", source_url: "https://a.example.com/", source_type: "official_site", verified_at: "2026-10-01T00:00:00Z" },
      { field: "name", value: "x", source_url: "https://a.example.com/", source_type: "scraped", verified_at: "2026-10-01T00:00:00Z" },
      { field: "name", value: "x", source_url: "javascript:alert(1)", source_type: "other", verified_at: "2026-10-01T00:00:00Z" },
    ]);
    expect(s).toHaveLength(1);
    expect(s[0].sourceUrl).toBeNull();
  });

  it("shortens long values for the card", () => {
    const [s] = mapSources([{ field: "description", value: "あ".repeat(300), source_url: "https://a.example.com/", source_type: "official_site", verified_at: "2026-10-01T00:00:00Z" }]);
    expect(s.value.length).toBe(80);
    expect(s.value.endsWith("…")).toBe(true);
  });

  it("researched date is the range of verified_at, or one day", () => {
    expect(buildTodayEvidence(eligibleInstagramInput()).researchedDate).toBe("2026/10/01");
    expect(buildTodayEvidence(eligibleEmailInput()).researchedDate).toBe("2026/10/01〜2026/10/03");
  });

  it("lists the expected fields without a source", () => {
    expect(buildTodayEvidence(eligibleInstagramInput()).missingSources.map((m) => m.field)).toEqual(["category"]);
    expect(buildTodayEvidence(eligibleEmailInput()).missingSources.map((m) => m.field)).toEqual(["category"]);
  });
});

describe("exclusion list match (the four keys persist compares)", () => {
  const keys = {
    instagramHandle: "test_shop",
    websiteDomain: "test-shop.example.com",
    emailDigests: [emailDigest("info@test-shop.example.com")],
    normalizedName: "てすと工房",
    normalizedAddress: "愛知県名古屋市中区てすと町1-1",
  };
  const row = (o: Partial<ExclusionRow>): ExclusionRow => ({
    reason: "existing_customer",
    instagram_handle: null,
    website_domain: null,
    email_digest: null,
    normalized_name: null,
    normalized_address: null,
    ...o,
  });

  it("matches on each key alone", () => {
    for (const r of [
      row({ instagram_handle: "test_shop" }),
      row({ website_domain: "test-shop.example.com" }),
      row({ email_digest: emailDigest("info@test-shop.example.com") }),
      row({ normalized_name: "てすと工房", normalized_address: "愛知県名古屋市中区てすと町1-1" }),
    ]) {
      expect(matchExclusions(keys, [r])).toEqual({ state: "match", reasons: ["existing_customer"] });
    }
  });

  it("name needs the address too; null keys never match; an unreadable list is unchecked", () => {
    expect(matchExclusions(keys, [row({ normalized_name: "てすと工房", normalized_address: "愛知県名古屋市東区別町" })])).toEqual({ state: "clear" });
    expect(matchExclusions({ ...keys, instagramHandle: null, websiteDomain: null, emailDigests: [] }, [row({ instagram_handle: "other" })])).toEqual({ state: "clear" });
    expect(matchExclusions(keys, [])).toEqual({ state: "clear" });
    expect(matchExclusions(keys, null)).toEqual({ state: "unchecked" });
  });

  it("review L2: digests every stored email — the public email and the email source rows — normalised", () => {
    const sources = [
      { field: "email", value: " Shop@Test-Shop.example.com ", source_url: "https://test-shop.example.com/contact", source_type: "official_contact", verified_at: "2026-10-01T00:00:00Z" },
      { field: "email", value: "info@test-shop.example.com", source_url: "https://test-shop.example.com/", source_type: "official_site", verified_at: "2026-10-01T00:00:00Z" },
      { field: "name", value: "x@y.example.com", source_url: "https://test-shop.example.com/", source_type: "official_site", verified_at: "2026-10-01T00:00:00Z" },
      { field: "email", value: "not an email", source_url: "https://test-shop.example.com/", source_type: "official_site", verified_at: "2026-10-01T00:00:00Z" },
    ];
    expect(storedEmails("info@test-shop.example.com", sources)).toEqual(["info@test-shop.example.com", "shop@test-shop.example.com"]);
    expect(storedEmails(null, null)).toEqual([]);
    const onlySource = { ...keys, emailDigests: storedEmails(null, sources).map(emailDigest) };
    expect(matchExclusions(onlySource, [row({ email_digest: emailDigest("shop@test-shop.example.com") })])).toEqual({ state: "match", reasons: ["existing_customer"] });
  });
});
