import pg from "pg";

/**
 * DEV-263g: the database owner's local switch of the test-recipient guard (sales_local_test_settings, default off;
 * migration 20261115000100). The local test runs approve fictional shops and example.com addresses, so their setup
 * switches it on AS THE OWNER (the trigger refuses every API role). Only for a loopback database: never a hosted one.
 */
export function loopbackDbUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" ? url : null;
  } catch {
    return null;
  }
}

export async function setLocalTestRecipients(on: boolean, url = process.env.SUPABASE_DB_URL): Promise<void> {
  const local = loopbackDbUrl(url);
  if (!local) throw new Error("the local test-recipient switch is set only on a loopback database");
  const c = new pg.Client({ connectionString: local });
  await c.connect();
  try {
    await c.query("update public.sales_local_test_settings set local_test_recipients_enabled = $1", [on]);
  } finally {
    await c.end();
  }
}

/** DEV-263f (PR #269 M2): the database owner's local switch of the facts CLI registration (default off). */
export async function setFactsCliRegistration(on: boolean, url = process.env.SUPABASE_DB_URL): Promise<void> {
  const local = loopbackDbUrl(url);
  if (!local) throw new Error("the local facts CLI switch is set only on a loopback database");
  const c = new pg.Client({ connectionString: local });
  await c.connect();
  try {
    await c.query("update public.sales_facts_registration_settings set operator_cli_enabled = $1", [on]);
  } finally {
    await c.end();
  }
}
