import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { handleIngest } from "@/lib/sales/ingest";
import { ingestRequest } from "@/lib/sales/ingest-schema";
import { createServiceClient } from "@/lib/supabase/service";

// The only endpoint Operational Claude may call (docs/ARCHITECTURE.md §5).
// Bearer-token auth, strict schema, run_id idempotency. It cannot send
// messages, change DNC or change deal outcomes, and it never fetches URLs
// it is given.

export const maxDuration = 60;

const MAX_BODY_BYTES = 256 * 1024;
const MIN_TOKEN_LENGTH = 32;

const noStore = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: noStore });
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time comparison; fails closed when the token is not configured. */
function authorize(req: NextRequest): "ok" | "unconfigured" | "denied" {
  const expected = process.env.SALES_AGENT_INGEST_TOKEN;
  if (!expected || expected.length < MIN_TOKEN_LENGTH) return "unconfigured";
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/.exec(header);
  if (!match) return "denied";
  return timingSafeEqual(digest(match[1]), digest(expected)) ? "ok" : "denied";
}

export async function POST(req: NextRequest) {
  const auth = authorize(req);
  if (auth === "unconfigured") return json(503, { error: "ingest_disabled" });
  if (auth === "denied") return json(401, { error: "unauthorized" });

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });
  const raw = await req.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid_json" });
  }

  const parsed = ingestRequest.safeParse(body);
  if (!parsed.success) {
    // Paths and messages only — never echo submitted values back.
    const issues = parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message }));
    return json(400, { error: "invalid_request", issues });
  }

  let db;
  try {
    db = createServiceClient();
  } catch {
    return json(503, { error: "ingest_disabled" });
  }
  const result = await handleIngest(db, parsed.data);
  return json(result.status, result.body);
}
