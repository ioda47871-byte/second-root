import type { VerifiedCandidateInput } from "@/lib/sales/ingest-schema";

// Fictional shops only (example.com / made-up Instagram handles).

let n = 0;

export function verifiedInput(overrides: Partial<VerifiedCandidateInput> = {}): VerifiedCandidateInput {
  n += 1;
  const at = "2026-09-27T01:00:00+09:00";
  const ig = `https://www.instagram.com/test_pan_${n}/`;
  return {
    key: `c${n}`,
    name: `テストパン工房${n}`,
    address: `愛知県名古屋市中区栄${n}丁目1番1号`,
    category: "bakery",
    website: { status: "not_found", url: null, checks: 2 },
    instagramUrl: ig,
    email: null,
    facts: [
      { field: "name", value: `テストパン工房${n}`, sourceUrl: ig, sourceType: "instagram_profile", verifiedAt: at },
      { field: "address", value: `名古屋市中区栄${n}-1-1`, sourceUrl: ig, sourceType: "instagram_profile", verifiedAt: at },
      { field: "hours", value: "8:00〜17:00", sourceUrl: ig, sourceType: "instagram_profile", verifiedAt: at },
    ],
    message: { subject: null, body: "はじめまして。名古屋でお店のホームページを作っている Second Root です。" },
    ...overrides,
  };
}

export function verifiedEmailInput(overrides: Partial<VerifiedCandidateInput> = {}): VerifiedCandidateInput {
  const base = verifiedInput();
  const domain = `pan${n}.example.com`;
  return {
    ...base,
    website: { status: "present", url: `https://${domain}/`, checks: 1 },
    instagramUrl: null,
    email: { address: `info@${domain}`, sourceUrl: `https://${domain}/contact`, sourceType: "official_contact" },
    message: { subject: "ホームページのご提案", body: base.message.body },
    ...overrides,
  };
}
