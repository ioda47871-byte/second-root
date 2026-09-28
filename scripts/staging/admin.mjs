#!/usr/bin/env node
// Registers the one MVP admin (docs/STAGING.md §3). The human creates the
// Auth user in the Supabase Dashboard (the password never reaches Claude);
// this only links that confirmed user to sales_admins.
//
//   SUPABASE_ACCESS_TOKEN=… npm run staging:admin -- --project-ref <ref> --email <admin email>

import { assertRef, managementQuery, parseArgs } from "./lib.mjs";

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ref = assertRef(args["project-ref"]);
  const email = String(args.email ?? "");
  if (!EMAIL.test(email) || email.length > 254) throw new Error("--email must be the admin's email address");
  const query = managementQuery(ref, process.env.SUPABASE_ACCESS_TOKEN);
  const literal = `'${email.toLowerCase().replaceAll("'", "''")}'`;

  const users = await query(`select id, email_confirmed_at is not null as confirmed from auth.users where lower(email) = ${literal}`);
  if (users.length !== 1) throw new Error(`expected exactly one Auth user with that email, found ${users.length} (create it in Authentication → Add user)`);
  if (!/^[0-9a-f-]{36}$/.test(users[0].id)) throw new Error("unexpected user id");
  if (!users[0].confirmed) throw new Error("the Auth user is not confirmed (use Auto Confirm User when creating it)");
  const admins = await query("select user_id from public.sales_admins");
  if (admins.some((a) => a.user_id === users[0].id)) {
    console.log("already the admin; nothing to do");
    return;
  }
  if (admins.length > 0) throw new Error(`another admin is already registered (${admins.length}); the MVP has exactly one admin`);
  await query(`insert into public.sales_admins (user_id) values ('${users[0].id}')`);
  console.log("admin registered");
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
