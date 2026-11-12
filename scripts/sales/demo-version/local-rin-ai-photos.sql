-- DEV-196s — LOCAL ONLY (owner decision 2026-11-12). NOT a migration; never applied to Staging or Production.
--
-- Lets the fictional 輪 (SR-001, seeded locally by import-local.ts --seed-rin with the fixed id below) carry its AI
-- demo photos on the owner's LOCAL stack. Apply it only with:
--   npx tsx scripts/sales/demo-version/apply-local-rin-patch.ts
-- which refuses a non-local database and refuses unless the 輪 seed row exists with its fictional markers.
-- Revert: `npx supabase db reset` (local) restores the original schema from supabase/migrations.
--
-- It changes exactly two things of supabase/migrations/20261111000000_sales_demo_versions.sql:
--  1. the table check sales_demo_images_real_shop_no_ai_demo (same name) becomes row-local: an ai_generated_demo /
--     ai_demo_internal row only for the 輪 prospect id;
--  2. sales_check_demo_image_write(): the migration's function with the edits of
--     lib/demo-version-package/local-rin-patch.ts RIN_PATCH_FUNCTION_EDITS (a unit test rebuilds it from the
--     migration): ai_generated_demo only for that id while the prospect row carries the fictional markers, and
--     ai_demo_internal only when every depicts_* is false, the provenance is valid and public_web is false (else
--     'unknown'). Share exclusion, immutability and revocation are unchanged. `create or replace` keeps the
--     function's grants and its trigger.
-- Idempotent: re-applying replaces the same check and function.

alter table public.sales_demo_images drop constraint if exists sales_demo_images_real_shop_no_ai_demo;
alter table public.sales_demo_images add constraint sales_demo_images_real_shop_no_ai_demo
  check ((source_kind <> 'ai_generated_demo' and rights_status <> 'ai_demo_internal') or prospect_id = 'c4d31f24-8c91-4495-8ba1-db4706f438f8'::uuid);

create or replace function public.sales_check_demo_image_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'demo_image_delete_forbidden' using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' then
    if new.revoked_at is not null then
      raise exception 'demo_image_must_start_unrevoked' using errcode = 'check_violation';
    end if;
    -- Review round 1 M1: a real shop never carries a fictional shop's AI demo picture.
    -- DEV-196s LOCAL ONLY (owner decision 2026-11-12): the one exception is the fictional 輪 seeded locally with
    -- this fixed id, and only while its row still carries the fictional markers (its name and placeholder address,
    -- no contact channel at all). Never part of the shared schema (supabase db reset restores the original).
    if new.source_kind = 'ai_generated_demo' or new.rights_status = 'ai_demo_internal' then
      if new.source_kind is distinct from 'ai_generated_demo'
         or new.prospect_id is distinct from 'c4d31f24-8c91-4495-8ba1-db4706f438f8'::uuid
         or not exists (
           select 1 from public.sales_prospects p
           where p.id = new.prospect_id
             and p.normalized_name = '架空自転車修理 輪'
             and p.normalized_address = '愛知県名古屋市（登録用の仮の住所。架空の研究用の店 輪、実在しない）'
             and p.instagram_url is null and p.instagram_handle is null and p.public_email is null
             and p.recommended_channel is null and p.website_url is null) then
        raise exception 'ai_demo_real_shop' using errcode = 'check_violation';
      end if;
    end if;
    -- §8.1 "derived on the server": the database derives the status from the
    -- source kind and the recorded conditions; a caller-supplied status is not
    -- trusted. The only caller value kept is 'unknown' (the server's
    -- checkPhotoRights / checkAiConceptRights found the record unusable, e.g. a
    -- wrong label or a forbidden hash the database cannot see): it only lowers.
    if new.rights_status is null or new.rights_status = 'unknown' then
      new.rights_status := 'unknown';
    elsif new.source_kind = 'ai_concept_internal' then
      new.rights_status := case
        when not new.depicts_real_shop and not new.depicts_identifiable_person and not new.depicts_real_product
             and not new.depicts_real_interior and not new.depicts_real_equipment
             and new.no_factual_impersonation_confirmed_at is not null
             and new.no_factual_impersonation_confirmed_by is not null
             and exists (select 1 from public.sales_admins a where a.user_id = new.no_factual_impersonation_confirmed_by)
             and public.sales_demo_ai_provenance_valid(new.provenance)
             and (new.allowed_uses->>'public_web') = 'false'
          then 'ai_concept_internal' else 'unknown' end;
    elsif new.source_kind = 'ai_generated_demo' then
      -- DEV-196s LOCAL ONLY: ai_demo_internal only when nothing real is depicted, the provenance is valid and public
      -- web use is not allowed; anything else is 'unknown' (the ingest then refuses the whole version)
      new.rights_status := case
        when not new.depicts_real_shop and not new.depicts_identifiable_person and not new.depicts_real_product
             and not new.depicts_real_interior and not new.depicts_real_equipment
             and public.sales_demo_ai_provenance_valid(new.provenance)
             and (new.allowed_uses->>'public_web') = 'false'
          then 'ai_demo_internal' else 'unknown' end;
    else
      new.rights_status := case
        when (new.allowed_uses->>'public_web') = 'true' and new.client_confirmed_at is not null
             and not new.depicts_identifiable_person then 'share_cleared'
        when new.source_kind = 'owner_provided' then 'owner_provided_internal'
        when new.source_kind = 'shop_provided' then 'shop_provided_internal'
        else 'licensed_terms_pinned_internal' end;
    end if;
    if new.rights_status <> 'unknown' and new.rights_expiry < public.sales_jst_date(now()) then
      new.rights_status := 'expired';
    end if;
    return new;
  end if;
  if row(new.id, new.prospect_id, new.sha256, new.bytes, new.width, new.height, new.format, new.record_schema,
         new.source_kind, new.depicts_real_shop, new.depicts_identifiable_person, new.depicts_real_product,
         new.depicts_real_interior, new.depicts_real_equipment, new.no_factual_impersonation_confirmed_at,
         new.no_factual_impersonation_confirmed_by, new.allowed_uses, new.client_confirmed_at,
         new.client_confirmation_ref, new.rights_expiry, new.provenance, new.created_at)
     is distinct from
     row(old.id, old.prospect_id, old.sha256, old.bytes, old.width, old.height, old.format, old.record_schema,
         old.source_kind, old.depicts_real_shop, old.depicts_identifiable_person, old.depicts_real_product,
         old.depicts_real_interior, old.depicts_real_equipment, old.no_factual_impersonation_confirmed_at,
         old.no_factual_impersonation_confirmed_by, old.allowed_uses, old.client_confirmed_at,
         old.client_confirmation_ref, old.rights_expiry, old.provenance, old.created_at) then
    raise exception 'demo_image_immutable' using errcode = 'check_violation';
  end if;
  if old.revoked_at is not null and new is distinct from old then
    raise exception 'demo_image_revoked_final' using errcode = 'check_violation';
  end if;
  -- §9.5 (review round 1 L4): revoking an image a shop's versions use is
  -- refused while that shop has a send screen open, whoever writes it.
  if new.revoked_at is not null then
    perform public.sales_demo_assert_no_open_send(v.demo_id)
      from (select distinct ver.demo_id from public.sales_demo_version_files fl
            join public.sales_demo_versions ver on ver.id = fl.version_id where fl.image_id = new.id) v;
  end if;
  if new.rights_status is distinct from old.rights_status
     and not (new.rights_status = 'revoked' or (new.rights_status = 'expired' and old.rights_status <> 'revoked')) then
    raise exception 'demo_image_rights_upgrade_forbidden' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
