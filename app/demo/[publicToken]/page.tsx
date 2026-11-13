import type { Metadata } from "next";
import { cache } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import VersionShareFrame from "@/components/demo/VersionShareFrame";
import { renderDesignedDemo } from "@/components/demo/renderDemo";
import { loadPublicDemo, type PublicDemo } from "@/lib/sales/demo-data";
import { resolveLegacyOnly, resolveShareOuter } from "@/lib/sales/demo-share";
import { demoShareEnabled } from "@/lib/sales/demo-version/flags";
import { createServiceClient } from "@/lib/supabase/service";

// Public proposal demo. Visibility (sent, 30 days, disabled, keep_alive) is
// decided at request time from Supabase; unknown, unsent, expired and
// disabled demos all return the same 404.
//
// DEV-196g: the database's share decision (sales_resolve_demo_share) comes
// first. A demo whose sent approval pinned no version (legacy) keeps the React
// demo exactly as before. While versioned sharing is on (SALES_DEMO_SHARE_ENABLED
// and the database switch) the pinned version is shown in a sandboxed frame from
// the artifact origin; with either off, a pinned demo is 404. Anything else is the
// same 404 — never another version or the React demo instead.

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

// The database's share decision first, then the React demo only for `legacy`; shared by generateMetadata and the page.
const load = cache(async (token: string): Promise<Loaded> => {
  await connection();
  // PR #267 M1: with the share flag off, a demo whose sent approval pinned a version is 404 too (never the React demo
  // in its place, spec §6.1・§6.6): the resolver still decides, and only `legacy` draws the React demo.
  if (!demoShareEnabled(process.env)) return (await resolveLegacyOnly(createServiceClient(), token)) ? loadReact(token) : null;
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
