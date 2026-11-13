import { setLocalTestRecipients } from "../../support/local-test-recipients";

// DEV-263g: the e2e specs approve fictional shops and example.com addresses (never a real shop), so the database
// owner's local switch of the test-recipient guard is turned on for the run (loopback database only; a run without a
// database URL has no sales database to switch). The server's own gate is opened by SALES_LOCAL_E2E_TEST_RECIPIENTS in
// the webServer env, as before.
export default async function globalSetup(): Promise<void> {
  if (!process.env.SUPABASE_DB_URL) return;
  await setLocalTestRecipients(true);
}
