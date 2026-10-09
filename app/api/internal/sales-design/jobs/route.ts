import { NextRequest, NextResponse } from "next/server";
import { handleDesignBridge } from "@/lib/sales/design-bridge";
import { authorizeBridge } from "@/lib/sales/design-bridge-auth";
import { designBridgeRequest } from "@/lib/sales/design-bridge-schema";
import { createServiceClient } from "@/lib/supabase/service";

// The only endpoint the local design bridge may call (DEV-030,
// docs/ARCHITECTURE.md §10). It can claim one design job and submit its
// result; nothing else (no prospect, outreach, DNC, run or send access).
//
// Fails closed: 503 unless SALES_AI_DESIGN_ENABLED is "true" and
// SALES_DESIGN_BRIDGE_TOKEN is set (≥ 32 characters) and differs from the
// Operational Claude ingest token. The ingest token never works here.

export const maxDuration = 30;

const MAX_BODY_BYTES = 32 * 1024;

const noStore = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: noStore });
}

/** Reads the body but stops as soon as it exceeds the limit. */
async function readLimited(req: NextRequest, limit: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(req: NextRequest) {
  const auth = authorizeBridge(req.headers.get("authorization"), process.env);
  if (auth === "disabled" || auth === "unconfigured") return json(503, { error: "design_bridge_disabled" });
  if (auth === "denied") return json(401, { error: "unauthorized" });

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });
  const raw = await readLimited(req, MAX_BODY_BYTES);
  if (raw === null) return json(413, { error: "payload_too_large" });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const parsed = designBridgeRequest.safeParse(body);
  if (!parsed.success) {
    // Schema paths and codes only; submitted values and unknown keys are never echoed.
    const issues = parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.filter((p) => typeof p === "number" || /^[A-Za-z]+$/.test(String(p))).join("."), code: i.code }));
    return json(400, { error: "invalid_request", issues });
  }

  let db;
  try {
    db = createServiceClient();
  } catch {
    return json(503, { error: "design_bridge_disabled" });
  }
  const result = await handleDesignBridge(db, parsed.data);
  return json(result.status, result.body);
}
