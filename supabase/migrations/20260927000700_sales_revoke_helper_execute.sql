-- Second Root Sales Agent — least privilege for helper functions (DEV-017)
--
-- Postgres grants EXECUTE on new functions to PUBLIC by default. The pure
-- helpers and trigger functions below hold no data and are invoker-rights,
-- but nothing outside the server needs them: only service_role (the run
-- functions) calls the helpers, and triggers fire without an EXECUTE check.

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.sales_phase_rank(text)',
    'public.sales_stage_is_terminal(text)',
    'public.sales_jst_date(timestamptz)',
    'public.sales_touch_updated_at()',
    'public.sales_check_email_provenance()',
    'public.sales_check_outreach_insert()',
    'public.sales_check_outreach_update()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- Postgres's default PUBLIC EXECUTE cannot be removed per schema, so every
-- migration that creates a function must revoke it explicitly
-- (`revoke all on function … from public, anon, authenticated`) and grant
-- only what is needed. tests/integration/db-security-audit.test.ts fails
-- if any sales function is left with a PUBLIC grant.
