import type { DemoView } from "@/lib/sales/demo-content";
import BakedGoodsTemplate from "./BakedGoodsTemplate";
import BakeryTemplate from "./BakeryTemplate";
import CafeTemplate from "./CafeTemplate";
import { resolveVariant, type Variant } from "./variant";

/**
 * Picks the component for a demo's template and art direction. The public
 * page passes no variant, so each shop always gets its own deterministic
 * one; the admin preview may request another to compare.
 */
export function renderDemo(demo: DemoView, requestedVariant?: string | null) {
  const variant = resolveVariant(demo, requestedVariant);
  switch (demo.template) {
    case "bakery_v1":
      return <BakeryTemplate demo={demo} />;
    case "baked_goods_v1":
      return <BakedGoodsTemplate demo={demo} variant={variant as Variant<"baked_goods_v1">} />;
    case "cafe_v1":
      return <CafeTemplate demo={demo} />;
  }
}
