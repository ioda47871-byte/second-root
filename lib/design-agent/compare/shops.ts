// The local comparison's test shops (DEV-073): fictional facts kept in the
// repository (scripts/sales-design-worker/compare/shops/*.json), in the
// sales_demos.content shape the worker's jobs carry (factsToDemoView makes the
// DemoView). Hand-written Stage 1 specs (compare/hand-written/*.json) are for
// the labelled renderer demo only, never presented as Codex's work.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { DemoView } from "@/lib/sales/demo-content";
import { factsToDemoView } from "../preview";
import { checkProfile, type DesignProfile } from "../profile";
import { pickFacts } from "../worker/queue";

export const SHOP_KEY = /^[a-z]{3,12}$/;
export const RICHNESS = ["rich", "medium", "sparse"] as const;

const ShopFileSchema = z.strictObject({
  key: z.string().regex(SHOP_KEY),
  richness: z.enum(RICHNESS),
  /** What kind of shop it is, for people reading the fixture (never sent anywhere). */
  industry: z.string().max(80),
  facts: z.record(z.string(), z.unknown()),
});

export type CompareShop = {
  key: string;
  richness: (typeof RICHNESS)[number];
  /** The job facts (pickFacts), written as the run's facts.json. */
  facts: Record<string, unknown>;
  demo: DemoView;
};

/** One shop file, checked: a known shape, facts that pass the demo fact filter. */
export function parseShop(value: unknown): CompareShop | null {
  const parsed = ShopFileSchema.safeParse(value);
  if (!parsed.success) return null;
  const facts = pickFacts(parsed.data.facts);
  const demo = factsToDemoView(facts);
  if (!demo) return null;
  return { key: parsed.data.key, richness: parsed.data.richness, facts, demo };
}

/** Every shop file of a directory, in name order; any invalid file fails the whole load. */
export async function loadShops(dir: string): Promise<CompareShop[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  const shops: CompareShop[] = [];
  for (const name of names) {
    const shop = parseShop(JSON.parse(await readFile(join(dir, name), "utf8")) as unknown);
    if (!shop || `${shop.key}.json` !== name) throw Object.assign(new Error(`shop fixture ${name}`), { code: "COMPARE_SHOP_INVALID" });
    shops.push(shop);
  }
  if (new Set(shops.map((s) => s.key)).size !== shops.length) throw Object.assign(new Error("shop keys repeat"), { code: "COMPARE_SHOP_INVALID" });
  return shops;
}

/** The hand-written specs of a directory by shop key, each checked like a Codex answer. */
export async function loadHandWritten(dir: string, keys: readonly string[]): Promise<Record<string, DesignProfile>> {
  const out: Record<string, DesignProfile> = {};
  for (const key of keys) {
    const check = checkProfile(JSON.parse(await readFile(join(dir, `${key}.json`), "utf8")) as unknown);
    if (!check.ok) throw Object.assign(new Error(`hand-written spec ${key}`), { code: "COMPARE_SPEC_INVALID" });
    out[key] = check.profile;
  }
  return out;
}

/** The fact strings a page must show, by fixed key (menu items as menu_items.<n>). */
export function factStrings(demo: DemoView): Array<{ key: string; text: string }> {
  const one = (key: string, text: string | null) => (text === null ? [] : [{ key, text }]);
  return [
    ...one("name", demo.name),
    ...one("address", demo.address),
    ...one("hours", demo.hours),
    ...one("closed_days", demo.closedDays),
    ...one("access", demo.access),
    ...one("phone", demo.phone),
    ...one("description", demo.description),
    ...demo.menuItems.map((text, i) => ({ key: `menu_items.${i}`, text })),
  ];
}

/** --shops: the listed keys (comma separated, each once, all known), or every shop when absent; null when invalid. */
export function selectShops(shops: CompareShop[], only: string | undefined): CompareShop[] | null {
  if (only === undefined) return shops;
  const keys = only.split(",");
  if (keys.length === 0 || new Set(keys).size !== keys.length) return null;
  const picked = shops.filter((s) => keys.includes(s.key));
  return picked.length === keys.length ? picked : null;
}
