import type { DesignProfile } from "@/lib/design-agent/profile";
import type { DemoView } from "@/lib/sales/demo-content";
import BakedGoodsTemplate from "./BakedGoodsTemplate";
import BakeryTemplate from "./BakeryTemplate";
import CafeTemplate from "./CafeTemplate";
import ProfileRenderer from "./profile/ProfileRenderer";

/** Picks the component for a demo's template. */
export function renderDemo(demo: DemoView) {
  switch (demo.template) {
    case "bakery_v1":
      return <BakeryTemplate demo={demo} />;
    case "baked_goods_v1":
      return <BakedGoodsTemplate demo={demo} />;
    case "cafe_v1":
      return <CafeTemplate demo={demo} />;
  }
}

/**
 * A sales demo (DEV-030): the shared profile renderer when a checked design
 * profile is given, otherwise the existing template. Never with photos: the
 * public demo shows no photo, screenshot or reference image.
 */
export function renderDesignedDemo(demo: DemoView, profile: DesignProfile | null) {
  return profile ? <ProfileRenderer demo={demo} profile={profile} /> : renderDemo(demo);
}
