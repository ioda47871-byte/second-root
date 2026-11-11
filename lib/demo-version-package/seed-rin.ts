/**
 * DEV-196r (option C): the fictional bicycle repair shop 輪 (SR-001's facts pack, `fictional-bicycle-repair-wa`) as
 * a prospect and demo in the LOCAL database only, so the version page's facts panel and facts hash are 輪's real
 * fictional facts. Never real-shop data; never a hosted database (the connection string must be a local stack).
 *
 * The prospect registry's schema is the sales MVP's: sales_prospects.category is bakery / baked_goods / cafe, the
 * address must be in Nagoya (sales_prospects_nagoya), and sales_demos.template is a React template. Those registry
 * columns therefore hold fixed, clearly-labelled placeholders (category "bakery", template "bakery_v1", the address
 * RIN_REGISTRY_ADDRESS, no ward). The shop's facts — category "bicycle_repair", 「架空市架空区…」 — are in
 * sales_demos.content, which the version page's facts panel and the facts hash read. The prospect has no outreach (it
 * never appears on the Today screen), has no contact (no Instagram, email or channel) and is never sent to.
 */
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { parse as parseConnectionString } from "pg-connection-string";

export type FactsPack = { schema: string; shop_id: string; facts: { id: string; key: string; value: string }[] };

export const RIN_SHOP_ID = "fictional-bicycle-repair-wa";
/** The registry row's address placeholder (the schema requires a Nagoya address; this is not a fact of 輪). */
export const RIN_REGISTRY_ADDRESS = "愛知県名古屋市（登録用の仮の住所。架空の研究用の店 輪、実在しない）";
/** The registry row's name, fixed so the seed is idempotent (with RIN_REGISTRY_ADDRESS). */
export const RIN_REGISTRY_KEY = "SR-001";
/**
 * DEV-196s: the fixed id of the fictional 輪 prospect. The seed creates the row with exactly this id (and only the seed,
 * run by the local operator with the service role, can create a prospect with a chosen id). Photo packages (AI demo
 * pictures) are imported only for this prospect (import.ts). The database-side rule for these pictures is pending the
 * owner's decision and is not part of this change.
 */
export const RIN_PROSPECT_ID = "c4d31f24-8c91-4495-8ba1-db4706f438f8";

/** Environment variables node-postgres would use for the host when a connection string leaves it out. */
export const PG_HOST_ENV = ["PGHOST", "PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"] as const;

export type LocalDbConfig = { host: "127.0.0.1" | "localhost"; port: number; user?: string; password?: string; database?: string };

/**
 * Only a local stack (review of #255 L1). The string is read with node-postgres's own parser (pg-connection-string,
 * pg's dependency), so a `?host=` / `?hostaddr=` / socket path cannot slip past: no query string or fragment at all,
 * the parsed host must be exactly 127.0.0.1 or localhost (no IPv6, no unix socket), and none of the PG* host
 * variables may be set. Returns an explicit config, so the client connects to exactly the host checked here.
 */
export function assertLocalDbUrl(raw: string | undefined, env: Readonly<Record<string, string | undefined>> = process.env): LocalDbConfig {
  let u: URL;
  try {
    u = new URL(raw ?? "");
  } catch {
    throw new Error("DB_URL_INVALID");
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error("DB_URL_NOT_LOCAL: not a postgres URL");
  if (u.search !== "" || u.hash !== "" || raw!.includes("?") || raw!.includes("#")) throw new Error("DB_URL_NOT_LOCAL: no query string or fragment is allowed");
  for (const k of PG_HOST_ENV) if (env[k] !== undefined && env[k] !== "") throw new Error(`DB_URL_NOT_LOCAL: ${k} is set`);
  const c = parseConnectionString(raw!);
  if (c.host !== "127.0.0.1" && c.host !== "localhost") throw new Error("DB_URL_NOT_LOCAL: only a local stack (127.0.0.1 / localhost) is allowed");
  if (u.hostname !== c.host) throw new Error("DB_URL_NOT_LOCAL: the host is ambiguous");
  const port = Number(c.port ?? 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("DB_URL_INVALID");
  return { host: c.host, port, ...(c.user ? { user: c.user } : {}), ...(c.password ? { password: c.password } : {}), ...(c.database ? { database: c.database } : {}) };
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

/**
 * Creates (or finds) the fictional 輪 prospect (id RIN_PROSPECT_ID) and its demo. Idempotent. Returns the ids.
 * DEV-196s: a row with the fixed id must still be 輪 (name, placeholder address, no contact at all); an older local seed
 * under another id (DEV-196r) is refused (RIN_SEED_OLD_ROW: reset the local database), never re-used.
 */
export async function seedRinShop(db: pg.Pool | pg.Client, pack: FactsPack): Promise<{ prospectId: string; demoId: string; created: boolean }> {
  const content = rinDemoContent(pack);
  const name = content.name as string;
  const byId = await db.query(
    `select p.normalized_name, p.normalized_address, p.instagram_url, p.instagram_handle, p.public_email, p.recommended_channel, p.website_url, d.id as demo_id
       from public.sales_prospects p left join public.sales_demos d on d.prospect_id = p.id where p.id = $1`,
    [RIN_PROSPECT_ID],
  );
  if (byId.rows[0]) {
    const r = byId.rows[0];
    const contact = [r.instagram_url, r.instagram_handle, r.public_email, r.recommended_channel, r.website_url].some((x) => x !== null);
    if (r.normalized_name !== name || r.normalized_address !== RIN_REGISTRY_ADDRESS || contact || !r.demo_id) throw new Error("RIN_SEED_ID_TAKEN");
    return { prospectId: RIN_PROSPECT_ID, demoId: r.demo_id as string, created: false };
  }
  const old = await db.query("select 1 from public.sales_prospects where normalized_address = $1 and normalized_name = $2", [RIN_REGISTRY_ADDRESS, name]);
  if (old.rows[0]) throw new Error("RIN_SEED_OLD_ROW");
  // one statement: the prospect and its demo together, or neither. Review of #255 L2: NO contact at all — no Instagram
  // URL / handle (a made-up handle could be someone's real account), no email, no recommended channel (the schema allows
  // null for each, and the channel checks pass on null) — so nothing can ever be sent to this registry row.
  const r = await db.query(
    `with p as (
       insert into public.sales_prospects (id, name, normalized_name, address, normalized_address, ward, category, website_status, instagram_url, instagram_handle, public_email, recommended_channel)
       values ($5::uuid, $1, $1, $2, $2, null, 'bakery', 'not_found', null, null, null, null) returning id)
     insert into public.sales_demos (prospect_id, public_token, template, content, expires_at)
     select id, $3, 'bakery_v1', $4::jsonb, null from p
     returning id as demo_id, prospect_id`,
    [name, RIN_REGISTRY_ADDRESS, randomBytes(32).toString("base64url"), JSON.stringify(content), RIN_PROSPECT_ID],
  );
  return { prospectId: r.rows[0].prospect_id as string, demoId: r.rows[0].demo_id as string, created: true };
}
