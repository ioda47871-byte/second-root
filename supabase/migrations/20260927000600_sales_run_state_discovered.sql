-- Second Root Sales Agent — resume verify from the checkpoint (DEV-015)
--
-- docs/ARCHITECTURE.md §7.3: nextAction = verify uses the discovered stubs
-- from the checkpoint and does not search again. A new Operational Claude
-- session has no memory of the stubs, so while the run is in phase
-- discovered the run state also returns them (only what the agent itself
-- submitted: key, name, category, ward, website/instagram URL).
-- create or replace keeps the existing grants (service_role only).

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
