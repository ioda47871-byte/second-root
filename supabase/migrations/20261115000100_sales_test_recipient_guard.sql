-- Second Root Sales Agent — the database side of the test-recipient guard
-- (DEV-263g, Issue #263; runbook B-2. Code, tests and the local DB approved.
-- Staging / Production need their own approval — this migration is applied
-- to the local stack only).
--
-- Until now only the server refused a fictional shop or a reserved test
-- address (lib/sales/test-recipient.ts, at approveSend / markFollowUpSent).
-- The database now refuses them too, at every initial send approval and when
-- the send screen is opened (sales_send_guards, used by
-- sales_approve_outreach and sales_mark_send_opened):
--
--   test_recipient_fictional_shop:  the demo's content.facts_pack starts with
--                                   `fictional-`;
--   test_recipient_reserved_domain: an email recipient whose domain is reserved
--                                   (RFC 2606 / 6761): example.com / .net /
--                                   .org and their subdomains, or a name in /
--                                   ending in .example, .test, .invalid,
--                                   .localhost. Normalised like the server:
--                                   NFKC, the ideographic full stops folded to
--                                   '.', lower case, trailing dots removed. A
--                                   domain with anything but [a-z0-9.-] left is
--                                   also tested with every other character
--                                   removed (default-ignorable characters such
--                                   as a zero-width joiner cannot hide a
--                                   reserved name; the server's IDNA mapping
--                                   refuses such a domain and blocks too).
--
-- Unless sales_local_test_settings.local_test_recipients_enabled is true: ONE
-- row, default false, changed only by the database owner (the trigger refuses
-- every write made as an API role). The local test runs (integration / e2e)
-- switch it on as the owner in their setup; a hosted project keeps it off.
--
-- At 送信済み for an opened approval (p_confirm_opened) nothing new refuses
-- (the approval and the opening were already guarded).
--
-- Rollback (local; restores the 20261111000000 sales_send_guards):
--   .ai/reviews/DEV-263g.md
--
-- Forward-only otherwise. Not applied to any hosted project by this change.

-- ---------------------------------------------------------------------------
-- 1. The local switch (one row, default off, owner only)
-- ---------------------------------------------------------------------------

create table public.sales_local_test_settings (
  id boolean primary key default true check (id),
  local_test_recipients_enabled boolean not null default false,
  changed_at timestamptz not null default now()
);

insert into public.sales_local_test_settings (id, local_test_recipients_enabled) values (true, false);

create function public.sales_check_local_test_settings_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated', 'service_role') then
    raise exception 'local_test_switch_owner_only' using errcode = 'insufficient_privilege';
  end if;
  if tg_op <> 'UPDATE' then
    raise exception 'local_test_switch_single_row' using errcode = 'check_violation';
  end if;
  new.changed_at := now();
  return new;
end;
$$;

create trigger sales_local_test_settings_write
  before insert or update or delete on public.sales_local_test_settings
  for each row execute function public.sales_check_local_test_settings_write();

-- No policy: no API role reads a row. Explicit grants like every sales_* table;
-- the trigger refuses every write made as an API role.
alter table public.sales_local_test_settings enable row level security;
revoke all on public.sales_local_test_settings from public, anon, authenticated, service_role;
grant select on public.sales_local_test_settings to authenticated;
grant select, insert, update, delete on public.sales_local_test_settings to service_role;

-- ---------------------------------------------------------------------------
-- 2. The test-recipient check (invoker rights; service_role only)
-- ---------------------------------------------------------------------------

-- Reserved (RFC 2606 / 6761) after normalisation: same names as
-- lib/sales/test-recipient.ts RESERVED_DOMAIN.
create function public.sales_reserved_test_domain(p_domain text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_domain ~ '(^|\.)example\.(com|net|org)$' or p_domain ~ '\.(example|test|invalid|localhost)$'
      or p_domain ~ '^(example|test|invalid|localhost)$'
$$;

-- Is this email address a reserved test address? NFKC, the full stops folded,
-- lower case, trailing dots removed; a domain with characters other than
-- [a-z0-9.-] left is also tested with those characters removed (fail closed).
-- An address without a domain is not one.
create function public.sales_test_email_reserved(p_email text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_at integer;
  v_domain text;
begin
  if p_email is null then
    return false;
  end if;
  v_at := length(p_email) - strpos(reverse(p_email), '@') + 1;
  if strpos(p_email, '@') = 0 then
    return false;
  end if;
  v_domain := btrim(substr(p_email, v_at + 1));
  if v_domain = '' then
    return false;
  end if;
  v_domain := lower(translate(normalize(v_domain, NFKC), '。．｡', '...'));
  v_domain := regexp_replace(v_domain, '\.+$', '');
  if v_domain = '' then
    return true;
  end if;
  if public.sales_reserved_test_domain(v_domain) then
    return true;
  end if;
  if v_domain ~ '[^a-z0-9.-]' then
    return public.sales_reserved_test_domain(regexp_replace(regexp_replace(v_domain, '[^a-z0-9.-]', '', 'g'), '\.+$', ''));
  end if;
  return false;
end;
$$;

-- Why a send to this prospect on this channel is refused as a test recipient
-- (null: not refused). The local switch lets local test runs through.
create function public.sales_test_recipient_block(p_prospect_id uuid, p_channel text)
returns text
language plpgsql
stable
set search_path = ''
as $$
begin
  if coalesce((select s.local_test_recipients_enabled from public.sales_local_test_settings s where s.id), false) then
    return null;
  end if;
  if exists (select 1 from public.sales_demos d where d.prospect_id = p_prospect_id and d.content->>'facts_pack' ~ '^fictional-') then
    return 'test_recipient_fictional_shop';
  end if;
  if p_channel = 'email' and public.sales_test_email_reserved(public.sales_outreach_recipient(p_prospect_id, 'email')) then
    return 'test_recipient_reserved_domain';
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. sales_send_guards: 20261111000000, plus the test-recipient check at
--    approval and when the send screen is opened (not at 送信済み of an opened
--    approval: p_confirm_opened)
-- ---------------------------------------------------------------------------

create or replace function public.sales_send_guards(o public.sales_outreaches, p_design_enabled boolean, p_confirm_opened boolean)
returns public.sales_demos
language plpgsql
set search_path = ''
as $$
declare
  d public.sales_demos;
  v_recipient text;
  v_block text;
  v_code text;
begin
  if o.kind <> 'initial' or o.status <> 'drafted' then
    raise exception 'invalid_transition' using errcode = 'P0001';
  end if;
  -- Serialises with sales_add_exclusion: an exclusion committed before this
  -- point is always seen; one added later waits for this send to finish.
  perform pg_advisory_xact_lock_shared(hashtext('second_root_sales_exclusions'));
  -- A concurrent DNC (sales_set_dnc locks the same row) is seen after the wait.
  perform 1 from public.sales_prospects where id = o.prospect_id for update;
  if coalesce(p_confirm_opened, false) then
    v_block := public.sales_outreach_block_reason(o.prospect_id);
    perform public.sales_assert_channel_eligible(o.prospect_id, o.kind, o.channel);
  else
    -- DNC, channel rules, recommended channel and the exclusion list.
    perform public.sales_assert_outreach_eligible(o.prospect_id, o.kind, o.channel);
  end if;

  v_recipient := public.sales_outreach_recipient(o.prospect_id, o.channel);
  if v_recipient is null then
    raise exception 'recipient_missing' using errcode = 'P0001';
  end if;
  -- DEV-263g: a fictional shop or a reserved test address (the database owner's local switch aside)
  if not coalesce(p_confirm_opened, false) then
    v_code := public.sales_test_recipient_block(o.prospect_id, o.channel);
    if v_code is not null then
      raise exception using message = v_code, errcode = 'P0001';
    end if;
  end if;
  if exists (
    select 1 from public.sales_outreach_approvals a
    where a.channel = o.channel and a.recipient = v_recipient and a.outreach_id <> o.id
      and a.state in ('approved', 'send_opened', 'sent')
  ) then
    raise exception 'duplicate_recipient' using errcode = 'P0001';
  end if;

  select * into d from public.sales_demos where prospect_id = o.prospect_id for update;
  if not found or (d.disabled_at is not null and v_block is distinct from 'do_not_contact') then
    raise exception 'demo_unavailable' using errcode = 'P0001';
  end if;
  if coalesce(p_design_enabled, false) and d.design_status in ('pending', 'processing') then
    raise exception 'design_pending' using errcode = 'P0001';
  end if;
  -- DEV-196c (§9.2): a quality-approved version must still be approved,
  -- unrevoked, unexpired, match the current facts and be shareable now.
  if not coalesce(p_confirm_opened, false) then
    v_code := public.sales_demo_version_send_block(d);
    if v_code is not null then
      raise exception using message = v_code, errcode = 'P0001';
    end if;
  end if;
  return d;
end;
$$;


-- ---------------------------------------------------------------------------
-- 4. Function privileges (service_role only, like every helper)
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.sales_check_local_test_settings_write()',
    'public.sales_reserved_test_domain(text)',
    'public.sales_test_email_reserved(text)',
    'public.sales_test_recipient_block(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;
