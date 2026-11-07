import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TodayItem } from "@/lib/admin/today";
import { buildTodayEvidence, UNCONFIRMED, type EvidenceInput } from "@/lib/sales/evidence";
import { emailDigest } from "@/lib/sales/email-digest";
import { EXCLUSION_ROWS_PER_CARD, postgrestInList } from "@/lib/admin/today";
import { eligibleEmailInput, eligibleInstagramInput } from "./today-evidence-fixture";

// DEV-194: the today card shows the contact verdict with its reasons and the
// folded evidence; the page never offers a send action on a card the server
// would refuse. loadTodayQueue reads the evidence through the admin session.

const state = vi.hoisted(() => ({ items: [] as unknown[] }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/admin/auth", () => ({ requireAdmin: vi.fn(async () => undefined), requireAdminPage: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/server", () => ({ createAuthClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/admin/today", async (original) => ({
  ...(await original<typeof import("@/lib/admin/today")>()),
  loadTodayQueue: vi.fn(async () => state.items),
}));

afterEach(() => vi.unstubAllEnvs());

const OUTREACH = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function item(input: EvidenceInput): TodayItem {
  return {
    kind: input.kind,
    prospectId: "11111111-2222-4333-8444-555555555555",
    doNotContact: false,
    since: new Date("2026-10-05T00:00:00Z"),
    outreachId: OUTREACH,
    channel: input.channel,
    shopName: "テスト工房",
    category: "bakery",
    ward: "中区",
    subject: input.channel === "email" ? "ホームページのご提案" : null,
    body: "テスト用の営業文です。",
    instagramUrl: input.instagramUrl,
    publicEmail: input.publicEmail,
    demoToken: input.demoAvailable ? "A".repeat(43) : null,
    sentAt: input.kind === "follow_up" ? "2026-09-28T00:00:00Z" : null,
    designStatus: input.designStatus,
    designErrorCode: null,
    designReview: null,
    evidence: buildTodayEvidence(input),
    draftVersion: 1,
    editedAt: null,
    instagramHandle: input.instagramHandle,
    approval: null,
  };
}

async function pageHtml(input: EvidenceInput): Promise<string> {
  state.items = [item(input)];
  const { default: TodayPage } = await import("@/app/admin/sales/page");
  return renderToStaticMarkup(await TodayPage());
}

describe("today page: the send action follows the verdict", () => {
  it("sendable cards keep their action and a 送信できます badge", async () => {
    // DEV-195: the first step of the send action is the approval of the exact text.
    const ig = await pageHtml(eligibleInstagramInput());
    expect(ig).toContain('data-testid="send-flow"');
    expect(ig).toContain("この内容で送信を承認");
    expect(ig).toContain('data-sendable="true"');
    expect(ig).not.toContain('data-testid="send-blocked"');
    const mail = await pageHtml(eligibleEmailInput());
    expect(mail).toContain('data-testid="send-flow"');
    expect(mail).toContain("この内容で送信を承認");
    expect(mail).not.toContain('data-testid="contact-blockers"');
  });

  it.each<[string, EvidenceInput]>([
    ["email without first-party provenance", eligibleEmailInput({ sources: [] })],
    ["channel differs from the recommended one", eligibleInstagramInput({ recommendedChannel: "email" })],
    ["Instagram with a website present", eligibleInstagramInput({ websiteStatus: "present", websiteDomain: "x.example.com" })],
    ["exclusion list match", eligibleInstagramInput({ exclusion: { state: "match", reasons: ["partner"] } })],
    ["exclusion list unreadable", eligibleInstagramInput({ exclusion: { state: "unchecked" } })],
    ["a follow-up whose email lost its provenance", eligibleEmailInput({ kind: "follow_up", outreachStatus: "sent", sources: [] })],
  ])("%s: no send action, a 送信できません badge with reasons", async (_name, input) => {
    const html = await pageHtml(input);
    expect(html).not.toContain('data-testid="send-flow"');
    expect(html).not.toContain("この内容で送信を承認");
    expect(html).not.toContain("DMを送る");
    expect(html).not.toContain("メールを作成");
    expect(html).not.toContain("フォローメールを作成");
    expect(html).toContain('data-testid="send-blocked"');
    expect(html).toContain('data-sendable="false"');
    expect(html).toContain("送信できません");
    expect(html).toContain('data-testid="contact-blockers"');
  });

  it("a design still pending keeps the existing waiting note (and the badge says why)", async () => {
    vi.stubEnv("SALES_AI_DESIGN_ENABLED", "true");
    const html = await pageHtml(eligibleInstagramInput({ designEnabled: true, designStatus: "pending" }));
    expect(html).toContain('data-testid="design-wait"');
    expect(html).not.toContain('data-testid="send-flow"');
    expect(html).not.toContain("DMを送る");
    expect(html).toContain("AIデザインの完成を待っています");
  });
});

describe("PR #239 M2: an opened approval keeps its controls when the card is no longer sendable", () => {
  it("excluded or DNC after opening: the confirm / withdraw controls and a warning instead of send-blocked", async () => {
    for (const input of [
      eligibleInstagramInput({ exclusion: { state: "match", reasons: ["partner"] } }),
      eligibleInstagramInput({ doNotContact: true, demoAvailable: false }),
    ]) {
      state.items = [
        {
          ...item(input),
          approval: {
            id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
            state: "send_opened",
            channel: "instagram",
            recipient: "test_shop",
            subject: null,
            body: "本文",
            approvedAt: "2026-11-07T01:00:00Z",
            approvedLabel: "2026/11/07 10:00",
            openedLabel: "2026/11/07 10:10",
            staleReasons: [],
          },
        },
      ];
      const { default: TodayPage } = await import("@/app/admin/sales/page");
      const html = renderToStaticMarkup(await TodayPage());
      expect(html).not.toContain('data-testid="send-blocked"');
      expect(html).toContain('data-testid="approval-blocked"');
      expect(html).toContain('data-testid="confirm-sent"');
      expect(html).toContain('data-testid="withdraw-approval"');
      expect(html).not.toContain("DMを送る");
    }
  });

  it("an approved but not opened approval is not kept: the card stays send-blocked", async () => {
    state.items = [
      {
        ...item(eligibleInstagramInput({ exclusion: { state: "match", reasons: ["partner"] } })),
        approval: {
          id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", state: "approved", channel: "instagram", recipient: "test_shop", subject: null, body: "本文",
          approvedAt: "2026-11-07T01:00:00Z", approvedLabel: "2026/11/07 10:00", openedLabel: null, staleReasons: [],
        },
      },
    ];
    const { default: TodayPage } = await import("@/app/admin/sales/page");
    const html = renderToStaticMarkup(await TodayPage());
    expect(html).toContain('data-testid="send-blocked"');
    expect(html).not.toContain('data-testid="confirm-sent"');
  });
});

describe("today card: evidence", () => {
  it("shows the selection, the sources with links and dates, and the checks", async () => {
    const html = await pageHtml(eligibleEmailInput());
    expect(html).toContain('data-testid="today-evidence"');
    expect(html).toContain("名古屋市中区のパン屋。公式サイトはあり、推奨チャネルはメールの候補。");
    expect(html).toContain(`改善の仮説</dt><dd>${UNCONFIRMED}（保存されていません）`);
    expect(html).toContain('data-field="email" data-source-type="official_contact"');
    expect(html).toContain('href="https://test-shop.example.com/contact" target="_blank" rel="noopener noreferrer nofollow"');
    expect(html).toContain("2026/10/01〜2026/10/03");
    expect(html).toContain('data-check="channel_rule" data-state="ok"');
    expect(html).toContain("店舗自身の公開（公式の問い合わせページ）");
  });

  it("a shop with no stored sources reads 未確認 everywhere it matters", async () => {
    const html = await pageHtml(eligibleEmailInput({ sources: [], registeredAt: null, ward: null }));
    expect(html).toContain('data-testid="evidence-no-sources"');
    expect(html).toContain(`調査日: <span data-testid="evidence-researched">${UNCONFIRMED}</span>`);
    expect(html).toContain(`登録日: ${UNCONFIRMED}`);
    expect(html).toContain(`出典${UNCONFIRMED}: 店名・住所・業種・メール`);
    expect(html).toContain(`名古屋市（区は${UNCONFIRMED}）`);
  });
});

describe("loadTodayQueue reads the evidence through the admin session", () => {
  type Call = { table: string; select?: string; eqs: Array<[string, unknown]>; or?: string; limit?: number };

  function fakeClient(opts: { exclusions: { data: unknown[] | null; error: unknown } }) {
    const calls: Call[] = [];
    const draft = {
      id: OUTREACH,
      prospect_id: "11111111-2222-4333-8444-555555555555",
      kind: "initial",
      channel: "email",
      status: "drafted",
      subject: "件名",
      body: "本文",
      sent_at: null,
      created_at: "2026-10-05T00:00:00Z",
      prospect: {
        name: "テスト工房",
        category: "bakery",
        ward: "中区",
        do_not_contact: false,
        instagram_url: null,
        public_email: "info@test-shop.example.com",
        address: "愛知県名古屋市中区テスト町1-1",
        normalized_name: "てすと工房",
        normalized_address: "愛知県名古屋市中区てすと町1-1",
        website_status: "present",
        website_domain: "test-shop.example.com",
        instagram_handle: null,
        recommended_channel: "email",
        created_at: "2026-10-05T00:00:00Z",
        sources: eligibleEmailInput().sources,
        demo: { public_token: "A".repeat(43), disabled_at: null },
      },
    };
    const client = {
      from(table: string) {
        const call: Call = { table, eqs: [] };
        calls.push(call);
        const result =
          table === "sales_followup_due"
            ? { data: [], error: null }
            : table === "sales_exclusions"
              ? opts.exclusions
              : { data: [draft], error: null };
        const chain = {
          select(s: string) {
            call.select = s;
            return chain;
          },
          eq(col: string, v: unknown) {
            call.eqs.push([col, v]);
            return chain;
          },
          in: () => chain,
          or(f: string) {
            call.or = f;
            return chain;
          },
          order: () => chain,
          limit(n: number) {
            call.limit = n;
            return chain;
          },
          then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
        };
        return chain;
      },
    };
    return { client, calls };
  }

  it("selects the stored channel facts and sources, keeps the DNC filter, and checks the exclusion list", async () => {
    const { loadTodayQueue } = await vi.importActual<typeof import("@/lib/admin/today")>("@/lib/admin/today");
    const { client, calls } = fakeClient({ exclusions: { data: [], error: null } });
    const items = await loadTodayQueue(client as never);
    const drafts = calls.find((c) => c.table === "sales_outreaches")!;
    expect(drafts.select).toContain("sources:sales_sources(field, value, source_url, source_type, verified_at)");
    expect(drafts.select).toContain("recommended_channel");
    expect(drafts.eqs).toContainEqual(["prospect.do_not_contact", false]);
    // Review L1: only this card's keys are asked for, with a bound.
    const ex = calls.find((c) => c.table === "sales_exclusions")!;
    expect(ex.or).toBe(
      `website_domain.in.("test-shop.example.com"),email_digest.in.("${emailDigest("info@test-shop.example.com")}"),normalized_name.in.("てすと工房")`,
    );
    expect(ex.limit).toBe(EXCLUSION_ROWS_PER_CARD);
    expect(items).toHaveLength(1);
    expect(items[0].evidence.contact.sendable).toBe(true);
    expect(items[0].evidence.sources.map((s) => s.field)).toEqual(["name", "address", "email"]);
  });

  it("an exclusion added after the draft blocks the card", async () => {
    const { loadTodayQueue } = await vi.importActual<typeof import("@/lib/admin/today")>("@/lib/admin/today");
    const { client } = fakeClient({
      exclusions: {
        data: [{ reason: "existing_customer", instagram_handle: null, website_domain: "test-shop.example.com", email_digest: null, normalized_name: null, normalized_address: null }],
        error: null,
      },
    });
    const [i] = await loadTodayQueue(client as never);
    expect(i.evidence.contact.sendable).toBe(false);
    expect(i.evidence.contact.blockers.join()).toContain("既存顧客");
  });

  it("an unreadable exclusion list fails closed (未確認, not sendable) without hiding the queue", async () => {
    const { loadTodayQueue } = await vi.importActual<typeof import("@/lib/admin/today")>("@/lib/admin/today");
    const { client } = fakeClient({ exclusions: { data: null, error: { message: "denied" } } });
    const [i] = await loadTodayQueue(client as never);
    expect(i.evidence.contact.sendable).toBe(false);
    expect(i.evidence.contact.checks.find((c) => c.id === "exclusion")?.state).toBe("unconfirmed");
  });

  it("review L1: a read that reaches the per-card bound may be cut off, so it is 未確認 (not sendable)", async () => {
    const { loadTodayQueue } = await vi.importActual<typeof import("@/lib/admin/today")>("@/lib/admin/today");
    const filler = { reason: "other", instagram_handle: null, website_domain: null, email_digest: null, normalized_name: "てすと工房", normalized_address: "愛知県名古屋市別区" };
    const { client } = fakeClient({ exclusions: { data: Array.from({ length: EXCLUSION_ROWS_PER_CARD }, () => filler), error: null } });
    const [i] = await loadTodayQueue(client as never);
    expect(i.evidence.contact.checks.find((c) => c.id === "exclusion")?.state).toBe("unconfirmed");
    expect(i.evidence.contact.sendable).toBe(false);
  });
});

describe("postgrestInList", () => {
  it("quotes every value so commas, brackets, quotes and backslashes stay literal", () => {
    expect(postgrestInList(["a,b", 'c"d', "e\\f", "(g)"])).toBe('("a,b","c\\"d","e\\\\f","(g)")');
  });
});

describe("review M1: a blocked follow-up is never a dead end", () => {
  it("shows the existing DNC control and a hint that names it", async () => {
    const html = await pageHtml(eligibleEmailInput({ kind: "follow_up", outreachStatus: "sent", exclusion: { state: "match", reasons: ["existing_customer"] } }));
    expect(html).not.toContain("フォローメールを作成");
    expect(html).toContain('data-testid="follow-up-dnc"');
    expect(html).toContain("営業不要（DNC）にする");
    expect(html).toContain("下の「営業不要（DNC）にする」で一覧から外せます");
  });

  it("a sendable follow-up keeps only its send action (no extra DNC control)", async () => {
    const html = await pageHtml(eligibleEmailInput({ kind: "follow_up", outreachStatus: "sent" }));
    expect(html).toContain("フォローメールを作成");
    expect(html).not.toContain('data-testid="follow-up-dnc"');
    expect(html).not.toContain("営業不要（DNC）にする");
  });

  it("a blocked initial points to the 詳細 controls it really has", async () => {
    const html = await pageHtml(eligibleInstagramInput({ recommendedChannel: "email" }));
    expect(html).toContain("「詳細」の「見送る」か「営業不要（DNC）にする」");
    expect(html).toContain('data-testid="skip-draft"');
    expect(html).not.toContain('data-testid="follow-up-dnc"');
  });
});
