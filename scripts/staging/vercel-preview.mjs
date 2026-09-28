#!/usr/bin/env node
// Sets the Staging environment variables on Vercel **Preview only**, scoped
// to one git branch (docs/STAGING.md §4). Values go straight from the
// Supabase Management API / the environment to the Vercel API and are
// never printed. Production variables are never touched.
//
//   SUPABASE_ACCESS_TOKEN=… VERCEL_TOKEN=… STAGING_SALES_AGENT_INGEST_TOKEN=… \
//   npm run staging:vercel -- --project-ref <ref> --vercel-project <id or name> [--team <teamId>] \
//     --git-branch develop --demo-base-url https://<develop preview host>          # plan only
//   … --apply
//
// Also reports whether Vercel Deployment Protection is on for previews
// (it would block the Operational Claude ingest calls and Meta webhooks).

import { assertRef, managementRequest, parseArgs, redact } from "./lib.mjs";

const VERCEL_API = "https://api.vercel.com";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ref = assertRef(args["project-ref"]);
  const project = String(args["vercel-project"] ?? "");
  const team = args.team ? String(args.team) : null;
  const branch = String(args["git-branch"] ?? "");
  const demoBase = String(args["demo-base-url"] ?? "");
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(project)) throw new Error("--vercel-project is required");
  if (team !== null && !/^[A-Za-z0-9_-]{1,100}$/.test(team)) throw new Error("--team must be a Vercel team id");
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch)) throw new Error("--git-branch is required (e.g. develop)");
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(demoBase)) throw new Error("--demo-base-url must be an https origin without a path");
  const vercelToken = process.env.VERCEL_TOKEN;
  const ingestToken = process.env.STAGING_SALES_AGENT_INGEST_TOKEN;
  if (!vercelToken || vercelToken.length < 20) throw new Error("VERCEL_TOKEN is not set");
  if (!ingestToken || ingestToken.length < 32) throw new Error("STAGING_SALES_AGENT_INGEST_TOKEN is not set (32+ characters, Staging only)");

  const keys = await managementRequest(ref, process.env.SUPABASE_ACCESS_TOKEN)("GET", "/api-keys?reveal=true");
  const pick = (name) => keys.find((k) => k.name === name && (k.type === "legacy" || k.type === undefined))?.api_key;
  const anon = pick("anon");
  const service = pick("service_role");
  if (!anon || !service) throw new Error("could not read the project's anon / service_role keys");

  const vercel = async (method, path, body) => {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${VERCEL_API}${path}${team ? `${sep}teamId=${team}` : ""}`, {
      method,
      headers: { Authorization: `Bearer ${vercelToken}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Vercel ${method} ${path.split("?")[0]} ${res.status}: ${redact(text, vercelToken, ingestToken, anon, service).slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };

  const info = await vercel("GET", `/v9/projects/${encodeURIComponent(project)}`);
  const sso = info.ssoProtection ? `on (${info.ssoProtection.deploymentType})` : "off";
  const password = info.passwordProtection ? "on" : "off";
  console.log(`Vercel project ${info.name}: Deployment Protection — Vercel Authentication ${sso}, password ${password}`);

  const vars = [
    { key: "NEXT_PUBLIC_SUPABASE_URL", value: `https://${ref}.supabase.co`, type: "plain" },
    { key: "NEXT_PUBLIC_SUPABASE_ANON_KEY", value: anon, type: "encrypted" },
    { key: "SUPABASE_SERVICE_ROLE_KEY", value: service, type: "sensitive" },
    { key: "SALES_AGENT_INGEST_TOKEN", value: ingestToken, type: "sensitive" },
    { key: "SALES_DEMO_BASE_URL", value: demoBase, type: "plain" },
  ];
  for (const v of vars) console.log(`  ${v.key} → Preview (branch ${branch}), ${v.type}`);
  if (!args.apply) {
    console.log("plan only (add --apply to set them)");
    return;
  }
  await vercel(
    "POST",
    `/v10/projects/${encodeURIComponent(project)}/env?upsert=true`,
    vars.map((v) => ({ ...v, target: ["preview"], gitBranch: branch })),
  );
  console.log(`set ${vars.length} Preview variables for branch ${branch}. Redeploy that branch to use them.`);
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
