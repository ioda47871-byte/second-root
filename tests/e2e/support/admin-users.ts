import { createClient } from "@supabase/supabase-js";
import pg from "pg";

// Creates fictional admin / non-admin users in the local Supabase stack for
// e2e tests. Keys come from `supabase status` via scripts/with-supabase-env.mjs.

// One pair of users per Playwright project and test run, so parallel
// projects or concurrent runs against the same local stack never race.
const RUN = process.env.E2E_RUN_ID ?? String(process.ppid);

export function usersFor(project: string) {
  return {
    admin: { email: `e2e-admin-${project}-${RUN}@test.example.com`, password: "e2e-admin-password-123" },
    outsider: { email: `e2e-outsider-${project}-${RUN}@test.example.com`, password: "e2e-outsider-password-123" },
  };
}

function service() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}

export async function ensureUsers(project: string): Promise<void> {
  const { admin: ADMIN, outsider: OUTSIDER } = usersFor(project);
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

export async function removeUsers(project: string): Promise<void> {
  const { admin: ADMIN, outsider: OUTSIDER } = usersFor(project);
  const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL });
  await db.connect();
  try {
    await db.query("delete from auth.users where email in ($1, $2)", [ADMIN.email, OUTSIDER.email]);
  } finally {
    await db.end();
  }
}
