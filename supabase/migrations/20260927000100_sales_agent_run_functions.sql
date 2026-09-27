-- Second Root Sales Agent — Operational run lifecycle (DEV-001)
--
-- docs/ARCHITECTURE.md §5 / §7. All functions are called only by the ingest
-- API with the service role. They make run_id an idempotency key, keep the
-- last safe checkpoint in sales_agent_runs, and fail closed.
--
-- Checkpoint layout (jsonb, ≤ 64KB):
--   discovered : { "at": ts, "candidates": [ { "key", "name", "ward", "category",
--                  "website_url"?, "instagram_url"? } ] }                    (≤ 20)
--   verified   : { "at": ts, "order": [key], "candidates": { key: candidate } } (≤ 10)
--   candidates : { key: { "stage", "prospect_id"?, "reason"?, "error_code"? } }
--
-- A verified candidate is fully prepared by the server-side TypeScript
-- (lib/sales) before it is stored, using snake_case keys:
--   name, normalized_name, address, normalized_address, ward, category,
--   website_status, website_url, website_domain, instagram_url,
--   instagram_handle, public_email, channel,
--   sources: [ { field, value, source_url, source_type, verified_at } ],
--   demo: { template, content }, outreach: { subject, body }
--
-- Candidate stages: pending → outreach_ready | rejected | duplicate | error.
-- Only outreach_ready / rejected / duplicate are terminal.

create or replace function public.sales_phase_rank(p_phase text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case p_phase
    when 'started' then 0 when 'discovered' then 1 when 'verified' then 2
    when 'persisting' then 3 when 'completed' then 4 end
$$;

create or replace function public.sales_stage_is_terminal(p_stage text)
returns boolean
language sql
immutable
set search_path = ''
as $$ select coalesce(p_stage in ('outreach_ready', 'rejected', 'duplicate'), false) $$;

-- Public view of a run returned by every action. No sales data beyond ids.
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
    'verified_order', coalesce(r.checkpoint->'verified'->'order', '[]'::jsonb),
    'candidates', coalesce(r.checkpoint->'candidates', '{}'::jsonb),
    'result', r.result,
    'replayed', p_replayed
  )
$$;

-- Locks the run row and applies the 24h expiry (fail closed: a stale run is
-- never resumed; the next run starts with a new run_id).
create or replace function public.sales_run_lock(p_run_id uuid)
returns public.sales_agent_runs
language plpgsql
set search_path = ''
as $$
declare
  r public.sales_agent_runs;
begin
  select * into r from public.sales_agent_runs where run_id = p_run_id for update;
  if not found then
    raise exception 'run_not_found' using errcode = 'P0002';
  end if;
  if r.status = 'running' and r.checkpoint_at < now() - interval '24 hours' then
    update public.sales_agent_runs
      set status = 'failed', error_code = 'run_expired',
          error_summary = 'No checkpoint for 24 hours; start a new run.',
          finished_at = now(), persist_lease_until = null
      where run_id = p_run_id
      returning * into r;
  end if;
  return r;
end;
$$;

create or replace function public.sales_run_start(p_run_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r public.sales_agent_runs;
  created boolean;
begin
  insert into public.sales_agent_runs (run_id) values (p_run_id)
    on conflict (run_id) do nothing;
  created := found;
  r := public.sales_run_lock(p_run_id);
  return public.sales_run_state(r, not created);
end;
$$;

-- Without a run_id: the most recent resumable run, or null.
create or replace function public.sales_run_status(p_run_id uuid default null)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r public.sales_agent_runs;
  target uuid := p_run_id;
begin
  if target is null then
    update public.sales_agent_runs
      set status = 'failed', error_code = 'run_expired',
          error_summary = 'No checkpoint for 24 hours; start a new run.',
          finished_at = now(), persist_lease_until = null
      where status = 'running' and checkpoint_at < now() - interval '24 hours';
    select run_id into target from public.sales_agent_runs
      where status = 'running' order by checkpoint_at desc limit 1;
    if target is null then
      return null;
    end if;
  end if;
  r := public.sales_run_lock(target);
  return public.sales_run_state(r);
end;
$$;

-- Saves the discovered / verified checkpoint. Re-sending the current phase
-- overwrites it; an earlier phase is a no-op; skipping a phase is refused.
create or replace function public.sales_run_checkpoint(p_run_id uuid, p_phase text, p_payload jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r public.sales_agent_runs;
  target_rank integer := public.sales_phase_rank(p_phase);
  current_rank integer;
  keys text[];
  discovered_keys text[];
  k text;
  stages jsonb := '{}'::jsonb;
begin
  if p_phase not in ('discovered', 'verified') then
    raise exception 'invalid_phase' using errcode = '22023';
  end if;

  r := public.sales_run_lock(p_run_id);
  if r.status = 'completed' then
    return public.sales_run_state(r, true);
  end if;
  if r.status = 'failed' then
    raise exception '%', coalesce(r.error_code, 'run_failed') using errcode = 'P0001';
  end if;

  current_rank := public.sales_phase_rank(r.phase);
  if current_rank > target_rank then
    return public.sales_run_state(r, true);
  end if;
  if current_rank < target_rank - 1 then
    raise exception 'phase_order_violation' using errcode = 'P0001';
  end if;

  if p_phase = 'discovered' then
    select coalesce(array_agg(c->>'key'), '{}') into keys
      from jsonb_array_elements(coalesce(p_payload->'candidates', '[]'::jsonb)) c;
    if cardinality(keys) > 20 then
      raise exception 'too_many_candidates' using errcode = '22023';
    end if;
    if cardinality(keys) <> (select count(distinct x) from unnest(keys) x where x is not null) then
      raise exception 'invalid_candidate_keys' using errcode = '22023';
    end if;
    update public.sales_agent_runs
      set checkpoint = jsonb_build_object(
            'discovered', jsonb_build_object('at', now(), 'candidates', p_payload->'candidates')),
          phase = 'discovered', checkpoint_at = now()
      where run_id = p_run_id returning * into r;
  else
    select coalesce(array_agg(x), '{}') into keys
      from jsonb_array_elements_text(coalesce(p_payload->'order', '[]'::jsonb)) x;
    select coalesce(array_agg(c->>'key'), '{}') into discovered_keys
      from jsonb_array_elements(coalesce(r.checkpoint->'discovered'->'candidates', '[]'::jsonb)) c;
    if cardinality(keys) > 10 then
      raise exception 'too_many_candidates' using errcode = '22023';
    end if;
    if cardinality(keys) <> (select count(distinct x) from unnest(keys) x) then
      raise exception 'invalid_candidate_keys' using errcode = '22023';
    end if;
    foreach k in array keys loop
      if not (k = any (discovered_keys)) then
        raise exception 'unknown_candidate_key' using errcode = '22023';
      end if;
      stages := stages || jsonb_build_object(k, coalesce(
        p_payload->'stages'->k,
        jsonb_build_object('stage', 'pending')));
      if not (stages->k->>'stage' in ('pending', 'rejected')) then
        raise exception 'invalid_candidate_stage' using errcode = '22023';
      end if;
      if stages->k->>'stage' = 'pending' and p_payload->'candidates'->k is null then
        raise exception 'missing_candidate' using errcode = '22023';
      end if;
    end loop;
    update public.sales_agent_runs
      set checkpoint = jsonb_build_object(
            'discovered', r.checkpoint->'discovered',
            'verified', jsonb_build_object(
              'at', now(), 'order', to_jsonb(keys), 'candidates', coalesce(p_payload->'candidates', '{}'::jsonb)),
            'candidates', stages),
          phase = 'verified', checkpoint_at = now()
      where run_id = p_run_id returning * into r;
  end if;
  return public.sales_run_state(r);
end;
$$;

-- Completes the run when every candidate is terminal, or after the third
-- persist attempt (remaining errors stay unprepared: partial_errors).
create or replace function public.sales_run_finalize(p_run_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r public.sales_agent_runs;
  open_count integer;
begin
  r := public.sales_run_lock(p_run_id);
  if r.status <> 'running' then
    return public.sales_run_state(r, r.status = 'completed');
  end if;
  if r.phase <> 'persisting' then
    raise exception 'phase_order_violation' using errcode = 'P0001';
  end if;

  select count(*) into open_count
    from jsonb_array_elements_text(coalesce(r.checkpoint->'verified'->'order', '[]'::jsonb)) k
    where not public.sales_stage_is_terminal(r.checkpoint->'candidates'->k->>'stage');

  if open_count = 0 or r.persist_attempts >= 3 then
    update public.sales_agent_runs
      set status = 'completed', phase = 'completed', finished_at = now(),
          checkpoint_at = now(), persist_lease_until = null,
          error_code = case when open_count > 0 then 'partial_errors' end,
          error_summary = case when open_count > 0
            then format('%s candidate(s) left unprepared after 3 persist attempts.', open_count) end,
          result = jsonb_build_object(
            'candidates', coalesce(r.checkpoint->'candidates', '{}'::jsonb),
            'outreach_ready', (select count(*) from jsonb_each(coalesce(r.checkpoint->'candidates', '{}'::jsonb)) e
                               where e.value->>'stage' = 'outreach_ready'),
            'unprepared', open_count)
      where run_id = p_run_id returning * into r;
  else
    update public.sales_agent_runs
      set persist_lease_until = null, checkpoint_at = now()
      where run_id = p_run_id returning * into r;
  end if;
  return public.sales_run_state(r);
end;
$$;

-- Takes the per-run persist lease (serialises concurrent persist calls).
create or replace function public.sales_run_begin_persist(p_run_id uuid, p_lease_seconds integer default 120)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r public.sales_agent_runs;
begin
  r := public.sales_run_lock(p_run_id);
  if r.status = 'completed' then
    return public.sales_run_state(r, true);
  end if;
  if r.status = 'failed' then
    raise exception '%', coalesce(r.error_code, 'run_failed') using errcode = 'P0001';
  end if;
  if r.phase not in ('verified', 'persisting') then
    raise exception 'phase_order_violation' using errcode = 'P0001';
  end if;
  if r.persist_lease_until is not null and r.persist_lease_until > now() then
    raise exception 'run_busy' using errcode = 'P0001';
  end if;
  if r.persist_attempts >= 3 then
    update public.sales_agent_runs set phase = 'persisting' where run_id = p_run_id;
    return public.sales_run_finalize(p_run_id);
  end if;
  update public.sales_agent_runs
    set phase = 'persisting', persist_attempts = persist_attempts + 1,
        persist_lease_until = now() + make_interval(secs => least(greatest(p_lease_seconds, 10), 600)),
        checkpoint_at = now()
    where run_id = p_run_id returning * into r;
  return public.sales_run_state(r);
end;
$$;

create or replace function public.sales_run_set_stage(r public.sales_agent_runs, p_key text, p_stage jsonb)
returns void
language sql
set search_path = ''
as $$
  update public.sales_agent_runs
    set checkpoint = jsonb_set(checkpoint, array['candidates', p_key], p_stage, true),
        checkpoint_at = now()
    where run_id = r.run_id
$$;

-- Persists one verified candidate in a single transaction: dedupe → DNC →
-- daily cap → prospect + sources + demo + outreach draft, and records the
-- candidate's stage in the checkpoint in the same transaction.
create or replace function public.sales_persist_candidate(p_run_id uuid, p_key text)
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
  if r.status <> 'running' or r.phase <> 'persisting' then
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
    insert into public.sales_demos (prospect_id, public_token, template, content, run_id)
      values (new_prospect, public.sales_new_demo_token(), c->'demo'->>'template',
              coalesce(c->'demo'->'content', '{}'::jsonb), p_run_id);
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

-- Records a failed candidate (called by the API after sales_persist_candidate
-- rolled back). Never overrides a terminal stage.
create or replace function public.sales_run_mark_candidate_error(p_run_id uuid, p_key text, p_error_code text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r public.sales_agent_runs;
  cur jsonb;
begin
  r := public.sales_run_lock(p_run_id);
  cur := r.checkpoint->'candidates'->p_key;
  if r.status <> 'running' or cur is null or public.sales_stage_is_terminal(cur->>'stage') then
    return public.sales_run_state(r);
  end if;
  perform public.sales_run_set_stage(r, p_key, jsonb_build_object(
    'stage', 'error',
    'error_code', case when p_error_code ~ '^[a-z][a-z0-9_]{0,63}$' then p_error_code else 'persist_failed' end));
  select * into r from public.sales_agent_runs where run_id = p_run_id;
  return public.sales_run_state(r);
end;
$$;

create or replace function public.sales_run_abort(p_run_id uuid, p_error_code text, p_error_summary text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r public.sales_agent_runs;
begin
  r := public.sales_run_lock(p_run_id);
  if r.status = 'running' then
    update public.sales_agent_runs
      set status = 'failed', finished_at = now(), persist_lease_until = null,
          error_code = case when p_error_code ~ '^[a-z][a-z0-9_]{0,63}$' then p_error_code else 'aborted' end,
          error_summary = left(p_error_summary, 500)
      where run_id = p_run_id returning * into r;
  end if;
  return public.sales_run_state(r);
end;
$$;

-- Only the server (service role) may drive runs.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.sales_run_start(uuid)',
    'public.sales_run_status(uuid)',
    'public.sales_run_checkpoint(uuid, text, jsonb)',
    'public.sales_run_begin_persist(uuid, integer)',
    'public.sales_persist_candidate(uuid, text)',
    'public.sales_run_mark_candidate_error(uuid, text, text)',
    'public.sales_run_finalize(uuid)',
    'public.sales_run_abort(uuid, text, text)',
    'public.sales_run_lock(uuid)',
    'public.sales_run_state(public.sales_agent_runs, boolean)',
    'public.sales_run_set_stage(public.sales_agent_runs, text, jsonb)',
    'public.sales_new_demo_token()',
    'public.sales_has_first_party_email(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
