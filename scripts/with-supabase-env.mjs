// Runs a command with the local Supabase stack's URL and keys in the
// environment (e.g. `node scripts/with-supabase-env.mjs vitest run ...`).
// Keys come from `supabase status` at run time and are never written to the
// repository. Requires `npx supabase start` to have been run first.
import { execFileSync, spawnSync } from "node:child_process";

let status;
try {
  status = JSON.parse(execFileSync("npx", ["supabase", "status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
} catch {
  console.error("Local Supabase is not running. Start it with `npx supabase start`.");
  process.exit(1);
}

const env = {
  ...process.env,
  SUPABASE_TEST: "1",
  NEXT_PUBLIC_SUPABASE_URL: status.API_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: status.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
  SUPABASE_DB_URL: status.DB_URL,
};

const [cmd, ...args] = process.argv.slice(2);
const result = spawnSync(cmd, args, { env, stdio: "inherit", shell: process.platform === "win32" });
process.exit(result.status ?? 1);
