import type { DemoView } from "@/lib/sales/demo-content";
import BaseTemplate from "./BaseTemplate";

/** Picks the component for a demo's template. */
export function renderDemo(demo: DemoView) {
  switch (demo.template) {
    case "bakery_v1":
    case "baked_goods_v1":
    case "cafe_v1":
      return <BaseTemplate demo={demo} />;
  }
}
