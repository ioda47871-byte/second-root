import { normalizeAddress, normalizeEmail, normalizeName } from "./normalize";
import { parseInstagramProfile, websiteKey } from "./url";

// DEV-049: the admin's exclusion list (existing customers, partners, ...).
// Values are normalised exactly like ingest (lib/sales/prepare.ts) so the
// persist check in SQL compares like with like.

export const EXCLUSION_REASONS = ["existing_customer", "partner", "other"] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export const EXCLUSION_REASON_LABEL: Record<ExclusionReason, string> = {
  existing_customer: "既存顧客",
  partner: "取引先・関係者",
  other: "その他",
};

export type ExclusionInput = {
  label: string;
  reason: string;
  note?: string;
  instagram?: string;
  website?: string;
  email?: string;
  name?: string;
  address?: string;
};

export type ExclusionKeys = {
  label: string;
  reason: ExclusionReason;
  note: string | null;
  instagramHandle: string | null;
  websiteDomain: string | null;
  publicEmail: string | null;
  normalizedName: string | null;
  normalizedAddress: string | null;
};

export type ExclusionParse = { ok: true; value: ExclusionKeys } | { ok: false; error: string };

const trim = (s: string | undefined) => (s ?? "").normalize("NFKC").trim();

/** Instagram URL, "@handle" or bare handle → the canonical handle. */
function instagramHandle(input: string): string | null {
  const s = input.replace(/^@/, "");
  const url = /^https?:\/\//i.test(s) ? s : `https://www.instagram.com/${s.replace(/\/+$/, "")}/`;
  return parseInstagramProfile(url)?.handle ?? null;
}

/** Site URL (scheme optional) → the same dedupe key as ingest. */
function websiteDomain(input: string): string | null {
  return websiteKey(/^https?:\/\//i.test(input) ? input : `https://${input}`);
}

export function parseExclusion(input: ExclusionInput): ExclusionParse {
  const label = trim(input.label);
  if (label.length < 1 || label.length > 200) return { ok: false, error: "表示名（店名など）を200文字以内で入力してください。" };
  if (!(EXCLUSION_REASONS as readonly string[]).includes(input.reason)) return { ok: false, error: "理由を選んでください。" };
  const note = trim(input.note);
  if (note.length > 500) return { ok: false, error: "メモは500文字以内にしてください。" };

  const ig = trim(input.instagram);
  const site = trim(input.website);
  const mail = trim(input.email);
  const name = trim(input.name);
  const address = trim(input.address);

  const handle = ig ? instagramHandle(ig) : null;
  if (ig && !handle) return { ok: false, error: "Instagram のアカウント（URL か @ユーザー名）を正しく入力してください。" };
  const domain = site ? websiteDomain(site) : null;
  if (site && !domain) return { ok: false, error: "公式サイトの URL を正しく入力してください（SNS やポータルの URL は使えません）。" };
  const email = mail ? normalizeEmail(mail) : null;
  if (mail && !email) return { ok: false, error: "メールアドレスを正しく入力してください。" };
  if ((name === "") !== (address === "")) return { ok: false, error: "店名と住所は両方そろえて入力してください。" };
  const normalizedName = name ? normalizeName(name) : null;
  const normalizedAddress = address ? normalizeAddress(address) : null;
  if (name && (!normalizedName || !normalizedAddress || normalizedName.length > 200 || normalizedAddress.length > 300)) {
    return { ok: false, error: "店名と住所を正しく入力してください。" };
  }
  if (!handle && !domain && !email && !normalizedName) {
    return { ok: false, error: "Instagram・公式サイト・メール・店名+住所のどれか1つ以上を入力してください。" };
  }
  return {
    ok: true,
    value: {
      label,
      reason: input.reason as ExclusionReason,
      note: note || null,
      instagramHandle: handle,
      websiteDomain: domain,
      publicEmail: email,
      normalizedName,
      normalizedAddress,
    },
  };
}
