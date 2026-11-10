-- Second Root Sales Agent — demo versions, artifact hashes, image rights and
-- the demo quality approval (DEV-196c; docs/design/DEV-196-demo-admin-spec.md
-- §4, §4.6, §8, §8.3.1, §9.2–§9.5, §10.2; owner approval 2026-11-10 for a
-- local-only migration).
--
-- What this adds:
--   1. sales_demo_versions: one row per uploaded artifact of a shop's demo,
--      with lineage (parent_version_id), the generation job id (idempotency
--      key), the worker commit, facts / direction / bundle hashes, the
--      manifest and the Storage prefix (decided here, never by the worker).
--      A version's content and hashes never change once it exists.
--   2. sales_demo_version_files: the manifest's files (path, role, sha256,
--      bytes, content type, dimensions), insert-only, written together with
--      the version.
--   3. sales_demo_images: per-image rights and provenance, DB only. AI images
--      (ai_demo_internal, ai_concept_internal) can never be shareable; the
--      reserved ai_share_approved and the owner AI-share decision cannot be
--      written.
--   4. sales_demo_quality_reviews: the demo QUALITY approval, a separate
--      record from the DEV-195 SEND approval (sales_outreach_approvals).
--      Append-only history; a review only moves active → withdrawn /
--      invalidated. At most one active approval per demo.
--   5. sales_demos.approved_version_id and the §9.3 link: sales_demo_version(d)
--      appends the approved version id and its bundle hash ONLY when a
--      version is approved, so every legacy demo keeps exactly its current
--      hash and live DEV-195 approvals stay valid. Send approvals pin the
--      version id / bundle hash / quality review; sales_send_guards re-derives
--      the version, quality, facts and rights at every guard (§9.2). Stored
--      flags (share_eligible, rights_summary, review state) are display caches.
--   6. §9.5: every hash-changing admin operation answers approval_open while
--      the shop has a send_opened approval. A send confirmed from send_opened
--      records demo_unavailable_after_open instead of being refused.
--   7. Versioned sharing is DISABLED: sales_demo_versioned_sharing_enabled()
--      and sales_demo_share_photos_enabled() are constant false (a later,
--      separately approved migration replaces them, after the dedicated
--      artifact origin exists, DEV-196g), share_eligible is checked false,
--      and sales_resolve_demo_share never returns a version. Demos whose sent
--      approval pinned no version keep the existing React demo
--      (/demo/[publicToken], isDemoPublic, unchanged).
--   8. Worker path: sales_ingest_demo_version (service_role only) inserts
--      unapproved draft versions and nothing else. Approving, reviewing,
--      withdrawing and revoking are admin RPCs (admin checked first), and
--      the triggers bind every approval write to a signed-in sales admin
--      (auth.uid()), so even a direct write with the service role key cannot
--      approve a version, write a review or point a demo at a version.
--
-- Nothing here copies reference material: no table, function or default
-- reads the success cases or SR-001; a version's files come only from its own
-- uploaded manifest. Nothing deletes a version, a file, an image or a review.
--
-- Forward-only. Not applied to any hosted project by this change.

-- ---------------------------------------------------------------------------
-- 0. Switches (constant; replaced only by a later approved migration)
-- ---------------------------------------------------------------------------

-- DEV-196c: sharing of versioned demos stays off until the dedicated artifact
-- origin is set up (spec §6.8, DEV-196g). Every share decision reads this.
create function public.sales_demo_versioned_sharing_enabled()
returns boolean
language sql
immutable
set search_path = ''
as $$ select false $$;

-- MVP_SPEC §7: no photo on a public demo (PUBLIC_DEMO_ASSETS_ENABLED = false,
-- lib/sales/demo-version/rights.ts SHARE_PHOTOS_ENABLED).
create function public.sales_demo_share_photos_enabled()
returns boolean
language sql
immutable
set search_path = ''
as $$ select false $$;

-- ---------------------------------------------------------------------------
-- 1. Value checks (immutable; used by table checks)
-- ---------------------------------------------------------------------------

-- §7.2 / lib/sales/demo-version/quality.ts QUALITY_CHECKLIST_ITEMS: exactly
-- the 7 items, each 'ok' or 'ng'.
create function public.sales_demo_checklist_valid(c jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_typeof(c) = 'object'
    and (select array_agg(k order by k) from jsonb_object_keys(c) k)
        = array['facts_confirmed', 'full_page_information', 'identity_lock', 'no_generic_lp_regression',
                'not_a_copy', 'photos_truthful', 'shop_specific_structure']
    and not exists (select 1 from jsonb_each(c) e where e.value not in ('"ok"'::jsonb, '"ng"'::jsonb)), false)
$$;

-- viewed_renders_sha256: { desktop_1440?, tablet_768?, mobile_390? } → 64 hex.
create function public.sales_demo_renders_valid(r jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_typeof(r) = 'object'
    and not exists (
      select 1 from jsonb_each(r) e
      where e.key not in ('desktop_1440', 'tablet_768', 'mobile_390')
         or jsonb_typeof(e.value) <> 'string' or (e.value #>> '{}') !~ '^[0-9a-f]{64}$'), false)
$$;

-- allowed_uses: exactly {edit, crop, commercial, public_web}, all boolean.
create function public.sales_demo_allowed_uses_valid(u jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_typeof(u) = 'object'
    and (select array_agg(k order by k) from jsonb_object_keys(u) k) = array['commercial', 'crop', 'edit', 'public_web']
    and not exists (select 1 from jsonb_each(u) e where jsonb_typeof(e.value) <> 'boolean'), false)
$$;

-- A note an admin writes: ≤ 500 chars, no URL, no domain, no email address
-- (same style as sales_prospect_insights). Checked on the NFKC form, so
-- full-width letters and punctuation (ｈｔｔｐｓ：, ｅｘａｍｐｌｅ．ｃｏｍ) are
-- caught too (review round 1 L3). A domain is a dotted name ending in 2+
-- letters, followed by "/", ":" or a word end (example.com, example.com/x).
create function public.sales_demo_note_valid(n text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select n is null or (char_length(n) between 1 and 500 and n = btrim(n)
    and lower(normalize(n, NFKC)) !~ '([a-z][a-z0-9+.-]*://|https?:|www\.)'
    and lower(normalize(n, NFKC)) !~ '[a-z0-9_-]+(\.[a-z0-9_-]+)*\.[a-z]{2,}([/:]|\M)'
    and normalize(n, NFKC) !~ '[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+')
$$;

-- §8.3.1 (AiConceptProvenance, lib/sales/demo-version/ai-concept-rights.ts):
-- generator, model (not "unknown"), generated_at, prompt_sha256, approval_id
-- and admin_preview_only = true, nothing else.
create function public.sales_demo_ai_provenance_valid(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_typeof(p) = 'object'
    and (select array_agg(k order by k) from jsonb_object_keys(p) k)
        = array['admin_preview_only', 'approval_id', 'generated_at', 'generator', 'model', 'prompt_sha256']
    and p->'admin_preview_only' = 'true'::jsonb
    and jsonb_typeof(p->'generator') = 'string' and char_length(btrim(p->>'generator')) between 1 and 300
    and jsonb_typeof(p->'model') = 'string' and (p->>'model') ~ '^[0-9A-Za-z._-]{1,60}$' and lower(p->>'model') <> 'unknown'
    and jsonb_typeof(p->'generated_at') = 'string' and (p->>'generated_at') ~ '^\d{4}-\d{2}-\d{2}T'
    and jsonb_typeof(p->'prompt_sha256') = 'string' and (p->>'prompt_sha256') ~ '^[0-9a-f]{64}$'
    and jsonb_typeof(p->'approval_id') = 'string' and (p->>'approval_id') ~ '^[a-z0-9][a-z0-9._-]{3,95}$', false)
$$;

-- The manifest's shape (lib/sales/demo-version/manifest.ts validateManifest,
-- the parts the database can check): {version: 1, files: 2..40 strict file
-- objects with distinct names, exactly one page/index.html and one
-- page/style.css}, at most 15 MiB in all. Names, roles, content types, sizes
-- and dimensions are checked again per file by sales_demo_version_files.
create function public.sales_demo_manifest_valid(m jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    jsonb_typeof(m) = 'object'
    and (select array_agg(k order by k) from jsonb_object_keys(m) k) = array['files', 'version']
    and m->'version' = '1'::jsonb
    and jsonb_typeof(m->'files') = 'array'
    and jsonb_array_length(m->'files') between 2 and 40
    and not exists (
      select 1 from jsonb_array_elements(m->'files') f
      where jsonb_typeof(f) <> 'object'
         or exists (select 1 from jsonb_object_keys(f) k where k not in ('name', 'role', 'sha256', 'bytes', 'content_type', 'width', 'height'))
         or jsonb_typeof(f->'name') is distinct from 'string' or jsonb_typeof(f->'role') is distinct from 'string'
         or jsonb_typeof(f->'sha256') is distinct from 'string' or (f->>'sha256') !~ '^[0-9a-f]{64}$'
         or jsonb_typeof(f->'bytes') is distinct from 'number' or (f->>'bytes') !~ '^[1-9][0-9]{0,7}$'
         or jsonb_typeof(f->'content_type') is distinct from 'string'
         or (f ? 'width' and (jsonb_typeof(f->'width') <> 'number' or (f->>'width') !~ '^[1-9][0-9]{0,3}$'))
         or (f ? 'height' and (jsonb_typeof(f->'height') <> 'number' or (f->>'height') !~ '^[1-9][0-9]{0,3}$')))
    and (select count(distinct f->>'name') from jsonb_array_elements(m->'files') f) = jsonb_array_length(m->'files')
    and (select count(*) from jsonb_array_elements(m->'files') f where f->>'name' = 'page/index.html') = 1
    and (select count(*) from jsonb_array_elements(m->'files') f where f->>'name' = 'page/style.css') = 1
    and (select sum((f->>'bytes')::bigint) from jsonb_array_elements(m->'files') f) <= 15728640, false)
$$;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

create table public.sales_demo_images (
  id uuid primary key default gen_random_uuid(),
  -- The shop the image was prepared for: never used in another shop's version.
  prospect_id uuid not null references public.sales_prospects (id) on delete restrict,
  sha256 text not null unique check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes integer not null check (bytes between 1 and 2000000),
  width integer not null check (width between 1 and 4096),
  height integer not null check (height between 1 and 4096),
  format text not null check (format in ('webp', 'jpeg')),
  record_schema text not null check (record_schema in ('photo_rights_v0', 'ai_concept_rights_v0')),
  source_kind text not null check (source_kind in
    ('owner_provided', 'shop_provided', 'licensed_stock_with_terms', 'ai_generated_demo', 'ai_concept_internal')),
  -- §8.1, derived by the server (lib/sales/demo-version/rights.ts); 'unknown' by default.
  rights_status text not null default 'unknown' check (rights_status in (
    'unknown', 'ai_demo_internal', 'ai_concept_internal', 'owner_provided_internal', 'shop_provided_internal',
    'licensed_terms_pinned_internal', 'share_cleared', 'ai_share_approved', 'expired', 'revoked')),
  depicts_real_shop boolean not null,
  depicts_identifiable_person boolean not null,
  depicts_real_product boolean not null,
  depicts_real_interior boolean not null,
  depicts_real_equipment boolean not null,
  no_factual_impersonation_confirmed_at timestamptz,
  no_factual_impersonation_confirmed_by uuid,
  allowed_uses jsonb not null check (public.sales_demo_allowed_uses_valid(allowed_uses)),
  client_confirmed_at timestamptz,
  client_confirmation_ref text check (char_length(client_confirmation_ref) between 1 and 200),
  rights_expiry date,
  -- §8.2: provenance lives here only (admin read), never in the repository.
  provenance jsonb check (provenance is null or (jsonb_typeof(provenance) = 'object' and pg_column_size(provenance) <= 2048)),
  -- §8.3: reserved; null until a separately approved spec change.
  owner_ai_share_decision_at timestamptz check (owner_ai_share_decision_at is null),
  owner_ai_share_decision_by uuid check (owner_ai_share_decision_by is null),
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_code text check (revoke_code ~ '^[A-Z][A-Z0-9_]{2,47}$'),
  created_at timestamptz not null default now(),
  constraint sales_demo_images_schema_kind
    check ((record_schema = 'ai_concept_rights_v0') = (source_kind = 'ai_concept_internal')),
  -- §8.1: the reserved AI-share status cannot be written.
  constraint sales_demo_images_no_ai_share check (rights_status <> 'ai_share_approved'),
  constraint sales_demo_images_revoked
    check ((rights_status = 'revoked') = (revoked_at is not null) and (revoked_at is null) = (revoke_code is null)),
  -- An AI image is only ever internal (or unusable): never shareable.
  constraint sales_demo_images_ai_internal check (
    source_kind not in ('ai_generated_demo', 'ai_concept_internal')
    or rights_status in ('unknown', 'expired', 'revoked',
                         case source_kind when 'ai_generated_demo' then 'ai_demo_internal' else 'ai_concept_internal' end)),
  constraint sales_demo_images_status_kind check (
    (rights_status <> 'ai_demo_internal' or source_kind = 'ai_generated_demo')
    and (rights_status <> 'owner_provided_internal' or source_kind = 'owner_provided')
    and (rights_status <> 'shop_provided_internal' or source_kind = 'shop_provided')
    and (rights_status <> 'licensed_terms_pinned_internal' or source_kind = 'licensed_stock_with_terms')),
  -- §8.3 / §8.3.1: a real shop's AI concept image depicts nothing real, is
  -- confirmed by the owner and carries its provenance.
  constraint sales_demo_images_ai_concept check (
    rights_status <> 'ai_concept_internal'
    or (not depicts_real_shop and not depicts_identifiable_person and not depicts_real_product
        and not depicts_real_interior and not depicts_real_equipment
        and no_factual_impersonation_confirmed_at is not null and no_factual_impersonation_confirmed_by is not null
        and public.sales_demo_ai_provenance_valid(provenance) and not (allowed_uses->>'public_web')::boolean)),
  -- Review round 1 M1: every sales_prospects row is a REAL shop. The fictional
  -- shops' AI demo pictures (ai_generated_demo / ai_demo_internal, AI_DEMO_SHOPS)
  -- never enter this table; a real shop's AI image is ai_concept_internal only.
  constraint sales_demo_images_real_shop_no_ai_demo
    check (source_kind <> 'ai_generated_demo' and rights_status <> 'ai_demo_internal'),
  constraint sales_demo_images_share_cleared check (
    rights_status <> 'share_cleared'
    or (source_kind in ('owner_provided', 'shop_provided', 'licensed_stock_with_terms')
        and (allowed_uses->>'public_web')::boolean and client_confirmed_at is not null
        and not depicts_identifiable_person))
);

create table public.sales_demo_versions (
  id uuid primary key default gen_random_uuid(),
  demo_id uuid not null references public.sales_demos (id) on delete restrict,
  version_no integer not null check (version_no between 1 and 1000),
  parent_version_id uuid references public.sales_demo_versions (id) on delete restrict,
  origin text not null check (origin in ('worker_autogen', 'design_bridge', 'manual_import')),
  -- §10.2: the idempotency key of the generation job.
  generation_job_id text unique check (generation_job_id ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  worker_commit text check (worker_commit ~ '^[0-9a-f]{7,40}$'),
  -- sales_demo_facts_sha256(demo) when the version was recorded (computed here).
  facts_sha256 text not null check (facts_sha256 ~ '^[0-9a-f]{64}$'),
  direction_sha256 text check (direction_sha256 ~ '^[0-9a-f]{64}$'),
  -- bundleSha256 (lib/sales/demo-version/manifest.ts), re-computed here.
  bundle_sha256 text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object' and pg_column_size(manifest) <= 16384),
  storage_prefix text not null,
  total_bytes integer not null check (total_bytes between 1 and 15728640),
  status text not null check (status in ('uploading', 'rejected', 'draft', 'approved', 'superseded', 'revoked', 'expired')),
  validator_result jsonb check (validator_result is null or (jsonb_typeof(validator_result) = 'object' and pg_column_size(validator_result) <= 2048)),
  worker_checks jsonb check (worker_checks is null or (jsonb_typeof(worker_checks) = 'object' and pg_column_size(worker_checks) <= 2048)),
  structure_descriptor jsonb check (structure_descriptor is null or (jsonb_typeof(structure_descriptor) = 'object' and pg_column_size(structure_descriptor) <= 2048)),
  rights_summary jsonb check (rights_summary is null or (jsonb_typeof(rights_summary) = 'object' and pg_column_size(rights_summary) <= 1024)),
  -- Display cache only (§9.2: guards re-derive). DEV-196c: versioned sharing
  -- is disabled, so it can only be false.
  share_eligible boolean not null default false check (not share_eligible),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_code text check (revoke_code ~ '^[A-Z][A-Z0-9_]{2,47}$'),
  created_at timestamptz not null default now(),
  validated_at timestamptz,
  status_changed_at timestamptz not null default now(),
  constraint sales_demo_versions_no unique (demo_id, version_no),
  constraint sales_demo_versions_prefix check (storage_prefix = 'v1/' || demo_id::text || '/' || id::text || '/'),
  constraint sales_demo_versions_revoked check (
    (status = 'revoked') = (revoked_at is not null)
    and (revoked_at is null) = (revoked_by is null) and (revoked_at is null) = (revoke_code is null)),
  constraint sales_demo_versions_parent_not_self check (parent_version_id is distinct from id)
);

-- §10.2: at most one upload in flight per demo; the same bundle is recorded
-- once per demo (a rejected upload does not block a corrected retry).
create unique index sales_demo_versions_one_uploading
  on public.sales_demo_versions (demo_id) where status = 'uploading';
create unique index sales_demo_versions_bundle_key
  on public.sales_demo_versions (demo_id, bundle_sha256) where status <> 'rejected';
-- At most one approved version per demo.
create unique index sales_demo_versions_one_approved
  on public.sales_demo_versions (demo_id) where status = 'approved';
create index sales_demo_versions_parent_idx on public.sales_demo_versions (parent_version_id) where parent_version_id is not null;

create table public.sales_demo_version_files (
  version_id uuid not null references public.sales_demo_versions (id) on delete restrict,
  path text not null check (path ~ '^(page/index\.html|page/style\.css|page/photos/[a-z][a-z0-9_]{0,39}-(desktop|tablet|mobile)\.(webp|jpg)|renders/(desktop_1440|tablet_768|mobile_390)\.webp)$'),
  role text not null check (role in ('html', 'css', 'photo', 'render')),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes integer not null check (bytes between 1 and 4194304),
  content_type text not null check (content_type in ('text/html', 'text/css', 'image/webp', 'image/jpeg')),
  width integer check (width between 1 and 4096),
  height integer check (height between 1 and 4096),
  image_id uuid references public.sales_demo_images (id) on delete restrict,
  primary key (version_id, path),
  constraint sales_demo_version_files_role check (
    case
      when path = 'page/index.html' then role = 'html' and content_type = 'text/html' and bytes <= 393216
      when path = 'page/style.css' then role = 'css' and content_type = 'text/css' and bytes <= 262144
      when path like 'page/photos/%' then role = 'photo' and bytes <= 2000000
        and content_type = case when path like '%.webp' then 'image/webp' else 'image/jpeg' end
      else role = 'render' and content_type = 'image/webp'
    end),
  constraint sales_demo_version_files_dims check (
    (role in ('photo', 'render')) = (width is not null and height is not null)
    and (role in ('photo', 'render') or (width is null and height is null))),
  constraint sales_demo_version_files_image check ((role = 'photo') = (image_id is not null))
);
create index sales_demo_version_files_image_idx on public.sales_demo_version_files (image_id) where image_id is not null;

create table public.sales_demo_quality_reviews (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.sales_demo_versions (id) on delete restrict,
  demo_id uuid not null references public.sales_demos (id) on delete restrict,
  decision text not null check (decision in ('approved', 'rejected', 'changes_requested')),
  state text not null default 'active' check (state in ('active', 'withdrawn', 'invalidated')),
  checklist jsonb not null check (public.sales_demo_checklist_valid(checklist)),
  -- What the admin screen showed (render name → sha256 of the version's file).
  viewed_renders_sha256 jsonb not null check (public.sales_demo_renders_valid(viewed_renders_sha256)),
  bundle_sha256 text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
  facts_sha256 text not null check (facts_sha256 ~ '^[0-9a-f]{64}$'),
  rights_summary_sha256 text check (rights_summary_sha256 ~ '^[0-9a-f]{64}$'),
  -- Admin-only free text (DEV-196d planning): ≤ 500 chars, no URL / email.
  note text check (public.sales_demo_note_valid(note)),
  reviewed_by uuid not null,
  reviewed_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  withdrawn_by uuid,
  invalidated_at timestamptz,
  invalidated_reason text check (invalidated_reason in
    ('rights_changed', 'facts_changed', 'version_revoked', 'superseded_by_newer_approval')),
  -- §7.2: an approval has every item 'ok' and both required renders viewed.
  constraint sales_demo_quality_reviews_approved check (
    decision <> 'approved'
    or (not jsonb_path_exists(checklist, '$.* ? (@ == "ng")')
        and viewed_renders_sha256 ? 'desktop_1440' and viewed_renders_sha256 ? 'mobile_390')),
  constraint sales_demo_quality_reviews_withdrawn
    check ((state = 'withdrawn') = (withdrawn_at is not null and withdrawn_by is not null)),
  constraint sales_demo_quality_reviews_invalidated
    check ((state = 'invalidated') = (invalidated_at is not null and invalidated_reason is not null)),
  constraint sales_demo_quality_reviews_withdraw_approved check (state <> 'withdrawn' or decision = 'approved')
);

-- At most one active quality approval per demo (§4.4).
create unique index sales_demo_quality_reviews_one_active_approval
  on public.sales_demo_quality_reviews (demo_id) where decision = 'approved' and state = 'active';
create index sales_demo_quality_reviews_version_idx on public.sales_demo_quality_reviews (version_id);

-- §4.4 / §9.3: the demo's quality-approved version (written only by the
-- review / withdraw / revoke functions below; a trigger binds it to an admin).
alter table public.sales_demos
  add column approved_version_id uuid references public.sales_demo_versions (id) on delete restrict;

-- §9.2: what a send approval pinned. All four null = a legacy demo (no
-- version); all set = the quality-approved version at approval time.
alter table public.sales_outreach_approvals
  add column demo_version_id uuid references public.sales_demo_versions (id) on delete restrict,
  add column demo_bundle_sha256 text check (demo_bundle_sha256 ~ '^[0-9a-f]{64}$'),
  add column demo_quality_review_id uuid references public.sales_demo_quality_reviews (id) on delete restrict,
  -- Record only (never used by a guard, §9.2).
  add column demo_share_eligible boolean,
  -- §9.5: a send confirmed from send_opened whose pinned version could not be
  -- shown any more at that moment (time-based changes cannot be refused).
  add column demo_unavailable_after_open text check (demo_unavailable_after_open in
    ('version_unavailable', 'version_expired', 'rights_expired', 'rights_revoked', 'not_shareable', 'revoked_urgent')),
  add constraint sales_outreach_approvals_demo_pin check (
    (demo_version_id is null) = (demo_bundle_sha256 is null)
    and (demo_version_id is null) = (demo_quality_review_id is null)
    and (demo_version_id is null) = (demo_share_eligible is null)),
  add constraint sales_outreach_approvals_unavailable_after_open
    check (demo_unavailable_after_open is null or (state = 'sent' and demo_version_id is not null));

create index sales_outreach_approvals_demo_version_idx
  on public.sales_outreach_approvals (demo_version_id) where demo_version_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Write rules (triggers; they hold whatever role writes)
-- ---------------------------------------------------------------------------

-- Images: never deleted; what was measured and recorded never changes; the
-- rights only move down (to expired / revoked); a revocation is final.
create function public.sales_check_demo_image_write()
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
    if new.source_kind = 'ai_generated_demo' or new.rights_status = 'ai_demo_internal' then
      raise exception 'ai_demo_real_shop' using errcode = 'check_violation';
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

create trigger sales_demo_images_write
  before insert or update or delete on public.sales_demo_images
  for each row execute function public.sales_check_demo_image_write();

-- Versions: never deleted; content and hashes fixed at creation; the status
-- only moves along §4.6; approval needs a signed-in sales admin and an active
-- approval of exactly this content (so the worker / service role cannot).
create function public.sales_check_demo_version_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_parent_demo uuid;
  v_facts text;
  allowed boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'demo_version_delete_forbidden' using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' then
    -- A version is born unapproved: never approved, superseded, revoked or expired.
    if new.status not in ('uploading', 'draft') then
      raise exception 'demo_version_must_start_unapproved' using errcode = 'check_violation';
    end if;
    if new.parent_version_id is not null then
      select demo_id into v_parent_demo from public.sales_demo_versions where id = new.parent_version_id;
      if v_parent_demo is distinct from new.demo_id then
        raise exception 'parent_other_demo' using errcode = 'check_violation';
      end if;
    end if;
    -- Review round 1 L4: the integrity checks hold for every writer, not only
    -- sales_ingest_demo_version. The manifest is well formed, the bundle hash
    -- is the manifest's, the size is its sum, the facts hash is the demo's
    -- content now, and the retention is at most 60 days from now.
    if not public.sales_demo_manifest_valid(new.manifest) then
      raise exception 'invalid_manifest' using errcode = 'check_violation';
    end if;
    if public.sales_demo_bundle_sha256(new.manifest) is distinct from new.bundle_sha256 then
      raise exception 'bundle_mismatch' using errcode = 'check_violation';
    end if;
    if new.total_bytes is distinct from (select sum((f->>'bytes')::bigint)::integer from jsonb_array_elements(new.manifest->'files') f) then
      raise exception 'invalid_manifest' using errcode = 'check_violation';
    end if;
    select public.sales_demo_facts_sha256(d) into v_facts from public.sales_demos d where d.id = new.demo_id;
    if v_facts is distinct from new.facts_sha256 then
      raise exception 'facts_mismatch' using errcode = 'check_violation';
    end if;
    if new.expires_at <= now() or new.expires_at > now() + interval '60 days' then
      raise exception 'invalid_expiry' using errcode = 'check_violation';
    end if;
    -- Review round 1 L5: a byte-identical bundle is never recorded for another
    -- shop (no template reuse, no copying between shops; §7.5, §7.6). Serialised
    -- per bundle so two concurrent inserts cannot both pass.
    perform pg_advisory_xact_lock(hashtext('second_root_demo_bundle:' || new.bundle_sha256));
    if exists (select 1 from public.sales_demo_versions v where v.bundle_sha256 = new.bundle_sha256 and v.demo_id <> new.demo_id) then
      raise exception 'bundle_reused_across_shops' using errcode = 'P0001';
    end if;
    new.created_at := now();
    new.status_changed_at := now();
    return new;
  end if;

  if row(new.id, new.demo_id, new.version_no, new.parent_version_id, new.origin, new.generation_job_id,
         new.worker_commit, new.facts_sha256, new.direction_sha256, new.bundle_sha256, new.manifest,
         new.storage_prefix, new.total_bytes, new.created_at)
     is distinct from
     row(old.id, old.demo_id, old.version_no, old.parent_version_id, old.origin, old.generation_job_id,
         old.worker_commit, old.facts_sha256, old.direction_sha256, old.bundle_sha256, old.manifest,
         old.storage_prefix, old.total_bytes, old.created_at) then
    raise exception 'demo_version_content_immutable' using errcode = 'check_violation';
  end if;
  -- The server's findings are fixed once the upload is finalized.
  if old.status <> 'uploading'
     and row(new.validator_result, new.worker_checks, new.structure_descriptor, new.rights_summary, new.validated_at)
         is distinct from
         row(old.validator_result, old.worker_checks, old.structure_descriptor, old.rights_summary, old.validated_at) then
    raise exception 'demo_version_content_immutable' using errcode = 'check_violation';
  end if;
  if old.status in ('revoked', 'rejected', 'expired') and new is distinct from old then
    raise exception 'demo_version_final' using errcode = 'check_violation';
  end if;
  -- Review round 1 L4: the retention may be shortened (fail-safe), but only
  -- extended for a version a sent approval pinned (sales_mark_sent, §6.6).
  if new.expires_at > old.expires_at and not exists (
       select 1 from public.sales_outreach_approvals a where a.demo_version_id = new.id and a.state = 'sent') then
    raise exception 'demo_version_expiry_extension_forbidden' using errcode = 'check_violation';
  end if;

  if new.status <> old.status then
    -- §9.5 (review round 1 L4): leaving or entering 'approved' and revoking
    -- change what a send would show; refused while a send screen is open,
    -- whoever writes it.
    if old.status = 'approved' or new.status in ('approved', 'revoked') then
      perform public.sales_demo_assert_no_open_send(new.demo_id);
    end if;
    allowed := case old.status
      when 'uploading' then new.status in ('draft', 'rejected')
      when 'draft' then new.status in ('approved', 'revoked', 'expired')
      when 'approved' then new.status in ('draft', 'superseded', 'revoked', 'expired')
      when 'superseded' then new.status in ('approved', 'revoked', 'expired')
      else false
    end;
    if not allowed then
      raise exception 'invalid_version_transition:%->%', old.status, new.status using errcode = 'check_violation';
    end if;
    if new.status = 'approved' then
      if not public.is_sales_admin() then
        raise exception 'admin_identity_required' using errcode = '42501';
      end if;
      if not exists (
        select 1 from public.sales_demo_quality_reviews r
        where r.version_id = new.id and r.decision = 'approved' and r.state = 'active'
          and r.bundle_sha256 = new.bundle_sha256 and r.facts_sha256 = new.facts_sha256) then
        raise exception 'quality_approval_required' using errcode = 'check_violation';
      end if;
    end if;
    new.status_changed_at := now();
  end if;
  return new;
end;
$$;

create trigger sales_demo_versions_write
  before insert or update or delete on public.sales_demo_versions
  for each row execute function public.sales_check_demo_version_write();

-- Files: insert-only, and only in the transaction that created the version
-- (so a stored version can never gain, lose or change a file). A photo is the
-- image row with the same bytes, prepared for the same shop.
create function public.sales_check_demo_version_file_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v public.sales_demo_versions;
  i public.sales_demo_images;
  v_prospect uuid;
begin
  if tg_op <> 'INSERT' then
    raise exception 'demo_version_files_immutable' using errcode = 'check_violation';
  end if;
  select * into v from public.sales_demo_versions where id = new.version_id;
  if v.created_at is distinct from now() or v.status not in ('uploading', 'draft') then
    raise exception 'demo_version_files_immutable' using errcode = 'check_violation';
  end if;
  -- Review round 1 L4: every file row is exactly one entry of the version's manifest.
  if not exists (
    select 1 from jsonb_array_elements(v.manifest->'files') f
    where f->>'name' = new.path and f->>'role' = new.role and f->>'sha256' = new.sha256
      and (f->>'bytes')::integer = new.bytes and f->>'content_type' = new.content_type
      and (f->>'width')::integer is not distinct from new.width and (f->>'height')::integer is not distinct from new.height) then
    raise exception 'file_not_in_manifest' using errcode = 'check_violation';
  end if;
  if new.image_id is not null then
    select * into i from public.sales_demo_images where id = new.image_id;
    select prospect_id into v_prospect from public.sales_demos where id = v.demo_id;
    if i.sha256 is distinct from new.sha256 or i.bytes is distinct from new.bytes
       or i.width is distinct from new.width or i.height is distinct from new.height
       or i.format is distinct from (case new.content_type when 'image/webp' then 'webp' else 'jpeg' end) then
      raise exception 'image_mismatch' using errcode = 'check_violation';
    end if;
    if i.prospect_id is distinct from v_prospect then
      raise exception 'image_other_shop' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger sales_demo_version_files_write
  before insert or update or delete on public.sales_demo_version_files
  for each row execute function public.sales_check_demo_version_file_write();

-- Review round 1 L4: at commit, a new version has exactly its manifest's files
-- (with the per-row check above: the same set), whoever wrote it.
create function public.sales_check_demo_version_files_complete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select count(*) from public.sales_demo_version_files f where f.version_id = new.id)
     <> jsonb_array_length(new.manifest->'files') then
    raise exception 'version_files_incomplete' using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

create constraint trigger sales_demo_versions_files_complete
  after insert on public.sales_demo_versions
  deferrable initially deferred
  for each row execute function public.sales_check_demo_version_files_complete();

-- Quality reviews: append-only. A review is written only by a signed-in sales
-- admin as themself, for exactly the version's content; afterwards it only
-- moves active → withdrawn (by an admin) / invalidated.
create function public.sales_check_quality_review_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v public.sales_demo_versions;
begin
  if tg_op = 'DELETE' then
    raise exception 'quality_review_delete_forbidden' using errcode = 'check_violation';
  end if;
  if tg_op = 'INSERT' then
    if not public.is_sales_admin() or new.reviewed_by is distinct from auth.uid() then
      raise exception 'admin_identity_required' using errcode = '42501';
    end if;
    if new.state <> 'active' or new.withdrawn_at is not null or new.invalidated_at is not null then
      raise exception 'quality_review_must_start_active' using errcode = 'check_violation';
    end if;
    select * into v from public.sales_demo_versions where id = new.version_id;
    if v.demo_id is distinct from new.demo_id or v.bundle_sha256 is distinct from new.bundle_sha256
       or v.facts_sha256 is distinct from new.facts_sha256 then
      raise exception 'quality_review_snapshot_mismatch' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if row(new.id, new.version_id, new.demo_id, new.decision, new.checklist, new.viewed_renders_sha256,
         new.bundle_sha256, new.facts_sha256, new.rights_summary_sha256, new.note, new.reviewed_by, new.reviewed_at)
     is distinct from
     row(old.id, old.version_id, old.demo_id, old.decision, old.checklist, old.viewed_renders_sha256,
         old.bundle_sha256, old.facts_sha256, old.rights_summary_sha256, old.note, old.reviewed_by, old.reviewed_at) then
    raise exception 'quality_review_immutable' using errcode = 'check_violation';
  end if;
  if new is distinct from old then
    if old.state <> 'active' or new.state not in ('withdrawn', 'invalidated') then
      raise exception 'quality_review_final' using errcode = 'check_violation';
    end if;
    if new.state = 'withdrawn' and (not public.is_sales_admin() or new.withdrawn_by is distinct from auth.uid()) then
      raise exception 'admin_identity_required' using errcode = '42501';
    end if;
    -- §9.5 (review round 1 L4): ending an active approval can change what a
    -- send would show; refused while a send screen is open, whoever writes it.
    if old.decision = 'approved' then
      perform public.sales_demo_assert_no_open_send(old.demo_id);
    end if;
  end if;
  return new;
end;
$$;

create trigger sales_demo_quality_reviews_write
  before insert or update or delete on public.sales_demo_quality_reviews
  for each row execute function public.sales_check_quality_review_write();

-- sales_demos.approved_version_id: null at creation; set only by a signed-in
-- sales admin, and only to an approved, unrevoked version of this demo with
-- an active approval. Clearing it (withdraw / revoke) is always allowed.
create function public.sales_check_demo_approved_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.approved_version_id is not null then
      raise exception 'approved_version_on_insert' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  -- §9.5 (review round 1 L4): any change of the approved version changes the
  -- send hash; refused while a send screen is open, whoever writes it.
  if new.approved_version_id is distinct from old.approved_version_id then
    perform public.sales_demo_assert_no_open_send(new.id);
  end if;
  if new.approved_version_id is not null and new.approved_version_id is distinct from old.approved_version_id then
    if not public.is_sales_admin() then
      raise exception 'admin_identity_required' using errcode = '42501';
    end if;
    if not exists (
      select 1 from public.sales_demo_versions v
      join public.sales_demo_quality_reviews r on r.version_id = v.id and r.decision = 'approved' and r.state = 'active'
      where v.id = new.approved_version_id and v.demo_id = new.id and v.status = 'approved' and v.revoked_at is null) then
      raise exception 'quality_approval_required' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger sales_demos_approved_version
  before insert or update of approved_version_id on public.sales_demos
  for each row execute function public.sales_check_demo_approved_version();

-- DEV-195's approval write rule, unchanged except: the version pin is part of
-- the immutable snapshot and must match the version / its active approval at
-- insert; demo_unavailable_after_open is written only on send_opened → sent.
create or replace function public.sales_check_approval_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'approved' or new.opened_at is not null or new.sent_at is not null or new.superseded_at is not null
       or new.demo_unavailable_after_open is not null then
      raise exception 'approval_must_start_approved' using errcode = 'check_violation';
    end if;
    if new.demo_version_id is not null and not exists (
      select 1 from public.sales_demo_versions v
      join public.sales_demos d on d.id = v.demo_id
      join public.sales_demo_quality_reviews r on r.id = new.demo_quality_review_id
      where v.id = new.demo_version_id and d.prospect_id = new.prospect_id
        and v.bundle_sha256 = new.demo_bundle_sha256 and r.version_id = v.id
        and r.decision = 'approved' and r.state = 'active') then
      raise exception 'approval_demo_pin_mismatch' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if row(new.outreach_id, new.prospect_id, new.mode, new.channel, new.recipient, new.subject, new.body,
         new.draft_version, new.demo_token, new.demo_design_status, new.demo_design_updated_at,
         new.demo_version, new.snapshot_sha256, new.approved_by, new.approved_at,
         new.demo_version_id, new.demo_bundle_sha256, new.demo_quality_review_id, new.demo_share_eligible)
     is distinct from
     row(old.outreach_id, old.prospect_id, old.mode, old.channel, old.recipient, old.subject, old.body,
         old.draft_version, old.demo_token, old.demo_design_status, old.demo_design_updated_at,
         old.demo_version, old.snapshot_sha256, old.approved_by, old.approved_at,
         old.demo_version_id, old.demo_bundle_sha256, old.demo_quality_review_id, old.demo_share_eligible) then
    raise exception 'approval_snapshot_immutable' using errcode = 'check_violation';
  end if;
  if old.state in ('sent', 'superseded') and new is distinct from old then
    raise exception 'approval_final_immutable' using errcode = 'check_violation';
  end if;
  if (new.blocked_after_open is distinct from old.blocked_after_open
      or new.demo_unavailable_after_open is distinct from old.demo_unavailable_after_open)
     and not (old.state = 'send_opened' and new.state = 'sent') then
    raise exception 'approval_final_immutable' using errcode = 'check_violation';
  end if;
  if new.state <> old.state and not (
       (old.state = 'approved' and new.state in ('send_opened', 'superseded'))
       or (old.state = 'send_opened' and new.state in ('sent', 'superseded'))) then
    raise exception 'invalid_approval_transition:%->%', old.state, new.state using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Helpers (invoker rights; service_role only)
-- ---------------------------------------------------------------------------

-- §9.2: the facts a version was generated from, computed from the database
-- (never taken from the worker): sha256 of the demo's verified content.
create function public.sales_demo_facts_sha256(d public.sales_demos)
returns text
language sql
stable
set search_path = ''
as $$
  select encode(sha256(convert_to(coalesce(d.content, '{}'::jsonb)::text, 'UTF8')), 'hex')
$$;

-- bundleSha256 (lib/sales/demo-version/manifest.ts canonicalManifest): the
-- files sorted by name, identity fields only, as JSON.stringify writes them.
-- Names are limited to [a-z0-9_./-] by the file check, so C order = JS order.
create function public.sales_demo_bundle_sha256(p_manifest jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(
    '{"version":' || (p_manifest->>'version') || ',"files":['
    || string_agg('{"name":' || to_json(f->>'name')::text || ',"role":' || to_json(f->>'role')::text
                  || ',"sha256":' || to_json(f->>'sha256')::text || ',"bytes":' || (f->>'bytes')
                  || ',"content_type":' || to_json(f->>'content_type')::text || '}',
                  ',' order by (f->>'name') collate "C")
    || ']}', 'UTF8')), 'hex')
  from jsonb_array_elements(p_manifest->'files') f
$$;

-- §8.1 / §8.3, re-derived now (stored flags are not trusted): an image may be
-- on a share URL only if photos may be shared at all, it is share_cleared,
-- not revoked and within its rights expiry (JST calendar day). AI images:
-- never (their status can never be share_cleared, table check; and here).
create function public.sales_demo_image_shareable(i public.sales_demo_images)
returns boolean
language sql
stable
set search_path = ''
as $$
  select public.sales_demo_share_photos_enabled()
     and i.rights_status = 'share_cleared'
     and i.source_kind not in ('ai_generated_demo', 'ai_concept_internal')
     and i.revoked_at is null
     and (i.rights_expiry is null or i.rights_expiry >= public.sales_jst_date(now()))
$$;

-- §8.1: an image the admin preview may show (anything else rejects the version).
create function public.sales_demo_image_previewable(i public.sales_demo_images)
returns boolean
language sql
stable
set search_path = ''
as $$
  select i.rights_status in ('ai_demo_internal', 'ai_concept_internal', 'owner_provided_internal',
                             'shop_provided_internal', 'licensed_terms_pinned_internal', 'share_cleared')
     and i.revoked_at is null
     and (i.rights_expiry is null or i.rights_expiry >= public.sales_jst_date(now()))
$$;

-- Rights of a whole version for sharing (fail closed: one image that is not
-- shareable makes the version not shareable; zero photos → true).
create function public.sales_demo_version_rights_shareable(p_version_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (select 1 from public.sales_demo_versions v where v.id = p_version_id)
     and not exists (
       select 1 from public.sales_demo_version_files f
       left join public.sales_demo_images i on i.id = f.image_id
       where f.version_id = p_version_id and f.role = 'photo'
         and (i.id is null or not public.sales_demo_image_shareable(i)))
$$;

-- Whether a version may be served on a share URL right now. DEV-196c: always
-- false (versioned sharing disabled until the dedicated origin, DEV-196g).
create function public.sales_demo_version_shareable(p_version_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select public.sales_demo_versioned_sharing_enabled()
     and exists (select 1 from public.sales_demo_versions v
                 where v.id = p_version_id and v.revoked_at is null and v.status in ('draft', 'approved', 'superseded'))
     and public.sales_demo_version_rights_shareable(p_version_id)
$$;

-- §9.2: why a send of this demo must be refused because of its approved
-- version (null: no version approved, or everything holds). Re-derived from
-- the rows at every call.
create function public.sales_demo_version_send_block(d public.sales_demos)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v public.sales_demo_versions;
begin
  if d.approved_version_id is null then
    return null;
  end if;
  select * into v from public.sales_demo_versions where id = d.approved_version_id;
  if not found or v.demo_id <> d.id or v.status <> 'approved' or v.revoked_at is not null or v.expires_at <= now() then
    return 'demo_version_unavailable';
  end if;
  if not exists (
    select 1 from public.sales_demo_quality_reviews r
    where r.version_id = v.id and r.decision = 'approved' and r.state = 'active'
      and r.bundle_sha256 = v.bundle_sha256 and r.facts_sha256 = v.facts_sha256) then
    return 'demo_quality_not_approved';
  end if;
  if v.facts_sha256 <> public.sales_demo_facts_sha256(d) then
    return 'demo_facts_changed';
  end if;
  if not public.sales_demo_version_shareable(v.id) then
    return 'demo_not_shareable';
  end if;
  return null;
end;
$$;

-- §9.5 rule 2: at a send confirmed from send_opened, why the pinned version
-- can no longer be shown (recorded, not refused). null: it still can, or the
-- approval pinned no version.
create function public.sales_demo_version_after_open_code(p_version_id uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v public.sales_demo_versions;
begin
  if p_version_id is null then
    return null;
  end if;
  select * into v from public.sales_demo_versions where id = p_version_id;
  if not found or v.revoked_at is not null or v.status in ('revoked', 'rejected', 'uploading') then
    return 'version_unavailable';
  end if;
  if v.expires_at <= now() or v.status = 'expired' then
    return 'version_expired';
  end if;
  if exists (select 1 from public.sales_demo_version_files f join public.sales_demo_images i on i.id = f.image_id
             where f.version_id = v.id and i.revoked_at is not null) then
    return 'rights_revoked';
  end if;
  if exists (select 1 from public.sales_demo_version_files f join public.sales_demo_images i on i.id = f.image_id
             where f.version_id = v.id
               and (i.rights_status = 'expired' or i.rights_expiry < public.sales_jst_date(now()))) then
    return 'rights_expired';
  end if;
  if not public.sales_demo_version_shareable(v.id) then
    return 'not_shareable';
  end if;
  return null;
end;
$$;

-- §9.5 rule 1: a hash-changing operation writes nothing while the shop has a
-- send_opened approval (the owner may already have sent from their app).
create function public.sales_demo_assert_no_open_send(p_demo_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.sales_outreach_approvals a
    join public.sales_demos d on d.prospect_id = a.prospect_id
    where d.id = p_demo_id and a.state = 'send_opened') then
    raise exception 'approval_open' using errcode = 'P0001';
  end if;
end;
$$;

-- §9.3: what the recipient sees. Identical to 20261107000000 while no version
-- is approved (the same 5-element hash, so live approvals of legacy demos stay
-- valid); with an approved version, its id and bundle hash are appended, so
-- approving another version, withdrawing or revoking changes it.
create or replace function public.sales_demo_version(d public.sales_demos)
returns text
language sql
stable
set search_path = ''
as $$
  select encode(sha256(convert_to(
    case when d.approved_version_id is null then
      jsonb_build_array(d.public_token, d.template, d.content, d.design_status, d.design_profile)
    else
      jsonb_build_array(d.public_token, d.template, d.content, d.design_status, d.design_profile,
                        d.approved_version_id,
                        (select v.bundle_sha256 from public.sales_demo_versions v where v.id = d.approved_version_id))
    end::text, 'UTF8')), 'hex')
$$;

-- The approval still describes exactly what would be sent now (unchanged from
-- 20261107000000 except the explicit version pin comparison).
create or replace function public.sales_approval_is_current(a public.sales_outreach_approvals, o public.sales_outreaches, d public.sales_demos)
returns boolean
language sql
stable
set search_path = ''
as $$
  select a.outreach_id = o.id
     and a.channel = o.channel
     and a.draft_version = o.draft_version
     and a.recipient is not distinct from public.sales_outreach_recipient(o.prospect_id, o.channel)
     and a.demo_token = d.public_token
     and a.demo_version = public.sales_demo_version(d)
     and a.demo_version_id is not distinct from d.approved_version_id
$$;

-- Every guard of a manual initial send: unchanged from 20261107000000 except
-- the §9.2 version / quality / facts / rights re-derivation at approval and at
-- 送信画面を開いた. From send_opened (p_confirm_opened) it does not refuse:
-- sales_mark_sent records demo_unavailable_after_open instead (§9.5).
create or replace function public.sales_send_guards(o public.sales_outreaches, p_design_enabled boolean, p_confirm_opened boolean)
returns public.sales_demos
language plpgsql
set search_path = ''
as $$
declare
  d public.sales_demos;
  v_recipient text;
  v_block text;
  v_code text;
begin
  if o.kind <> 'initial' or o.status <> 'drafted' then
    raise exception 'invalid_transition' using errcode = 'P0001';
  end if;
  -- Serialises with sales_add_exclusion: an exclusion committed before this
  -- point is always seen; one added later waits for this send to finish.
  perform pg_advisory_xact_lock_shared(hashtext('second_root_sales_exclusions'));
  -- A concurrent DNC (sales_set_dnc locks the same row) is seen after the wait.
  perform 1 from public.sales_prospects where id = o.prospect_id for update;
  if coalesce(p_confirm_opened, false) then
    v_block := public.sales_outreach_block_reason(o.prospect_id);
    perform public.sales_assert_channel_eligible(o.prospect_id, o.kind, o.channel);
  else
    -- DNC, channel rules, recommended channel and the exclusion list.
    perform public.sales_assert_outreach_eligible(o.prospect_id, o.kind, o.channel);
  end if;

  v_recipient := public.sales_outreach_recipient(o.prospect_id, o.channel);
  if v_recipient is null then
    raise exception 'recipient_missing' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.sales_outreach_approvals a
    where a.channel = o.channel and a.recipient = v_recipient and a.outreach_id <> o.id
      and a.state in ('approved', 'send_opened', 'sent')
  ) then
    raise exception 'duplicate_recipient' using errcode = 'P0001';
  end if;

  select * into d from public.sales_demos where prospect_id = o.prospect_id for update;
  if not found or (d.disabled_at is not null and v_block is distinct from 'do_not_contact') then
    raise exception 'demo_unavailable' using errcode = 'P0001';
  end if;
  if coalesce(p_design_enabled, false) and d.design_status in ('pending', 'processing') then
    raise exception 'design_pending' using errcode = 'P0001';
  end if;
  -- DEV-196c (§9.2): a quality-approved version must still be approved,
  -- unrevoked, unexpired, match the current facts and be shareable now.
  if not coalesce(p_confirm_opened, false) then
    v_code := public.sales_demo_version_send_block(d);
    if v_code is not null then
      raise exception using message = v_code, errcode = 'P0001';
    end if;
  end if;
  return d;
end;
$$;

-- §6.4 steps 3–4 (database side): what the share URL of a demo may show.
--   none:    nothing (404) — demo not public, sent approvals disagree, or the
--            pinned version cannot be served. NEVER a fallback.
--   legacy:  no sent approval pinned a version: the existing React demo,
--            exactly as before (isDemoPublic decides, lib/sales/demo.ts).
--   version: the pinned version (unreachable in DEV-196c: sharing disabled).
-- Not wired to any route yet (DEV-196g); the React path does not call it.
create function public.sales_resolve_demo_share(p_public_token text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  d public.sales_demos;
  v public.sales_demo_versions;
  v_pinned integer;
  v_unpinned integer;
  v_distinct integer;
  v_pin uuid;
begin
  select * into d from public.sales_demos where public_token = p_public_token;
  if not found or d.disabled_at is not null or d.expires_at is null or not (d.keep_alive or d.expires_at > now()) then
    return jsonb_build_object('mode', 'none');
  end if;
  select count(*) filter (where a.demo_version_id is not null), count(*) filter (where a.demo_version_id is null),
         count(distinct a.demo_version_id), max(a.demo_version_id::text)::uuid
    into v_pinned, v_unpinned, v_distinct, v_pin
    from public.sales_outreach_approvals a
    where a.prospect_id = d.prospect_id and a.state = 'sent';
  if v_pinned = 0 then
    return jsonb_build_object('mode', 'legacy');
  end if;
  if v_unpinned > 0 or v_distinct <> 1 then
    return jsonb_build_object('mode', 'none');
  end if;
  if not public.sales_demo_versioned_sharing_enabled() then
    return jsonb_build_object('mode', 'none');
  end if;
  select * into v from public.sales_demo_versions where id = v_pin;
  if not found or v.demo_id <> d.id or not public.sales_demo_version_shareable(v.id) then
    return jsonb_build_object('mode', 'none');
  end if;
  return jsonb_build_object('mode', 'version', 'version_id', v.id);
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.sales_demo_versioned_sharing_enabled()',
    'public.sales_demo_share_photos_enabled()',
    'public.sales_demo_checklist_valid(jsonb)',
    'public.sales_demo_renders_valid(jsonb)',
    'public.sales_demo_allowed_uses_valid(jsonb)',
    'public.sales_demo_note_valid(text)',
    'public.sales_demo_ai_provenance_valid(jsonb)',
    'public.sales_demo_manifest_valid(jsonb)',
    'public.sales_check_demo_version_files_complete()',
    'public.sales_check_demo_image_write()',
    'public.sales_check_demo_version_write()',
    'public.sales_check_demo_version_file_write()',
    'public.sales_check_quality_review_write()',
    'public.sales_check_demo_approved_version()',
    'public.sales_check_approval_write()',
    'public.sales_demo_facts_sha256(public.sales_demos)',
    'public.sales_demo_bundle_sha256(jsonb)',
    'public.sales_demo_image_shareable(public.sales_demo_images)',
    'public.sales_demo_image_previewable(public.sales_demo_images)',
    'public.sales_demo_version_rights_shareable(uuid)',
    'public.sales_demo_version_shareable(uuid)',
    'public.sales_demo_version_send_block(public.sales_demos)',
    'public.sales_demo_version_after_open_code(uuid)',
    'public.sales_demo_assert_no_open_send(uuid)',
    'public.sales_demo_version(public.sales_demos)',
    'public.sales_approval_is_current(public.sales_outreach_approvals, public.sales_outreaches, public.sales_demos)',
    'public.sales_send_guards(public.sales_outreaches, boolean, boolean)',
    'public.sales_resolve_demo_share(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. RLS: admin read only; writes only through the functions
-- ---------------------------------------------------------------------------

alter table public.sales_demo_images enable row level security;
alter table public.sales_demo_versions enable row level security;
alter table public.sales_demo_version_files enable row level security;
alter table public.sales_demo_quality_reviews enable row level security;

create policy sales_demo_images_admin_read on public.sales_demo_images
  for select to authenticated using ((select public.is_sales_admin()));
create policy sales_demo_versions_admin_read on public.sales_demo_versions
  for select to authenticated using ((select public.is_sales_admin()));
create policy sales_demo_version_files_admin_read on public.sales_demo_version_files
  for select to authenticated using ((select public.is_sales_admin()));
create policy sales_demo_quality_reviews_admin_read on public.sales_demo_quality_reviews
  for select to authenticated using ((select public.is_sales_admin()));

revoke all on public.sales_demo_images, public.sales_demo_versions, public.sales_demo_version_files,
  public.sales_demo_quality_reviews from public, anon, authenticated, service_role;
grant select on public.sales_demo_images to authenticated;
grant select on public.sales_demo_versions to authenticated;
grant select on public.sales_demo_version_files to authenticated;
grant select on public.sales_demo_quality_reviews to authenticated;
-- The server (service role) reads, inserts and updates like every sales_*
-- table (scripts/staging/lib.mjs REQUIRED_CHECKS); the triggers above still
-- refuse any approval, review or approved-version write without a sales admin
-- identity, and any change to a version's content, files or hashes. Rows of
-- these four tables are never deleted (review round 1 L4): no DELETE and no
-- TRUNCATE for any API role (NO_DELETE_TABLES in scripts/staging/lib.mjs).
grant select, insert, update on public.sales_demo_images to service_role;
grant select, insert, update on public.sales_demo_versions to service_role;
grant select, insert, update on public.sales_demo_version_files to service_role;
grant select, insert, update on public.sales_demo_quality_reviews to service_role;

-- ---------------------------------------------------------------------------
-- 6. Worker path: insert an unapproved draft version (service_role only)
-- ---------------------------------------------------------------------------

-- Called by the server's upload route (DEV-196d) after its own checks
-- (spec §7.1: re-hash, HTML/CSS rules, fonts, image heads, rights). It can
-- only ever create a NEW version in 'draft' (unapproved): it cannot approve,
-- review, withdraw, revoke, share or touch a send approval, and it never
-- replaces the approved version or a version pinned by a sent approval.
-- Re-checked here: the shop may be worked on; the manifest's shape; the
-- bundle hash (recomputed); the validator verdict; lineage within the demo;
-- every photo is a declared image of THIS shop whose rights the admin preview
-- may show. The facts hash and the Storage prefix are decided here.
-- Idempotent per generation job: the same job and bundle replays; the same
-- job with another bundle or demo is refused.
create function public.sales_ingest_demo_version(
  p_demo_id uuid,
  p_generation_job_id text,
  p_parent_version_id uuid,
  p_origin text,
  p_worker_commit text,
  p_direction_sha256 text,
  p_bundle_sha256 text,
  p_manifest jsonb,
  p_images jsonb,
  p_validator_result jsonb,
  p_worker_checks jsonb,
  p_structure_descriptor jsonb,
  p_rights_summary jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  d public.sales_demos;
  p public.sales_prospects;
  v public.sales_demo_versions;
  img public.sales_demo_images;
  f jsonb;
  e jsonb;
  v_id uuid := gen_random_uuid();
  v_no integer;
  v_total bigint;
  v_constraint text;
begin
  if p_origin is null or p_origin not in ('worker_autogen', 'design_bridge', 'manual_import')
     or (p_origin = 'worker_autogen' and p_generation_job_id is null)
     or (p_generation_job_id is not null and p_generation_job_id !~ '^[a-z0-9][a-z0-9-]{2,62}$')
     or (p_worker_commit is not null and p_worker_commit !~ '^[0-9a-f]{7,40}$')
     or (p_direction_sha256 is not null and p_direction_sha256 !~ '^[0-9a-f]{64}$')
     or p_bundle_sha256 is null or p_bundle_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_version' using errcode = '22023';
  end if;

  select * into d from public.sales_demos where id = p_demo_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into p from public.sales_prospects where id = d.prospect_id;

  -- §10.2: the same job replays (same demo and bundle) or is refused.
  if p_generation_job_id is not null then
    select * into v from public.sales_demo_versions where generation_job_id = p_generation_job_id;
    if found then
      if v.demo_id = d.id and v.bundle_sha256 = p_bundle_sha256 then
        return jsonb_build_object('version_id', v.id, 'version_no', v.version_no, 'status', v.status, 'replayed', true);
      end if;
      raise exception 'job_conflict' using errcode = 'P0001';
    end if;
  end if;

  -- §10.1: no new work for a disabled demo, a DNC / excluded shop or a shop
  -- already contacted.
  if d.disabled_at is not null then
    raise exception 'demo_disabled' using errcode = 'P0001';
  end if;
  if p.do_not_contact then
    raise exception 'do_not_contact' using errcode = 'P0001';
  end if;
  if public.sales_prospect_excluded(p.id) then
    raise exception 'excluded' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.sales_outreaches o where o.prospect_id = p.id and o.kind = 'initial' and o.status <> 'drafted') then
    raise exception 'already_sent' using errcode = 'P0001';
  end if;

  -- The manifest (the version trigger checks the same for every writer).
  if not public.sales_demo_manifest_valid(p_manifest) then
    raise exception 'invalid_manifest' using errcode = '22023';
  end if;
  select sum((x->>'bytes')::bigint) into v_total from jsonb_array_elements(p_manifest->'files') x;
  if public.sales_demo_bundle_sha256(p_manifest) is distinct from p_bundle_sha256 then
    raise exception 'bundle_mismatch' using errcode = '22023';
  end if;
  -- §7.1: only a version the server's validator passed is recorded as a draft.
  if jsonb_typeof(p_validator_result) <> 'object' or p_validator_result->'ok' is distinct from 'true'::jsonb then
    raise exception 'validator_not_ok' using errcode = 'P0001';
  end if;

  if p_parent_version_id is not null
     and not exists (select 1 from public.sales_demo_versions where id = p_parent_version_id and demo_id = d.id) then
    raise exception 'parent_other_demo' using errcode = 'P0001';
  end if;

  -- Images: one declared record per photo file (no extra records), keyed by
  -- the file's sha256; an image recorded for another shop is refused.
  if p_images is null then
    p_images := '[]'::jsonb;
  end if;
  if jsonb_typeof(p_images) <> 'array' or jsonb_array_length(p_images) > 40 then
    raise exception 'invalid_image' using errcode = '22023';
  end if;
  for e in select x from jsonb_array_elements(p_images) x loop
    if jsonb_typeof(e) <> 'object'
       or exists (select 1 from jsonb_object_keys(e) k where k not in (
            'sha256', 'bytes', 'width', 'height', 'format', 'record_schema', 'source_kind', 'rights_status',
            'depicts_real_shop', 'depicts_identifiable_person', 'depicts_real_product', 'depicts_real_interior',
            'depicts_real_equipment', 'no_factual_impersonation_confirmed_at', 'no_factual_impersonation_confirmed_by',
            'allowed_uses', 'client_confirmed_at', 'client_confirmation_ref', 'rights_expiry', 'provenance'))
       or not exists (select 1 from jsonb_array_elements(p_manifest->'files') x
                      where x->>'role' = 'photo' and x->>'sha256' = e->>'sha256') then
      raise exception 'invalid_image' using errcode = '22023';
    end if;
  end loop;
  if (select count(distinct x->>'sha256') from jsonb_array_elements(p_images) x) <> jsonb_array_length(p_images) then
    raise exception 'invalid_image' using errcode = '22023';
  end if;

  for f in select x from jsonb_array_elements(p_manifest->'files') x where x->>'role' = 'photo' loop
    select * into img from public.sales_demo_images where sha256 = f->>'sha256';
    if found then
      if img.prospect_id <> p.id then
        raise exception 'image_other_shop' using errcode = 'P0001';
      end if;
    else
      select x into e from jsonb_array_elements(p_images) x where x->>'sha256' = f->>'sha256';
      if e is null then
        raise exception 'rights_unknown' using errcode = 'P0001';
      end if;
      -- §8.3.1: the owner's "no factual impersonation" confirmation must be a sales admin's.
      if e ? 'no_factual_impersonation_confirmed_by'
         and not exists (select 1 from public.sales_admins a where a.user_id::text = e->>'no_factual_impersonation_confirmed_by') then
        raise exception 'invalid_image' using errcode = '22023';
      end if;
      begin
        insert into public.sales_demo_images (
          prospect_id, sha256, bytes, width, height, format, record_schema, source_kind, rights_status,
          depicts_real_shop, depicts_identifiable_person, depicts_real_product, depicts_real_interior,
          depicts_real_equipment, no_factual_impersonation_confirmed_at, no_factual_impersonation_confirmed_by,
          allowed_uses, client_confirmed_at, client_confirmation_ref, rights_expiry, provenance)
        values (
          p.id, e->>'sha256', (e->>'bytes')::integer, (e->>'width')::integer, (e->>'height')::integer, e->>'format',
          e->>'record_schema', e->>'source_kind', coalesce(e->>'rights_status', 'unknown'),
          (e->>'depicts_real_shop')::boolean, (e->>'depicts_identifiable_person')::boolean,
          (e->>'depicts_real_product')::boolean, (e->>'depicts_real_interior')::boolean,
          (e->>'depicts_real_equipment')::boolean, (e->>'no_factual_impersonation_confirmed_at')::timestamptz,
          (e->>'no_factual_impersonation_confirmed_by')::uuid, e->'allowed_uses',
          (e->>'client_confirmed_at')::timestamptz, e->>'client_confirmation_ref', (e->>'rights_expiry')::date,
          e->'provenance')
        returning * into img;
      exception
        when check_violation or not_null_violation or invalid_text_representation or invalid_datetime_format
             or datetime_field_overflow or numeric_value_out_of_range then
          raise exception 'invalid_image' using errcode = '22023';
      end;
    end if;
    -- §8.1: unknown / expired / revoked rights reject the whole version.
    if not public.sales_demo_image_previewable(img) then
      raise exception 'rights_unknown' using errcode = 'P0001';
    end if;
  end loop;

  select coalesce(max(version_no), 0) + 1 into v_no from public.sales_demo_versions where demo_id = d.id;
  begin
    insert into public.sales_demo_versions (
      id, demo_id, version_no, parent_version_id, origin, generation_job_id, worker_commit, facts_sha256,
      direction_sha256, bundle_sha256, manifest, storage_prefix, total_bytes, status, validator_result,
      worker_checks, structure_descriptor, rights_summary, share_eligible, expires_at, validated_at)
    values (
      v_id, d.id, v_no, p_parent_version_id, p_origin, p_generation_job_id, p_worker_commit,
      public.sales_demo_facts_sha256(d), p_direction_sha256, p_bundle_sha256, p_manifest,
      'v1/' || d.id::text || '/' || v_id::text || '/', v_total::integer, 'draft', p_validator_result,
      p_worker_checks, p_structure_descriptor, p_rights_summary, false, now() + interval '60 days', now());

    insert into public.sales_demo_version_files (version_id, path, role, sha256, bytes, content_type, width, height, image_id)
      select v_id, x->>'name', x->>'role', x->>'sha256', (x->>'bytes')::integer, x->>'content_type',
             (x->>'width')::integer, (x->>'height')::integer,
             (select i.id from public.sales_demo_images i where i.sha256 = x->>'sha256' and x->>'role' = 'photo')
      from jsonb_array_elements(p_manifest->'files') x;
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'sales_demo_versions_bundle_key' then
        raise exception 'duplicate_bundle' using errcode = '23505';
      end if;
      raise exception 'job_conflict' using errcode = '23505';
    when check_violation or not_null_violation then
      raise exception 'invalid_manifest' using errcode = '22023';
  end;
  return jsonb_build_object('version_id', v_id, 'version_no', v_no, 'status', 'draft', 'replayed', false);
end;
$$;

revoke all on function public.sales_ingest_demo_version(uuid, text, uuid, text, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.sales_ingest_demo_version(uuid, text, uuid, text, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- 7. Admin functions (SECURITY DEFINER, admin checked first)
-- ---------------------------------------------------------------------------

-- 品質を承認 / 差し戻し / 不採用 (§7.2, §4.4). The quality approval only: it
-- never creates, changes or approves a SEND. p_viewed_renders is what the
-- admin screen showed (render name → sha256) and must be this version's
-- render files; an approval needs both PC1440 and SP390 (and the tablet
-- render if the version has one), every checklist item 'ok', the content the
-- admin saw (p_bundle_sha256), the current facts and previewable rights.
-- Approving moves sales_demos.approved_version_id (the §9.3 hash), so it
-- answers approval_open while a send screen is open (§9.5).
create function public.sales_review_demo_version(
  p_version_id uuid, p_decision text, p_checklist jsonb, p_viewed_renders jsonb, p_bundle_sha256 text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.sales_demo_versions;
  d public.sales_demos;
  r public.sales_demo_quality_reviews;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_renders jsonb;
begin
  perform public.sales_assert_admin();
  if p_decision is null or p_decision not in ('approved', 'rejected', 'changes_requested') then
    raise exception 'invalid_decision' using errcode = '22023';
  end if;
  -- Refused before any insert, so a failing note never reaches the log.
  if not public.sales_demo_note_valid(v_note) then
    raise exception 'invalid_note' using errcode = '22023';
  end if;
  if not public.sales_demo_checklist_valid(p_checklist) then
    raise exception 'invalid_checklist' using errcode = '22023';
  end if;
  if p_viewed_renders is null or not public.sales_demo_renders_valid(p_viewed_renders) then
    raise exception 'invalid_renders' using errcode = '22023';
  end if;
  select * into v from public.sales_demo_versions where id = p_version_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into d from public.sales_demos where id = v.demo_id for update;
  select * into v from public.sales_demo_versions where id = p_version_id for update;
  if p_bundle_sha256 is distinct from v.bundle_sha256 then
    raise exception 'stale_version' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_object_agg(substring(fl.path from '^renders/(.*)\.webp$'), fl.sha256), '{}'::jsonb)
    into v_renders
    from public.sales_demo_version_files fl where fl.version_id = v.id and fl.role = 'render';
  -- Every render the screen claims to have shown is this version's file.
  if exists (select 1 from jsonb_each_text(p_viewed_renders) x where v_renders->>x.key is distinct from x.value) then
    raise exception 'render_not_viewed' using errcode = 'P0001';
  end if;

  if p_decision = 'approved' then
    if not (v_renders ? 'desktop_1440' and v_renders ? 'mobile_390') then
      raise exception 'render_missing' using errcode = 'P0001';
    end if;
    -- …and every render the version has was shown.
    if exists (select 1 from jsonb_each_text(v_renders) x where p_viewed_renders->>x.key is distinct from x.value) then
      raise exception 'render_not_viewed' using errcode = 'P0001';
    end if;
    if jsonb_path_exists(p_checklist, '$.* ? (@ == "ng")') then
      raise exception 'checklist_has_ng' using errcode = 'P0001';
    end if;
    select * into r from public.sales_demo_quality_reviews
      where version_id = v.id and decision = 'approved' and state = 'active';
    if found and v.status = 'approved' then
      return jsonb_build_object('review_id', r.id, 'version_id', v.id, 'status', v.status, 'replayed', true);
    end if;
  end if;

  if v.revoked_at is not null or v.status not in ('draft', 'superseded') or v.expires_at <= now() then
    raise exception 'version_not_reviewable' using errcode = 'P0001';
  end if;
  if d.disabled_at is not null then
    raise exception 'demo_unavailable' using errcode = 'P0001';
  end if;
  if v.facts_sha256 <> public.sales_demo_facts_sha256(d) then
    raise exception 'demo_facts_changed' using errcode = 'P0001';
  end if;
  if v.validator_result->'ok' is distinct from 'true'::jsonb then
    raise exception 'validator_not_ok' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.sales_demo_version_files fl
             left join public.sales_demo_images i on i.id = fl.image_id
             where fl.version_id = v.id and fl.role = 'photo'
               and (i.id is null or not public.sales_demo_image_previewable(i))) then
    raise exception 'rights_not_previewable' using errcode = 'P0001';
  end if;

  if p_decision = 'approved' then
    perform public.sales_demo_assert_no_open_send(d.id);
    update public.sales_demo_quality_reviews
      set state = 'invalidated', invalidated_at = now(), invalidated_reason = 'superseded_by_newer_approval'
      where demo_id = d.id and decision = 'approved' and state = 'active';
    update public.sales_demo_versions set status = 'superseded' where demo_id = d.id and status = 'approved';
  end if;

  insert into public.sales_demo_quality_reviews (
    version_id, demo_id, decision, checklist, viewed_renders_sha256, bundle_sha256, facts_sha256,
    rights_summary_sha256, note, reviewed_by)
  values (
    v.id, d.id, p_decision, p_checklist, p_viewed_renders, v.bundle_sha256, v.facts_sha256,
    case when v.rights_summary is null then null else encode(sha256(convert_to(v.rights_summary::text, 'UTF8')), 'hex') end,
    v_note, auth.uid())
  returning * into r;

  if p_decision = 'approved' then
    update public.sales_demo_versions set status = 'approved' where id = v.id;
    update public.sales_demos set approved_version_id = v.id where id = d.id;
  end if;
  return jsonb_build_object('review_id', r.id, 'version_id', v.id,
                            'status', case when p_decision = 'approved' then 'approved' else v.status end, 'replayed', false);
end;
$$;

-- 品質承認を取り下げる (§4.6): the version goes back to draft and the demo has
-- no approved version (legacy hash again). approval_open while a send screen
-- is open (§9.5). A send already confirmed keeps its pinned version.
create function public.sales_withdraw_demo_quality_review(p_review_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.sales_demo_quality_reviews;
begin
  perform public.sales_assert_admin();
  select * into r from public.sales_demo_quality_reviews where id = p_review_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform 1 from public.sales_demos where id = r.demo_id for update;
  select * into r from public.sales_demo_quality_reviews where id = p_review_id for update;
  if r.decision <> 'approved' then
    raise exception 'not_an_approval' using errcode = 'P0001';
  end if;
  if r.state = 'withdrawn' then
    return jsonb_build_object('review_id', r.id, 'state', r.state, 'replayed', true);
  end if;
  if r.state <> 'active' then
    raise exception 'review_not_active' using errcode = 'P0001';
  end if;
  perform public.sales_demo_assert_no_open_send(r.demo_id);
  update public.sales_demo_quality_reviews
    set state = 'withdrawn', withdrawn_at = now(), withdrawn_by = auth.uid()
    where id = r.id;
  update public.sales_demos set approved_version_id = null where id = r.demo_id and approved_version_id = r.version_id;
  update public.sales_demo_versions set status = 'draft' where id = r.version_id and status = 'approved';
  return jsonb_build_object('review_id', r.id, 'state', 'withdrawn', 'replayed', false);
end;
$$;

-- 版を取り消す (§6.6, §9.3): final. Its approval is invalidated, the demo no
-- longer points at it, and a share URL that pinned it shows nothing (never
-- another version or the React demo: sales_resolve_demo_share). approval_open
-- while a send screen is open (§9.5; settle it first).
create function public.sales_revoke_demo_version(p_version_id uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.sales_demo_versions;
begin
  perform public.sales_assert_admin();
  if p_code is null or p_code !~ '^[A-Z][A-Z0-9_]{2,47}$' then
    raise exception 'invalid_code' using errcode = '22023';
  end if;
  select * into v from public.sales_demo_versions where id = p_version_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform 1 from public.sales_demos where id = v.demo_id for update;
  select * into v from public.sales_demo_versions where id = p_version_id for update;
  if v.status = 'revoked' then
    return jsonb_build_object('version_id', v.id, 'status', v.status, 'replayed', true);
  end if;
  if v.status not in ('draft', 'approved', 'superseded') then
    raise exception 'version_not_revocable' using errcode = 'P0001';
  end if;
  perform public.sales_demo_assert_no_open_send(v.demo_id);
  update public.sales_demo_quality_reviews
    set state = 'invalidated', invalidated_at = now(), invalidated_reason = 'version_revoked'
    where version_id = v.id and state = 'active';
  update public.sales_demos set approved_version_id = null where id = v.demo_id and approved_version_id = v.id;
  update public.sales_demo_versions
    set status = 'revoked', revoked_at = now(), revoked_by = auth.uid(), revoke_code = p_code
    where id = v.id;
  return jsonb_build_object('version_id', v.id, 'status', 'revoked', 'replayed', false);
end;
$$;

-- 画像の権利を取り消す (§6.6, §9.4): final. Every version using it loses its
-- quality approval (rights_changed) and goes back to draft; no demo points at
-- such a version any more. approval_open while any affected shop has a send
-- screen open (§9.5).
create function public.sales_revoke_demo_image(p_image_id uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.sales_demo_images;
  v_demo uuid;
begin
  perform public.sales_assert_admin();
  if p_code is null or p_code !~ '^[A-Z][A-Z0-9_]{2,47}$' then
    raise exception 'invalid_code' using errcode = '22023';
  end if;
  select * into i from public.sales_demo_images where id = p_image_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  for v_demo in
    select distinct v.demo_id from public.sales_demo_version_files fl
    join public.sales_demo_versions v on v.id = fl.version_id
    where fl.image_id = i.id order by v.demo_id
  loop
    perform 1 from public.sales_demos where id = v_demo for update;
    perform public.sales_demo_assert_no_open_send(v_demo);
  end loop;
  select * into i from public.sales_demo_images where id = p_image_id for update;
  if i.revoked_at is not null then
    return jsonb_build_object('image_id', i.id, 'rights_status', i.rights_status, 'replayed', true);
  end if;
  update public.sales_demo_images
    set rights_status = 'revoked', revoked_at = now(), revoked_by = auth.uid(), revoke_code = p_code
    where id = i.id;
  update public.sales_demo_quality_reviews r
    set state = 'invalidated', invalidated_at = now(), invalidated_reason = 'rights_changed'
    where r.state = 'active'
      and r.version_id in (select fl.version_id from public.sales_demo_version_files fl where fl.image_id = i.id);
  update public.sales_demos d set approved_version_id = null
    where d.approved_version_id in (select fl.version_id from public.sales_demo_version_files fl where fl.image_id = i.id);
  update public.sales_demo_versions v set status = 'draft'
    where v.status = 'approved'
      and v.id in (select fl.version_id from public.sales_demo_version_files fl where fl.image_id = i.id);
  return jsonb_build_object('image_id', i.id, 'rights_status', 'revoked', 'replayed', false);
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.sales_review_demo_version(uuid, text, jsonb, jsonb, text, text)',
    'public.sales_withdraw_demo_quality_review(uuid)',
    'public.sales_revoke_demo_version(uuid, text)',
    'public.sales_revoke_demo_image(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. DEV-195 send functions: the version pin (create or replace keeps grants)
-- ---------------------------------------------------------------------------

-- この内容で送信を承認: unchanged from 20261107000000 except that, when the
-- demo has a quality-approved version, the approval pins its id, bundle hash
-- and active quality review (sales_send_guards has re-derived all of them).
-- A demo without an approved version is approved exactly as before (§9.2,
-- owner decision 2026-11-10: the React demo, with the human approval).
create or replace function public.sales_approve_outreach(p_outreach_id uuid, p_draft_version integer, p_subject text, p_body text, p_design_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.sales_outreaches;
  d public.sales_demos;
  a public.sales_outreach_approvals;
  v_recipient text;
  v_demo_version text;
  v_snapshot text;
  v_bundle text;
  v_review uuid;
  v_share boolean;
begin
  perform public.sales_assert_admin();
  o := public.sales_lock_initial(p_outreach_id);
  if o.status <> 'drafted' then
    raise exception 'invalid_transition' using errcode = 'P0001';
  end if;
  if o.draft_version is distinct from p_draft_version then
    raise exception 'stale_snapshot' using errcode = 'P0001';
  end if;
  d := public.sales_send_guards(o, p_design_enabled, false);

  if (o.channel = 'email' and p_subject is distinct from o.subject)
     or (o.channel = 'instagram' and p_subject is not null) then
    raise exception 'stale_snapshot' using errcode = 'P0001';
  end if;
  if p_body is null or char_length(p_body) > 8000
     or strpos(p_body, o.body) = 0
     or strpos(p_body, '/demo/' || d.public_token) = 0
     or strpos(p_body, '貴店の公式サイトではありません。') = 0
     or strpos(p_body, '以後ご連絡いたしません。') = 0 then
    raise exception 'invalid_snapshot' using errcode = '22023';
  end if;

  if d.approved_version_id is not null then
    select v.bundle_sha256 into v_bundle from public.sales_demo_versions v where v.id = d.approved_version_id;
    select r.id into v_review from public.sales_demo_quality_reviews r
      where r.version_id = d.approved_version_id and r.decision = 'approved' and r.state = 'active';
    v_share := public.sales_demo_version_shareable(d.approved_version_id);
  end if;

  v_recipient := public.sales_outreach_recipient(o.prospect_id, o.channel);
  v_demo_version := public.sales_demo_version(d);
  v_snapshot := encode(sha256(convert_to(jsonb_build_array(
    o.id, o.channel, v_recipient, p_subject, p_body, o.draft_version, v_demo_version)::text, 'UTF8')), 'hex');

  select * into a from public.sales_outreach_approvals
    where outreach_id = o.id and state in ('approved', 'send_opened') for update;
  if found then
    if a.snapshot_sha256 = v_snapshot then
      return jsonb_build_object('approval_id', a.id, 'state', a.state, 'replayed', true);
    end if;
    if a.state = 'send_opened' then
      raise exception 'approval_open' using errcode = 'P0001';
    end if;
    update public.sales_outreach_approvals
      set state = 'superseded', superseded_at = now(), superseded_reason = 'reapproved'
      where id = a.id;
  end if;

  insert into public.sales_outreach_approvals (
    outreach_id, prospect_id, mode, channel, recipient, subject, body, draft_version,
    demo_token, demo_design_status, demo_design_updated_at, demo_version, snapshot_sha256, approved_by,
    demo_version_id, demo_bundle_sha256, demo_quality_review_id, demo_share_eligible)
  values (
    o.id, o.prospect_id, 'manual', o.channel, v_recipient, p_subject, p_body, o.draft_version,
    d.public_token, d.design_status, d.design_updated_at, v_demo_version, v_snapshot, auth.uid(),
    d.approved_version_id, v_bundle, v_review, v_share)
  returning * into a;
  return jsonb_build_object('approval_id', a.id, 'state', a.state, 'replayed', false);
end;
$$;

-- 手動で送信済み: unchanged from 20261110000000 (DEV-197) except §9.5 rule 2:
-- when the approval pinned a version that can no longer be shown (expired,
-- rights expired, not shareable), the send is still recorded, with
-- demo_unavailable_after_open (the share URL shows nothing for it); and a
-- pinned version is kept for the admin about 30 days after the share period.
create or replace function public.sales_mark_sent(p_outreach_id uuid, p_approval_id uuid, p_design_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.sales_outreaches;
  a public.sales_outreach_approvals;
  d public.sales_demos;
  sent timestamptz := now();
  v_block text;
  v_stale boolean;
  v_unavailable text;
begin
  perform public.sales_assert_admin();
  select * into o from public.sales_outreaches where id = p_outreach_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into a from public.sales_outreach_approvals where id = p_approval_id and outreach_id = o.id for update;
  if not found then
    raise exception 'approval_required' using errcode = 'P0001';
  end if;
  if o.status = 'sent' and a.state = 'sent' then
    return jsonb_build_object('outreach_id', o.id, 'status', o.status, 'sent_at', o.sent_at, 'approval_id', a.id,
                              'blocked_after_open', o.blocked_after_open, 'stale_at_send', a.stale_at_send,
                              'demo_unavailable_after_open', a.demo_unavailable_after_open, 'replayed', true);
  end if;
  if o.kind <> 'initial' or o.status <> 'drafted' then
    raise exception 'invalid_transition' using errcode = 'P0001';
  end if;
  if a.state = 'approved' then
    raise exception 'not_opened' using errcode = 'P0001';
  end if;
  if a.state <> 'send_opened' then
    raise exception 'stale_snapshot' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock_shared(hashtext('second_root_sales_exclusions'));
  perform 1 from public.sales_prospects where id = o.prospect_id for update;
  v_block := public.sales_outreach_block_reason(o.prospect_id);

  if v_block is null then
    d := public.sales_send_guards(o, p_design_enabled, true);
    if not coalesce(public.sales_approval_is_current(a, o, d), false) then
      raise exception 'stale_snapshot' using errcode = 'P0001';
    end if;
    v_stale := false;
  else
    if a.draft_version <> o.draft_version or a.channel <> o.channel then
      raise exception 'stale_snapshot' using errcode = 'P0001';
    end if;
    perform public.sales_assert_recorded_channel(o.prospect_id, o.kind, o.channel, a.recipient);
    select * into d from public.sales_demos where prospect_id = o.prospect_id for update;
    if not found or (d.disabled_at is not null and v_block is distinct from 'do_not_contact') then
      raise exception 'demo_unavailable' using errcode = 'P0001';
    end if;
    if coalesce(p_design_enabled, false) and d.design_status in ('pending', 'processing') then
      raise exception 'design_pending' using errcode = 'P0001';
    end if;
    v_stale := not coalesce(public.sales_approval_is_current(a, o, d), false);
  end if;
  -- DEV-196c (§9.5 rule 2): recorded, never refused.
  v_unavailable := public.sales_demo_version_after_open_code(a.demo_version_id);

  update public.sales_outreach_approvals
    set state = 'sent', sent_at = sent, sent_by = auth.uid(), blocked_after_open = v_block, stale_at_send = v_stale,
        demo_unavailable_after_open = v_unavailable
    where id = a.id;
  update public.sales_outreaches set status = 'sent', sent_at = sent, blocked_after_open = v_block where id = o.id;
  update public.sales_demos
    set expires_at = sent + interval '30 days'
    where prospect_id = o.prospect_id and expires_at is null;
  if a.demo_version_id is not null then
    update public.sales_demo_versions v
      set expires_at = greatest(v.expires_at, coalesce(dm.expires_at, sent + interval '30 days') + interval '30 days')
      from public.sales_demos dm
      where v.id = a.demo_version_id and dm.prospect_id = o.prospect_id and v.status not in ('revoked', 'rejected', 'expired');
  end if;

  return jsonb_build_object('outreach_id', o.id, 'status', 'sent', 'sent_at', sent, 'approval_id', a.id,
                            'blocked_after_open', v_block, 'stale_at_send', v_stale,
                            'demo_unavailable_after_open', v_unavailable, 'replayed', false);
end;
$$;

revoke all on function public.sales_approve_outreach(uuid, integer, text, text, boolean) from public, anon;
grant execute on function public.sales_approve_outreach(uuid, integer, text, text, boolean) to authenticated;
revoke all on function public.sales_mark_sent(uuid, uuid, boolean) from public, anon;
grant execute on function public.sales_mark_sent(uuid, uuid, boolean) to authenticated;
