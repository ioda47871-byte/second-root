-- Second Root Sales Agent — the hosted facts store and the send-time
-- re-compare of the facts (DEV-263f, Issue #263; runbook B-2. Code, tests and
-- the local DB approved. Staging / Production need their own approval — this
-- migration is applied to the local stack only).
--
-- Until now the only facts path was LOCAL: a facts pack committed to the
-- repository (import-local.ts --trusted-facts). A shop's trusted facts pack is
-- now kept in the database:
--
--   1. sales_demo_facts_packs: append-only. The exact facts pack bytes, their
--      sha256 (facts_sha256, the hash every copy review names) and a canonical
--      content hash (facts_jsonb_sha256: the jsonb normal form, so key order and
--      whitespace do not matter). Tied to the prospect and its demo: the demo's
--      sales_demos.content must name exactly these bytes
--      (content.facts_pack_sha256) and this shop (content.facts_pack).
--      The newest row of a prospect is its CURRENT facts pack.
--   2. Written only by the owner: sales_register_facts_pack (a signed-in sales
--      admin, auth.uid()) or sales_register_facts_pack_as (service role only,
--      for the registration / import CLI, with an explicit admin identity that
--      must be in sales_admins). Both are SECURITY DEFINER; a direct insert by
--      any API role (anon, authenticated, service_role) is refused by the
--      trigger, so neither the generator nor the package importer can write a
--      row without naming an admin. Never updated or deleted.
--   3. The facts-path evidence (sales_demo_copy_facts_checks) now references
--      the store row it was made from (facts_pack_id): a check is recorded only
--      when the prospect's current stored facts pack is the review's facts pack
--      and the demo's content names it. Rows made before this migration have no
--      facts_pack_id and no longer count.
--   4. The send-time re-compare (sales_copy_send_block, used by
--      sales_demo_version_send_block → sales_send_guards at approval and when
--      the send screen is opened): the review's facts pack must still be the
--      prospect's current stored facts pack, that row must be of this demo, and
--      the demo's content must still name it. A newer facts row with other bytes
--      or any mismatch refuses with demo_copy_facts_changed.
--
-- New function names do not start with sales_demo_ (DEV-196c's audit test
-- counts those).
--
-- Rollback: .ai/reviews/DEV-263f.md (restores the 20261113000000 definitions
-- of sales_check_copy_facts_check_write and sales_copy_send_block, drops the
-- column, the functions and the table). Forward-only otherwise. Not applied to
-- any hosted project by this change.

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------

create table public.sales_demo_facts_packs (
  id uuid primary key default gen_random_uuid(),
  -- the order the store received the packs: the newest row of a prospect is its current facts pack
  seq bigint generated always as identity unique,
  prospect_id uuid not null references public.sales_prospects (id) on delete restrict,
  demo_id uuid not null references public.sales_demos (id) on delete restrict,
  -- derived from facts_pack_text by the trigger
  shop_id text not null check (shop_id ~ '^[a-z0-9][a-z0-9_-]{1,40}$'),
  facts_sha256 text not null check (facts_sha256 ~ '^[0-9a-f]{64}$'),
  facts_jsonb_sha256 text not null check (facts_jsonb_sha256 ~ '^[0-9a-f]{64}$'),
  -- the exact bytes (UTF-8) the owner registered
  facts_pack_text text not null check (octet_length(facts_pack_text) between 2 and 1048576),
  recorded_by uuid not null references public.sales_admins (user_id) on delete restrict,
  recorded_via text not null check (recorded_via in ('admin_session', 'operator_cli')),
  recorded_at timestamptz not null default now()
);
create index sales_demo_facts_packs_prospect_idx on public.sales_demo_facts_packs (prospect_id, seq);

-- Insert-only, never by an API role directly (only the two SECURITY DEFINER
-- functions below, which run as the owner). Every column is re-derived.
create function public.sales_check_facts_pack_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_pack jsonb;
  d public.sales_demos;
begin
  if tg_op <> 'INSERT' then
    raise exception 'facts_pack_immutable' using errcode = 'check_violation';
  end if;
  if current_user in ('anon', 'authenticated', 'service_role') then
    raise exception 'facts_pack_owner_path_only' using errcode = 'insufficient_privilege';
  end if;
  begin
    v_pack := new.facts_pack_text::jsonb;
  exception when others then
    raise exception 'invalid_facts_pack' using errcode = '22023';
  end;
  if jsonb_typeof(v_pack) <> 'object' or v_pack->>'schema' is distinct from 'shop_facts_pack_v1'
     or jsonb_typeof(v_pack->'shop_id') <> 'string' or jsonb_typeof(v_pack->'facts') <> 'array'
     or jsonb_array_length(v_pack->'facts') = 0 then
    raise exception 'invalid_facts_pack' using errcode = '22023';
  end if;
  select * into d from public.sales_demos where id = new.demo_id;
  if not found or d.prospect_id <> new.prospect_id then
    raise exception 'facts_pack_demo_mismatch' using errcode = 'check_violation';
  end if;
  new.shop_id := v_pack->>'shop_id';
  new.facts_sha256 := encode(sha256(convert_to(new.facts_pack_text, 'UTF8')), 'hex');
  new.facts_jsonb_sha256 := encode(sha256(convert_to(v_pack::text, 'UTF8')), 'hex');
  -- the demo row and the stored facts share one origin
  if d.content->>'facts_pack_sha256' is distinct from new.facts_sha256 or d.content->>'facts_pack' is distinct from new.shop_id then
    raise exception 'facts_pack_not_demo_content' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.sales_admins a where a.user_id = new.recorded_by) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  new.recorded_at := now();
  return new;
end;
$$;

create trigger sales_demo_facts_packs_write
  before insert or update or delete on public.sales_demo_facts_packs
  for each row execute function public.sales_check_facts_pack_write();

-- ---------------------------------------------------------------------------
-- 2. Registration (owner only)
-- ---------------------------------------------------------------------------

-- The shared body of both registration functions. Not callable by any API role.
-- The same bytes as the current row of the prospect (same demo) replay.
create function public.sales_insert_facts_pack(p_demo_id uuid, p_facts_pack text, p_admin_id uuid, p_via text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  d public.sales_demos;
  cur public.sales_demo_facts_packs;
  r public.sales_demo_facts_packs;
  v_sha text;
begin
  if p_demo_id is null or p_facts_pack is null or p_admin_id is null or octet_length(p_facts_pack) not between 2 and 1048576 then
    raise exception 'invalid_facts_pack' using errcode = '22023';
  end if;
  select * into d from public.sales_demos where id = p_demo_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtext('second_root_facts_packs:' || d.prospect_id::text));
  v_sha := encode(sha256(convert_to(p_facts_pack, 'UTF8')), 'hex');
  select * into cur from public.sales_demo_facts_packs where prospect_id = d.prospect_id order by seq desc limit 1;
  if cur.id is not null and cur.facts_sha256 = v_sha and cur.demo_id = d.id then
    return jsonb_build_object('facts_pack_id', cur.id, 'facts_sha256', cur.facts_sha256, 'shop_id', cur.shop_id, 'replayed', true);
  end if;
  insert into public.sales_demo_facts_packs (prospect_id, demo_id, shop_id, facts_sha256, facts_jsonb_sha256, facts_pack_text, recorded_by, recorded_via)
  -- placeholders: the trigger derives the shop and the hashes from the text
  values (d.prospect_id, d.id, 'xx', repeat('0', 64), repeat('0', 64), p_facts_pack, p_admin_id, p_via)
  returning * into r;
  return jsonb_build_object('facts_pack_id', r.id, 'facts_sha256', r.facts_sha256, 'shop_id', r.shop_id, 'replayed', false);
end;
$$;

-- 店舗の事実を登録する: the signed-in sales admin (the admin screen, under the
-- admin's own session). The admin is checked first.
create function public.sales_register_facts_pack(p_demo_id uuid, p_facts_pack text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.sales_assert_admin();
  return public.sales_insert_facts_pack(p_demo_id, p_facts_pack, (select auth.uid()), 'admin_session');
end;
$$;

-- The registration / import CLI (service role only), with an explicit admin
-- identity: the admin must be in sales_admins (the trigger checks again).
create function public.sales_register_facts_pack_as(p_demo_id uuid, p_facts_pack text, p_admin_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_admin_id is null or not exists (select 1 from public.sales_admins a where a.user_id = p_admin_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return public.sales_insert_facts_pack(p_demo_id, p_facts_pack, p_admin_id, 'operator_cli');
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The facts-path evidence references the store row
-- ---------------------------------------------------------------------------

alter table public.sales_demo_copy_facts_checks
  add column facts_pack_id uuid references public.sales_demo_facts_packs (id) on delete restrict;

-- 20261113000000, plus: the prospect's current stored facts pack must be the
-- review's facts pack, of the review's demo, and named by the demo's content.
create or replace function public.sales_check_copy_facts_check_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  q public.sales_demo_copy_reviews;
  d public.sales_demos;
  cur public.sales_demo_facts_packs;
begin
  if tg_op <> 'INSERT' then
    raise exception 'copy_facts_check_immutable' using errcode = 'check_violation';
  end if;
  select * into q from public.sales_demo_copy_reviews where id = new.review_id;
  if q.id is null or q.facts_sha256 <> new.facts_sha256 then
    raise exception 'copy_facts_check_mismatch' using errcode = 'check_violation';
  end if;
  select * into d from public.sales_demos where id = q.demo_id;
  select * into cur from public.sales_demo_facts_packs where prospect_id = q.prospect_id order by seq desc limit 1;
  if cur.id is null or cur.facts_sha256 <> q.facts_sha256 or cur.demo_id <> q.demo_id
     or d.content->>'facts_pack_sha256' is distinct from cur.facts_sha256 then
    raise exception 'copy_facts_not_in_store' using errcode = 'P0001';
  end if;
  new.facts_pack_id := cur.id;
  new.demo_facts_sha256 := public.sales_demo_facts_sha256(d);
  new.checked_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The send-time re-compare
-- ---------------------------------------------------------------------------

-- 20261113000000, plus: only evidence made from the store counts, and the
-- review's facts pack must still be the prospect's current stored facts pack,
-- of this demo, named by the demo's content (demo_copy_facts_changed).
create or replace function public.sales_copy_send_block(p_version_id uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  q public.sales_demo_copy_reviews;
  o public.sales_demo_copy_owner_decisions;
  cur public.sales_demo_facts_packs;
begin
  select r.* into q from public.sales_demo_version_copy_links l
    join public.sales_demo_copy_reviews r on r.id = l.review_id
    where l.version_id = p_version_id;
  if q.id is null then
    return 'demo_copy_review_missing';
  end if;
  if not exists (select 1 from public.sales_demo_copy_facts_checks c
                 where c.review_id = q.id and c.facts_sha256 = q.facts_sha256 and c.facts_pack_id is not null) then
    return 'demo_copy_facts_not_from_facts_path';
  end if;
  -- PR #262 M2: the facts-path check must have been made on the facts the version was generated from
  if not exists (select 1 from public.sales_demo_copy_facts_checks c join public.sales_demo_versions v on v.id = p_version_id
                 where c.review_id = q.id and c.facts_sha256 = q.facts_sha256 and c.facts_pack_id is not null
                   and c.demo_facts_sha256 = v.facts_sha256) then
    return 'demo_copy_facts_stale';
  end if;
  -- DEV-263f: the send-time re-compare with the facts store
  select * into cur from public.sales_demo_facts_packs where prospect_id = q.prospect_id order by seq desc limit 1;
  if cur.id is null or cur.facts_sha256 <> q.facts_sha256 or cur.demo_id <> q.demo_id
     or (select d.content->>'facts_pack_sha256' from public.sales_demos d where d.id = q.demo_id) is distinct from cur.facts_sha256 then
    return 'demo_copy_facts_changed';
  end if;
  -- the review's page must still be the version's page, and nothing may have followed it in its chain
  if (select f.sha256 from public.sales_demo_version_files f where f.version_id = p_version_id and f.path = 'page/index.html') is distinct from q.page_html_sha256
     or (select f.sha256 from public.sales_demo_version_files f where f.version_id = p_version_id and f.path = 'page/style.css') is distinct from q.page_css_sha256
     or exists (select 1 from public.sales_demo_copy_reviews n
                where n.prospect_id = q.prospect_id and n.lane = q.lane and n.facts_content_sha256 = q.facts_content_sha256 and n.round > q.round) then
    return 'demo_copy_review_stale';
  end if;
  if q.lane <> 'real_shop_proposal' or q.copy_verdict <> 'approve_candidate' then
    return 'demo_copy_review_not_passed';
  end if;
  if exists (select 1 from unnest(q.gate_blockers) b where b <> 'OWNER_APPROVAL_MISSING') then
    return 'demo_copy_send_blocked';
  end if;
  select * into o from public.sales_demo_copy_owner_decisions where review_id = q.id;
  if o.id is null or o.decision <> 'approve' or o.version_id <> p_version_id then
    return 'demo_copy_owner_confirmation_missing';
  end if;
  if row(o.review_sha256, o.facts_sha256, o.copy_sha256, o.page_html_sha256, o.page_css_sha256)
     is distinct from row(q.review_sha256, q.facts_sha256, q.copy_sha256, q.page_html_sha256, q.page_css_sha256) then
    return 'demo_copy_owner_confirmation_mismatch';
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. RLS and privileges
-- ---------------------------------------------------------------------------

alter table public.sales_demo_facts_packs enable row level security;
create policy sales_demo_facts_packs_admin_read on public.sales_demo_facts_packs
  for select to authenticated using ((select public.is_sales_admin()));

revoke all on public.sales_demo_facts_packs from public, anon, authenticated, service_role;
grant select on public.sales_demo_facts_packs to authenticated;
-- Like every sales_* table (scripts/staging/lib.mjs REQUIRED_CHECKS); the trigger refuses every direct write by an
-- API role and every update. Never deleted: no DELETE and no TRUNCATE for any API role.
grant select, insert, update on public.sales_demo_facts_packs to service_role;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.sales_check_facts_pack_write()',
    'public.sales_insert_facts_pack(uuid, text, uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', fn);
  end loop;
end;
$$;

revoke all on function public.sales_register_facts_pack(uuid, text) from public, anon, service_role;
grant execute on function public.sales_register_facts_pack(uuid, text) to authenticated;
revoke all on function public.sales_register_facts_pack_as(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.sales_register_facts_pack_as(uuid, text, uuid) to service_role;
