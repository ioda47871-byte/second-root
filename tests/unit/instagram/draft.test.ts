import { describe, expect, it } from "vitest";
import { checkDraft, detectExplicitRefusal, MAX_DRAFT_BYTES } from "@/lib/instagram/draft";

const DEMO = "https://secondroot.jp/demo/abcDEF123_-xyz";
const draft = (body: string, extra: Partial<Parameters<typeof checkDraft>[0]> = {}) =>
  checkDraft({ replyType: "question", body, futureContactRefused: false, ...extra }, DEMO, "料金はいくらですか？");

describe("detectExplicitRefusal", () => {
  it.each([
    "今後このような連絡はしないでください",
    "もうDMは送らないでください",
    "営業はお断りしています",
    "二度とメッセージしないで",
    "連絡やめてください",
    "今後一切ご連絡不要です",
  ])("flags an explicit refusal of future contact: %s", (text) => {
    expect(detectExplicitRefusal(text)).toBe(true);
  });

  it.each([
    "もう連絡してこないでください",
    "営業のDMはご遠慮ください",
    "迷惑なのでやめてください",
    "二度と送ってこないで",
    "こういう連絡は今後いりません",
    "今後の営業連絡はお控えください",
  ])("also flags other common phrasings: %s", (text) => {
    expect(detectExplicitRefusal(text)).toBe(true);
  });

  it.each(["今回は結構です", "検討しましたが見送ります", "興味あります！", "料金を教えてください", "営業時間外は不要です", "営業日は火曜から土曜です", "", null])(
    "does not treat a plain decline or anything else as refusal: %s",
    (text) => {
      expect(detectExplicitRefusal(text)).toBe(false);
    },
  );
});

describe("checkDraft", () => {
  it("accepts a short plain reply and trims it", () => {
    const r = draft("  ご質問ありがとうございます。詳しくご説明します。 ");
    expect(r).toEqual({ ok: true, body: "ご質問ありがとうございます。詳しくご説明します。", dncCandidate: false, needsHumanReview: false, reviewReasons: [] });
  });

  it("allows only the shop's own demo URL as a link", () => {
    expect(draft(`デモはこちらです ${DEMO}`).ok).toBe(true);
    expect(draft("詳しくは https://example.com/ をご覧ください")).toEqual({ ok: false, reason: "link_not_allowed" });
    expect(draft("www.secondroot.jp もご覧ください")).toEqual({ ok: false, reason: "link_not_allowed" });
    expect(checkDraft({ replyType: "question", body: `デモ ${DEMO}`, futureContactRefused: false }, null, null)).toEqual({ ok: false, reason: "link_not_allowed" });
  });

  it.each([
    "詳しくは evil.com へ",
    "bit.ly/abc をご覧ください",
    "xn--80ak6aa92e.com",
    "ｅｖｉｌ．ｃｏｍ",
    "evil。com",
    "hxxps://evil.com",
    "secondroot.jp/works もどうぞ",
    `${DEMO} と example.org`,
  ])("refuses any other link or domain, including disguised ones: %s", (body) => {
    expect(draft(body)).toEqual({ ok: false, reason: "link_not_allowed" });
  });

  it.each(["０５２−１２３−４５６７", "090ー1234ー5678", "090.1234.5678", "+81 90 1234 5678"])("refuses phone numbers with any separator: %s", (body) => {
    expect(draft(`お電話は ${body} まで`)).toEqual({ ok: false, reason: "contact_details" });
  });

  it("does not mistake amounts or ordinary Japanese for contact details or links", () => {
    expect(draft("制作費は1000000円からです").ok).toBe(true);
    expect(draft("ホームページのデザイン、メニュー、アクセス情報をまとめます。").ok).toBe(true);
    expect(draft("Ver.2 のご提案もできます").ok).toBe(true);
  });

  it("refuses contact details (email, phone)", () => {
    expect(draft("info@secondroot.jp までご連絡ください")).toEqual({ ok: false, reason: "contact_details" });
    expect(draft("お電話は 052-123-4567 まで")).toEqual({ ok: false, reason: "contact_details" });
    expect(draft("０９０－１２３４－５６７８")).toEqual({ ok: false, reason: "contact_details" });
  });

  it("enforces Instagram's 1000-byte limit and non-empty text", () => {
    expect(draft("あ".repeat(Math.floor(MAX_DRAFT_BYTES / 3) + 1))).toEqual({ ok: false, reason: "too_long" });
    expect(draft("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("flags price, schedule and contract wording for a closer human look", () => {
    const r = draft("制作費用は5万円で、来週には公開できます。必ずご満足いただけます。");
    expect(r).toMatchObject({ ok: true, needsHumanReview: true, reviewReasons: ["price", "schedule", "contract"] });
  });

  it("marks a DNC candidate from the shop's message or the drafter's flag, never sets DNC itself", () => {
    const fromText = checkDraft({ replyType: "decline", body: "承知しました。失礼いたしました。", futureContactRefused: false }, DEMO, "今後は連絡しないでください");
    expect(fromText).toMatchObject({ ok: true, dncCandidate: true, needsHumanReview: true, reviewReasons: ["dnc_candidate"] });
    const fromFlag = checkDraft({ replyType: "decline", body: "承知しました。", futureContactRefused: true }, DEMO, "結構です");
    expect(fromFlag).toMatchObject({ ok: true, dncCandidate: true });
    const plain = checkDraft({ replyType: "decline", body: "承知しました。", futureContactRefused: false }, DEMO, "今回は結構です");
    expect(plain).toMatchObject({ ok: true, dncCandidate: false });
  });
  it.each([
    "ドメイン.jp へどうぞ",
    "例え.テスト",
    "evil.みんな",
    "192.168.0.1 にアクセス",
    "93.184.216.34:8080",
    "evil\u200b.com",
    "evil\u2060.com",
    "e\ufeffvil.com",
    `${DEMO}/../otherToken`,
    `${DEMO}/x`,
    `${DEMO}?q=1`,
    `${DEMO}#top`,
    "https://secondroot.jp/demo/otherToken",
    "@evil_shop までDMください",
    "mailto:someone",
    "javascript:alert(1)",
  ])("[fail-closed] refuses other links: %s", (body) => {
    expect(draft(body)).toEqual({ ok: false, reason: "link_not_allowed" });
  });

  it.each(["090\u200b1234\u200b5678", "LINE ID を追加してください", "LINE ID: shop", "LINE@abc"])("[fail-closed] refuses hidden contact details: %s", (body) => {
    expect(draft(body)).toEqual({ ok: false, reason: "contact_details" });
  });

  it("keeps ordinary Japanese sentences, decimals and the demo URL at a sentence end", () => {
    expect(draft("ありがとうございます。次回もよろしくお願いします。").ok).toBe(true);
    expect(draft("評価は4.5点でした。").ok).toBe(true);
    expect(draft(`デモはこちらです ${DEMO}。ぜひご覧ください`).ok).toBe(true);
    expect(draft(`デモ: ${DEMO}.`).ok).toBe(true);
  });

  it("flags wording rules on the visible text (long vowel marks, hidden characters)", () => {
    expect(draft("キャンペーン中です")).toMatchObject({ ok: true, reviewReasons: ["price"] });
    expect(draft("契\u200b約について")).toMatchObject({ ok: true, reviewReasons: ["contract"] });
    expect(detectExplicitRefusal("もうメッセージいらない")).toBe(true);
    expect(detectExplicitRefusal("今後は連\u200b絡しないでください")).toBe(true);
  });
  it.each([`${"DEMO"};/../other`, `${"DEMO"})/../other`, `${"DEMO"}\\..\\other`, `${"DEMO"},/../other`, `${"DEMO"}!/../other`, "焼き菓子.クッキー"])(
    "[fail-closed] round 3: refuses demo URL escapes and IDN with long vowels: %s",
    (body) => {
      expect(draft(body.replace("DEMO", DEMO))).toEqual({ ok: false, reason: "link_not_allowed" });
    },
  );

  it("round 3: accepts the demo URL before closing punctuation, and catches LINE ID wording", () => {
    for (const end of ["", "。", "、", ".", "」", ")", "！", "\nよろしく"]) expect(draft(`デモ「${DEMO}${end}`).ok, end).toBe(true);
    expect(draft("ラインID: abc")).toEqual({ ok: false, reason: "contact_details" });
    expect(draft("LINEのIDはabc")).toEqual({ ok: false, reason: "contact_details" });
    expect(draft("LINEでもご連絡いただけます").ok).toBe(true);
  });

  it("round 3: polite phrases are not refusals", () => {
    expect(detectExplicitRefusal("何かあればご連絡ご遠慮なくどうぞ")).toBe(false);
    expect(detectExplicitRefusal("連絡もらえたら結構嬉しいです")).toBe(false);
    expect(detectExplicitRefusal("DMは迷惑ではないです")).toBe(false);
    expect(detectExplicitRefusal("今後は連絡しないでください")).toBe(true);
  });
});
