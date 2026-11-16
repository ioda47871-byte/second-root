-- Issue #275 / DEV-263k: an unverified optional fact is absent, not fabricated.
-- Hosted Staging / Production: DO NOT APPLY without the owner's separate runbook approval.
-- Local migrations already include the original 20261116000000 implementation.
-- For compatibility, this replacement changes only which keys are required;
-- it preserves the hash of the original bytes, strict validation, duplicates rejection,
-- mapping, privileges, and the existing security-definer onboarding path.
-- Required: name, category, address, description. Optional: ward, hours,
-- closed_days, access, phone, workshop. All keys remain strictly allowlisted.
-- Rollback (owner approval required on any hosted environment): restore exactly
-- the function body from migration 20261116000000; do not delete stored facts.

create or replace function public.sales_derive_facts_demo_content(p_facts_pack text)
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
  -- All other single facts are optional, because missing/unknown must never be invented.
  c_required constant text[] := array['name', 'category', 'address', 'description'];
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
     or jsonb_typeof(v_pack->'facts') is distinct from 'array' or coalesce(jsonb_array_length(v_pack->'facts'), 0) not between 1 and 200 then
    raise exception 'invalid_facts_pack' using errcode = '22023';
  end if;
  for f in select e.value from jsonb_array_elements(v_pack->'facts') e loop
    if jsonb_typeof(f) is distinct from 'object'
       or exists (select 1 from jsonb_object_keys(f) x where x not in ('id', 'key', 'value', 'source_id'))
       or jsonb_typeof(f->'id') is distinct from 'string' or jsonb_typeof(f->'key') is distinct from 'string'
       or jsonb_typeof(f->'value') is distinct from 'string' or jsonb_typeof(f->'source_id') is distinct from 'string'
       or (f->>'id') !~ '^F[0-9]{1,3}$' or (f->>'source_id') !~ '^S[0-9]{1,3}$'
       or (f->>'key') !~ '^[a-z][a-z0-9_]{1,40}$'
       -- FactsPack's max(400) counts characters (code points), as char_length does
       or char_length(f->>'value') not between 1 and 400 then
      raise exception 'invalid_facts_pack' using errcode = '22023';
    end if;
    -- FactsPack's unsafeText (lib/design-agent/quality-pipeline/facts-pack.ts): control characters, <<< / >>>, a tag
    -- opening (JavaScript's \s, case-insensitive [a-z]; NUL cannot be in a text value)
    if (f->>'value') ~ '[\x01-\x09\x0b-\x1f\x7f]|<<<|>>>|<[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*/?[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*[a-zA-Z!]' then
      raise exception 'facts_pack_unsafe_text' using errcode = '22023';
    end if;
    if (f->>'value') ~ '^[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
       or (f->>'value') ~ '[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$' then
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
  foreach k in array c_required loop
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
