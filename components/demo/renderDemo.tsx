import type { DemoView } from "@/lib/sales/demo-content";
import BakedGoodsTemplate from "./BakedGoodsTemplate";
import BakeryTemplate from "./BakeryTemplate";
import CafeTemplate from "./CafeTemplate";

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
