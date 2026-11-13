/**
 * DEV-263a (PR #266 Fresh Review L2): a fictional shop or a reserved test address is never approved for sending, unless
 * the LOCAL E2E flag is set. The sendable fictional shop 環 (lib/demo-version-package/seed-sendable.ts) and the e2e
 * seeds use example.com addresses: a real send to them would reach no one, but approving one outside a local E2E run
 * means test data reached the real send path.
 *
 *   - the demo's content.facts_pack (the facts pack's shop id) starts with `fictional-`;
 *   - the recipient email's domain is reserved (RFC 2606 / 6761): example.com / example.net / example.org (and their
 *     subdomains), or ends in .example, .test, .invalid or .localhost.
 *
 * LOCAL_E2E_TEST_RECIPIENTS_ENV is exactly "true" only in the local E2E run (playwright.config.ts webServer env); it is
 * never set on a hosted deployment (default off). Server gate only: the database's own guard would need a migration
 * (not in DEV-263a; recorded in .ai/reviews/DEV-263a.md).
 *
 * Pure.
 */
export const LOCAL_E2E_TEST_RECIPIENTS_ENV = "SALES_LOCAL_E2E_TEST_RECIPIENTS";

export type TestRecipientCode = "test_recipient_fictional_shop" | "test_recipient_reserved_domain";

export const TEST_RECIPIENT_LABEL: Record<TestRecipientCode, string> = {
  test_recipient_fictional_shop: "架空の店（動作確認用）のデモなので送信できません。",
  test_recipient_reserved_domain: "宛先が予約済みのテスト用ドメインのため送信できません。",
};

const RESERVED_DOMAIN = /(^|\.)example\.(com|net|org)$|\.(example|test|invalid|localhost)$|^(example|test|invalid|localhost)$/;

export function isReservedEmailDomain(email: string | null | undefined): boolean {
  if (!email) return false;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
  return RESERVED_DOMAIN.test(domain);
}

export function isFictionalFactsPack(factsPack: unknown): boolean {
  return typeof factsPack === "string" && /^fictional-/.test(factsPack);
}

/** Why this recipient may not be approved (null: this gate does not block). */
export function testRecipientBlock(
  i: { publicEmail: string | null | undefined; channel: string; factsPack: unknown },
  env: Readonly<Record<string, string | undefined>> = process.env,
): TestRecipientCode | null {
  if (env[LOCAL_E2E_TEST_RECIPIENTS_ENV] === "true") return null;
  if (isFictionalFactsPack(i.factsPack)) return "test_recipient_fictional_shop";
  if (i.channel === "email" && isReservedEmailDomain(i.publicEmail)) return "test_recipient_reserved_domain";
  return null;
}
