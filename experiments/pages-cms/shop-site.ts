/**
 * PR (3): the shop-site interface. A shop's site is its own page code plus what it declares about its content; the
 * build (build.ts) and both Q1 checks (q1-check.ts, q1-render.ts) take a ShopSite and know nothing else about a shop.
 * Only data is shared between shops (content-model.ts); each site's composition, CSS and label wording stay its own.
 *
 *   id        a short name for reports and file names
 *   profile   the fixed shop name and the trade extensions the site turns on (content-model.ts ShopProfile)
 *   render    content + today → index.html and style.css (pure; escapes every text)
 *   fixtures  the site's fictional Q1 test content
 */
import { BAKERY_PROFILE, renderBakery } from "./bakery-site";
import { CAFE_PROFILE, renderCafe } from "./cafe-site";
import { cafeFixtures } from "./cafe-fixtures";
import type { ShopContent, ShopProfile } from "./content-model";
import { q1Fixtures, type Fixture } from "./fixtures";

export type ShopSite = {
  id: string;
  profile: ShopProfile;
  render: (content: ShopContent, today: string) => { html: string; css: string };
  fixtures: () => Record<string, Fixture>;
};

export const BAKERY_SITE: ShopSite = { id: "bakery", profile: BAKERY_PROFILE, render: renderBakery, fixtures: q1Fixtures };
export const CAFE_SITE: ShopSite = { id: "cafe", profile: CAFE_PROFILE, render: renderCafe, fixtures: cafeFixtures };

/** Every fictional shop of the experiment, in report order. */
export const SHOP_SITES: readonly ShopSite[] = [BAKERY_SITE, CAFE_SITE];
