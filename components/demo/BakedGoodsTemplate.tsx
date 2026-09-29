import type { DemoView } from "@/lib/sales/demo-content";
import Luxury from "./baked/Luxury";
import Minimal from "./baked/Minimal";
import Pop from "./baked/Pop";
import type { Variant } from "./variant";

// baked_goods_v1 — three art directions (editorial luxury, American pop,
// minimal boutique). Which one a shop gets is decided in ./variant.

export default function BakedGoodsTemplate({ demo, variant }: { demo: DemoView; variant: Variant<"baked_goods_v1"> }) {
  switch (variant) {
    case "luxury":
      return <Luxury demo={demo} />;
    case "pop":
      return <Pop demo={demo} />;
    case "minimal":
      return <Minimal demo={demo} />;
  }
}
