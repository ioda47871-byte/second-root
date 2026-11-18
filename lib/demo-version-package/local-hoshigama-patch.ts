/**
 * DEV-139 (owner approval 2026-11-18, Issue #139 comment 6970468763 follow-up: "ローカル DB の許可は localhost のみ・test
 * shop のみ・Staging/Production なし"): a LOCAL-ONLY database patch so the fictional ほし窯's AI demo photos can be
 * ingested into its Stage 0 prospect on the owner's local stack. Modelled on 輪's (local-rin-patch.ts). It is NOT a
 * migration and never part of the shared schema: it lives in scripts/sales/demo-version/local-hoshigama-ai-photos.sql
 * (outside supabase/migrations), is applied by scripts/sales/demo-version/apply-local-hoshigama-patch.ts to a local
 * database only (with the owner's explicit flag), and `npx supabase db reset` (local) restores the original schema.
 *
 * What it changes, and nothing else:
 *  - the table check `sales_demo_images_real_shop_no_ai_demo` (same name) becomes row-local: an
 *    `ai_generated_demo` / `ai_demo_internal` row is allowed only when `prospect_id` is S0_PROSPECT_ID;
 *  - `public.sales_check_demo_image_write()` is the migration's function with exactly the edits below
 *    (HOSHIGAMA_PATCH_FUNCTION_EDITS; a unit test rebuilds the patch's function from the migration with them): an
 *    `ai_generated_demo` insert is allowed only for S0_PROSPECT_ID while that prospect row carries the S0 fictional
 *    markers (S0_MARKER_CONDITIONS), and its status is `ai_demo_internal` only when every depicts_* is false, the
 *    provenance is valid and public web use is not allowed — otherwise 'unknown'. Share exclusion, immutability and
 *    revocation are the migration's, byte for byte.
 *
 * The S0 markers, precisely (the row seed-s0.ts s0RegistryRow derives from the committed bakery facts pack):
 *  - name and normalized_name, address and normalized_address are exactly the seed's (S0_MARKERS; a test pins them to
 *    s0RegistryRow of the committed facts pack);
 *  - no Instagram (instagram_url and instagram_handle null);
 *  - every other contact is null or exactly the RFC 2606 example domain's: public_email null or S0_EMAIL, website_url
 *    null or S0_SITE, website_domain null or S0_DOMAIN, recommended_channel null or 'email';
 *  - every sales_sources row of the prospect is the email S0_EMAIL with a source_url on S0_SITE (none other).
 * Unlike 輪 (no contact at all), S0 keeps its example.com contact for the send tests, so the markers allow exactly that
 * and nothing else. The patch is S0-only: it replaces 輪's local patch if that was applied (the apply command refuses
 * while any AI demo picture of another prospect exists, since re-adding the check would refuse those rows).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { factsPackSha256 } from "./facts-content";
import { RIN_PATCH_FUNCTION_EDITS, migrationImageWriteFunction, patchedImageWriteFunction } from "./local-rin-patch";
import { S0_DOMAIN, S0_EMAIL, S0_PROSPECT_ID, S0_SITE, s0RegistryRow } from "./seed-s0";

export { migrationImageWriteFunction };
export const HOSHIGAMA_PATCH_SQL = "scripts/sales/demo-version/local-hoshigama-ai-photos.sql";
/** The explicit flag the apply command requires (the owner's local DB allowance of 2026-11-18). */
export const HOSHIGAMA_PATCH_FLAG = "--owner-approved-local-patch";

/** The S0 registry row's identity, as the patch's marker check spells it (pinned to s0RegistryRow by a unit test). */
export const S0_MARKERS = {
  name: "架空パン店 ほし窯",
  normalized_name: "架空ぱん店ほし窯",
  address: "名古屋市瑞穂区架空町四丁目2-6",
  normalized_address: "愛知県名古屋市瑞穂区架空町4-2-6",
  email: S0_EMAIL,
  site: S0_SITE,
  domain: S0_DOMAIN,
} as const;

/** The marker conditions on `p` (sales_prospects), as SQL; every term is non-null (exists / coalesce), never unknown. */
export const S0_MARKER_CONDITIONS = `p.name = '${S0_MARKERS.name}' and p.normalized_name = '${S0_MARKERS.normalized_name}'
             and p.address = '${S0_MARKERS.address}' and p.normalized_address = '${S0_MARKERS.normalized_address}'
             and p.instagram_url is null and p.instagram_handle is null
             and (p.public_email is null or p.public_email = '${S0_MARKERS.email}')
             and (p.website_url is null or p.website_url = '${S0_MARKERS.site}')
             and (p.website_domain is null or p.website_domain = '${S0_MARKERS.domain}')
             and (p.recommended_channel is null or p.recommended_channel = 'email')
             and not exists (
               select 1 from public.sales_sources s
               where s.prospect_id = p.id
                 and not coalesce(s.field = 'email' and s.value = '${S0_MARKERS.email}' and starts_with(s.source_url, '${S0_MARKERS.site}'), false))`;

/** The edits that turn the migration's sales_check_demo_image_write() into the patch's (exact text). */
export const HOSHIGAMA_PATCH_FUNCTION_EDITS: ReadonlyArray<{ old: string; new: string }> = [
  // the same first edit as 輪's: `create or replace` keeps the function's grants and its trigger
  RIN_PATCH_FUNCTION_EDITS[0]!,
  {
    old: `    if new.source_kind = 'ai_generated_demo' or new.rights_status = 'ai_demo_internal' then
      raise exception 'ai_demo_real_shop' using errcode = 'check_violation';
    end if;`,
    new: `    -- DEV-139 LOCAL ONLY (owner approval 2026-11-18): the one exception is the fictional ほし窯 Stage 0 prospect seeded
    -- locally with this fixed id, and only while its row still carries the S0 fictional markers (its name and address
    -- from the facts pack, no Instagram, contacts only on the example domain). Never part of the shared schema
    -- (supabase db reset restores the original).
    if new.source_kind = 'ai_generated_demo' or new.rights_status = 'ai_demo_internal' then
      if new.source_kind is distinct from 'ai_generated_demo'
         or new.prospect_id is distinct from '${S0_PROSPECT_ID}'::uuid
         or not exists (
           select 1 from public.sales_prospects p
           where p.id = new.prospect_id
             and ${S0_MARKER_CONDITIONS}) then
        raise exception 'ai_demo_real_shop' using errcode = 'check_violation';
      end if;
    end if;`,
  },
  {
    old: `          then 'ai_concept_internal' else 'unknown' end;
    else`,
    new: `          then 'ai_concept_internal' else 'unknown' end;
    elsif new.source_kind = 'ai_generated_demo' then
      -- DEV-139 LOCAL ONLY: ai_demo_internal only when nothing real is depicted, the provenance is valid and public
      -- web use is not allowed; anything else is 'unknown' (the ingest then refuses the whole version)
      new.rights_status := case
        when not new.depicts_real_shop and not new.depicts_identifiable_person and not new.depicts_real_product
             and not new.depicts_real_interior and not new.depicts_real_equipment
             and public.sales_demo_ai_provenance_valid(new.provenance)
             and (new.allowed_uses->>'public_web') = 'false'
          then 'ai_demo_internal' else 'unknown' end;
    else`,
  },
];

/** The patch's three statements before the function: drop and re-add the same-named check, row-local to S0. */
export const HOSHIGAMA_PATCH_CHECK = [
  "alter table public.sales_demo_images drop constraint if exists sales_demo_images_real_shop_no_ai_demo;",
  "alter table public.sales_demo_images add constraint sales_demo_images_real_shop_no_ai_demo",
  `  check ((source_kind <> 'ai_generated_demo' and rights_status <> 'ai_demo_internal') or prospect_id = '${S0_PROSPECT_ID}'::uuid);`,
].join("\n");

/** The migration's function with the ほし窯 edits applied. */
export const hoshigamaPatchedImageWriteFunction = (migration: string): string => patchedImageWriteFunction(migration, HOSHIGAMA_PATCH_FUNCTION_EDITS);

export const readHoshigamaPatchSql = (repo: string) => readFileSync(join(repo, HOSHIGAMA_PATCH_SQL), "utf8");

/**
 * Refuses unless the S0 seed row exists with its fixed id and the S0 markers (as the patch's function checks them), and
 * its demo carries the committed bakery facts pack (content.facts_pack = the pack's shop id; a stored facts pack row with
 * the pack's SHA-256). Throws Error("S0_SEED_MISSING" | "S0_SEED_MARKERS").
 */
export async function assertS0SeedRow(db: pg.Pool | pg.Client | pg.PoolClient, factsPack: Uint8Array): Promise<void> {
  const row = s0RegistryRow(factsPack);
  if (row.name !== S0_MARKERS.name || row.normalized_name !== S0_MARKERS.normalized_name || row.address !== S0_MARKERS.address || row.normalized_address !== S0_MARKERS.normalized_address) throw new Error("S0_SEED_MARKERS");
  const exists = await db.query("select 1 from public.sales_prospects where id = $1", [S0_PROSPECT_ID]);
  if (!exists.rows[0]) throw new Error("S0_SEED_MISSING");
  const r = await db.query(
    `select (select count(*)::int from public.sales_prospects p where p.id = $1 and ${S0_MARKER_CONDITIONS}) as markers,
            (select count(*)::int from public.sales_demos d where d.prospect_id = $1 and d.content->>'facts_pack' = $2) as demos,
            (select count(*)::int from public.sales_demo_facts_packs f where f.prospect_id = $1 and f.facts_sha256 = $3) as facts`,
    [S0_PROSPECT_ID, row.shop_id, factsPackSha256(factsPack)],
  );
  const c = r.rows[0] as { markers: number; demos: number; facts: number };
  if (c.markers !== 1 || c.demos !== 1 || c.facts < 1) throw new Error("S0_SEED_MARKERS");
}

/**
 * The patch is S0-only: re-adding the row-local check would refuse an existing AI demo row of any other prospect (for
 * example 輪's, after 輪's local patch). Refuses (OTHER_AI_DEMO_ROWS_PRESENT) while any exists — reset the stack first.
 */
export async function assertNoOtherAiDemoRows(db: pg.Pool | pg.Client | pg.PoolClient): Promise<void> {
  const r = await db.query(
    "select count(*)::int as n from public.sales_demo_images where (source_kind = 'ai_generated_demo' or rights_status = 'ai_demo_internal') and prospect_id is distinct from $1::uuid",
    [S0_PROSPECT_ID],
  );
  if ((r.rows[0] as { n: number }).n !== 0) throw new Error("OTHER_AI_DEMO_ROWS_PRESENT");
}

/** Applies the patch in one transaction (idempotent: re-running replaces the same check and function). */
export async function applyLocalHoshigamaPatch(client: pg.Client | pg.PoolClient, factsPack: Uint8Array, sql: string): Promise<void> {
  await client.query("begin");
  try {
    await assertS0SeedRow(client, factsPack);
    await assertNoOtherAiDemoRows(client);
    await client.query(sql);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
}
