/**
 * DEV-196r (option C): the fictional bicycle repair shop 輪 (SR-001's facts pack, `fictional-bicycle-repair-wa`) as
 * a prospect and demo in the LOCAL database only, so the version page's facts panel and facts hash are 輪's real
 * fictional facts. Never real-shop data; never a hosted database (the connection string must be a local stack).
 *
 * The schema allows only bakery / baked_goods / cafe for sales_prospects.category and the matching template for
 * sales_demos.template (the React demo's categories). Those two columns therefore hold the placeholder "bakery" /
 * "bakery_v1"; the shop's facts — including category "bicycle_repair" — are in sales_demos.content, which the
 * version page and the facts hash read. The prospect has no outreach (it never appears on the Today screen).
 */
import { randomBytes } from "node:crypto";
import type pg from "pg";

export type FactsPack = { schema: string; shop_id: string; facts: { id: string; key: string; value: string }[] };

export const RIN_SHOP_ID = "fictional-bicycle-repair-wa";
/** fixed so the seed is idempotent */
export const RIN_INSTAGRAM_HANDLE = "sr001_rin_fictional_local";

/** Only a local stack: postgres(ql)://…@127.0.0.1|localhost:<port>/… */
export function assertLocalDbUrl(raw: string | undefined): string {
  let u: URL;
  try {
    u = new URL(raw ?? "");
  } catch {
    throw new Error("DB_URL_INVALID");
  }
  if (!/^postgres(ql)?:$/.test(u.protocol) || !(u.hostname === "127.0.0.1" || u.hostname === "localhost")) throw new Error("DB_URL_NOT_LOCAL: only a local stack (127.0.0.1 / localhost) is allowed");
  return raw!;
}

/** The demo content from the facts pack: every fact, under the keys the version page reads. Pure. */
export function rinDemoContent(pack: FactsPack): Record<string, unknown> {
  if (pack.schema !== "shop_facts_pack_v1" || pack.shop_id !== RIN_SHOP_ID) throw new Error("FACTS_PACK_NOT_RIN");
  const v = (key: string) => {
    const f = pack.facts.find((x) => x.key === key);
    if (!f) throw new Error(`FACT_MISSING:${key}`);
    return f.value;
  };
  const many = (prefix: string) => pack.facts.filter((f) => f.key.startsWith(prefix)).sort((a, b) => a.key.localeCompare(b.key, "en", { numeric: true })).map((f) => f.value);
  return {
    name: v("name"),
    category: v("category"),
    ward: v("ward"),
    address: v("address"),
    hours: v("hours"),
    closed_days: v("closed_days"),
    access: v("access"),
    phone: v("phone"),
    description: v("description"),
    menu_items: many("service_"),
    statements: many("statement_"),
    workshop: v("workshop"),
    facts_pack: pack.shop_id,
  };
}

/** Creates (or finds) the fictional 輪 prospect and demo. Idempotent. Returns the ids. */
export async function seedRinShop(db: pg.Pool | pg.Client, pack: FactsPack): Promise<{ prospectId: string; demoId: string; created: boolean }> {
  const content = rinDemoContent(pack);
  const name = content.name as string;
  const found = await db.query(
    "select p.id as prospect_id, d.id as demo_id from public.sales_prospects p join public.sales_demos d on d.prospect_id = p.id where p.instagram_handle = $1",
    [RIN_INSTAGRAM_HANDLE],
  );
  if (found.rows[0]) return { prospectId: found.rows[0].prospect_id as string, demoId: found.rows[0].demo_id as string, created: false };
  // one statement: the prospect and its demo together, or neither
  const r = await db.query(
    `with p as (
       insert into public.sales_prospects (name, normalized_name, address, normalized_address, ward, category, website_status, instagram_url, instagram_handle, recommended_channel)
       values ($1, $1, $2, $2, $3, 'bakery', 'not_found', $4, $5, 'instagram') returning id)
     insert into public.sales_demos (prospect_id, public_token, template, content, expires_at)
     select id, $6, 'bakery_v1', $7::jsonb, null from p
     returning id as demo_id, prospect_id`,
    [name, content.address, content.ward, `https://www.instagram.com/${RIN_INSTAGRAM_HANDLE}/`, RIN_INSTAGRAM_HANDLE, randomBytes(32).toString("base64url"), JSON.stringify(content)],
  );
  return { prospectId: r.rows[0].prospect_id as string, demoId: r.rows[0].demo_id as string, created: true };
}
