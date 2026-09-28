import type { Metadata } from "next";
import { cache } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { renderDemo } from "@/components/demo/renderDemo";
import { loadPublicDemo } from "@/lib/sales/demo-data";
import { createServiceClient } from "@/lib/supabase/service";

// Public proposal demo. Visibility (sent, 30 days, disabled, keep_alive) is
// decided at request time from Supabase; unknown, unsent, expired and
// disabled demos all return the same 404.

const noIndex: Metadata["robots"] = { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } };

// One database read per request, shared by generateMetadata and the page.
const load = cache(async (token: string) => {
  await connection();
  try {
    return await loadPublicDemo(createServiceClient(), token);
  } catch {
    return null;
  }
});

export async function generateMetadata({ params }: PageProps<"/demo/[publicToken]">): Promise<Metadata> {
  const { publicToken } = await params;
  const demo = await load(publicToken);
  return {
    title: demo ? { absolute: `${demo.name}（ご提案用デモ）` } : { absolute: "ページが見つかりません" },
    description: null,
    keywords: null,
    robots: noIndex,
    alternates: { canonical: null },
    openGraph: null,
    twitter: null,
  };
}

export default async function DemoPage({ params }: PageProps<"/demo/[publicToken]">) {
  const { publicToken } = await params;
  const demo = await load(publicToken);
  if (!demo) notFound();
  return renderDemo(demo);
}
