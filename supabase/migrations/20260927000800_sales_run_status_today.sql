-- Second Root Sales Agent — one run per day across sessions (DEV-016 rehearsal)
--
-- The local live rehearsal found that after a run completed, `status`
-- without a runId returned null, so a second session (or a second trigger)
-- on the same day was told to start a new run. Now, when no run is in
-- progress, status returns the run started today (Asia/Tokyo) if there is
-- one: completed → nextAction none, failed → start_new_run (which the run
-- prompt treats as "stop for today"). Only with no run today is it null.
-- The daily cap on new actionable shops still holds regardless.
-- (Supersedes the "latest resumable run, or null" behaviour described in
-- 20260927000100_sales_agent_run_functions.sql.)

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
      select run_id into target from public.sales_agent_runs
        where public.sales_jst_date(started_at) = public.sales_jst_date(now())
        order by started_at desc limit 1;
    end if;
    if target is null then
      return null;
    end if;
  end if;
  r := public.sales_run_lock(target);
  return public.sales_run_state(r);
end;
$$;
