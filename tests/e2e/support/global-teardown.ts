import { setLocalTestRecipients } from "../../support/local-test-recipients";

// DEV-263g: the owner's local test-recipient switch back to its default (off) after the run.
export default async function globalTeardown(): Promise<void> {
  if (!process.env.SUPABASE_DB_URL) return;
  await setLocalTestRecipients(false);
}
