import { aiDesignEnabled, type DesignStatus } from "@/lib/sales/design";
import { buildTodayEvidence, type EvidenceInput, type TodayEvidence } from "@/lib/sales/evidence";

// DEV-194: stored facts of an eligible Instagram shop (website not found,
// handle, no email, recommended channel instagram, sources), as loadTodayQueue
// would read them. Tests override single fields to break one server rule.

const AT = "2026-10-01T03:00:00Z";

export function eligibleInstagramInput(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    kind: "initial",
    outreachStatus: "drafted",
    channel: "instagram",
    category: "bakery",
    ward: "中区",
    address: "愛知県名古屋市中区テスト町1-1",
    doNotContact: false,
    websiteStatus: "not_found",
    websiteDomain: null,
    instagramUrl: "https://www.instagram.com/test_shop/",
    instagramHandle: "test_shop",
    publicEmail: null,
    recommendedChannel: "instagram",
    registeredAt: "2026-10-02T01:00:00Z",
    sources: [
      { field: "name", value: "テスト工房", source_url: "https://www.instagram.com/test_shop/", source_type: "instagram_profile", verified_at: AT },
      { field: "address", value: "名古屋市中区テスト町1-1", source_url: "https://maps.example.com/p/1", source_type: "map_listing", verified_at: AT },
      { field: "instagram_url", value: "https://www.instagram.com/test_shop/", source_url: "https://www.instagram.com/test_shop/", source_type: "instagram_profile", verified_at: AT },
    ],
    designEnabled: false,
    designStatus: null,
    demoAvailable: true,
    exclusion: { state: "clear" },
    ...overrides,
  };
}

export function eligibleEmailInput(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
  return eligibleInstagramInput({
    channel: "email",
    websiteStatus: "present",
    websiteDomain: "test-shop.example.com",
    instagramUrl: null,
    instagramHandle: null,
    publicEmail: "info@test-shop.example.com",
    recommendedChannel: "email",
    sources: [
      { field: "name", value: "テスト工房", source_url: "https://test-shop.example.com/", source_type: "official_site", verified_at: AT },
      { field: "address", value: "名古屋市中区テスト町1-1", source_url: "https://test-shop.example.com/", source_type: "official_site", verified_at: AT },
      { field: "email", value: "info@test-shop.example.com", source_url: "https://test-shop.example.com/contact", source_type: "official_contact", verified_at: "2026-10-03T03:00:00Z" },
    ],
    ...overrides,
  });
}

/** Evidence for the existing card fixtures: the design gate follows the env, as loadTodayQueue does. */
export function fixtureEvidence(designStatus: DesignStatus | null, kind: "initial" | "follow_up" = "initial"): TodayEvidence {
  return buildTodayEvidence(
    eligibleInstagramInput({ kind, outreachStatus: kind === "follow_up" ? "sent" : "drafted", designEnabled: aiDesignEnabled(), designStatus }),
  );
}
