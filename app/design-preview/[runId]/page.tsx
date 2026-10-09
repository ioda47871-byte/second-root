import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { renderDemo } from "@/components/demo/renderDemo";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import { loadPreviewRun, previewRoot } from "@/lib/design-agent/preview";

// Local-only preview for the design agent PoC (DEV-028). It renders a run's
// verified facts from a directory outside the repository, with a candidate
// design profile or with the existing template ("before"). It exists only
// when SR_DESIGN_PREVIEW_ROOT is set on the machine running `next start`;
// the Vercel environments never set it, so there it is always a 404.

export const metadata: Metadata = { robots: { index: false, follow: false, nocache: true } };

export default async function DesignPreviewPage({ params, searchParams }: PageProps<"/design-preview/[runId]">) {
  await connection();
  const root = previewRoot(process.env);
  if (!root) notFound();
  const { runId } = await params;
  const { profile } = await searchParams;
  const run = await loadPreviewRun(root, runId, typeof profile === "string" ? profile : "none");
  if (!run) notFound();
  return run.profile ? <ProfileRenderer demo={run.demo} profile={run.profile} /> : renderDemo(run.demo);
}
