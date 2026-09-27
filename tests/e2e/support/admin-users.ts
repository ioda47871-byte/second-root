import { createClient } from "@supabase/supabase-js";
import pg from "pg";

// Creates fictional admin / non-admin users in the local Supabase stack for
// e2e tests. Keys come from `supabase status` via scripts/with-supabase-env.mjs.

export const ADMIN = { email: "e2e-admin@test.example.com", password: "e2e-admin-password-123" };
export const OUTSIDER = { email: "e2e-outsider@test.example.com", password: "e2e-outsider-password-123" };

function service() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}

export async function ensureUsers(): Promise<void> {
  const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL });
  await db.connect();
  try {
    await db.query("delete from auth.users where email in ($1, $2)", [ADMIN.email, OUTSIDER.email]);
    const admin = await service().auth.admin.createUser({ ...ADMIN, email_confirm: true });
    if (admin.error) throw admin.error;
    const outsider = await service().auth.admin.createUser({ ...OUTSIDER, email_confirm: true });
    if (outsider.error) throw outsider.error;
    await db.query("insert into public.sales_admins (user_id) values ($1) on conflict do nothing", [admin.data.user.id]);
  } finally {
    await db.end();
  }
}

export async function removeUsers(): Promise<void> {
  const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL });
  await db.connect();
  try {
    await db.query("delete from auth.users where email in ($1, $2)", [ADMIN.email, OUTSIDER.email]);
  } finally {
    await db.end();
  }
}
