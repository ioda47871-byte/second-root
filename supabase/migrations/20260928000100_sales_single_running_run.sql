-- Second Root Sales Agent — at most one running run (DEV-025)
--
-- The DEV-016 Staging run found that `start` with a new run_id succeeded
-- while another run was still running, so two sessions (a double trigger,
-- or a session that skipped `status`) could both discover and verify.
--
-- Now:
--   * A partial unique index allows at most one row with status 'running'.
--     This is the guarantee: two concurrent starts cannot both commit.
--   * sales_run_start
--       - same run_id again  → the stored run, replayed (unchanged behaviour)
--       - another run running → run_in_progress (the API answers 409)
--       - a running run older than 24h is expired first (as sales_run_lock
--         and sales_run_status do), so it never blocks a new run
--       - completed / failed runs never block a new run (unchanged)
--
-- If this migration fails on the index, two runs were already running:
-- finish or abort one (action=abort) and apply it again.

-- Runs that are stale by the existing 24h rule are expired first, so the
-- index is not blocked by runs that could never be resumed anyway.
update public.sales_agent_runs
  set status = 'failed', error_code = 'run_expired',
      error_summary = 'No checkpoint for 24 hours; start a new run.',
      finished_at = now(), persist_lease_until = null
  where status = 'running' and checkpoint_at < now() - interval '24 hours';

create unique index sales_agent_runs_one_running
  on public.sales_agent_runs ((true)) where status = 'running';

create or replace function public.sales_run_start(p_run_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r public.sales_agent_runs;
begin
  -- Replay: the run already exists (running, completed or failed).
  if exists (select 1 from public.sales_agent_runs where run_id = p_run_id) then
    r := public.sales_run_lock(p_run_id);
    return public.sales_run_state(r, true);
  end if;

  update public.sales_agent_runs
    set status = 'failed', error_code = 'run_expired',
        error_summary = 'No checkpoint for 24 hours; start a new run.',
        finished_at = now(), persist_lease_until = null
    where status = 'running' and checkpoint_at < now() - interval '24 hours';

  if exists (select 1 from public.sales_agent_runs where status = 'running') then
    raise exception 'run_in_progress' using errcode = 'P0001';
  end if;

  begin
    insert into public.sales_agent_runs (run_id) values (p_run_id);
  exception when unique_violation then
    -- Lost a race. Either the same run_id was started concurrently (replay)
    -- or another run became the running one (refuse).
    if exists (select 1 from public.sales_agent_runs where run_id = p_run_id) then
      r := public.sales_run_lock(p_run_id);
      return public.sales_run_state(r, true);
    end if;
    raise exception 'run_in_progress' using errcode = 'P0001';
  end;

  r := public.sales_run_lock(p_run_id);
  return public.sales_run_state(r, false);
end;
$$;

-- Only the server (service role) may drive runs (same as 20260927000100).
revoke all on function public.sales_run_start(uuid) from public, anon, authenticated;
grant execute on function public.sales_run_start(uuid) to service_role;
