-- Second Root Sales Agent — explicit API role privileges on the core tables (DEV-016)
--
-- The core migration (20260927000000) relied on Supabase's default
-- privileges, which used to grant every new public table to anon /
-- authenticated / service_role, and only revoked what those roles must not
-- have. Newer hosted Supabase projects (found on the Staging project,
-- 2026-09-28) no longer grant SELECT / INSERT / UPDATE to the API roles by
-- default, so there the admin screens could not read and the ingest API
-- (service_role) could not write the core tables.
--
-- This makes the intended privileges explicit, so every project ends up
-- the same whatever its defaults (the local stack already had exactly
-- these). Row level security is unchanged: signed-in users still only see
-- rows when they are the admin (`sales_*_admin_read` policies), and
-- nothing is granted to anon.

grant select on
  public.sales_admins, public.sales_agent_runs, public.sales_prospects,
  public.sales_sources, public.sales_demos, public.sales_outreaches
  to authenticated;

grant select, insert, update, delete on
  public.sales_admins, public.sales_agent_runs, public.sales_prospects,
  public.sales_sources, public.sales_demos, public.sales_outreaches
  to service_role;
