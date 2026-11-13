-- Second Root Sales Agent — the stored structure findings of a demo version
-- (DEV-196q; owner decision 2026-11-11: required before sharing, DEV-196g.
-- Issue #263: code, tests and the local DB approved. Staging / Production
-- need their own approval — this migration is applied to the local stack only).
--
-- What this adds:
--   sales_demo_structure_findings: the template-drift findings of one version
--   (spec §7.5: GENERIC_SKELETON, the same skeleton as another shop's approved
--   version, too close to a success case / SR-001, aspects not measured), one
--   row per version, insert-only, in the restated shape of
--   lib/sales/demo-version/quality.ts StructureFindingInput. The admin quality
--   screen shows them beside checklist items 3 and 4 as ADVICE: no finding
--   rejects a version, blocks a quality approval or a send (owner decision
--   2026-11-10, §7.5). Nothing here reads the findings in a guard.
--
-- Who writes: the server only (service role), through
-- sales_record_structure_findings, after it validated the shape. The trigger
-- checks the shape again, that the version is live (draft / approved /
-- superseded), and that every "sibling" is a version of ANOTHER shop's demo.
-- The findings are computed outside the database (the structure descriptor
-- module is isolated: who may compute them is a separate approval); the
-- database only keeps what it was given, in a strict shape.
--
-- Rollback (local only; nothing reads this table in a guard):
--   drop function public.sales_record_structure_findings(uuid, jsonb, integer, text);
--   drop table public.sales_demo_structure_findings;
--   drop function public.sales_check_structure_findings_write();
--   drop function public.sales_structure_findings_valid(jsonb);
--
-- Forward-only. Not applied to any hosted project by this change.

-- ---------------------------------------------------------------------------
-- 1. Shape
-- ---------------------------------------------------------------------------

-- The findings array, exactly as quality.ts StructureFindingInput: at most 64
-- entries, each one of four codes with exactly its own keys.
create function public.sales_structure_findings_valid(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  e jsonb;
  k text;
  x jsonb;
  n integer;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 64 or pg_column_size(p) > 16384 then
    return false;
  end if;
  for e in select value from jsonb_array_elements(p) loop
    if jsonb_typeof(e) <> 'object' or jsonb_typeof(e -> 'code') <> 'string' then
      return false;
    end if;
    k := e ->> 'code';
    if k in ('TOO_CLOSE_TO_REFERENCE', 'SIBLINGS_SAME_SKELETON') then
      if jsonb_typeof(e -> 'similarity') <> 'number'
         or (e ->> 'similarity')::numeric < 0 or (e ->> 'similarity')::numeric > 1 then
        return false;
      end if;
      if k = 'TOO_CLOSE_TO_REFERENCE' then
        if (select count(*) from jsonb_object_keys(e)) <> 3
           or jsonb_typeof(e -> 'reference') <> 'string'
           or (e ->> 'reference') !~ '^[A-Z][A-Z0-9]*-[0-9A-Za-z-]{1,40}$' then
          return false;
        end if;
      else
        if (select count(*) from jsonb_object_keys(e)) <> 3
           or jsonb_typeof(e -> 'sibling') <> 'string'
           or (e ->> 'sibling') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          return false;
        end if;
      end if;
    elsif k = 'GENERIC_SKELETON' then
      if (select count(*) from jsonb_object_keys(e)) <> 2 or jsonb_typeof(e -> 'reasons') <> 'array' then
        return false;
      end if;
      n := jsonb_array_length(e -> 'reasons');
      if n < 1 or n > 8 then
        return false;
      end if;
      for x in select value from jsonb_array_elements(e -> 'reasons') loop
        if jsonb_typeof(x) <> 'string' or (x #>> '{}') !~ '^[a-z_]{1,40}:[a-z_0-9/]{1,40}$' then
          return false;
        end if;
      end loop;
    elsif k = 'ASPECTS_UNKNOWN' then
      if (select count(*) from jsonb_object_keys(e)) <> 2 or jsonb_typeof(e -> 'aspects') <> 'array' then
        return false;
      end if;
      n := jsonb_array_length(e -> 'aspects');
      if n < 1 or n > 8 then
        return false;
      end if;
      for x in select value from jsonb_array_elements(e -> 'aspects') loop
        if jsonb_typeof(x) <> 'string' or (x #>> '{}') not in
           ('hero', 'flow', 'navigation', 'reading_path', 'section_layouts', 'transitions', 'text_direction', 'imagery') then
          return false;
        end if;
      end loop;
    else
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Table
-- ---------------------------------------------------------------------------

create table public.sales_demo_structure_findings (
  version_id uuid primary key references public.sales_demo_versions (id) on delete restrict,
  demo_id uuid not null references public.sales_demos (id) on delete restrict,
  -- where the findings came from (one source today: an observation report of the version's page)
  source text not null check (source in ('observation_report')),
  findings jsonb not null check (public.sales_structure_findings_valid(findings)),
  -- how many recently approved versions of other shops were compared (spec §7.5: up to 20)
  siblings_compared integer not null check (siblings_compared between 0 and 20),
  recorded_at timestamptz not null default now()
);
create index sales_demo_structure_findings_demo_idx on public.sales_demo_structure_findings (demo_id);

-- Insert-only; the version is this demo's and live; siblings are other shops' versions.
create function public.sales_check_structure_findings_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v public.sales_demo_versions;
  s text;
begin
  if tg_op <> 'INSERT' then
    raise exception 'structure_findings_immutable' using errcode = 'check_violation';
  end if;
  select * into v from public.sales_demo_versions where id = new.version_id;
  if v.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v.demo_id <> new.demo_id then
    raise exception 'structure_findings_other_demo' using errcode = 'check_violation';
  end if;
  if v.status not in ('draft', 'approved', 'superseded') then
    raise exception 'structure_findings_version_unavailable' using errcode = 'P0001';
  end if;
  for s in select e ->> 'sibling' from jsonb_array_elements(new.findings) e where e ->> 'code' = 'SIBLINGS_SAME_SKELETON' loop
    if not exists (select 1 from public.sales_demo_versions o where o.id = s::uuid and o.demo_id <> new.demo_id) then
      raise exception 'structure_findings_sibling_invalid' using errcode = 'check_violation';
    end if;
  end loop;
  new.recorded_at := now();
  return new;
end;
$$;

create trigger sales_demo_structure_findings_write
  before insert or update or delete on public.sales_demo_structure_findings
  for each row execute function public.sales_check_structure_findings_write();

alter table public.sales_demo_structure_findings enable row level security;
create policy sales_demo_structure_findings_admin_read on public.sales_demo_structure_findings
  for select to authenticated using ((select public.is_sales_admin()));

-- Like every sales_* history table: admins read; the server reads, inserts and
-- updates (the trigger refuses every update); never deleted by any API role.
revoke all on public.sales_demo_structure_findings from public, anon, authenticated, service_role;
grant select on public.sales_demo_structure_findings to authenticated;
grant select, insert, update on public.sales_demo_structure_findings to service_role;

-- ---------------------------------------------------------------------------
-- 3. Server path (service_role only)
-- ---------------------------------------------------------------------------

-- The same findings again replay; different findings for a version that has
-- them are refused (the first record stands: no silent rewrite of advice).
create function public.sales_record_structure_findings(
  p_version_id uuid,
  p_findings jsonb,
  p_siblings_compared integer,
  p_source text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v public.sales_demo_versions;
  f public.sales_demo_structure_findings;
begin
  if p_version_id is null or p_siblings_compared is null or p_source is null
     or not public.sales_structure_findings_valid(p_findings) then
    raise exception 'invalid_structure_findings' using errcode = '22023';
  end if;
  select * into v from public.sales_demo_versions where id = p_version_id;
  if v.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into f from public.sales_demo_structure_findings where version_id = p_version_id;
  if f.version_id is not null then
    if f.findings = p_findings and f.siblings_compared = p_siblings_compared and f.source = p_source then
      return jsonb_build_object('version_id', p_version_id, 'replayed', true);
    end if;
    raise exception 'structure_findings_exist' using errcode = 'P0001';
  end if;
  insert into public.sales_demo_structure_findings (version_id, demo_id, source, findings, siblings_compared)
    values (p_version_id, v.demo_id, p_source, p_findings, p_siblings_compared);
  return jsonb_build_object('version_id', p_version_id, 'replayed', false);
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.sales_structure_findings_valid(jsonb)',
    'public.sales_check_structure_findings_write()',
    'public.sales_record_structure_findings(uuid, jsonb, integer, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
