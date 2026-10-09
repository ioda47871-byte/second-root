-- Second Root Sales Agent — AI design state on demos (DEV-030, Sales Design Bridge)
--
-- Adds the AI design step between the demo row and the human's first DM
-- (docs/ARCHITECTURE.md §10). Forward only; nothing existing changes meaning:
--
--   * design_status null      = a legacy demo (no AI design asked). This is
--     every demo made while SALES_AI_DESIGN_ENABLED is off, and every demo
--     that existed before this migration.
--   * pending → processing → ready | blocked | failed, driven only by the
--     service role through sales_design_claim / sales_design_submit (the
--     narrow bridge API). A ready demo is never redesigned.
--
-- design_profile holds only a validated DesignProfile (no rationale, no
-- screenshots, prompts or Codex output). The server re-validates it with
-- DesignProfileSchema every time it reads it; this table only bounds its
-- shape and size.

alter table public.sales_demos
  add column design_status text
    check (design_status in ('pending', 'processing', 'ready', 'blocked', 'failed')),
  add column design_profile jsonb
    check (design_profile is null or (
      jsonb_typeof(design_profile) = 'object'
      and design_profile->>'version' = '1'
      and pg_column_size(design_profile) <= 8192)),
  add column design_job_id uuid unique,
  add column design_attempts smallint not null default 0 check (design_attempts between 0 and 3),
  add column design_claimed_at timestamptz,
  add column design_worker_commit text check (design_worker_commit ~ '^[0-9a-f]{7,40}$'),
  add column design_error_code text check (design_error_code ~ '^[A-Z][A-Z0-9_]{2,47}$'),
  add column design_updated_at timestamptz;

alter table public.sales_demos
  -- A profile exists exactly when the design is ready.
  add constraint sales_demos_design_profile_ready
    check ((design_status is not distinct from 'ready') = (design_profile is not null)),
  -- A job in progress always has its lineage (job id) and its lease start.
  add constraint sales_demos_design_processing_claim
    check (design_status is distinct from 'processing' or (design_job_id is not null and design_claimed_at is not null)),
  -- A legacy demo carries no design data at all.
  add constraint sales_demos_design_legacy_empty
    check (design_status is not null or (
      design_job_id is null and design_attempts = 0 and design_claimed_at is null
      and design_worker_commit is null and design_error_code is null));

create index sales_demos_design_queue on public.sales_demos (design_updated_at, created_at)
  where design_status in ('pending', 'processing');

-- ---------------------------------------------------------------------------
-- persist: the same function, with the demo's design state decided in the
-- same transaction as the demo row (p_design comes from the server's
-- SALES_AI_DESIGN_ENABLED; the default keeps the legacy behaviour).
-- ---------------------------------------------------------------------------

drop function public.sales_persist_candidate(uuid, text);

create function public.sales_persist_candidate(p_run_id uuid, p_key text, p_design boolean default false)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r public.sales_agent_runs;
  c jsonb;
  cur jsonb;
  m_id uuid;
  m_dnc boolean;
  m_own boolean;
  today_count integer;
  new_prospect uuid;
  result jsonb;
begin
  r := public.sales_run_lock(p_run_id);
  if r.status <> 'running' then
    return jsonb_build_object('key', p_key, 'run_status', r.status, 'error_code', r.error_code);
  end if;
  if r.phase <> 'persisting' then
    raise exception 'phase_order_violation' using errcode = 'P0001';
  end if;
  if r.persist_lease_until is null or r.persist_lease_until <= now() then
    raise exception 'lease_lost' using errcode = 'P0001';
  end if;

  cur := r.checkpoint->'candidates'->p_key;
  if cur is null then
    raise exception 'unknown_candidate_key' using errcode = '22023';
  end if;
  if public.sales_stage_is_terminal(cur->>'stage') then
    return jsonb_build_object('key', p_key) || cur;
  end if;
  c := r.checkpoint->'verified'->'candidates'->p_key;
  if c is null then
    raise exception 'missing_candidate' using errcode = '22023';
  end if;

  -- One writer at a time across all runs: the dedupe and daily-cap checks
  -- below must see every committed prospect.
  perform pg_advisory_xact_lock(hashtext('second_root_sales_persist'));

  begin
    select p.id, p.do_not_contact,
           coalesce(p.first_seen_run_id = p_run_id and p.first_seen_candidate_key = p_key, false)
      into m_id, m_dnc, m_own
      from public.sales_prospects p
      where (p.normalized_name = c->>'normalized_name' and p.normalized_address = c->>'normalized_address')
         or (c->>'website_domain' is not null and p.website_domain = c->>'website_domain')
         or (c->>'instagram_handle' is not null and p.instagram_handle = c->>'instagram_handle')
         or (c->>'public_email' is not null and p.public_email = c->>'public_email')
      order by (p.first_seen_run_id = p_run_id and p.first_seen_candidate_key = p_key) desc nulls last,
               p.do_not_contact desc, p.created_at
      limit 1;
  exception when others then
    raise exception 'dedupe_unavailable' using errcode = 'P0001';
  end;

  if m_id is not null then
    if m_own then
      result := jsonb_build_object('stage', 'outreach_ready', 'prospect_id', m_id);
    elsif m_dnc then
      result := jsonb_build_object('stage', 'rejected', 'reason', 'do_not_contact');
    else
      result := jsonb_build_object('stage', 'duplicate', 'prospect_id', m_id);
    end if;
    perform public.sales_run_set_stage(r, p_key, result);
    return jsonb_build_object('key', p_key) || result;
  end if;

  select count(*) into today_count
    from public.sales_outreaches o
    where o.kind = 'initial' and public.sales_jst_date(o.created_at) = public.sales_jst_date(now());
  if today_count >= 5 then
    result := jsonb_build_object('stage', 'rejected', 'reason', 'daily_cap');
    perform public.sales_run_set_stage(r, p_key, result);
    return jsonb_build_object('key', p_key) || result;
  end if;

  begin
    insert into public.sales_prospects (
      name, normalized_name, address, normalized_address, ward, category,
      website_status, website_url, website_domain, instagram_url, instagram_handle,
      public_email, recommended_channel, first_seen_run_id, first_seen_candidate_key)
    values (
      c->>'name', c->>'normalized_name', c->>'address', c->>'normalized_address', c->>'ward', c->>'category',
      c->>'website_status', c->>'website_url', c->>'website_domain', c->>'instagram_url', c->>'instagram_handle',
      c->>'public_email', c->>'channel', p_run_id, p_key)
    returning id into new_prospect;

    insert into public.sales_sources (prospect_id, field, value, source_url, source_type, verified_at, run_id)
      select new_prospect, s->>'field', s->>'value', s->>'source_url', s->>'source_type',
             (s->>'verified_at')::timestamptz, p_run_id
      from jsonb_array_elements(coalesce(c->'sources', '[]'::jsonb)) s;

    set constraints public.sales_prospects_email_provenance immediate;
  exception when others then
    raise exception 'persist_failed:%', sqlerrm using errcode = 'P0001';
  end;

  begin
    -- DEV-030: with the AI design step on, the demo waits for its design
    -- (pending) in the same transaction; off, it is a legacy demo (null).
    insert into public.sales_demos (prospect_id, public_token, template, content, run_id, design_status, design_updated_at)
      values (new_prospect, public.sales_new_demo_token(), c->'demo'->>'template',
              coalesce(c->'demo'->'content', '{}'::jsonb), p_run_id,
              case when p_design then 'pending' end, case when p_design then now() end);
  exception when others then
    raise exception 'demo_failed:%', sqlerrm using errcode = 'P0001';
  end;

  begin
    insert into public.sales_outreaches (prospect_id, kind, channel, subject, body, run_id)
      values (new_prospect, 'initial', c->>'channel', c->'outreach'->>'subject', c->'outreach'->>'body', p_run_id);
  exception when others then
    raise exception 'outreach_failed:%', sqlerrm using errcode = 'P0001';
  end;

  result := jsonb_build_object('stage', 'outreach_ready', 'prospect_id', new_prospect);
  perform public.sales_run_set_stage(r, p_key, result);
  return jsonb_build_object('key', p_key) || result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Design jobs (the bridge API: app/api/internal/sales-design/jobs)
-- ---------------------------------------------------------------------------

create function public.sales_design_state(d public.sales_demos, p_replayed boolean)
returns jsonb
language sql
set search_path = ''
as $$
  select jsonb_build_object(
    'job_id', d.design_job_id,
    'status', d.design_status,
    'error_code', d.design_error_code,
    'attempts', d.design_attempts,
    'replayed', p_replayed)
$$;

-- Hands out the oldest waiting design job, one at a time. First returns
-- stale jobs (lease over: the bridge or the worker vanished) to pending, or
-- to failed after the last attempt. A waiting demo that must not be designed
-- any more (DNC, disabled, initial outreach already sent, no visual source)
-- is closed as blocked with a fixed code and skipped.
-- Returns null when there is nothing to do.
create function public.sales_design_claim(p_lease_seconds integer default 7200, p_max_attempts integer default 3)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  d public.sales_demos;
  p public.sales_prospects;
  blocked_code text;
  i integer := 0;
begin
  if p_lease_seconds is null or p_lease_seconds < 600 or p_lease_seconds > 86400
     or p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 3 then
    raise exception 'invalid_argument' using errcode = '22023';
  end if;

  -- One claimer at a time: no demo is handed out twice.
  perform pg_advisory_xact_lock(hashtext('second_root_sales_design_claim'));

  update public.sales_demos
    set design_status = case when design_attempts >= p_max_attempts then 'failed' else 'pending' end,
        design_error_code = 'DESIGN_STALE',
        design_claimed_at = null,
        design_updated_at = now()
    where design_status = 'processing'
      and design_claimed_at < now() - make_interval(secs => p_lease_seconds);

  loop
    i := i + 1;
    exit when i > 20;
    select * into d from public.sales_demos
      where design_status = 'pending'
      order by design_updated_at nulls first, created_at, id
      limit 1
      for update skip locked;
    if not found then
      return null;
    end if;
    select * into p from public.sales_prospects where id = d.prospect_id;

    blocked_code := case
      when p.do_not_contact then 'DO_NOT_CONTACT'
      when d.disabled_at is not null then 'DEMO_DISABLED'
      when not exists (
        select 1 from public.sales_outreaches o
        where o.prospect_id = d.prospect_id and o.kind = 'initial' and o.status = 'drafted') then 'ALREADY_SENT'
      when p.instagram_url is null and not (p.website_status = 'present' and p.website_url is not null) then 'NO_VISUAL_SOURCE'
    end;
    if blocked_code is not null then
      update public.sales_demos
        set design_status = 'blocked', design_error_code = blocked_code, design_claimed_at = null, design_updated_at = now()
        where id = d.id;
      continue;
    end if;

    update public.sales_demos
      set design_status = 'processing',
          design_job_id = gen_random_uuid(),
          design_attempts = design_attempts + 1,
          design_claimed_at = now(),
          design_updated_at = now()
      where id = d.id
      returning * into d;
    return jsonb_build_object(
      'job_id', d.design_job_id,
      'attempt', d.design_attempts,
      'template', d.template,
      'content', d.content,
      'website_url', case when p.website_status = 'present' then p.website_url end,
      'instagram_url', p.instagram_url);
  end loop;
  return null;
end;
$$;

-- Records the result of one design job. The job id is the lineage: a result
-- for a job that is no longer the demo's current one (superseded after a
-- stale lease) is refused with job_superseded; a result re-sent for a job
-- that already finished changes nothing and returns replayed. A failed job
-- goes back to pending while attempts remain. If the first outreach was sent
-- in the meantime, the demo is not changed after the fact (ALREADY_SENT).
create function public.sales_design_submit(
  p_job_id uuid, p_outcome text, p_profile jsonb, p_error_code text, p_worker_commit text,
  p_max_attempts integer default 3)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  d public.sales_demos;
  outcome text := p_outcome;
  profile jsonb := p_profile;
  code text := p_error_code;
  next_status text;
begin
  if p_job_id is null or outcome is null or outcome not in ('ready', 'blocked', 'failed')
     or (outcome = 'ready') <> (profile is not null)
     or (outcome = 'ready') <> (code is null)
     or p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 3 then
    raise exception 'invalid_result' using errcode = '22023';
  end if;

  select * into d from public.sales_demos where design_job_id = p_job_id for update;
  if not found then
    raise exception 'job_superseded' using errcode = 'P0001';
  end if;
  if d.design_status <> 'processing' then
    return public.sales_design_state(d, true);
  end if;

  if not exists (
    select 1 from public.sales_outreaches o
    where o.prospect_id = d.prospect_id and o.kind = 'initial' and o.status = 'drafted') then
    outcome := 'blocked';
    profile := null;
    code := 'ALREADY_SENT';
  end if;

  next_status := case
    when outcome = 'failed' and d.design_attempts < p_max_attempts then 'pending'
    else outcome
  end;

  update public.sales_demos
    set design_status = next_status,
        design_profile = case when next_status = 'ready' then profile end,
        design_error_code = code,
        design_worker_commit = p_worker_commit,
        design_claimed_at = null,
        design_updated_at = now()
    where id = d.id
    returning * into d;
  return public.sales_design_state(d, false);
end;
$$;

-- Only the server (service role) may drive persist and design jobs.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.sales_persist_candidate(uuid, text, boolean)',
    'public.sales_design_state(public.sales_demos, boolean)',
    'public.sales_design_claim(integer, integer)',
    'public.sales_design_submit(uuid, text, jsonb, text, text, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
