import { NextRequest, NextResponse } from "next/server";
import { sha256Hex, verifySignature, verifyToken } from "@/lib/instagram/signature";
import { extractEvents } from "@/lib/instagram/webhook";
import { createServiceClient } from "@/lib/supabase/service";

// Meta webhook for Instagram messages (DEV-020, docs/INSTAGRAM_MESSAGING.md).
// GET  — subscription handshake: echo hub.challenge when hub.verify_token matches.
// POST — message events: verify X-Hub-Signature-256 over the raw body, then
//        store them idempotently. Nothing is stored unless the signature is
//        valid. Returns 200 once stored (or already stored) so Meta stops
//        retrying; 5xx only when storing failed, so Meta retries safely.
// Secrets are server-only environment variables and are never logged.

export const maxDuration = 30;

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MIN_SECRET_LENGTH = 16;

const noStore = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: noStore });
}

function secret(name: string): string | null {
  const value = process.env[name];
  return value && value.length >= MIN_SECRET_LENGTH ? value : null;
}

export async function GET(req: NextRequest) {
  const expected = secret("INSTAGRAM_WEBHOOK_VERIFY_TOKEN");
  if (!expected) return json(503, { error: "webhook_disabled" });
  const params = req.nextUrl.searchParams;
  const challenge = params.get("hub.challenge") ?? "";
  if (params.get("hub.mode") !== "subscribe" || !verifyToken(params.get("hub.verify_token"), expected) || !/^[\w-]{1,256}$/.test(challenge)) {
    return json(403, { error: "forbidden" });
  }
  return new NextResponse(challenge, { status: 200, headers: { ...noStore, "Content-Type": "text/plain" } });
}

/** Reads the raw body bytes, stopping as soon as the limit is exceeded. */
async function readLimited(req: NextRequest, limit: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array();
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
  return new Uint8Array(Buffer.concat(chunks));
}

export async function POST(req: NextRequest) {
  const appSecret = secret("INSTAGRAM_APP_SECRET");
  // Our own account id is required: events for any other account connected
  // to the same Meta app must never be stored as ours (fail closed).
  const accountId = process.env.INSTAGRAM_ACCOUNT_ID ?? "";
  if (!appSecret || !/^[0-9]{1,32}$/.test(accountId)) return json(503, { error: "webhook_disabled" });

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });
  const raw = await readLimited(req, MAX_BODY_BYTES);
  if (raw === null) return json(413, { error: "payload_too_large" });

  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), appSecret)) {
    return json(401, { error: "invalid_signature" });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const extracted = extractEvents(payload, accountId);
  if (!extracted) return json(400, { error: "invalid_payload" });

  let db;
  try {
    db = createServiceClient();
  } catch {
    return json(503, { error: "webhook_disabled" });
  }
  const { data, error } = await db.rpc("sales_ig_ingest", { p_body_sha256: sha256Hex(raw), p_events: extracted.events });
  if (error) return json(500, { error: "store_failed" });
  return json(200, { ok: true, ...(data as Record<string, unknown>), ignored: extracted.ignored });
}
