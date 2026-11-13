-- Second Root Sales Agent — the database switch of versioned sharing
-- (DEV-196g; spec §6.4・§6.8・§9.4・§12. Issue #263: code, tests and the local
-- DB approved. Staging / Production need their own approval — this migration
-- is applied to the local stack only).
--
-- DEV-196c made public.sales_demo_versioned_sharing_enabled() a constant
-- false, "replaced only by a later approved migration". This is that
-- migration. The function now reads ONE row of a settings table that starts
-- OFF, so after this migration everything behaves exactly as before
-- (sales_resolve_demo_share never answers 'version', every versioned send
-- still stops at demo_not_shareable).
--
-- Turning it on is a deliberate act of the database owner (the SQL editor or a
-- migration), never of the app: the trigger refuses every write made as an
-- API role (anon, authenticated, service_role), so neither a request nor the
-- server's service role can switch sharing on. It is one half of the switch:
-- the server also needs SALES_DEMO_SHARE_ENABLED=true (and the dedicated
-- artifact origin), and both must be on for a version to be served.
--
--   update public.sales_demo_share_settings set versioned_sharing_enabled = true;   -- owner only
--
-- Nothing else changes: photos stay unshareable
-- (sales_demo_share_photos_enabled() is still constant false, MVP_SPEC §7),
-- and every rule of sales_resolve_demo_share / sales_demo_version_shareable /
-- the send guards is unchanged.
--
-- Rollback (local; restores the DEV-196c constant):
--   create or replace function public.sales_demo_versioned_sharing_enabled()
--     returns boolean language sql immutable set search_path = '' as $$ select false $$;
--   drop table public.sales_demo_share_settings;
--   drop function public.sales_check_demo_share_settings_write();
--
-- Forward-only. Not applied to any hosted project by this change.

create table public.sales_demo_share_settings (
  id boolean primary key default true check (id),
  versioned_sharing_enabled boolean not null default false,
  changed_at timestamptz not null default now()
);

insert into public.sales_demo_share_settings (id, versioned_sharing_enabled) values (true, false);

-- Only the database owner (not an API role) may change the switch; nobody may
-- add or remove the row.
create function public.sales_check_demo_share_settings_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated', 'service_role') then
    raise exception 'share_switch_owner_only' using errcode = 'insufficient_privilege';
  end if;
  if tg_op <> 'UPDATE' then
    raise exception 'share_switch_single_row' using errcode = 'check_violation';
  end if;
  new.changed_at := now();
  return new;
end;
$$;

create trigger sales_demo_share_settings_write
  before insert or update or delete on public.sales_demo_share_settings
  for each row execute function public.sales_check_demo_share_settings_write();

-- No policy: no API role reads a row (the switch is read only through the
-- security-definer function below). Explicit grants like every sales_* table;
-- the trigger refuses every write made as an API role.
alter table public.sales_demo_share_settings enable row level security;
revoke all on public.sales_demo_share_settings from public, anon, authenticated, service_role;
grant select on public.sales_demo_share_settings to authenticated;
grant select, insert, update, delete on public.sales_demo_share_settings to service_role;

-- Same name, signature and privileges (service_role only); stable now (it reads
-- a row). Not security definer, like every helper: its callers are the
-- security-definer send RPCs (run as the owner) and the server's service role,
-- both of which read the row past RLS; no API role can execute it directly.
create or replace function public.sales_demo_versioned_sharing_enabled()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select s.versioned_sharing_enabled from public.sales_demo_share_settings s where s.id), false)
$$;

revoke all on function public.sales_demo_versioned_sharing_enabled() from public, anon, authenticated;
grant execute on function public.sales_demo_versioned_sharing_enabled() to service_role;
revoke all on function public.sales_check_demo_share_settings_write() from public, anon, authenticated;
grant execute on function public.sales_check_demo_share_settings_write() to service_role;
