import type { NextRequest } from "next/server";
import { demoFrameNotFound, requestOrigin, serveDemoFrame } from "@/lib/demo-frame/serve";
import { supabaseFrameStore } from "@/lib/demo-frame/store";

// DEV-196g (spec §6.4・§6.8): one file of the version a sent approval pinned, for the share page's sandboxed frame —
// only from the dedicated artifact origin, behind SALES_DEMO_VERSIONS_ENABLED + SALES_DEMO_SHARE_ENABLED and the
// database's share switch (all off by default → the same 404 as every other refusal). Reads no cookie and logs
// nothing; the decision is in lib/demo-frame/serve.ts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  return serveDemoFrame(
    {
      method: request.method,
      pathname: request.nextUrl.pathname,
      search: request.nextUrl.search,
      origin: requestOrigin({ host: request.headers.get("host"), forwardedProto: request.headers.get("x-forwarded-proto"), urlProtocol: request.nextUrl.protocol }),
      secFetchDest: request.headers.get("sec-fetch-dest"),
    },
    { env: process.env, now: new Date(), store: () => supabaseFrameStore() },
    "p",
  );
}

export async function HEAD(): Promise<Response> {
  return demoFrameNotFound();
}
export async function POST(): Promise<Response> {
  return demoFrameNotFound();
}
export async function PUT(): Promise<Response> {
  return demoFrameNotFound();
}
export async function PATCH(): Promise<Response> {
  return demoFrameNotFound();
}
export async function DELETE(): Promise<Response> {
  return demoFrameNotFound();
}
export async function OPTIONS(): Promise<Response> {
  return demoFrameNotFound();
}
