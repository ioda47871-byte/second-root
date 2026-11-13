-- Second Root Sales Agent — a real shop's demo content from its facts pack
-- (DEV-263h, Issue #263; runbook B-2. Code, tests and the local DB approved.
-- Staging / Production need their own approval — this migration is applied to
-- the local stack only).
--
-- Until now the only demo whose sales_demos.content was derived from a facts
-- pack was the fictional seed (環). The facts store (20261115000000) accepts a
-- pack only when the demo's content already names it, so a real shop's facts
-- could not be registered at all. This adds ONE owner-authorised step that,
-- for an existing prospect (created by the existing ingest, with every
-- prospect rule — Nagoya, category, contact sources, dedupe — unchanged):
--
--   1. derives the demo content from the pack bytes IN THE DATABASE
--      (sales_derive_facts_demo_content: the same mapping as
--      lib/demo-version-package/facts-content.ts demoContentWithFactsSha —
--      strict: an unmapped key, a key twice or a missing key is refused),
--   2. creates the prospect's demo (none yet) or replaces its content (a
--      legacy React demo, or older facts of the same shop) — only with the
--      owner's explicit confirmation, never for a demo that is disabled,
--      shared / sent, has a send approval in flight or a design job running,
--   3. registers the same bytes in the facts store (sales_insert_facts_pack:
--      append-only, replay on the same bytes),
--
-- all in one transaction. Refused for a prospect on the do-not-contact or the
-- exclusion list, for 輪 (SR-001, its photo packages are ai_demo_internal),
-- and when the same shop_id is already another prospect's.
--
-- Callers: sales_create_demo_from_facts (a signed-in sales admin, SECURITY
-- DEFINER, the admin screen) and, for local development only, the database
-- owner's own connection (scripts/sales/demo-version/onboard-local.ts, local
-- stack only) while the owner's local CLI switch
-- (sales_facts_registration_settings.operator_cli_enabled, default off) is on.
-- No service-role entry point is added. New function names do not start with
-- sales_demo_ (DEV-196c's audit test counts those).
--
-- Rollback (one transaction; registered facts and demo content written by
-- this path stay — removing them is a separate, human decision):
--   begin;
--   drop function public.sales_create_demo_from_facts(uuid, text, boolean);
--   drop function public.sales_onboard_facts_demo(uuid, text, boolean, uuid, text);
--   drop function public.sales_derive_facts_demo_content(text);
--   delete from supabase_migrations.schema_migrations where version = '20261116000000';
--   commit;

-- ---------------------------------------------------------------------------
-- 1. The derivation (pure)
-- ---------------------------------------------------------------------------

-- The demo content of a facts pack: every single key, the numbered services
-- (menu_items) and statements in number order, the shop id (facts_pack) and the
-- bytes' sha256 (facts_pack_sha256). Values are copied exactly; a value with
-- surrounding whitespace is refused (the server's FactsPack schema trims, so a
-- copied value could otherwise differ from the server's).
create function public.sales_derive_facts_demo_content(p_facts_pack text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_pack jsonb;
  f jsonb;
  v_key text;
  v_seen text[] := '{}';
  v_single jsonb := '{}'::jsonb;
  k text;
  c_single constant text[] := array['name', 'category', 'ward', 'address', 'hours', 'closed_days', 'access', 'phone', 'description', 'workshop'];
begin
  if p_facts_pack is null or octet_length(p_facts_pack) not between 2 and 1048576 then
    raise exception 'invalid_facts_pack' using errcode = '22023';
  end if;
  begin
    v_pack := p_facts_pack::jsonb;
  exception when others then
    raise exception 'invalid_facts_pack' using errcode = '22023';
  end;
  if jsonb_typeof(v_pack) is distinct from 'object'
     or exists (select 1 from jsonb_object_keys(v_pack) x where x not in ('schema', 'shop_id', 'facts'))
     or v_pack->>'schema' is distinct from 'shop_facts_pack_v1'
     or jsonb_typeof(v_pack->'shop_id') is distinct from 'string' or (v_pack->>'shop_id') !~ '^[a-z0-9][a-z0-9_-]{1,40}$'
     or jsonb_typeof(v_pack->'facts') is distinct from 'array' or coalesce(jsonb_array_length(v_pack->'facts'), 0) = 0 then
    raise exception 'invalid_facts_pack' using errcode = '22023';
  end if;
  for f in select e.value from jsonb_array_elements(v_pack->'facts') e loop
    if jsonb_typeof(f) is distinct from 'object'
       or exists (select 1 from jsonb_object_keys(f) x where x not in ('id', 'key', 'value', 'source_id'))
       or jsonb_typeof(f->'id') is distinct from 'string' or jsonb_typeof(f->'key') is distinct from 'string'
       or jsonb_typeof(f->'value') is distinct from 'string' or jsonb_typeof(f->'source_id') is distinct from 'string'
       or (f->>'key') !~ '^[a-z][a-z0-9_]{1,40}$' or char_length(f->>'value') not between 1 and 400 then
      raise exception 'invalid_facts_pack' using errcode = '22023';
    end if;
    if (f->>'value') ~ '^[\s   -     　﻿]'
       or (f->>'value') ~ '[\s   -     　﻿]$' then
      raise exception 'facts_pack_value_untrimmed' using errcode = '22023';
    end if;
    v_key := f->>'key';
    if v_key = any (v_seen) then
      raise exception 'facts_pack_duplicate_key' using errcode = '22023';
    end if;
    v_seen := v_seen || v_key;
    if v_key = any (c_single) then
      v_single := v_single || jsonb_build_object(v_key, f->>'value');
    elsif v_key !~ '^(service|statement)_[1-9][0-9]{0,2}$' then
      raise exception 'facts_pack_unmapped_key' using errcode = '22023';
    end if;
  end loop;
  foreach k in array c_single loop
    if not v_single ? k then
      raise exception 'facts_pack_incomplete' using errcode = '22023';
    end if;
  end loop;
  return v_single || jsonb_build_object(
    'menu_items', coalesce((select jsonb_agg(e.value->'value' order by substring(e.value->>'key' from 9)::integer)
                              from jsonb_array_elements(v_pack->'facts') e where e.value->>'key' ~ '^service_[1-9][0-9]{0,2}$'), '[]'::jsonb),
    'statements', coalesce((select jsonb_agg(e.value->'value' order by substring(e.value->>'key' from 11)::integer)
                              from jsonb_array_elements(v_pack->'facts') e where e.value->>'key' ~ '^statement_[1-9][0-9]{0,2}$'), '[]'::jsonb),
    'facts_pack', v_pack->>'shop_id',
    'facts_pack_sha256', encode(sha256(convert_to(p_facts_pack, 'UTF8')), 'hex'));
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The onboarding step (not callable by any API role)
-- ---------------------------------------------------------------------------

create function public.sales_onboard_facts_demo(p_prospect_id uuid, p_facts_pack text, p_replace_content boolean, p_admin_id uuid, p_via text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  p public.sales_prospects;
  d public.sales_demos;
  v_content jsonb;
  v_shop text;
  v_block text;
  v_created boolean := false;
  v_changed boolean := false;
  v_reg jsonb;
begin
  if p_prospect_id is null or p_facts_pack is null or p_admin_id is null or p_via is null
     or p_via not in ('admin_session', 'operator_cli') then
    raise exception 'invalid_facts_pack' using errcode = '22023';
  end if;
  if p_via = 'operator_cli' and not coalesce((select s.operator_cli_enabled from public.sales_facts_registration_settings s where s.id), false) then
    raise exception 'facts_cli_registration_disabled' using errcode = '42501';
  end if;
  if not exists (select 1 from public.sales_admins a where a.user_id = p_admin_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  -- the send guards' lock order: the exclusion list (shared), then the prospect row (a concurrent DNC waits)
  perform pg_advisory_xact_lock_shared(hashtext('second_root_sales_exclusions'));
  select * into p from public.sales_prospects where id = p_prospect_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_block := public.sales_outreach_block_reason(p.id);
  if v_block = 'do_not_contact' then
    raise exception 'facts_onboarding_do_not_contact' using errcode = 'P0001';
  elsif v_block is not null then
    raise exception 'facts_onboarding_excluded' using errcode = 'P0001';
  end if;
  v_content := public.sales_derive_facts_demo_content(p_facts_pack);
  v_shop := v_content->>'facts_pack';
  if v_shop = 'fictional-bicycle-repair-wa' then
    raise exception 'facts_onboarding_rin' using errcode = 'P0001';
  end if;
  -- one shop, one prospect (serialised per shop id)
  perform pg_advisory_xact_lock(hashtext('second_root_facts_shops:' || v_shop));
  if exists (select 1 from public.sales_demos o where o.prospect_id <> p.id and o.content->>'facts_pack' = v_shop)
     or exists (select 1 from public.sales_demo_facts_packs s where s.prospect_id <> p.id and s.shop_id = v_shop) then
    raise exception 'facts_onboarding_shop_other_prospect' using errcode = 'P0001';
  end if;
  select * into d from public.sales_demos where prospect_id = p.id for update;
  if not found then
    insert into public.sales_demos (prospect_id, public_token, template, content)
    values (p.id, public.sales_new_demo_token(), p.category || '_v1', v_content)
    returning * into d;
    v_created := true;
  elsif d.content is distinct from v_content then
    if d.content->>'facts_pack' = 'fictional-bicycle-repair-wa' then
      raise exception 'facts_onboarding_rin' using errcode = 'P0001';
    end if;
    if d.content ? 'facts_pack' and d.content->>'facts_pack' is distinct from v_shop then
      raise exception 'facts_onboarding_shop_changed' using errcode = 'P0001';
    end if;
    if d.disabled_at is not null then
      raise exception 'demo_unavailable' using errcode = 'P0001';
    end if;
    -- what a recipient may already see, or what an approval / open send screen hashed, is never rewritten
    if d.expires_at is not null or exists (select 1 from public.sales_outreach_approvals a
                                           where a.prospect_id = p.id and a.state in ('approved', 'send_opened', 'sent')) then
      raise exception 'facts_onboarding_demo_in_use' using errcode = 'P0001';
    end if;
    if d.design_status in ('pending', 'processing') then
      raise exception 'design_pending' using errcode = 'P0001';
    end if;
    if not coalesce(p_replace_content, false) then
      raise exception 'facts_onboarding_replace_unconfirmed' using errcode = 'P0001';
    end if;
    update public.sales_demos set content = v_content where id = d.id returning * into d;
    v_changed := true;
  end if;
  v_reg := public.sales_insert_facts_pack(d.id, p_facts_pack, p_admin_id, p_via);
  return jsonb_build_object('prospect_id', p.id, 'demo_id', d.id, 'demo_created', v_created, 'content_changed', v_changed,
    'facts_pack_id', v_reg->'facts_pack_id', 'facts_sha256', v_reg->'facts_sha256', 'shop_id', v_reg->'shop_id', 'replayed', v_reg->'replayed');
end;
$$;

-- デモの事実を facts pack から作る: the signed-in sales admin (the admin screen, under the admin's own session). The admin
-- is checked first.
create function public.sales_create_demo_from_facts(p_prospect_id uuid, p_facts_pack text, p_replace_content boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.sales_assert_admin();
  return public.sales_onboard_facts_demo(p_prospect_id, p_facts_pack, p_replace_content, (select auth.uid()), 'admin_session');
end;
$$;

revoke all on function public.sales_derive_facts_demo_content(text) from public, anon, authenticated, service_role;
revoke all on function public.sales_onboard_facts_demo(uuid, text, boolean, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.sales_create_demo_from_facts(uuid, text, boolean) from public, anon, service_role;
grant execute on function public.sales_create_demo_from_facts(uuid, text, boolean) to authenticated;
