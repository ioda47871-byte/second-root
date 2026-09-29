import type { DemoTemplate, DemoView } from "@/lib/sales/demo-content";

// Each template has several art directions. A shop always gets the same one:
// it is chosen from the verified name and category only (no randomness, no
// stored state), so a demo looks the same on every visit and in the admin
// preview. The admin preview may override it to compare directions.

export const VARIANTS = {
  baked_goods_v1: ["luxury", "pop", "minimal"],
  bakery_v1: ["classic"],
  cafe_v1: ["classic"],
} as const satisfies Record<DemoTemplate, readonly string[]>;

export type Variant<T extends DemoTemplate = DemoTemplate> = (typeof VARIANTS)[T][number];

/** FNV-1a (32 bit) — small, stable across runtimes. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function pickVariant(demo: Pick<DemoView, "template" | "name" | "category">): Variant {
  const options: readonly Variant[] = VARIANTS[demo.template];
  return options[hash(`${demo.category}\u0000${demo.name}`) % options.length];
}

/** The requested variant when it exists for this template, else the shop's own. */
export function resolveVariant(demo: Pick<DemoView, "template" | "name" | "category">, requested?: string | null): Variant {
  const options: readonly string[] = VARIANTS[demo.template];
  return requested && options.includes(requested) ? (requested as Variant) : pickVariant(demo);
}
