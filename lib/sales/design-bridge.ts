import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkProfile } from "@/lib/design-agent/profile";
import { toDemoView, type DemoView } from "./demo-content";
import { DESIGN_LEASE_SECONDS, DESIGN_MAX_ATTEMPTS } from "./design";
import { workerJobIdFor, type DesignBridgeRequest, type DesignFacts, type DesignJob, type DesignResult } from "./design-bridge-schema";
import { isOfficialSiteCandidate, parseInstagramProfile, parseSafeHttpUrl } from "./url";

// Actions of the bridge API (DEV-030). The database functions own the state
// machine (sales_design_claim / sales_design_submit: one job at a time,
// lineage by job id, bounded retries, stale leases); this module only maps
// rows to the narrow job shape and back.
//
// A job carries the fact-only DemoView's inputs and the verified source
// URLs, nothing else (no prospect id, email, outreach text, run data). The
// server never fetches these URLs.

export type BridgeResult = { status: number; body: Record<string, unknown> };

type ClaimRow = {
  job_id: string;
  attempt: number;
  template: string;
  content: unknown;
  website_url: string | null;
  instagram_url: string | null;
};

type StateRow = { job_id: string; status: DesignResult["status"]; error_code: string | null; attempts: number; replayed: boolean };

/** The facts a design may use: exactly what the public demo would show (emails and unknown keys dropped). */
export function factsFromView(view: DemoView): DesignFacts {
  const facts: DesignFacts = { name: view.name, category: view.category };
  if (view.ward) facts.ward = view.ward;
  if (view.address) facts.address = view.address;
  if (view.hours) facts.hours = view.hours;
  if (view.closedDays) facts.closed_days = view.closedDays;
  if (view.access) facts.access = view.access;
  if (view.phone) facts.phone = view.phone;
  if (view.description) facts.description = view.description;
  if (view.menuItems.length > 0) facts.menu_items = view.menuItems;
  return facts;
}

/** Only a verified official site that is not a social or portal page; only a canonical Instagram profile. */
export function jobSource(row: { website_url: string | null; instagram_url: string | null }): DesignJob["source"] | null {
  const website = row.website_url && isOfficialSiteCandidate(row.website_url) ? parseSafeHttpUrl(row.website_url)?.toString() : undefined;
  const instagram = parseInstagramProfile(row.instagram_url)?.url;
  if (!website && !instagram) return null;
  return { ...(website ? { website_url: website } : {}), ...(instagram ? { instagram_url: instagram } : {}) };
}

function errorCode(message: string | undefined): string {
  return (message ?? "").split(":")[0].trim();
}

async function submitRow(
  db: SupabaseClient,
  args: { jobId: string; outcome: "ready" | "blocked" | "failed"; profile: unknown; errorCode: string | null; workerCommit: string | null },
): Promise<{ ok: true; row: StateRow } | { ok: false; code: string }> {
  const { data, error } = await db.rpc("sales_design_submit", {
    p_job_id: args.jobId,
    p_outcome: args.outcome,
    p_profile: args.profile,
    p_error_code: args.errorCode,
    p_worker_commit: args.workerCommit,
    p_max_attempts: DESIGN_MAX_ATTEMPTS,
  });
  if (error) return { ok: false, code: errorCode(error.message) };
  return { ok: true, row: data as StateRow };
}

/** Claims up to a few jobs until one can be handed out (a job without usable facts or source is closed as blocked). */
async function claim(db: SupabaseClient): Promise<BridgeResult> {
  for (let i = 0; i < 5; i++) {
    const { data, error } = await db.rpc("sales_design_claim", { p_lease_seconds: DESIGN_LEASE_SECONDS, p_max_attempts: DESIGN_MAX_ATTEMPTS });
    if (error) return { status: 503, body: { error: "unavailable" } };
    if (!data) return { status: 200, body: { job: null } };
    const row = data as ClaimRow;
    const view = toDemoView(row.template, row.content);
    const source = jobSource(row);
    if (!view || !source) {
      const closed = await submitRow(db, { jobId: row.job_id, outcome: "blocked", profile: null, errorCode: view ? "NO_VISUAL_SOURCE" : "DEMO_CONTENT_INVALID", workerCommit: null });
      if (!closed.ok) return { status: 503, body: { error: "unavailable" } };
      continue;
    }
    const job: DesignJob = { jobId: row.job_id, workerJobId: workerJobIdFor(row.job_id), attempt: row.attempt, facts: factsFromView(view), source };
    return { status: 200, body: { job } };
  }
  return { status: 200, body: { job: null } };
}

async function submit(db: SupabaseClient, request: Extract<DesignBridgeRequest, { action: "submit" }>): Promise<BridgeResult> {
  // The same checks the renderer applies (schema, contrast, repeated motifs):
  // a profile that could not be drawn is never stored.
  if (request.profile) {
    const checked = checkProfile(request.profile);
    if (!checked.ok) return { status: 400, body: { error: "invalid_profile" } };
  }
  const result = await submitRow(db, request);
  if (!result.ok) {
    if (result.code === "job_superseded") return { status: 409, body: { error: "job_superseded" } };
    if (result.code === "invalid_result") return { status: 400, body: { error: "invalid_result" } };
    return { status: 503, body: { error: "unavailable" } };
  }
  const r = result.row;
  const body: DesignResult = { jobId: r.job_id, status: r.status, errorCode: r.error_code, attempts: r.attempts, replayed: r.replayed };
  return { status: 200, body: { result: body } };
}

export async function handleDesignBridge(db: SupabaseClient, request: DesignBridgeRequest): Promise<BridgeResult> {
  return request.action === "claim" ? claim(db) : submit(db, request);
}
