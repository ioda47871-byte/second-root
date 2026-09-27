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

-- Functions created later in this schema start closed; each migration
-- grants EXECUTE explicitly to the roles that need it.
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
