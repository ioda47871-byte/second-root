import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import InitialSend, { type ApprovalProps, type ComposedMessage } from "@/components/admin/InitialSend";
import { APPROVAL_STATE_LABEL, errorCode, liveApproval, SEND_ERROR_LABEL, sendErrorMessage, type ApprovalRow } from "@/lib/sales/approval";
import { checkDraftMessage, containsContactOrLink, DEFAULT_EMAIL_SUBJECT } from "@/lib/sales/draft";
import { buildTodayEvidence, formatJstDateTime, UNCONFIRMED } from "@/lib/sales/evidence";
import { verifiedCandidateInput } from "@/lib/sales/ingest-schema";
import { checkInsight, mapInsights, preparedInsights } from "@/lib/sales/insights";
import { DEMO_DISCLAIMER, DM_OPT_OUT, EMAIL_OPT_OUT } from "@/lib/sales/messages";
import { followUpStatus, followUpStatusLabel } from "@/lib/sales/followup";
import { copyText, openInstagram, openMail, type OpenDeps } from "@/lib/sales/open-send";
import { prepareCandidate } from "@/lib/sales/prepare";
import { verifiedInput } from "./ingest-fixtures";
import { eligibleInstagramInput } from "./today-evidence-fixture";

// DEV-195: the draft rules, the notes and their provenance, the approval view
// model, the send actions and the three-step send UI. The database side is
// tests/integration/send-approval.test.ts.

const state = vi.hoisted(() => ({ row: null as unknown, rpc: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/admin/auth", () => ({ requireAdmin: vi.fn(async () => undefined), requireAdminPage: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/server", () => ({
  createAuthClient: vi.fn(async () => {
    const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: state.row, error: null }) };
    return { from: () => chain, rpc: state.rpc };
  }),
}));

const OUTREACH = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const APPROVAL = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const PROSPECT = "11111111-2222-4333-8444-555555555555";
const TOKEN = "A".repeat(43);

function igRow(overrides: Record<string, unknown> = {}) {
  return {
    id: OUTREACH,
    kind: "initial",
    status: "drafted",
    channel: "instagram",
    subject: null,
    body: "テスト用の営業文です。",
    draft_version: 3,
    prospect: { name: "テスト工房", public_email: null, instagram_url: "https://www.instagram.com/test_shop/", instagram_handle: "test_shop", demo: [{ public_token: TOKEN, disabled_at: null }] },
    ...overrides,
  };
}

beforeEach(() => {
  state.rpc.mockReset();
  state.rpc.mockResolvedValue({ data: { replayed: false }, error: null });
  state.row = igRow();
  vi.unstubAllEnvs();
});

describe("draft rules (the composer's rules for the owner's text)", () => {
  it("accepts a plain message, trims it, and takes the default subject for an empty email subject", () => {
    expect(checkDraftMessage({ channel: "instagram", subject: null, body: "  こんにちは。  " })).toEqual({ ok: true, subject: null, body: "こんにちは。" });
    expect(checkDraftMessage({ channel: "email", subject: "  ", body: "本文" })).toEqual({ ok: true, subject: DEFAULT_EMAIL_SUBJECT, body: "本文" });
    expect(checkDraftMessage({ channel: "email", subject: "件名\n続き", body: "本文" })).toEqual({ ok: true, subject: "件名 続き", body: "本文" });
    expect(checkDraftMessage({ channel: "instagram", subject: "無視される", body: "本文" })).toMatchObject({ ok: true, subject: null });
  });

  it.each([
    ["empty", { channel: "instagram" as const, subject: null, body: "   " }],
    ["too_long", { channel: "instagram" as const, subject: null, body: "長".repeat(1201) }],
    ["subject_too_long", { channel: "email" as const, subject: "件".repeat(101), body: "本文" }],
    ["contact_or_link", { channel: "instagram" as const, subject: null, body: "詳しくは https://example.com へ" }],
    ["contact_or_link", { channel: "instagram" as const, subject: null, body: "owner＠example.com まで" }],
    ["contact_or_link", { channel: "email" as const, subject: "www.example.com", body: "本文" }],
    ["unsafe_content", { channel: "instagram" as const, subject: null, body: "<a href=x>リンク</a>" }],
  ])("refuses %s", (reason, input) => {
    expect(checkDraftMessage(input)).toEqual({ ok: false, reason });
  });

  it("is the same contact / link rule prepareCandidate applies to Operational Claude's draft", () => {
    expect(containsContactOrLink("shop.jp")).toBe(true);
    const withLink = verifiedInput({ message: { subject: null, body: "詳しくは shop.example.com へ" } });
    expect(prepareCandidate(withLink)).toEqual({ stage: "rejected", reason: "message_contains_url" });
    expect(checkDraftMessage({ channel: "instagram", subject: null, body: "詳しくは shop.example.com へ" })).toEqual({ ok: false, reason: "contact_or_link" });
  });
});

describe("selection rationale / improvement hypothesis", () => {
  it("checkInsight: trims, empty means remove, refuses long text, contacts and links", () => {
    expect(checkInsight("  地図がない ")).toEqual({ ok: true, body: "地図がない" });
    expect(checkInsight("   ")).toEqual({ ok: true, body: null });
    expect(checkInsight("長".repeat(301))).toEqual({ ok: false, reason: "too_long" });
    expect(checkInsight("owner@example.com")).toEqual({ ok: false, reason: "contact_or_link" });
    expect(checkInsight("https://example.com")).toEqual({ ok: false, reason: "contact_or_link" });
  });

  it("ingest: optional and backwards compatible; a note that does not pass is dropped, never the shop", () => {
    const plain = verifiedInput();
    expect(verifiedCandidateInput.safeParse(plain).success).toBe(true);
    const prepared = prepareCandidate(plain);
    expect(prepared.stage === "pending" && "insights" in prepared.candidate).toBe(false);

    const notes = verifiedInput({ insights: { selectionRationale: " Instagram だけで案内 ", improvementHypothesis: "連絡先 a@example.com" } });
    expect(verifiedCandidateInput.safeParse(notes).success).toBe(true);
    const withNotes = prepareCandidate(notes);
    expect(withNotes.stage).toBe("pending");
    if (withNotes.stage === "pending") expect(withNotes.candidate.insights).toEqual({ selection_rationale: "Instagram だけで案内" });

    // PR #239 L4: a note of the wrong shape is dropped, never a reason to refuse the candidate.
    for (const insights of [{ other: "x" }, { selectionRationale: 42 }, "text", ["a"], null, { improvementHypothesis: "長".repeat(1500) }]) {
      const input = { ...plain, insights };
      expect(verifiedCandidateInput.safeParse(input).success, JSON.stringify(insights).slice(0, 40)).toBe(true);
      const p = prepareCandidate(verifiedCandidateInput.parse(input));
      expect(p.stage === "pending" && "insights" in p.candidate).toBe(false);
    }
    expect(preparedInsights({ other: "x", improvementHypothesis: "地図を載せる" })).toEqual({ improvement_hypothesis: "地図を載せる" });
    // The rest of the candidate is still strict.
    expect(verifiedCandidateInput.safeParse({ ...plain, unknownField: "x" }).success).toBe(false);
    expect(preparedInsights({ improvementHypothesis: "長".repeat(400) })).toBeUndefined();
    expect(preparedInsights(undefined)).toBeUndefined();
  });

  it("the card shows stored notes with who wrote them (JST) and 未確認 otherwise — never invented", () => {
    const insights = mapInsights([
      { kind: "selection_rationale", body: "公式サイトがない", source: "ingest", run_id: "12345678-aaaa-4bbb-8ccc-dddddddddddd", written_at: "2026-11-06T15:30:00Z" },
      { kind: "improvement_hypothesis", body: "地図を載せる", source: "owner", run_id: null, written_at: "2026-11-07T01:05:00Z" },
      { kind: "unknown_kind", body: "x", source: "owner", run_id: null, written_at: "2026-11-07T01:05:00Z" },
    ]);
    const e = buildTodayEvidence(eligibleInstagramInput({ insights }));
    expect(e.hypothesis).toBe("地図を載せる");
    expect(e.insights).toEqual([
      { kind: "selection_rationale", label: "選んだ理由（記録）", value: "公式サイトがない", provenance: "記入: Operational Claude（run 12345678）・2026/11/07 00:30" },
      { kind: "improvement_hypothesis", label: "改善の仮説", value: "地図を載せる", provenance: "記入: オーナー・2026/11/07 10:05" },
    ]);
    const none = buildTodayEvidence(eligibleInstagramInput());
    expect(none.hypothesis).toBeNull();
    expect(none.insights.map((i) => [i.value, i.provenance])).toEqual([[null, null], [null, null]]);
  });

  it("formatJstDateTime is Asia/Tokyo and 未確認 for nothing", () => {
    expect(formatJstDateTime("2026-11-06T15:00:00Z")).toBe("2026/11/07 00:00");
    expect(formatJstDateTime(null)).toBe(UNCONFIRMED);
    expect(formatJstDateTime("x")).toBe(UNCONFIRMED);
  });
});

describe("approval view model", () => {
  const row = (overrides: Partial<ApprovalRow> = {}): ApprovalRow => ({
    id: APPROVAL,
    state: "approved",
    channel: "instagram",
    recipient: "test_shop",
    subject: null,
    body: "本文",
    draft_version: 3,
    demo_token: TOKEN,
    approved_at: "2026-11-07T01:00:00Z",
    opened_at: null,
    opened_via: null,
    ...overrides,
  });
  const ctx = { channel: "instagram" as const, draftVersion: 3, recipient: "test_shop", demoToken: TOKEN };

  it("picks the live approval and ignores superseded / sent ones", () => {
    expect(liveApproval([], ctx)).toBeNull();
    expect(liveApproval([row({ state: "superseded" }), row({ state: "sent" })], ctx)).toBeNull();
    const live = liveApproval([row({ state: "superseded", id: "x" }), row({ state: "send_opened", opened_at: "2026-11-07T01:10:00Z", opened_via: "mailto" })], ctx);
    expect(live).toMatchObject({ id: APPROVAL, state: "send_opened", approvedLabel: "2026/11/07 10:00", openedLabel: "2026/11/07 10:10・メールアプリを開いた", staleReasons: [] });
  });

  it("explains what makes it stale", () => {
    expect(liveApproval([row()], { ...ctx, draftVersion: 4 })?.staleReasons).toEqual(["承認の後に文面が編集されました"]);
    expect(liveApproval([row()], { ...ctx, recipient: "other" })?.staleReasons).toEqual(["承認の後に宛先が変わりました"]);
    expect(liveApproval([row()], { ...ctx, demoToken: null })?.staleReasons).toEqual(["承認の後にデモが変わったか無効になりました"]);
  });

  it("never says 自動送信: the sent state is the owner's manual confirmation", () => {
    expect(APPROVAL_STATE_LABEL.sent).toBe("手動で送信済み");
    expect(JSON.stringify(APPROVAL_STATE_LABEL) + JSON.stringify(SEND_ERROR_LABEL)).not.toContain("自動送信");
  });

  it("maps database refusals to the owner's words", () => {
    expect(errorCode("invalid_transition:drafted->sent")).toBe("invalid_transition");
    expect(sendErrorMessage("excluded")).toContain("除外リスト");
    expect(sendErrorMessage("duplicate_recipient")).toContain("同じ宛先");
    expect(sendErrorMessage("stale_snapshot")).toContain("もう一度承認");
    expect(sendErrorMessage("something else", "既定")).toBe("既定");
  });
});

describe("the database markers are the composer's own text", () => {
  const sql = readFileSync(new URL("../../../supabase/migrations/20261107000000_sales_send_approval.sql", import.meta.url), "utf8");
  it("disclaimer and opt-out lines", () => {
    expect(DEMO_DISCLAIMER).toContain("貴店の公式サイトではありません。");
    expect(EMAIL_OPT_OUT).toContain("以後ご連絡いたしません。");
    expect(DM_OPT_OUT).toContain("以後ご連絡いたしません。");
    expect(sql).toContain("strpos(p_body, '貴店の公式サイトではありません。') = 0");
    expect(sql).toContain("strpos(p_body, '以後ご連絡いたしません。') = 0");
    expect(sql).toContain("strpos(p_body, '/demo/' || d.public_token) = 0");
  });
});

describe("send actions", () => {
  it("approveSend records the server's own composition, only if it is what the owner saw", async () => {
    const { approveSend } = await import("@/app/admin/sales/_actions/send");
    const { composedFor } = await import("@/lib/admin/initial-send");
    const composed = composedFor(state.row as never)!;
    expect(composed.body).toContain("テスト用の営業文です。");
    expect(composed.body).toContain(`/demo/${TOKEN}`);
    expect(await approveSend(OUTREACH, 3, { subject: null, body: composed.body })).toEqual({ ok: true });
    expect(state.rpc).toHaveBeenCalledWith("sales_approve_outreach", {
      p_outreach_id: OUTREACH, p_draft_version: 3, p_subject: null, p_body: composed.body, p_design_enabled: false,
    });
    state.rpc.mockClear();
    expect(await approveSend(OUTREACH, 3, { subject: null, body: `${composed.body}改変` })).toMatchObject({ ok: false });
    expect(await approveSend(OUTREACH, 2, { subject: null, body: composed.body })).toMatchObject({ ok: false });
    state.row = igRow({ status: "sent" });
    expect(await approveSend(OUTREACH, 3, { subject: null, body: composed.body })).toMatchObject({ ok: false });
    expect(await approveSend("not-a-uuid", 3, { subject: null, body: composed.body })).toMatchObject({ ok: false });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("approveSend passes the design flag and refuses a pending design before the database", async () => {
    vi.stubEnv("SALES_AI_DESIGN_ENABLED", "true");
    const { approveSend } = await import("@/app/admin/sales/_actions/send");
    const { composedFor } = await import("@/lib/admin/initial-send");
    state.row = igRow({ prospect: { ...igRow().prospect, demo: [{ public_token: TOKEN, disabled_at: null, design_status: "pending" }] } });
    const body = composedFor(state.row as never)!.body;
    expect(await approveSend(OUTREACH, 3, { subject: null, body })).toEqual({ ok: false, error: SEND_ERROR_LABEL.design_pending });
    expect(state.rpc).not.toHaveBeenCalled();
    state.row = igRow({ prospect: { ...igRow().prospect, demo: [{ public_token: TOKEN, disabled_at: null, design_status: "ready" }] } });
    expect(await approveSend(OUTREACH, 3, { subject: null, body })).toEqual({ ok: true });
    expect(state.rpc.mock.calls[0][1]).toMatchObject({ p_design_enabled: true });
  });

  it("a refusal from the database reaches the owner in words", async () => {
    const { approveSend, markSendOpened, markSent } = await import("@/app/admin/sales/_actions/send");
    const { composedFor } = await import("@/lib/admin/initial-send");
    state.rpc.mockResolvedValue({ data: null, error: { message: "excluded" } });
    expect(await approveSend(OUTREACH, 3, { subject: null, body: composedFor(state.row as never)!.body })).toEqual({ ok: false, error: SEND_ERROR_LABEL.excluded });
    expect(await markSendOpened(APPROVAL, "mailto")).toEqual({ ok: false, error: SEND_ERROR_LABEL.excluded });
    expect(await markSent(OUTREACH, APPROVAL)).toEqual({ ok: false, error: SEND_ERROR_LABEL.excluded });
  });

  it("markSendOpened accepts only the three ways of opening", async () => {
    const { markSendOpened } = await import("@/app/admin/sales/_actions/send");
    expect(await markSendOpened(APPROVAL, "instagram_profile")).toEqual({ ok: true });
    expect(state.rpc).toHaveBeenCalledWith("sales_mark_send_opened", { p_approval_id: APPROVAL, p_via: "instagram_profile", p_design_enabled: false });
    state.rpc.mockClear();
    expect(await markSendOpened(APPROVAL, "auto" as never)).toMatchObject({ ok: false });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("editDraft checks the text before the database and keeps the revision", async () => {
    const { editDraft } = await import("@/app/admin/sales/_actions/draft");
    expect(await editDraft(OUTREACH, 3, null, "URL は https://example.com")).toMatchObject({ ok: false });
    expect(state.rpc).not.toHaveBeenCalled();
    expect(await editDraft(OUTREACH, 3, null, "  書き直した本文  ")).toMatchObject({ ok: true });
    expect(state.rpc).toHaveBeenCalledWith("sales_update_outreach_draft", { p_outreach_id: OUTREACH, p_draft_version: 3, p_subject: null, p_body: "書き直した本文" });
    state.rpc.mockResolvedValue({ data: null, error: { message: "approval_open" } });
    expect(await editDraft(OUTREACH, 3, null, "本文")).toEqual({ ok: false, error: SEND_ERROR_LABEL.approval_open });
  });

  it("setInsight stores the owner's note, or clears it with an empty text", async () => {
    const { setInsight } = await import("@/app/admin/sales/_actions/draft");
    expect(await setInsight(PROSPECT, "improvement_hypothesis", " 地図を載せる ")).toMatchObject({ ok: true });
    expect(state.rpc).toHaveBeenLastCalledWith("sales_set_prospect_insight", { p_prospect_id: PROSPECT, p_kind: "improvement_hypothesis", p_body: "地図を載せる" });
    expect(await setInsight(PROSPECT, "selection_rationale", "")).toMatchObject({ ok: true, message: expect.stringContaining("未確認") });
    expect(state.rpc).toHaveBeenLastCalledWith("sales_set_prospect_insight", { p_prospect_id: PROSPECT, p_kind: "selection_rationale", p_body: "" });
    state.rpc.mockClear();
    expect(await setInsight(PROSPECT, "selection_rationale", "a@example.com")).toMatchObject({ ok: false });
    expect(await setInsight(PROSPECT, "other" as never, "x")).toMatchObject({ ok: false });
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("InitialSend: approve → open → confirm", () => {
  const composed: ComposedMessage = { channel: "email", recipient: "info@test-shop.example.com", subject: "ご提案", body: "本文と /demo/x" };
  const approval = (overrides: Partial<ApprovalProps> = {}): ApprovalProps => ({
    id: APPROVAL,
    state: "approved",
    recipient: composed.recipient,
    subject: composed.subject,
    body: composed.body,
    approvedLabel: "2026/11/07 10:00",
    openedLabel: null,
    staleReasons: [],
    link: "mailto:info@test-shop.example.com?subject=x&body=y",
    ...overrides,
  });
  const render = (a: ApprovalProps | null, c = composed) => renderToStaticMarkup(<InitialSend outreachId={OUTREACH} draftVersion={1} composed={c} approval={a} />);

  it("before approval: the exact text and recipient, the approve button, no way to open or confirm", () => {
    const html = render(null);
    expect(html).toContain('data-step="review"');
    expect(html).toContain("この内容で送信を承認");
    expect(html).toContain("info@test-shop.example.com");
    expect(html).toContain("本文と /demo/x");
    expect(html).not.toContain("メールを作成");
    expect(html).not.toContain("手動で送信済みにする");
  });

  it("approved: a メールを作成 button and no mailto in the page until the server recorded the opening; no confirm yet", () => {
    const html = render(approval());
    expect(html).toContain('data-step="approved"');
    expect(html).toContain('data-testid="open-mail"');
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain('data-testid="mail-fallback"');
    expect(html).toContain("メールを作成");
    expect(html).not.toContain("手動で送信済みにする");
    expect(html).toContain("送らなかった");
  });

  it("send_opened: 手動で送信済みにする appears; Instagram gets DMを送る", () => {
    const html = render(approval({ state: "send_opened", openedLabel: "2026/11/07 10:10・メールアプリを開いた" }));
    expect(html).toContain('data-testid="confirm-sent"');
    expect(html).toContain("手動で送信済みにする");
    const ig = render(approval({ state: "send_opened", recipient: "test_shop", subject: null, link: "https://www.instagram.com/test_shop/" }), { channel: "instagram", recipient: "test_shop", subject: null, body: "本文" });
    expect(ig).toContain("DMを送る");
    expect(ig).toContain("@test_shop");
    expect(html + ig).not.toContain("自動送信");
  });

  it("a stale approval offers neither the send screen nor the confirm, only withdrawing", () => {
    const html = render(approval({ state: "send_opened", staleReasons: ["承認の後に文面が編集されました"] }));
    expect(html).toContain('data-testid="approval-stale"');
    expect(html).not.toContain("メールを作成");
    expect(html).not.toContain('data-testid="confirm-sent"');
    expect(html).toContain('data-testid="withdraw-approval"');
  });
});

describe("PR #239 M1: the send screen opens only after the server agreed", () => {
  function deps(result: { ok: true } | { ok: false; error: string }) {
    const calls: string[] = [];
    const d: OpenDeps = {
      record: vi.fn(async (via) => {
        calls.push(`record:${via}`);
        return result;
      }),
      openExternal: vi.fn((url: string) => void calls.push(`open:${url}`)),
      copy: vi.fn(async (text: string) => void calls.push(`copy:${text}`)),
    };
    return { d, calls };
  }
  const win = () => {
    const calls: string[] = [];
    return { calls, w: { navigate: (u: string) => void calls.push(`navigate:${u}`), close: () => void calls.push("close") } };
  };

  it("email: records first, then hands the mailto over; nothing on a refusal", async () => {
    const ok = deps({ ok: true });
    expect(await openMail("mailto:a@example.com?x", ok.d)).toEqual({ kind: "opened" });
    expect(ok.calls).toEqual(["record:mailto", "open:mailto:a@example.com?x"]);
    const no = deps({ ok: false, error: SEND_ERROR_LABEL.excluded });
    expect(await openMail("mailto:a@example.com?x", no.d)).toEqual({ kind: "refused", error: SEND_ERROR_LABEL.excluded });
    expect(no.calls).toEqual(["record:mailto"]);
    const thrown = deps({ ok: true });
    thrown.d.record = vi.fn(async () => {
      throw new Error("network");
    });
    expect((await openMail("mailto:x", thrown.d)).kind).toBe("refused");
    expect(thrown.d.openExternal).not.toHaveBeenCalled();
  });

  it("Instagram: the blank window goes to the profile only after the record; on a refusal it is closed and nothing is copied", async () => {
    const ok = deps({ ok: true });
    const okWin = win();
    expect(await openInstagram("https://www.instagram.com/test_shop/", "本文", okWin.w, ok.d)).toEqual({ kind: "opened", copied: true });
    expect(ok.calls).toEqual(["record:instagram_profile", "copy:本文"]);
    expect(okWin.calls).toEqual(["navigate:https://www.instagram.com/test_shop/"]);
    const no = deps({ ok: false, error: SEND_ERROR_LABEL.do_not_contact });
    const noWin = win();
    expect(await openInstagram("https://www.instagram.com/test_shop/", "本文", noWin.w, no.d)).toEqual({ kind: "refused", error: SEND_ERROR_LABEL.do_not_contact });
    expect(no.calls).toEqual(["record:instagram_profile"]);
    expect(noWin.calls).toEqual(["close"]);
  });

  it("copy: records first, then copies; nothing on a refusal", async () => {
    const ok = deps({ ok: true });
    expect(await copyText("本文", ok.d)).toEqual({ kind: "opened", copied: true });
    expect(ok.calls).toEqual(["record:copy", "copy:本文"]);
    const no = deps({ ok: false, error: "x" });
    expect((await copyText("本文", no.d)).kind).toBe("refused");
    expect(no.calls).toEqual(["record:copy"]);
  });
});

describe("PR #239 M2: an opened approval of a shop that became DNC / excluded", () => {
  const blocked: ApprovalProps = {
    id: APPROVAL,
    state: "send_opened",
    recipient: "test_shop",
    subject: null,
    body: "本文",
    approvedLabel: "2026/11/07 10:00",
    openedLabel: "2026/11/07 10:10・Instagram を開いた",
    staleReasons: [],
    link: "https://www.instagram.com/test_shop/",
  };
  const igComposed: ComposedMessage = { channel: "instagram", recipient: "test_shop", subject: null, body: "本文" };

  it("keeps 手動で送信済みにする and 送らなかった with a warning, but offers no way to open the send screen again", () => {
    const html = renderToStaticMarkup(
      <InitialSend outreachId={OUTREACH} draftVersion={1} composed={igComposed} approval={blocked} blockedWarning={["営業不要（DNC）: 営業不要（DNC）の店舗です"]} />,
    );
    expect(html).toContain('data-testid="approval-blocked"');
    expect(html).toContain('data-testid="confirm-sent"');
    expect(html).toContain('data-testid="withdraw-approval"');
    expect(html).not.toContain("DMを送る");
    expect(html).not.toContain("文面をコピー");
  });

  it("the follow-up state of such an outreach is 「フォローなし」", () => {
    const status = followUpStatus(
      { channel: "email", status: "sent", sentAt: new Date("2026-10-01T00:00:00Z"), hasFollowUp: false, doNotContact: false, demoPublic: true, blockedAfterOpen: true },
      new Date("2026-11-07T00:00:00Z"),
    );
    expect(status).toEqual({ kind: "blocked" });
    expect(followUpStatusLabel(status)).toContain("フォローなし");
  });
});

describe("PR #239 re-review L4b: 見送る while the send screen is open", () => {
  it("shows the reason the database gives (approval_open)", async () => {
    const { skipDraft } = await import("@/app/admin/sales/_actions/outcomes");
    state.row = { status: "drafted", kind: "initial" };
    state.rpc.mockResolvedValue({ data: null, error: { message: "approval_open" } });
    expect(await skipDraft(OUTREACH, "")).toEqual({
      ok: false,
      error: "送信画面を開いた承認があります。送った場合は「手動で送信済みにする」、送らなかった場合は「送らなかった」を先に押してください。",
    });
    expect(state.rpc).toHaveBeenCalledWith("sales_mark_lost", { p_outreach_id: OUTREACH, p_reason: null });
  });
});
