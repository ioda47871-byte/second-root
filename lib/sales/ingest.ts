import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { demoUrl } from "@/lib/admin/today";
import { checkDraft } from "@/lib/instagram/draft";
import { fetchUsername } from "@/lib/instagram/graph";
import { checkpointProblem } from "./checkpoint";
import type { IngestRequest } from "./ingest-schema";
import { prepareCandidate, type PreparedCandidate } from "./prepare";
import { isTerminalStage, nextAction, type CandidateStage, type NextAction, type RunPhase, type RunStatus } from "./run";

// Ingest actions for POST /api/internal/sales-agent/runs
// (docs/ARCHITECTURE.md §5, §7). The run state lives only in Supabase; this
// module never keeps state between requests, so any request can be retried
// and any session can resume a run.

type DbRunState = {
  run_id: string;
  status: RunStatus;
  phase: RunPhase;
  checkpoint_at: string;
  persist_attempts: number;
  error_code: string | null;
  error_summary: string | null;
  discovered_keys: string[];
  discovered?: Array<{ key: string; name: string; category: string; ward: string | null; website_url: string | null; instagram_url: string | null }>;
  verified_order: string[];
  candidates: Record<string, { stage: CandidateStage; prospect_id?: string; reason?: string; error_code?: string }>;
  replayed: boolean;
};

export type RunView = {
  runId: string;
  status: RunStatus;
  phase: RunPhase;
  checkpointAt: string;
  nextAction: NextAction;
  persistAttempts: number;
  errorCode: string | null;
  errorSummary: string | null;
  discoveredKeys: string[];
  /** The discovered stubs, only while nextAction is verify (resume without searching again). */
  discovered: Array<{ key: string; name: string; category: string; ward: string | null; websiteUrl: string | null; instagramUrl: string | null }>;
  candidates: Array<{ key: string; stage: CandidateStage; prospectId?: string; reason?: string; errorCode?: string }>;
  replayed: boolean;
};

export type IngestResult = { status: number; body: Record<string, unknown> };

/** Errors raised by the run functions that the client can act on. */
const CLIENT_ERRORS: Record<string, number> = {
  run_not_found: 404,
  phase_order_violation: 409,
  run_busy: 409,
  too_many_candidates: 400,
  invalid_candidate_keys: 400,
  unknown_candidate_key: 400,
  invalid_candidate_stage: 400,
  missing_candidate: 400,
  invalid_phase: 400,
  not_found: 404,
  stale_message: 409,
  not_draftable: 409,
};

const CANDIDATE_ERROR_CODES = new Set(["dedupe_unavailable", "persist_failed", "demo_failed", "outreach_failed"]);

class RunError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
  ) {
    super(code);
  }
}

/** First token of a Postgres exception message raised by our functions. */
function errorCode(message: string | undefined): string {
  return (message ?? "").split(":")[0].trim();
}

async function call<T>(db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    const code = errorCode(error.message);
    if (code in CLIENT_ERRORS) throw new RunError(code, CLIENT_ERRORS[code]);
    throw new RunError("internal_error", 503);
  }
  return data as T;
}

export function toView(state: DbRunState, now: Date = new Date()): RunView {
  return {
    runId: state.run_id,
    status: state.status,
    phase: state.phase,
    checkpointAt: state.checkpoint_at,
    nextAction: nextAction({ status: state.status, phase: state.phase, checkpointAt: new Date(state.checkpoint_at) }, now),
    persistAttempts: state.persist_attempts,
    errorCode: state.error_code,
    errorSummary: state.error_summary,
    discoveredKeys: state.discovered_keys ?? [],
    discovered: (state.discovered ?? []).map((c) => ({
      key: c.key,
      name: c.name,
      category: c.category,
      ward: c.ward ?? null,
      websiteUrl: c.website_url ?? null,
      instagramUrl: c.instagram_url ?? null,
    })),
    candidates: (state.verified_order ?? []).map((key) => {
      const c = state.candidates?.[key] ?? { stage: "pending" as const };
      return {
        key,
        stage: c.stage,
        ...(c.prospect_id ? { prospectId: c.prospect_id } : {}),
        ...(c.reason ? { reason: c.reason } : {}),
        ...(c.error_code ? { errorCode: c.error_code } : {}),
      };
    }),
    replayed: state.replayed,
  };
}

/** A failed run is never resumed: 409 with nextAction start_new_run. */
function respond(state: DbRunState): IngestResult {
  const view = toView(state);
  return { status: state.status === "failed" ? 409 : 200, body: { run: view } };
}

async function persist(db: SupabaseClient, runId: string): Promise<IngestResult> {
  const begun = await call<DbRunState>(db, "sales_run_begin_persist", { p_run_id: runId, p_lease_seconds: 120 });
  if (begun.status !== "running") return respond(begun);

  for (const key of begun.verified_order) {
    if (isTerminalStage(begun.candidates[key]?.stage ?? "pending")) continue;
    const { data, error } = await db.rpc("sales_persist_candidate", { p_run_id: runId, p_key: key });
    if (error) {
      const code = errorCode(error.message);
      if (code === "lease_lost" || code === "phase_order_violation") break;
      try {
        await call(db, "sales_run_mark_candidate_error", {
          p_run_id: runId,
          p_key: key,
          p_error_code: CANDIDATE_ERROR_CODES.has(code) ? code : "persist_failed",
        });
      } catch {
        // Could not record the error: stop and let finalize release the lease.
        break;
      }
      continue;
    }
    // The run stopped (expired / aborted) while persisting: stop the loop.
    if (data && typeof data === "object" && "run_status" in data) break;
  }
  return respond(await call<DbRunState>(db, "sales_run_finalize", { p_run_id: runId }));
}

type PendingRow = {
  thread_id: string;
  message_id: string;
  match_status: "matched" | "unmatched";
  messages: Array<{ direction: "inbound" | "outbound"; text: string | null; attachment_types: string[]; sent_at: string }>;
  shop: {
    name: string;
    category: string;
    ward: string | null;
    demo_token: string | null;
    initial_outreach: { status: string; reply_type: string | null; body: string } | null;
  } | null;
};

/**
 * Tries to link unmatched conversations. Usernames are fetched from the
 * official API only for conversations that have none yet (newest first, a
 * few in parallel, bounded time); conversations that already have one are
 * re-checked in SQL (the shop may have been contacted since). Returns the
 * number of errors so a broken token is noticed.
 */
async function matchUnmatched(db: SupabaseClient): Promise<number> {
  let errors = 0;
  const { data: noName, error: e1 } = await db
    .from("sales_ig_threads")
    .select("id, igsid")
    .eq("match_status", "unmatched")
    .is("username", null)
    .order("last_inbound_at", { ascending: false })
    .limit(5);
  if (e1) errors += 1;
  await Promise.all(
    ((noName ?? []) as Array<{ id: string; igsid: string }>).map(async (t) => {
      const username = await fetchUsername(t.igsid);
      if (!username) return;
      const { error } = await db.rpc("sales_ig_match_thread", { p_thread_id: t.id, p_username: username });
      if (error) errors += 1;
    }),
  );
  const { data: named, error: e2 } = await db
    .from("sales_ig_threads")
    .select("id, username")
    .eq("match_status", "unmatched")
    .not("username", "is", null)
    .order("last_inbound_at", { ascending: false })
    .limit(20);
  if (e2) errors += 1;
  for (const t of (named ?? []) as Array<{ id: string; username: string }>) {
    const { error } = await db.rpc("sales_ig_match_thread", { p_thread_id: t.id, p_username: t.username });
    if (error) errors += 1;
  }
  return errors;
}

async function inboxPending(db: SupabaseClient, limit: number): Promise<IngestResult> {
  const matchErrors = await matchUnmatched(db);
  const rows = await call<PendingRow[]>(db, "sales_ig_inbox_pending", { p_limit: limit });
  return {
    status: 200,
    body: {
      matchErrors,
      inbox: rows.map((r) => ({
        threadId: r.thread_id,
        messageId: r.message_id,
        matched: r.match_status === "matched",
        messages: r.messages.map((m) => ({ direction: m.direction, text: m.text, attachmentTypes: m.attachment_types, sentAt: m.sent_at })),
        shop: r.shop && {
          name: r.shop.name,
          category: r.shop.category,
          ward: r.shop.ward,
          demoUrl: r.shop.demo_token ? demoUrl(r.shop.demo_token) : null,
          initialOutreach: r.shop.initial_outreach
            ? { status: r.shop.initial_outreach.status, replyType: r.shop.initial_outreach.reply_type, message: r.shop.initial_outreach.body }
            : null,
        },
      })),
    },
  };
}

async function inboxDraft(db: SupabaseClient, request: Extract<IngestRequest, { action: "inbox_draft" }>): Promise<IngestResult> {
  const { data: thread } = await db
    .from("sales_ig_threads")
    .select("id, prospect:sales_prospects(demo:sales_demos(public_token, disabled_at, expires_at, keep_alive))")
    .eq("id", request.threadId)
    .maybeSingle();
  if (!thread) return { status: 404, body: { error: "not_found" } };
  // Everything the person wrote since our last reply (a refusal may be
  // followed by a polite closing line).
  const { data: recent } = await db
    .from("sales_ig_messages")
    .select("direction, text")
    .eq("thread_id", request.threadId)
    .is("deleted_at", null)
    .order("sent_at", { ascending: false })
    .limit(10);
  const sinceOurReply: string[] = [];
  for (const m of (recent ?? []) as Array<{ direction: string; text: string | null }>) {
    if (m.direction === "outbound") break;
    if (m.text) sinceOurReply.push(m.text);
  }
  type Demo = { public_token: string; disabled_at: string | null; expires_at: string | null; keep_alive: boolean };
  const prospect = (thread as unknown as { prospect: { demo: Demo | Demo[] | null } | null }).prospect;
  const demo = Array.isArray(prospect?.demo) ? prospect?.demo[0] : prospect?.demo;
  const live = demo && !demo.disabled_at && demo.expires_at && (demo.keep_alive || Date.parse(demo.expires_at) > Date.now());
  const checked = checkDraft(request, live ? demoUrl(demo.public_token) : null, sinceOurReply.reverse().join("\n"));
  if (!checked.ok) {
    // Counts toward the back-off so one conversation cannot block the queue.
    await db.rpc("sales_ig_note_draft_failure", { p_thread_id: request.threadId, p_message_id: request.messageId });
    return { status: 400, body: { error: "invalid_draft", reason: checked.reason } };
  }
  const saved = await call<{ draft_id: string; status: string; replayed: boolean }>(db, "sales_ig_save_draft", {
    p_thread_id: request.threadId,
    p_message_id: request.messageId,
    p_reply_type: request.replyType,
    p_body: checked.body,
    p_dnc_candidate: checked.dncCandidate,
    p_needs_review: checked.needsHumanReview,
    p_review_reasons: checked.reviewReasons,
  });
  return {
    status: 200,
    body: { draft: { draftId: saved.draft_id, status: saved.status, replayed: saved.replayed, needsHumanReview: checked.needsHumanReview, dncCandidate: checked.dncCandidate } },
  };
}

export async function handleIngest(db: SupabaseClient, request: IngestRequest): Promise<IngestResult> {
  try {
    switch (request.action) {
      case "start":
        return respond(await call<DbRunState>(db, "sales_run_start", { p_run_id: request.runId }));

      case "status": {
        const state = await call<DbRunState | null>(db, "sales_run_status", { p_run_id: request.runId ?? null });
        if (!state) return { status: 200, body: { run: null, nextAction: "start_new_run" } };
        return respond(state);
      }

      case "checkpoint": {
        if (request.phase === "discovered") {
          const payload = {
            candidates: request.candidates.map((c) => ({
              key: c.key,
              name: c.name,
              category: c.category,
              ward: c.ward ?? null,
              website_url: c.websiteUrl ?? null,
              instagram_url: c.instagramUrl ?? null,
            })),
          };
          if (checkpointProblem(payload) !== null) return { status: 400, body: { error: "unsafe_checkpoint_content" } };
          return respond(await call<DbRunState>(db, "sales_run_checkpoint", { p_run_id: request.runId, p_phase: "discovered", p_payload: payload }));
        }

        const order: string[] = [];
        const candidates: Record<string, PreparedCandidate> = {};
        const stages: Record<string, { stage: "pending" | "rejected"; reason?: string }> = {};
        for (const input of request.candidates) {
          order.push(input.key);
          const prepared = prepareCandidate(input);
          if (prepared.stage === "pending") {
            candidates[input.key] = prepared.candidate;
            stages[input.key] = { stage: "pending" };
          } else {
            stages[input.key] = { stage: "rejected", reason: prepared.reason };
          }
        }
        const payload = { order, candidates, stages };
        const problem = checkpointProblem(payload);
        if (problem === "too_large") return { status: 413, body: { error: "checkpoint_too_large" } };
        if (problem !== null) return { status: 400, body: { error: "unsafe_checkpoint_content" } };
        return respond(await call<DbRunState>(db, "sales_run_checkpoint", { p_run_id: request.runId, p_phase: "verified", p_payload: payload }));
      }

      case "persist":
        return await persist(db, request.runId);

      case "inbox_pending":
        return await inboxPending(db, request.limit ?? 10);

      case "inbox_draft":
        return await inboxDraft(db, request);

      case "abort":
        return respond(
          await call<DbRunState>(db, "sales_run_abort", {
            p_run_id: request.runId,
            p_error_code: request.errorCode,
            p_error_summary: request.errorSummary,
          }),
        );
    }
  } catch (err) {
    if (err instanceof RunError) return { status: err.httpStatus, body: { error: err.code } };
    return { status: 503, body: { error: "internal_error" } };
  }
}
