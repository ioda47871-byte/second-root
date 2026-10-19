-- Second Root Sales Agent — discovery-stage screening and memory of rejected
-- candidates (DEV-054)
--
-- 1. sales_rejected_candidates remembers candidates the server rejected for a
--    durable reason (the shop itself makes it ineligible, not a transient
--    problem with the run), so Operational Claude does not verify the same
--    shop again every day. One row per key, with an expiry.
-- 2. sales_discovery_known_keys screens the stubs of a `discovered`
--    checkpoint: a stub whose Instagram handle or website key belongs to a
--    known shop (any prospect, DNC included; the admin's exclusion list; a
--    remembered rejection) is marked "known" so Op Claude skips it. Only the
--    keys come back — never which list matched or anything from the lists.
-- 3. sales_remember_rejections records the durable rejections of a run's
--    verified checkpoint (only those the checkpoint really holds).
-- 4. sales_run_state also returns known_keys (additive).
--
-- The verified-phase persist (sales_persist_candidate) is unchanged and stays
-- the final authority: dedupe, DNC, exclusion list, daily cap, idempotency.
-- A "known" mark only saves Op Claude a verification.

-- ---------------------------------------------------------------------------
-- Memory of rejected candidates
-- ---------------------------------------------------------------------------
--
-- One durable reason only (lib/sales/discovery.ts DURABLE_REJECTIONS),
-- decided after the shop's name and address were checked against their sources:
--   site_without_email : the shop has its own website and no first-party email
--                        (out of MVP scope, MVP_SPEC §3.2). Remembered only
--                        when the candidate submitted no email at all (a
--                        submitted email prepare refused is a submission
--                        problem, not the shop's).
-- Not remembered: excluded / do_not_contact / duplicate (the exclusion list and
-- the prospects already answer those, and removing an exclusion must take
-- effect at once), daily_cap and every error (transient), and reasons about
-- what Op Claude submitted rather than the shop (missing_source,
-- website_not_rechecked, website_unknown_without_email, invalid_*, ...).
-- outside_nagoya / unsupported_category are decided before the name and
-- address are source-checked, so they are not remembered either.
-- no_eligible_channel (no website, no Instagram) is not remembered: it has
-- neither of the keys screening matches on.
--
-- Keys: exactly the two that discovery screening matches on, with the ingest
-- normalisation: instagram_handle (parseInstagramProfile) and website_domain
-- (websiteKey). No name / address and no email, plain or digested: the
-- discovered stubs carry neither, so they would never be used.
-- A row expires 90 days after the last rejection (shops change: a site is
-- dropped, an email is published); expired rows are ignored and deleted on the
-- next write. Read: admin only (RLS). Write: the service-role function below.

create table public.sales_rejected_candidates (
  id uuid primary key default gen_random_uuid(),
  key_type text not null check (key_type in ('instagram_handle', 'website_domain')),
  key_value text not null check (
    char_length(key_value) between 1 and 520
    and key_value !~ '[[:space:]]'
    and key_value !~ '[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+'),
  reason text not null check (reason in ('site_without_email')),
  run_id uuid references public.sales_agent_runs (run_id) on delete set null,
  first_rejected_at timestamptz not null default now(),
  last_rejected_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint sales_rejected_candidates_key unique (key_type, key_value),
  constraint sales_rejected_candidates_key_shape check (
    (key_type = 'instagram_handle' and key_value ~ '^[a-z0-9._]{1,30}$')
    or (key_type = 'website_domain' and key_value = lower(key_value) and char_length(key_value) between 3 and 512)),
  constraint sales_rejected_candidates_expiry check (expires_at > last_rejected_at)
);

create index sales_rejected_candidates_expires_idx on public.sales_rejected_candidates (expires_at);

alter table public.sales_rejected_candidates enable row level security;
create policy sales_rejected_candidates_admin_read on public.sales_rejected_candidates
  for select to authenticated using ((select public.is_sales_admin()));
revoke all on public.sales_rejected_candidates from public, anon, authenticated;
grant select on public.sales_rejected_candidates to authenticated;
grant select, insert, update, delete on public.sales_rejected_candidates to service_role;

-- ---------------------------------------------------------------------------
-- Discovery screening (called by the ingest API before the discovered checkpoint)
-- ---------------------------------------------------------------------------
--
-- p_stubs: [{ "key", "instagram_handle"?, "website_domain"? }] computed by the
-- server (lib/sales/discovery.ts). Returns the keys of known stubs, in order.
-- No name / ward matching: a stub has no address, and wrongly marking a
-- different shop as known would silently drop it (MVP_SPEC §3.5).

create function public.sales_discovery_known_keys(p_stubs jsonb)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(s.value->>'key' order by s.ord), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(p_stubs) = 'array' then p_stubs else '[]'::jsonb end)
       with ordinality as s(value, ord)
  where s.ord <= 20
    and (
      (nullif(s.value->>'instagram_handle', '') is not null and (
         exists (select 1 from public.sales_prospects p where p.instagram_handle = s.value->>'instagram_handle')
         or exists (select 1 from public.sales_exclusions e where e.instagram_handle = s.value->>'instagram_handle')
         or exists (select 1 from public.sales_rejected_candidates m
                    where m.key_type = 'instagram_handle' and m.key_value = s.value->>'instagram_handle'
                      and m.expires_at > now())))
      or (nullif(s.value->>'website_domain', '') is not null and (
         exists (select 1 from public.sales_prospects p where p.website_domain = s.value->>'website_domain')
         or exists (select 1 from public.sales_exclusions e where e.website_domain = s.value->>'website_domain')
         or exists (select 1 from public.sales_rejected_candidates m
                    where m.key_type = 'website_domain' and m.key_value = s.value->>'website_domain'
                      and m.expires_at > now()))))
$$;

-- ---------------------------------------------------------------------------
-- Remembering durable rejections (called by the ingest API after the verified
-- checkpoint is saved)
-- ---------------------------------------------------------------------------
--
-- p_entries: [{ "key", "reason", "keys": [{ "type", "value" }] }] computed by
-- the server from the submitted candidate. An entry is recorded only when the
-- run's checkpoint holds that key as rejected with that same durable reason,
-- so nothing else can be remembered. Re-sending is idempotent (one row per
-- key; a repeat refreshes the reason, run and expiry). A key the table refuses
-- (bad type / shape, check_violation or not_null_violation) is skipped on its
-- own; the rest of the batch is still recorded (the server validates first,
-- lib/sales/discovery.ts validMemoryEntries).

create function public.sales_remember_rejections(p_run_id uuid, p_entries jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  r public.sales_agent_runs;
  e jsonb;
  k jsonb;
  st jsonb;
  saved integer := 0;
begin
  -- Two steps: jsonb_array_length must never see a non-array.
  if jsonb_typeof(p_entries) is distinct from 'array' then
    raise exception 'invalid_rejection_memory' using errcode = '22023';
  end if;
  if jsonb_array_length(p_entries) > 10 then
    raise exception 'invalid_rejection_memory' using errcode = '22023';
  end if;
  select * into r from public.sales_agent_runs where run_id = p_run_id;
  if not found then
    raise exception 'run_not_found' using errcode = 'P0002';
  end if;

  delete from public.sales_rejected_candidates where expires_at <= now();

  for e in select value from jsonb_array_elements(p_entries) loop
    st := r.checkpoint->'candidates'->(e->>'key');
    if st is null or st->>'stage' is distinct from 'rejected'
       or st->>'reason' is distinct from e->>'reason'
       or e->>'reason' is distinct from 'site_without_email'
       or jsonb_typeof(e->'keys') is distinct from 'array' then
      continue;
    end if;
    for k in select value from jsonb_array_elements(e->'keys') loop
      -- One bad key skips only itself (a subtransaction per key).
      begin
        insert into public.sales_rejected_candidates (key_type, key_value, reason, run_id, expires_at)
          values (k->>'type', k->>'value', e->>'reason', p_run_id, now() + interval '90 days')
          on conflict (key_type, key_value) do update
            set reason = excluded.reason, run_id = excluded.run_id,
                last_rejected_at = now(), expires_at = excluded.expires_at;
        saved := saved + 1;
      exception when check_violation or not_null_violation then
        null;
      end;
    end loop;
  end loop;
  return saved;
end;
$$;

-- ---------------------------------------------------------------------------
-- Run state: as 20260927000600, plus known_keys (the discovered stubs the
-- server marked known). create or replace keeps the grants (service_role only).
-- ---------------------------------------------------------------------------

create or replace function public.sales_run_state(r public.sales_agent_runs, p_replayed boolean default false)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'run_id', r.run_id,
    'status', r.status,
    'phase', r.phase,
    'checkpoint_at', r.checkpoint_at,
    'persist_attempts', r.persist_attempts,
    'error_code', r.error_code,
    'error_summary', r.error_summary,
    'discovered_keys', coalesce(
      (select jsonb_agg(c->'key') from jsonb_array_elements(r.checkpoint->'discovered'->'candidates') c),
      '[]'::jsonb),
    'known_keys', coalesce(
      (select jsonb_agg(c->'key') from jsonb_array_elements(r.checkpoint->'discovered'->'candidates') c
        where c->'known' = 'true'::jsonb),
      '[]'::jsonb),
    'discovered', case
      when r.status = 'running' and r.phase = 'discovered'
        then coalesce(r.checkpoint->'discovered'->'candidates', '[]'::jsonb)
      else '[]'::jsonb
    end,
    'verified_order', coalesce(r.checkpoint->'verified'->'order', '[]'::jsonb),
    'candidates', coalesce(r.checkpoint->'candidates', '{}'::jsonb),
    'result', r.result,
    'replayed', p_replayed
  )
$$;

-- Only the server (service role) may call these.
revoke all on function public.sales_discovery_known_keys(jsonb) from public, anon, authenticated;
revoke all on function public.sales_remember_rejections(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.sales_discovery_known_keys(jsonb) to service_role;
grant execute on function public.sales_remember_rejections(uuid, jsonb) to service_role;
