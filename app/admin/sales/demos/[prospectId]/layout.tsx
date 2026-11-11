import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/admin/auth";
import { demoVersionsPageExists } from "@/lib/admin/demo-versions";
import { demoVersionsEnabled } from "@/lib/sales/demo-version/flags";

// DEV-196d-3: the gate runs here, outside loading.tsx's boundary, so a refusal is a real 404 (Next streams the
// loading state with 200 and cannot change the status afterwards: docs "loading.js › Status Codes"). Flag off (the
// default) → 404 before anything is queried; then the admin check; then the shop must have a demo.
export default async function DemoVersionsLayout({ children, params }: LayoutProps<"/admin/sales/demos/[prospectId]">) {
  if (!demoVersionsEnabled(process.env)) notFound();
  await requireAdminPage();
  const { prospectId } = await params;
  if (!(await demoVersionsPageExists(prospectId, { env: process.env }))) notFound();
  return children;
}
