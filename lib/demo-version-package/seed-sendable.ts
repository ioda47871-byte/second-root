/**
 * DEV-263a (Issue #263): the fictional, photo-less bicycle repair shop 環 (`fictional-bicycle-repair-tamaki`, facts pack
 * SENDABLE_FACTS_PATH) as a SENDABLE prospect and demo in the LOCAL database only — for the local scripts and the
 * later local E2E of the send path. Never a real shop; never a hosted database (the caller connects with
 * assertLocalDbUrl); never sends anything (no outreach is created here).
 *
 * Unlike 輪 (seed-rin.ts, no contact at all), this prospect has a contact so the send path can be walked through: an
 * official email on a reserved example.com domain (RFC 2606: it can never reach anyone) with its first-party source,
 * recommended channel email. The registry columns hold the sales MVP schema's placeholders, as for 輪: category
 * "bakery" (the schema allows bakery / baked_goods / cafe only), template "bakery_v1", and the Nagoya placeholder
 * address SENDABLE_REGISTRY_ADDRESS (the schema requires a Nagoya address; it is not a fact of 環). The shop's facts —
 * category "bicycle_repair", 「架空市架空区…」 — are in sales_demos.content, derived from the committed facts pack with
 * demoContentFromFacts, so import-local.ts --trusted-facts can prove the demo row and the facts evidence share one origin.
 */
import { randomBytes } from "node:crypto";
import type pg from "pg";
import { demoContentWithFactsSha } from "./local-inputs";
import { demoContentFromFacts, type FactsPack } from "./seed-rin";

export const SENDABLE_SHOP_ID = "fictional-bicycle-repair-tamaki";
/** The committed facts pack of 環 (the local facts path). */
export const SENDABLE_FACTS_PATH = "design-library/research/quality-pipeline/poc/sendable-tamaki/facts-pack.json";
/** The committed photo-less page of 環 (index.html, style.css, copy.json, copy-review.json). */
export const SENDABLE_PAGE_DIR = "design-library/research/quality-pipeline/poc/sendable-tamaki/page";
/** The fixed id of the fictional 環 prospect (only the local seed creates a prospect with a chosen id). */
export const SENDABLE_PROSPECT_ID = "5e2d0a63-7c1b-4f0e-9a6d-263a00000001";
export const SENDABLE_REGISTRY_ADDRESS = "愛知県名古屋市（登録用の仮の住所。架空の確認用の店 環、実在しない）";
export const SENDABLE_DOMAIN = "tamaki-demo.example.com";
export const SENDABLE_EMAIL = `info@${SENDABLE_DOMAIN}`;
export const SENDABLE_SITE = `https://${SENDABLE_DOMAIN}/`;

/** The demo content of 環 (demoContentFromFacts, for 環 only). Pure. */
export function sendableDemoContent(pack: FactsPack): Record<string, unknown> {
  if (pack.schema !== "shop_facts_pack_v1" || pack.shop_id !== SENDABLE_SHOP_ID) throw new Error("FACTS_PACK_NOT_SENDABLE_SHOP");
  return demoContentFromFacts(pack);
}

/**
 * DEV-263a (PR #266 M1): the content seeded for 環 from its facts pack BYTES — the derived content (every key mapped)
 * and content.facts_pack_sha256, so import-local.ts --trusted-facts can require the trusted pack to be exactly these
 * bytes. 輪's seed (seed-rin.ts) is unchanged.
 */
export function sendableSeedContent(factsPack: Uint8Array): Record<string, unknown> {
  const pack = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(factsPack)) as FactsPack;
  sendableDemoContent(pack);
  return demoContentWithFactsSha(factsPack);
}

/**
 * Creates (or finds) the fictional 環 prospect (id SENDABLE_PROSPECT_ID), its email source and its demo, in one
 * transaction on this client (the email provenance check runs at commit). Idempotent: a row with the fixed id must
 * still be 環 (name, placeholder address, example.com email, no Instagram) with the same demo content, else
 * SENDABLE_SEED_ID_TAKEN / SENDABLE_SEED_CONTENT_STALE (reset the local database).
 */
export async function seedSendableShop(db: pg.ClientBase, factsPack: Uint8Array): Promise<{ prospectId: string; demoId: string; created: boolean }> {
  const content = sendableSeedContent(factsPack);
  const name = content.name as string;
  const byId = await db.query(
    `select p.normalized_name, p.normalized_address, p.public_email, p.instagram_handle, p.recommended_channel, d.id as demo_id, d.content
       from public.sales_prospects p left join public.sales_demos d on d.prospect_id = p.id where p.id = $1`,
    [SENDABLE_PROSPECT_ID],
  );
  if (byId.rows[0]) {
    const r = byId.rows[0];
    if (r.normalized_name !== name || r.normalized_address !== SENDABLE_REGISTRY_ADDRESS || r.public_email !== SENDABLE_EMAIL || r.instagram_handle !== null || r.recommended_channel !== "email" || !r.demo_id)
      throw new Error("SENDABLE_SEED_ID_TAKEN");
    if (JSON.stringify(sortKeys(r.content)) !== JSON.stringify(sortKeys(content))) throw new Error("SENDABLE_SEED_CONTENT_STALE");
    return { prospectId: SENDABLE_PROSPECT_ID, demoId: r.demo_id as string, created: false };
  }
  await db.query("begin");
  try {
    await db.query(
      `insert into public.sales_prospects (id, name, normalized_name, address, normalized_address, ward, category, website_status, website_url, website_domain, public_email, recommended_channel)
       values ($1::uuid, $2, $2, $3, $3, null, 'bakery', 'present', $4, $5, $6, 'email')`,
      [SENDABLE_PROSPECT_ID, name, SENDABLE_REGISTRY_ADDRESS, SENDABLE_SITE, SENDABLE_DOMAIN, SENDABLE_EMAIL],
    );
    await db.query(
      `insert into public.sales_sources (prospect_id, field, value, source_url, source_type, verified_at)
       values ($1::uuid, 'email', $2, $3, 'official_contact', now())`,
      [SENDABLE_PROSPECT_ID, SENDABLE_EMAIL, `${SENDABLE_SITE}contact`],
    );
    const d = await db.query(
      `insert into public.sales_demos (prospect_id, public_token, template, content, expires_at)
       values ($1::uuid, $2, 'bakery_v1', $3::jsonb, null) returning id`,
      [SENDABLE_PROSPECT_ID, randomBytes(32).toString("base64url"), JSON.stringify(content)],
    );
    await db.query("commit");
    return { prospectId: SENDABLE_PROSPECT_ID, demoId: d.rows[0].id as string, created: true };
  } catch (e) {
    await db.query("rollback");
    throw e;
  }
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}
