import { demoFrameNotFound } from "@/lib/demo-frame/serve";

// DEV-196d-2: everything else under /demo-frame — the share scope `p` (never built in DEV-196d; DEV-196g needs its own
// approval and the dedicated artifact origin), a missing path, any other scope — is the same 404 as the admin route's
// refusals, flag on or off.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return demoFrameNotFound();
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
