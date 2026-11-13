/**
 * DEV-263g: the test-recipient refusals (the server's gate lib/sales/test-recipient.ts and the database's
 * sales_test_recipient_block, migration 20261115000100) in the owner's words. No imports: the send screen's labels in
 * lib/sales/approval.ts use these, and that module reaches client components.
 */
export type TestRecipientCode = "test_recipient_fictional_shop" | "test_recipient_reserved_domain";

export const TEST_RECIPIENT_LABEL: Record<TestRecipientCode, string> = {
  test_recipient_fictional_shop: "架空の店（動作確認用）のデモなので送信できません。",
  test_recipient_reserved_domain: "宛先が予約済みのテスト用ドメインのため送信できません。",
};
