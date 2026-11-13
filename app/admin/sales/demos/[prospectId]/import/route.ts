/**
 * DEV-263i: 版を取り込む — POST ?step=begin | put | finalize (lib/admin/demo-version-upload.ts has the design).
 *
 * Order: the preview flag (off → the same 404 as the page), the quality-review write flag (off → refused, nothing read),
 * the origin (a same-origin request from this app's page; CSRF), the admin (signed in and on sales_admins; the same 404
 * as the page for anyone else), then the step with the server's service-role client. Every body is read with a fixed
 * limit. Answers JSON with a fixed code; never a database message, a stack or a key. Headers: /admin/:path* in
 * next.config.ts (no-store, noindex, no framing).
 */
import { NextResponse, type NextRequest } from "next/server";
import { getAdminState } from "@/lib/admin/auth";
import { beginUpload, finalizeUpload, readBoundedBody, sameOriginRequest, stageFile, supabaseStagingStore, UPLOAD_LIMITS, uploadErrorCode, uploadRefusal } from "@/lib/admin/demo-version-upload";
import { supabasePackageStore } from "@/lib/demo-version-package/import";
import { PackageError } from "@/lib/demo-version-package/verify";
import { demoQualityReviewEnabled, demoVersionsEnabled } from "@/lib/sales/demo-version/flags";
import { createServiceClient } from "@/lib/supabase/service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
const refused = (status: number, code: string, details?: readonly string[]) => json(status, { ok: false, code, error: uploadRefusal(code), ...(details?.length ? { details: details.slice(0, 10) } : {}) });

export async function POST(request: NextRequest, ctx: RouteContext<"/admin/sales/demos/[prospectId]/import">) {
  if (!demoVersionsEnabled(process.env)) return new NextResponse("Not Found", { status: 404 });
  if (!demoQualityReviewEnabled(process.env)) return refused(403, "FEATURE_DISABLED");
  if (!sameOriginRequest(request.headers)) return refused(403, "INVALID_INPUT");
  const admin = await getAdminState();
  if (admin.kind === "anonymous") return json(401, { ok: false, code: "forbidden", error: "ログインし直してください。" });
  if (admin.kind !== "admin") return new NextResponse("Not Found", { status: 404 });

  const { prospectId } = await ctx.params;
  const step = request.nextUrl.searchParams.get("step");
  if (!UUID.test(prospectId) || (step !== "begin" && step !== "put" && step !== "finalize")) return refused(400, "INVALID_INPUT");

  try {
    const client = createServiceClient();
    const store = supabaseStagingStore(client, supabasePackageStore(client));
    if (step === "begin") {
      const body = await readBoundedBody(request, UPLOAD_LIMITS.packageJsonBytes);
      const packageJson = decode(body);
      return json(200, { ok: true, ...(await beginUpload({ env: process.env, client, store, prospectId, packageJson })) });
    }
    if (step === "put") {
      const bytes = await readBoundedBody(request, UPLOAD_LIMITS.putBytes);
      const r = await stageFile({ env: process.env, store, contentType: request.headers.get("content-type") ?? "", expectedSha256: request.headers.get("x-content-sha256") ?? "", bytes });
      return json(200, { ok: true, ...r });
    }
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) return refused(400, "INVALID_INPUT");
    const body = await readBoundedBody(request, UPLOAD_LIMITS.finalizeBytes);
    let form: FormData;
    try {
      form = await new Response(body, { headers: { "content-type": contentType } }).formData();
    } catch {
      return refused(400, "INVALID_INPUT");
    }
    let packageJson: string | null = null;
    const copyFiles = new Map<string, Uint8Array>();
    for (const [name, value] of form.entries()) {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(await value.arrayBuffer());
      if (name === "package.json") {
        if (packageJson !== null) return refused(400, "INVALID_INPUT");
        packageJson = decode(bytes);
      } else {
        // a part appears once; its name is checked against the copy manifest's fixed names in finalizeUpload
        if (copyFiles.has(name)) return refused(400, "INVALID_INPUT");
        copyFiles.set(name, bytes);
      }
    }
    if (packageJson === null) return refused(400, "INVALID_INPUT");
    return json(200, { ok: true, ...(await finalizeUpload({ env: process.env, client, store, prospectId, packageJson, copyFiles })) });
  } catch (e) {
    const code = uploadErrorCode(e);
    if (code === null) return json(500, { ok: false, code: "UNEXPECTED", error: "取り込めませんでした。もう一度試してください。" });
    return refused(code === "FEATURE_DISABLED" ? 403 : 422, code, e instanceof PackageError ? e.details : undefined);
  }
}

function decode(b: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return "";
  }
}
