import type { NextRequest } from "next/server";
import { demoFrameNotFound, serveDemoFrame } from "@/lib/demo-frame/serve";
import { supabaseFrameStore } from "@/lib/demo-frame/store";

// DEV-196d-2 (spec §6.4): one file of one demo version for the admin preview, behind SALES_DEMO_VERSIONS_ENABLED
// (off by default → the same 404 as every other refusal). Reads no cookie and logs nothing; the decision is in
// lib/demo-frame/serve.ts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  return serveDemoFrame(
    {
      method: request.method,
      pathname: request.nextUrl.pathname,
      search: request.nextUrl.search,
      origin: request.nextUrl.origin,
      secFetchDest: request.headers.get("sec-fetch-dest"),
    },
    { env: process.env, now: new Date(), store: () => supabaseFrameStore() },
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
