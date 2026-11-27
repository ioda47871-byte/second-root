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
 *   design    Issue #380 (SORAIRO): the site's own STATIC design pictures (photos.ts SiteDesign: a folder next to the page
 *             code with its generated-materials record); the build checks and copies them to dist/design/ and passes
 *             their paths to render (id → { src, alt }). Never content: the CMS cannot change them
 */
import { autoFixtures } from "./auto-fixtures";
import { AUTO_PROFILE, renderAuto } from "./auto-site";
import { BAKERY_PROFILE, renderBakery } from "./bakery-site";
import { CAFE_PROFILE, renderCafe } from "./cafe-site";
import { cafeFixtures } from "./cafe-fixtures";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTO_DESIGN_PICTURES, type DesignAssets } from "./auto-site";
import type { ShopContent, ShopProfile } from "./content-model";
import { q1Fixtures, type Fixture } from "./fixtures";
import type { SiteDesign } from "./photos";

/** This folder (Second Root runs the page code as CommonJS; the delivery repository's build loads it as an ES module). */
const HERE = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));

export type ShopSite = {
  id: string;
  profile: ShopProfile;
  render: (content: ShopContent, today: string, slotOf?: (image: string) => string | undefined, design?: DesignAssets) => { html: string; css: string };
  spMaxWidth: number;
  fixtures: () => Record<string, Fixture>;
  design?: SiteDesign;
};

export const BAKERY_SITE: ShopSite = { id: "bakery", profile: BAKERY_PROFILE, render: renderBakery, spMaxWidth: 600, fixtures: q1Fixtures };
export const CAFE_SITE: ShopSite = { id: "cafe", profile: CAFE_PROFILE, render: renderCafe, spMaxWidth: 760, fixtures: cafeFixtures };
/** Issue #380: the car-care shop (施工実績 instead of a menu), with the SORAIRO design (owner 2026-11-28) and its static pictures. */
export const AUTO_SITE: ShopSite = { id: "auto", profile: AUTO_PROFILE, render: renderAuto, spMaxWidth: 800, fixtures: autoFixtures, design: { dir: join(HERE, "design", "sorairo"), pictures: AUTO_DESIGN_PICTURES } };

/** Every fictional shop of the experiment, in report order. */
export const SHOP_SITES: readonly ShopSite[] = [BAKERY_SITE, CAFE_SITE, AUTO_SITE];
