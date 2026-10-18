import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExclusionReason } from "@/lib/sales/exclusions";

// DEV-049: the exclusion list for the admin (session + RLS; nothing for non-admins).

export type ExclusionItem = {
  id: string;
  label: string;
  reason: ExclusionReason;
  note: string | null;
  instagramHandle: string | null;
  websiteDomain: string | null;
  /** DEV-050: only whether an email was registered; the address is never stored. */
  hasEmail: boolean;
  normalizedName: string | null;
  normalizedAddress: string | null;
  createdAt: string;
};

type Row = {
  id: string;
  label: string;
  reason: ExclusionReason;
  note: string | null;
  instagram_handle: string | null;
  website_domain: string | null;
  email_digest: string | null;
  normalized_name: string | null;
  normalized_address: string | null;
  created_at: string;
};

export async function loadExclusions(supabase: SupabaseClient, limit = 500): Promise<ExclusionItem[]> {
  const { data, error } = await supabase
    .from("sales_exclusions")
    .select("id, label, reason, note, instagram_handle, website_domain, email_digest, normalized_name, normalized_address, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error("exclusions_unavailable");
  return ((data ?? []) as Row[]).map((r) => ({
    id: r.id,
    label: r.label,
    reason: r.reason,
    note: r.note,
    instagramHandle: r.instagram_handle,
    websiteDomain: r.website_domain,
    hasEmail: r.email_digest !== null,
    normalizedName: r.normalized_name,
    normalizedAddress: r.normalized_address,
    createdAt: r.created_at,
  }));
}
