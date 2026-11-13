import type { Metadata } from "next";
import { cache } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import VersionShareFrame from "@/components/demo/VersionShareFrame";
import { renderDesignedDemo } from "@/components/demo/renderDemo";
import { loadPublicDemo, type PublicDemo } from "@/lib/sales/demo-data";
import { resolveShareOuter } from "@/lib/sales/demo-share";
import { demoShareEnabled } from "@/lib/sales/demo-version/flags";
import { createServiceClient } from "@/lib/supabase/service";

// Public proposal demo. Visibility (sent, 30 days, disabled, keep_alive) is
// decided at request time from Supabase; unknown, unsent, expired and
// disabled demos all return the same 404.
//
// DEV-196g: while versioned sharing is on (SALES_DEMO_SHARE_ENABLED), the
// database's share decision comes first: the version pinned by the sent
// approval is shown in a sandboxed frame from the artifact origin, a demo
// whose sent approval pinned no version keeps the React demo, and anything
// else is the same 404 — never another version or the React demo instead.
// With the flag off this page is exactly what it was.

const noIndex: Metadata["robots"] = { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } };

type Loaded = { kind: "react"; demo: PublicDemo } | { kind: "version"; shopName: string; frameSrc: string } | null;

async function loadReact(token: string): Promise<Loaded> {
  try {
    const demo = await loadPublicDemo(createServiceClient(), token);
    return demo ? { kind: "react", demo } : null;
  } catch {
    return null;
  }
}

// One database read (two with sharing on) per request, shared by generateMetadata and the page.
const load = cache(async (token: string): Promise<Loaded> => {
  await connection();
  if (!demoShareEnabled(process.env)) return loadReact(token);
  try {
    const share = await resolveShareOuter(createServiceClient(), token, { env: process.env, now: new Date() });
    if (share.kind === "legacy") return loadReact(token);
    if (share.kind === "version") return { kind: "version", shopName: share.shopName, frameSrc: share.frameSrc };
    return null;
  } catch {
    return null;
  }
});

export async function generateMetadata({ params }: PageProps<"/demo/[publicToken]">): Promise<Metadata> {
  const { publicToken } = await params;
  const loaded = await load(publicToken);
  const name = loaded?.kind === "react" ? loaded.demo.view.name : loaded?.kind === "version" ? loaded.shopName : null;
  return {
    title: name ? { absolute: `${name}（ご提案用デモ）` } : { absolute: "ページが見つかりません" },
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
  const loaded = await load(publicToken);
  if (!loaded) notFound();
  if (loaded.kind === "version") return <VersionShareFrame shopName={loaded.shopName} frameSrc={loaded.frameSrc} />;
  return renderDesignedDemo(loaded.demo.view, loaded.demo.profile);
}
