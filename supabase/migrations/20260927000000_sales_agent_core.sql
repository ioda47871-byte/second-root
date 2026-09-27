-- Second Root Sales Agent — core schema, RLS and run/persist functions (DEV-001)
--
-- Design: docs/ARCHITECTURE.md §4 (data model), §5 (ingest), §7 (resilience).
-- The database is the last line of defence for the MVP hard rules: even if
-- application code or Operational Claude is wrong, these constraints, triggers
-- and functions refuse duplicate outreach, DNC contact, ineligible channels,
-- invalid state transitions and oversized checkpoints.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.sales_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- JST calendar date used for the daily cap.
create or replace function public.sales_jst_date(ts timestamptz)
returns date
language sql
immutable
set search_path = ''
as $$ select (ts at time zone 'Asia/Tokyo')::date $$;

-- ---------------------------------------------------------------------------
-- Admin allowlist. Rows are added by a human (SQL editor / migration for the
-- specific user), never through the API. Being authenticated is NOT enough.
-- ---------------------------------------------------------------------------

create table public.sales_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function public.is_sales_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.sales_admins where user_id = (select auth.uid())
  )
$$;

revoke all on function public.is_sales_admin() from public, anon;
grant execute on function public.is_sales_admin() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Operational runs (checkpoint / resume / idempotency)
-- ---------------------------------------------------------------------------

create table public.sales_agent_runs (
  run_id uuid primary key,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  phase text not null default 'started'
    check (phase in ('started', 'discovered', 'verified', 'persisting', 'completed')),
  checkpoint jsonb not null default '{}'::jsonb
    check (jsonb_typeof(checkpoint) = 'object' and pg_column_size(checkpoint) <= 65536),
  checkpoint_at timestamptz not null default now(),
  result jsonb check (result is null or pg_column_size(result) <= 65536),
  error_code text check (error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  error_summary text check (char_length(error_summary) <= 500),
  persist_attempts integer not null default 0 check (persist_attempts between 0 and 3),
  persist_lease_until timestamptz,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint sales_agent_runs_completed_phase
    check ((status = 'completed') = (phase = 'completed')),
  constraint sales_agent_runs_finished
    check ((status = 'running') = (finished_at is null))
);

create index sales_agent_runs_running_idx
  on public.sales_agent_runs (checkpoint_at desc) where status = 'running';

create trigger sales_agent_runs_touch
  before update on public.sales_agent_runs
  for each row execute function public.sales_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Prospects (shops)
-- ---------------------------------------------------------------------------

create table public.sales_prospects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  normalized_name text not null check (char_length(normalized_name) between 1 and 200),
  address text not null check (char_length(address) between 1 and 300),
  normalized_address text not null check (char_length(normalized_address) between 1 and 300),
  ward text check (char_length(ward) <= 20),
  category text not null check (category in ('bakery', 'baked_goods', 'cafe')),
  website_status text not null check (website_status in ('present', 'not_found', 'unknown')),
  website_url text check (website_url ~ '^https?://' and char_length(website_url) <= 2048),
  website_domain text check (website_domain = lower(website_domain) and char_length(website_domain) <= 253),
  instagram_url text check (instagram_url ~ '^https://(www\.)?instagram\.com/' and char_length(instagram_url) <= 2048),
  instagram_handle text check (instagram_handle ~ '^[a-z0-9._]{1,30}$'),
  public_email text check (public_email = lower(public_email) and public_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' and char_length(public_email) <= 254),
  recommended_channel text check (recommended_channel in ('instagram', 'email')),
  do_not_contact boolean not null default false,
  dnc_reason text check (dnc_reason in ('explicit_refusal', 'admin_manual')),
  dnc_set_at timestamptz,
  first_seen_run_id uuid references public.sales_agent_runs (run_id),
  first_seen_candidate_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Nagoya only (MVP_SPEC §2).
  constraint sales_prospects_nagoya check (normalized_address like '%名古屋市%'),
  -- A site marked present has a URL; not_found / unknown never do.
  constraint sales_prospects_website_url
    check ((website_status = 'present') = (website_url is not null)),
  constraint sales_prospects_website_domain
    check ((website_url is null) = (website_domain is null)),
  constraint sales_prospects_instagram_pair
    check ((instagram_url is null) = (instagram_handle is null)),
  -- Channel eligibility (MVP_SPEC §3.2). unknown never goes to Instagram.
  constraint sales_prospects_channel_instagram
    check (recommended_channel <> 'instagram'
           or (website_status = 'not_found' and instagram_handle is not null and public_email is null)),
  constraint sales_prospects_channel_email
    check (recommended_channel <> 'email' or public_email is not null),
  constraint sales_prospects_dnc
    check (do_not_contact = (dnc_set_at is not null) and do_not_contact = (dnc_reason is not null)),
  constraint sales_prospects_name_address unique (normalized_name, normalized_address)
);

create unique index sales_prospects_domain_key
  on public.sales_prospects (website_domain) where website_domain is not null;
create unique index sales_prospects_instagram_key
  on public.sales_prospects (instagram_handle) where instagram_handle is not null;
create unique index sales_prospects_email_key
  on public.sales_prospects (public_email) where public_email is not null;

create trigger sales_prospects_touch
  before update on public.sales_prospects
  for each row execute function public.sales_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Source evidence for facts (the server never fetches source_url)
-- ---------------------------------------------------------------------------

create table public.sales_sources (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references public.sales_prospects (id) on delete cascade,
  field text not null check (field in (
    'name', 'address', 'category', 'website_url', 'instagram_url', 'email',
    'hours', 'closed_days', 'access', 'phone', 'description', 'menu_item'
  )),
  value text not null check (char_length(value) between 1 and 2000),
  source_url text not null check (source_url ~ '^https?://' and char_length(source_url) <= 2048),
  source_type text not null check (source_type in (
    'official_site', 'official_contact', 'official_profile', 'instagram_profile', 'map_listing', 'other'
  )),
  verified_at timestamptz not null,
  run_id uuid references public.sales_agent_runs (run_id),
  created_at timestamptz not null default now()
);

create index sales_sources_prospect_idx on public.sales_sources (prospect_id);

-- A public email is only usable with first-party provenance (MVP_SPEC §3.4).
create or replace function public.sales_has_first_party_email(p_prospect_id uuid, p_email text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.sales_sources s
    where s.prospect_id = p_prospect_id
      and s.field = 'email'
      and lower(s.value) = p_email
      and s.source_type in ('official_site', 'official_contact', 'official_profile')
  )
$$;

-- Deferred so the prospect and its sources can be inserted in one transaction.
create or replace function public.sales_check_email_provenance()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.public_email is not null
     and not public.sales_has_first_party_email(new.id, new.public_email) then
    raise exception 'email_provenance_missing' using errcode = 'check_violation';
  end if;
  return null;
end;
$$;

create constraint trigger sales_prospects_email_provenance
  after insert or update of public_email on public.sales_prospects
  deferrable initially deferred
  for each row execute function public.sales_check_email_provenance();

-- ---------------------------------------------------------------------------
-- Demos (one per prospect; public only after the initial outreach is sent)
-- ---------------------------------------------------------------------------

create table public.sales_demos (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null unique references public.sales_prospects (id) on delete cascade,
  public_token text not null unique check (public_token ~ '^[A-Za-z0-9_-]{43,}$'),
  template text not null check (template in ('bakery_v1', 'baked_goods_v1', 'cafe_v1')),
  content jsonb not null default '{}'::jsonb
    check (jsonb_typeof(content) = 'object' and pg_column_size(content) <= 32768),
  expires_at timestamptz,
  disabled_at timestamptz,
  keep_alive boolean not null default false,
  run_id uuid references public.sales_agent_runs (run_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger sales_demos_touch
  before update on public.sales_demos
  for each row execute function public.sales_touch_updated_at();

-- 256-bit URL-safe token.
create or replace function public.sales_new_demo_token()
returns text
language sql
volatile
set search_path = ''
as $$ select translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_') $$;

-- ---------------------------------------------------------------------------
-- Outreaches (initial: one per prospect; follow_up: email only, once)
-- ---------------------------------------------------------------------------

create table public.sales_outreaches (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references public.sales_prospects (id) on delete cascade,
  kind text not null check (kind in ('initial', 'follow_up')),
  channel text not null check (channel in ('instagram', 'email')),
  subject text check (char_length(subject) <= 200),
  body text not null check (char_length(body) between 1 and 4000),
  status text not null default 'drafted'
    check (status in ('drafted', 'sent', 'replied', 'meeting', 'won', 'lost')),
  reply_type text check (reply_type in ('interested', 'question', 'meeting_request', 'decline', 'other')),
  sent_at timestamptz,
  replied_at timestamptz,
  meeting_at timestamptz,
  closed_at timestamptz,
  won_amount_jpy integer check (won_amount_jpy > 0),
  lost_reason text check (char_length(lost_reason) <= 500),
  run_id uuid references public.sales_agent_runs (run_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_outreaches_won_amount
    check ((status = 'won') = (won_amount_jpy is not null)),
  constraint sales_outreaches_follow_up
    check (kind = 'initial' or (channel = 'email' and status in ('drafted', 'sent'))),
  constraint sales_outreaches_email_subject
    check (channel <> 'email' or subject is not null),
  constraint sales_outreaches_sent_at
    check (status = 'drafted' or sent_at is not null),
  constraint sales_outreaches_replied
    check ((reply_type is null) = (replied_at is null)),
  constraint sales_outreaches_closed
    check ((status in ('won', 'lost')) = (closed_at is not null))
);

create unique index sales_outreaches_initial_key
  on public.sales_outreaches (prospect_id) where kind = 'initial';
create unique index sales_outreaches_follow_up_key
  on public.sales_outreaches (prospect_id) where kind = 'follow_up';
create index sales_outreaches_status_idx on public.sales_outreaches (status, kind);

create trigger sales_outreaches_touch
  before update on public.sales_outreaches
  for each row execute function public.sales_touch_updated_at();

-- Eligibility and DNC are re-checked by the database on every insert, so an
-- outreach draft can never exist for an ineligible or DNC shop.
create or replace function public.sales_check_outreach_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  p public.sales_prospects%rowtype;
begin
  select * into p from public.sales_prospects where id = new.prospect_id;
  if p.do_not_contact then
    raise exception 'do_not_contact' using errcode = 'check_violation';
  end if;
  if new.status <> 'drafted' then
    raise exception 'outreach_must_start_drafted' using errcode = 'check_violation';
  end if;
  if new.channel = 'instagram'
     and not (p.website_status = 'not_found' and p.instagram_handle is not null) then
    raise exception 'instagram_not_eligible' using errcode = 'check_violation';
  end if;
  if new.channel = 'email'
     and not (p.public_email is not null and public.sales_has_first_party_email(p.id, p.public_email)) then
    raise exception 'email_not_eligible' using errcode = 'check_violation';
  end if;
  if new.kind = 'initial' and p.recommended_channel is distinct from new.channel then
    raise exception 'channel_mismatch' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger sales_outreaches_check_insert
  before insert on public.sales_outreaches
  for each row execute function public.sales_check_outreach_insert();

-- Outreach state machine (MVP_SPEC §5). Identity columns are immutable.
create or replace function public.sales_check_outreach_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  allowed boolean;
  dnc boolean;
begin
  if new.prospect_id <> old.prospect_id or new.kind <> old.kind or new.channel <> old.channel
     or new.run_id is distinct from old.run_id or new.created_at <> old.created_at then
    raise exception 'outreach_identity_immutable' using errcode = 'check_violation';
  end if;

  if new.status = old.status then
    return new;
  end if;

  allowed := case old.status
    when 'drafted' then new.status in ('sent', 'lost')
    when 'sent' then new.status in ('replied', 'lost')
    when 'replied' then new.status in ('meeting', 'lost')
    when 'meeting' then new.status in ('won', 'lost')
    else false
  end;
  if not allowed then
    raise exception 'invalid_transition:%->%', old.status, new.status using errcode = 'check_violation';
  end if;

  if new.status = 'sent' then
    select do_not_contact into dnc from public.sales_prospects where id = new.prospect_id;
    if dnc then
      raise exception 'do_not_contact' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger sales_outreaches_check_update
  before update on public.sales_outreaches
  for each row execute function public.sales_check_outreach_update();

-- ---------------------------------------------------------------------------
-- Row level security: only the allowlisted admin may read. All writes go
-- through the server (service role) or admin RPCs added by later tasks.
-- ---------------------------------------------------------------------------

alter table public.sales_admins enable row level security;
alter table public.sales_agent_runs enable row level security;
alter table public.sales_prospects enable row level security;
alter table public.sales_sources enable row level security;
alter table public.sales_demos enable row level security;
alter table public.sales_outreaches enable row level security;

create policy sales_admins_self_read on public.sales_admins
  for select to authenticated using (user_id = (select auth.uid()));
create policy sales_agent_runs_admin_read on public.sales_agent_runs
  for select to authenticated using ((select public.is_sales_admin()));
create policy sales_prospects_admin_read on public.sales_prospects
  for select to authenticated using ((select public.is_sales_admin()));
create policy sales_sources_admin_read on public.sales_sources
  for select to authenticated using ((select public.is_sales_admin()));
create policy sales_demos_admin_read on public.sales_demos
  for select to authenticated using ((select public.is_sales_admin()));
create policy sales_outreaches_admin_read on public.sales_outreaches
  for select to authenticated using ((select public.is_sales_admin()));

-- Belt and braces: no direct table writes for API roles at all.
revoke insert, update, delete, truncate on
  public.sales_admins, public.sales_agent_runs, public.sales_prospects,
  public.sales_sources, public.sales_demos, public.sales_outreaches
  from anon, authenticated;
revoke all on
  public.sales_admins, public.sales_agent_runs, public.sales_prospects,
  public.sales_sources, public.sales_demos, public.sales_outreaches
  from anon;
