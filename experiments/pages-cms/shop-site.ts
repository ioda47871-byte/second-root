/**
 * PR (3): the shop-site interface. A shop's site is its own page code plus what it declares about its content; the
 * build (build.ts) and both Q1 checks (q1-check.ts, q1-render.ts) take a ShopSite and know nothing else about a shop.
 * Only data is shared between shops (content-model.ts); each site's composition, CSS and label wording stay its own.
 *
 *   id        a short name for reports and file names
 *   profile   the fixed shop name, the trade extensions and (Issue #380) the collections the site turns on
 *             (content-model.ts ShopProfile)
 *   render    content + today → index.html and style.css (pure; escapes every text). DEV-364 PR 2b: an optional
 *             slotOf(image) names the photo slot of a picture; the site marks that <img> with data-slot (nothing else)
 *   spMaxWidth  the site's SP breakpoint (the slot CSS for SP goes under it)
 *   fixtures  the site's fictional Q1 test content
 */
import { autoFixtures } from "./auto-fixtures";
import { AUTO_PROFILE, renderAuto } from "./auto-site";
import { BAKERY_PROFILE, renderBakery } from "./bakery-site";
import { CAFE_PROFILE, renderCafe } from "./cafe-site";
import { cafeFixtures } from "./cafe-fixtures";
import type { ShopContent, ShopProfile } from "./content-model";
import { q1Fixtures, type Fixture } from "./fixtures";

export type ShopSite = {
  id: string;
  profile: ShopProfile;
  render: (content: ShopContent, today: string, slotOf?: (image: string) => string | undefined) => { html: string; css: string };
  spMaxWidth: number;
  fixtures: () => Record<string, Fixture>;
};

export const BAKERY_SITE: ShopSite = { id: "bakery", profile: BAKERY_PROFILE, render: renderBakery, spMaxWidth: 600, fixtures: q1Fixtures };
export const CAFE_SITE: ShopSite = { id: "cafe", profile: CAFE_PROFILE, render: renderCafe, spMaxWidth: 760, fixtures: cafeFixtures };
/** Issue #380: the car-care shop (施工実績 instead of a menu). */
export const AUTO_SITE: ShopSite = { id: "auto", profile: AUTO_PROFILE, render: renderAuto, spMaxWidth: 720, fixtures: autoFixtures };

/** Every fictional shop of the experiment, in report order. */
export const SHOP_SITES: readonly ShopSite[] = [BAKERY_SITE, CAFE_SITE, AUTO_SITE];
