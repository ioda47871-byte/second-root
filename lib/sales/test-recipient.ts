import { domainToASCII } from "node:url";

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
 * never set on a hosted deployment (default off). DEV-263g: the database refuses the same recipients on its own
 * (sales_test_recipient_block in sales_send_guards, migration 20261115000100) unless the database owner's local switch
 * (sales_local_test_settings) is on; this server gate stays in front of it.
 *
 * DEV-263e (PR #266 review Lows): the domain is NFKC-normalised, put through the WHATWG IDNA mapping (domainToASCII:
 * full-width letters, ideographic full stops and mixed case all fold to the ASCII form) and stripped of every trailing
 * dot before the reserved test; a domain the mapping rejects counts as reserved (blocked, not let through). The local
 * flag counts only when the server's Supabase URL is a loopback host (localhost / 127.0.0.0/8 / ::1): a deployment that
 * has the flag by mistake but talks to a hosted project still blocks.
 *
 * Pure (the environment is a parameter).
 */
export const LOCAL_E2E_TEST_RECIPIENTS_ENV = "SALES_LOCAL_E2E_TEST_RECIPIENTS";

import type { TestRecipientCode } from "./test-recipient-labels";

export { TEST_RECIPIENT_LABEL, type TestRecipientCode } from "./test-recipient-labels";

const RESERVED_DOMAIN = /(^|\.)example\.(com|net|org)$|\.(example|test|invalid|localhost)$|^(example|test|invalid|localhost)$/;

/** The domain as DNS would see it: NFKC, IDNA (WHATWG) to ASCII, lower case, no trailing dots. null: not a domain. */
export function normaliseEmailDomain(raw: string): string | null {
  const nfkc = raw.normalize("NFKC").trim();
  if (nfkc === "") return null;
  const ascii = domainToASCII(nfkc);
  if (ascii === "") return null;
  const domain = ascii.toLowerCase().replace(/\.+$/, "");
  return domain === "" ? null : domain;
}

export function isReservedEmailDomain(email: string | null | undefined): boolean {
  if (!email) return false;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const raw = email.slice(at + 1);
  if (raw.trim() === "") return false;
  const domain = normaliseEmailDomain(raw);
  // a domain the IDNA mapping refuses is never a real recipient: treat it as a test address (fail closed)
  if (domain === null) return true;
  return RESERVED_DOMAIN.test(domain);
}

/** The Supabase URL names this machine (localhost, 127.0.0.0/8 or ::1) — the only place the local E2E flag counts. */
export function isLoopbackSupabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "localhost" || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** The local E2E flag is exactly "true" AND the server talks to a loopback Supabase. */
export function localE2eTestRecipientsAllowed(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[LOCAL_E2E_TEST_RECIPIENTS_ENV] === "true" && isLoopbackSupabaseUrl(env.NEXT_PUBLIC_SUPABASE_URL);
}

export function isFictionalFactsPack(factsPack: unknown): boolean {
  return typeof factsPack === "string" && /^fictional-/.test(factsPack);
}

/** Why this recipient may not be approved (null: this gate does not block). */
export function testRecipientBlock(
  i: { publicEmail: string | null | undefined; channel: string; factsPack: unknown },
  env: Readonly<Record<string, string | undefined>> = process.env,
): TestRecipientCode | null {
  if (localE2eTestRecipientsAllowed(env)) return null;
  if (isFictionalFactsPack(i.factsPack)) return "test_recipient_fictional_shop";
  if (i.channel === "email" && isReservedEmailDomain(i.publicEmail)) return "test_recipient_reserved_domain";
  return null;
}
