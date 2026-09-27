#!/usr/bin/env node
// Local dry-run of the Operational Claude run protocol (DEV-015).
//
// Plays two sessions against a LOCAL ingest API with fictional shops only
// (example.com / fictional Instagram handles; nothing is fetched, nothing is
// sent to any shop):
//   session A: status → start → checkpoint(discovered) → session is lost
//   session B: status (no runId, no memory) → verify the returned stubs →
//              checkpoint(verified) → persist (+ retry while errors) → status
// It uses only SALES_AGENT_INGEST_TOKEN, like Operational Claude.
//
// Usage (local Supabase + `npm run dev` or `npm start` running):
//   SALES_AGENT_INGEST_TOKEN=... node ops/sales-agent/dry-run.mjs [http://localhost:3000]

import { randomUUID } from "node:crypto";

const base = (process.argv[2] ?? process.env.SALES_AGENT_INGEST_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const url = new URL(base.endsWith("/api/internal/sales-agent/runs") ? base : `${base}/api/internal/sales-agent/runs`);
const token = process.env.SALES_AGENT_INGEST_TOKEN ?? "";

// Local only: never exercise a shared environment with fictional data from here.
if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
  console.error(`dry-run: refusing non-local target ${url.hostname} (local only)`);
  process.exit(2);
}
if (token.length < 32) {
  console.error("dry-run: SALES_AGENT_INGEST_TOKEN is not set (or shorter than 32 characters)");
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(body, { expect = [200] } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Same runId, same action, same body: safe to resend (idempotent).
      if (attempt < 3) {
        await sleep(attempt * 1000);
        continue;
      }
      throw err;
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: `non-JSON response (HTTP ${res.status})` };
    }
    if (res.status >= 500 && attempt < 3) {
      await sleep(attempt * 1000);
      continue;
    }
    if (!expect.includes(res.status)) {
      throw new Error(`${body.action}: HTTP ${res.status} ${JSON.stringify(json)}`);
    }
    return json;
  }
}

function assert(condition, message) {
  if (!condition) {
    console.error(`dry-run: FAILED — ${message}`);
    process.exit(1);
  }
}

const n = randomUUID().slice(0, 6);
const now = new Date().toISOString();

// ---- session A -------------------------------------------------------------
const runId = randomUUID();
// 409 = today's run failed; a completed run today also closes the day.
const first = await call({ action: "status" }, { expect: [200, 409] });
console.log(`A status → ${first.run ? `${first.run.runId} ${first.run.nextAction}` : "no run today"}`);
assert(
  !first.run,
  first.run && ["none", "start_new_run"].includes(first.run.nextAction)
    ? "today's run already exists locally (one run per day); delete it from the local sales_agent_runs to run again"
    : "a resumable run already exists locally; finish or abort it first",
);

const started = await call({ action: "start", runId });
assert(started.run.nextAction === "discover", "start must lead to discover");

const stubs = [
  { key: "c01", name: `ドライラン工房${n}`, category: "bakery", ward: "中区", websiteUrl: null, instagramUrl: `https://www.instagram.com/dryrun_${n}/` },
  { key: "c02", name: `ドライラン焼菓子${n}`, category: "baked_goods", ward: "東区", websiteUrl: `https://dryrun-${n}.example.com/`, instagramUrl: null },
];
const discovered = await call({ action: "checkpoint", runId, phase: "discovered", candidates: stubs });
assert(discovered.run.nextAction === "verify", "discovered must lead to verify");
console.log(`A checkpoint(discovered) → ${stubs.length} stubs; session A is lost here`);

// ---- session B (no memory of A) ---------------------------------------------
const resumed = await call({ action: "status" });
assert(resumed.run?.runId === runId, "status without runId must return the interrupted run");
assert(resumed.run.nextAction === "verify", `expected verify, got ${resumed.run.nextAction}`);
assert(resumed.run.discovered.length === stubs.length, "status must return the discovered stubs");
console.log(`B status → ${resumed.run.runId} ${resumed.run.nextAction} (${resumed.run.discovered.length} stubs from the checkpoint)`);

// Resend of the same checkpoint (e.g. after a timeout) is harmless.
await call({ action: "checkpoint", runId, phase: "discovered", candidates: stubs });

const verified = resumed.run.discovered.map((s) => {
  const address = s.key === "c01" ? `愛知県名古屋市中区ドライラン${n}-1` : `愛知県名古屋市東区ドライラン${n}-2`;
  const source = s.instagramUrl ?? s.websiteUrl;
  const sourceType = s.instagramUrl ? "instagram_profile" : "official_site";
  return {
    key: s.key,
    name: s.name,
    address,
    category: s.category,
    website: s.websiteUrl ? { status: "present", url: s.websiteUrl, checks: 1 } : { status: "not_found", url: null, checks: 2 },
    instagramUrl: s.instagramUrl,
    email: s.websiteUrl
      ? { address: `info@dryrun-${n}.example.com`, sourceUrl: `${s.websiteUrl}contact`, sourceType: "official_contact" }
      : null,
    facts: [
      { field: "name", value: s.name, sourceUrl: source, sourceType, verifiedAt: now },
      { field: "address", value: address, sourceUrl: source, sourceType, verifiedAt: now },
    ],
    message: {
      subject: s.websiteUrl ? "ホームページのご提案" : null,
      body: "ドライラン用の営業文です（架空の店舗）。",
    },
  };
});
const afterVerify = await call({ action: "checkpoint", runId, phase: "verified", candidates: verified });
assert(afterVerify.run.nextAction === "persist", "verified must lead to persist");
console.log(`B checkpoint(verified) → ${verified.length} candidates`);

// 409 run_busy has no run in the body: wait, then read the state from status.
async function persist() {
  const res = await call({ action: "persist", runId }, { expect: [200, 409] });
  if (res.run) return res.run;
  await sleep(2000);
  return (await call({ action: "status", runId })).run;
}
let run = await persist();
for (let i = 0; i < 2 && run.nextAction === "persist"; i += 1) {
  run = await persist();
}
console.log(`B persist → ${run.status} (${run.candidates.map((c) => `${c.key}:${c.stage}${c.reason ? `(${c.reason})` : ""}`).join(", ")})`);
assert(run.status === "completed" && run.nextAction === "none", "persist must complete the run");

// A late resend of persist replays the stored result, never duplicates.
const replay = await call({ action: "persist", runId });
assert(replay.run.replayed === true, "a completed run must replay its result");

console.log("dry-run: OK");
console.log(`SALES_AGENT_RUN_REPORT
runId: ${runId}
status: ${run.status}
discovered: ${stubs.length}
verified: ${verified.length}
outreach_ready: ${run.candidates.filter((c) => c.stage === "outreach_ready").length} / rejected: ${run.candidates.filter((c) => c.stage === "rejected").length} / duplicate: ${run.candidates.filter((c) => c.stage === "duplicate").length} / error: ${run.candidates.filter((c) => c.stage === "error").length}
notes: local dry-run with fictional shops`);
