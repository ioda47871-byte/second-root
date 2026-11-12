/**
 * DEV-196s (owner decision 2026-11-12): a LOCAL-ONLY database patch so the fictional 輪's AI demo photos can be
 * ingested on the owner's local stack. It is NOT a migration and never part of the shared schema: it lives in
 * scripts/sales/demo-version/local-rin-ai-photos.sql (outside supabase/migrations), is applied by
 * scripts/sales/demo-version/apply-local-rin-patch.ts to a local database only, and `supabase db reset` (local)
 * restores the original schema.
 *
 * What it changes, and nothing else:
 *  - the table check `sales_demo_images_real_shop_no_ai_demo` (same name) becomes row-local: an
 *    `ai_generated_demo` / `ai_demo_internal` row is allowed only when `prospect_id` is RIN_PROSPECT_ID;
 *  - `public.sales_check_demo_image_write()` is the migration's function with exactly the two edits below
 *    (RIN_PATCH_FUNCTION_EDITS; a unit test rebuilds the patch's function from the migration with them): an
 *    `ai_generated_demo` insert is allowed only for RIN_PROSPECT_ID while that prospect row carries the fictional
 *    markers (its name and placeholder address, no contact channel at all), and its status is `ai_demo_internal` only
 *    when every depicts_* is false, the provenance is valid and public web use is not allowed — otherwise 'unknown'.
 *    Share exclusion, immutability and revocation are the migration's, byte for byte.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { RIN_PROSPECT_ID, RIN_REGISTRY_ADDRESS, rinDemoContent, type FactsPack } from "./seed-rin";

export const RIN_PATCH_SQL = "scripts/sales/demo-version/local-rin-ai-photos.sql";
export const RIN_PATCH_MIGRATION = "supabase/migrations/20261111000000_sales_demo_versions.sql";
/** The fictional 輪's registry name (its facts pack's name), as the patch's marker check spells it. */
export const RIN_REGISTRY_NAME = "架空自転車修理 輪";

/** The two edits that turn the migration's sales_check_demo_image_write() into the patch's (exact text). */
export const RIN_PATCH_FUNCTION_EDITS: ReadonlyArray<{ old: string; new: string }> = [
  { old: "create function public.sales_check_demo_image_write()", new: "create or replace function public.sales_check_demo_image_write()" },
  {
    old: `    if new.source_kind = 'ai_generated_demo' or new.rights_status = 'ai_demo_internal' then
      raise exception 'ai_demo_real_shop' using errcode = 'check_violation';
    end if;`,
    new: `    -- DEV-196s LOCAL ONLY (owner decision 2026-11-12): the one exception is the fictional 輪 seeded locally with
    -- this fixed id, and only while its row still carries the fictional markers (its name and placeholder address,
    -- no contact channel at all). Never part of the shared schema (supabase db reset restores the original).
    if new.source_kind = 'ai_generated_demo' or new.rights_status = 'ai_demo_internal' then
      if new.source_kind is distinct from 'ai_generated_demo'
         or new.prospect_id is distinct from '${RIN_PROSPECT_ID}'::uuid
         or not exists (
           select 1 from public.sales_prospects p
           where p.id = new.prospect_id
             and p.normalized_name = '${RIN_REGISTRY_NAME}'
             and p.normalized_address = '${RIN_REGISTRY_ADDRESS}'
             and p.instagram_url is null and p.instagram_handle is null and p.public_email is null
             and p.recommended_channel is null and p.website_url is null) then
        raise exception 'ai_demo_real_shop' using errcode = 'check_violation';
      end if;
    end if;`,
  },
  {
    old: `          then 'ai_concept_internal' else 'unknown' end;
    else`,
    new: `          then 'ai_concept_internal' else 'unknown' end;
    elsif new.source_kind = 'ai_generated_demo' then
      -- DEV-196s LOCAL ONLY: ai_demo_internal only when nothing real is depicted, the provenance is valid and public
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

/** The migration's function text (from `create function …write()` to its closing `$$;`). */
export function migrationImageWriteFunction(migration: string): string {
  const start = migration.indexOf("create function public.sales_check_demo_image_write()");
  if (start < 0) throw new Error("RIN_PATCH_FUNCTION_NOT_FOUND");
  return migration.slice(start, migration.indexOf("$$;", start) + 3);
}

/** The migration's function with the edits applied (each old text must occur exactly once). */
export function patchedImageWriteFunction(migration: string): string {
  let fn = migrationImageWriteFunction(migration);
  for (const e of RIN_PATCH_FUNCTION_EDITS) {
    if (fn.split(e.old).length !== 2) throw new Error("RIN_PATCH_EDIT_NOT_UNIQUE");
    fn = fn.replace(e.old, () => e.new);
  }
  return fn;
}

export const readRinPatchSql = (repo: string) => readFileSync(join(repo, RIN_PATCH_SQL), "utf8");

/**
 * Refuses unless the 輪 seed row exists with the fixed id and its fictional markers (name, placeholder address, no
 * contact at all) and its demo carries 輪's facts pack. Throws Error("RIN_SEED_MISSING" | "RIN_SEED_MARKERS").
 */
export async function assertRinSeedRow(db: pg.Pool | pg.Client | pg.PoolClient, pack: FactsPack): Promise<void> {
  const content = rinDemoContent(pack);
  if (content.name !== RIN_REGISTRY_NAME) throw new Error("RIN_SEED_MARKERS");
  const r = await db.query(
    `select p.normalized_name, p.normalized_address, p.instagram_url, p.instagram_handle, p.public_email, p.recommended_channel, p.website_url, d.content->>'facts_pack' as facts_pack
       from public.sales_prospects p left join public.sales_demos d on d.prospect_id = p.id where p.id = $1`,
    [RIN_PROSPECT_ID],
  );
  const row = r.rows[0];
  if (!row) throw new Error("RIN_SEED_MISSING");
  const contact = [row.instagram_url, row.instagram_handle, row.public_email, row.recommended_channel, row.website_url].some((x) => x !== null);
  if (row.normalized_name !== RIN_REGISTRY_NAME || row.normalized_address !== RIN_REGISTRY_ADDRESS || contact || row.facts_pack !== pack.shop_id) throw new Error("RIN_SEED_MARKERS");
}

/** Applies the patch in one transaction (idempotent: re-running replaces the same check and function). */
export async function applyLocalRinPatch(client: pg.Client | pg.PoolClient, pack: FactsPack, sql: string): Promise<void> {
  await client.query("begin");
  try {
    await assertRinSeedRow(client, pack);
    await client.query(sql);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
}
