import { demoFrameNotFound } from "@/lib/demo-frame/serve";

// DEV-196d-2: everything else under /demo-frame — a missing path, any other scope, `p/` or `a/` without a token and a
// file — is the same 404 as the artifact routes' refusals, flags on or off. (The share scope `p` has its own route
// since DEV-196g: app/demo-frame/p/[token]/[...path].)
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
