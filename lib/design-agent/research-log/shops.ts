/**
 * Issue #302 P5: the only shops the committed research log accepts — fictional shops whose facts pack is in this
 * repository and says so (`shop_id` starts with "fictional-"). A real shop's data never enters the repository (DEV-263h),
 * so a slug that is not listed here, or whose facts pack does not mark it fictional, is refused (SHOP_NOT_FICTIONAL).
 * Adding a shop is a reviewed code change, never a command-line flag.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LogStop } from "./store";

const POC = "design-library/research/quality-pipeline/poc";

/** slug → facts pack (the directory name differs from the slug for hoshigama). */
export const FICTIONAL_SHOPS: Readonly<Record<string, string>> = Object.freeze({
  hoshigama: `${POC}/bakery/facts-pack.json`,
  bicycle: `${POC}/bicycle/facts-pack.json`,
  cafe: `${POC}/cafe/facts-pack.json`,
  sento: `${POC}/sento/facts-pack.json`,
  wagashi: `${POC}/wagashi/facts-pack.json`,
});

/** Throws SHOP_NOT_FICTIONAL unless `slug` is listed and its facts pack's shop_id starts with "fictional-". */
export async function assertFictionalShop(repo: string, slug: string): Promise<void> {
  const rel = Object.hasOwn(FICTIONAL_SHOPS, slug) ? FICTIONAL_SHOPS[slug] : undefined;
  if (!rel) throw new LogStop("SHOP_NOT_FICTIONAL", `${slug} is not a listed fictional shop (lib/design-agent/research-log/shops.ts)`);
  let shopId: unknown;
  try {
    shopId = (JSON.parse(await readFile(join(repo, rel), "utf8")) as { shop_id?: unknown }).shop_id;
  } catch {
    throw new LogStop("SHOP_NOT_FICTIONAL", `${rel} is missing or not JSON`);
  }
  if (typeof shopId !== "string" || !shopId.startsWith("fictional-")) throw new LogStop("SHOP_NOT_FICTIONAL", `${rel} does not mark ${slug} as fictional`);
}
