import { connection } from "next/server";
import { readPreviewAsset } from "@/lib/design-agent/assets/serve";
import { previewRoot } from "@/lib/design-agent/preview";

// A photo of a design run, for the local design preview only (DEV-029).
// Like the preview page it exists only where SR_DESIGN_PREVIEW_ROOT is set
// (never on Vercel). The URL gives ids only; readPreviewAsset decides
// everything else from the run directory and the asset manifest.

const notFound = () => new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string; assetId: string }> }) {
  await connection();
  const root = previewRoot(process.env);
  if (!root) return notFound();
  const { runId, assetId } = await params;
  const png = await readPreviewAsset({ previewRoot: root, runId, assetId, env: process.env, repoDir: process.cwd() });
  if (!png) return notFound();
  return new Response(new Uint8Array(png), {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" },
  });
}
