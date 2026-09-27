-- Second Root Sales Agent — replies, meetings, won / lost, DNC (DEV-012)
--
-- Admin-only (is_sales_admin) security-definer functions; the outreach
-- triggers still enforce the state machine. A plain decline closes the deal
-- as lost but does NOT set do_not_contact; only an explicit refusal of future
-- contact does, and it also disables the shop's demo (MVP_SPEC §5, §6, §7).

create or replace function public.sales_assert_admin()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not public.is_sales_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.sales_lock_initial(p_outreach_id uuid)
returns public.sales_outreaches
language plpgsql
set search_path = ''
as $$
declare
  o public.sales_outreaches;
begin
  select * into o from public.sales_outreaches where id = p_outreach_id and kind = 'initial' for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return o;
end;
$$;

create or replace function public.sales_set_dnc_internal(p_prospect_id uuid, p_reason text)
returns void
language sql
set search_path = ''
as $$
  update public.sales_prospects
    set do_not_contact = true, dnc_reason = p_reason, dnc_set_at = now()
    where id = p_prospect_id and not do_not_contact;
  update public.sales_demos set disabled_at = now() where prospect_id = p_prospect_id and disabled_at is null;
$$;

create or replace function public.sales_record_reply(p_outreach_id uuid, p_reply_type text, p_future_contact_refused boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.sales_outreaches;
begin
  perform public.sales_assert_admin();
  if p_reply_type not in ('interested', 'question', 'meeting_request', 'decline', 'other') then
    raise exception 'invalid_reply_type' using errcode = '22023';
  end if;
  if coalesce(p_future_contact_refused, false) and p_reply_type <> 'decline' then
    raise exception 'refusal_requires_decline' using errcode = '22023';
  end if;
  o := public.sales_lock_initial(p_outreach_id);
  if o.status = 'replied' or (o.status = 'lost' and o.reply_type is not null) then
    return jsonb_build_object('outreach_id', o.id, 'status', o.status, 'replayed', true);
  end if;
  if o.status <> 'sent' then
    raise exception 'invalid_transition' using errcode = 'P0001';
  end if;

  update public.sales_outreaches
    set status = 'replied', reply_type = p_reply_type, replied_at = now()
    where id = o.id;
  if p_reply_type = 'decline' then
    -- Declined: this shop's outreach ends here (no other channel, no follow-up).
    update public.sales_outreaches
      set status = 'lost', closed_at = now(), lost_reason = 'declined'
      where id = o.id;
  end if;
  if coalesce(p_future_contact_refused, false) then
    perform public.sales_set_dnc_internal(o.prospect_id, 'explicit_refusal');
  end if;
  select * into o from public.sales_outreaches where id = o.id;
  return jsonb_build_object('outreach_id', o.id, 'status', o.status, 'replayed', false);
end;
$$;

create or replace function public.sales_mark_meeting(p_outreach_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.sales_outreaches;
begin
  perform public.sales_assert_admin();
  o := public.sales_lock_initial(p_outreach_id);
  if o.status = 'meeting' then
    return jsonb_build_object('outreach_id', o.id, 'status', o.status, 'replayed', true);
  end if;
  update public.sales_outreaches set status = 'meeting', meeting_at = now() where id = o.id;
  return jsonb_build_object('outreach_id', o.id, 'status', 'meeting', 'replayed', false);
end;
$$;

create or replace function public.sales_mark_won(p_outreach_id uuid, p_amount_jpy integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.sales_outreaches;
begin
  perform public.sales_assert_admin();
  if p_amount_jpy is null or p_amount_jpy <= 0 then
    raise exception 'won_amount_required' using errcode = '22023';
  end if;
  o := public.sales_lock_initial(p_outreach_id);
  if o.status = 'won' then
    return jsonb_build_object('outreach_id', o.id, 'status', o.status, 'replayed', true);
  end if;
  update public.sales_outreaches
    set status = 'won', won_amount_jpy = p_amount_jpy, closed_at = now()
    where id = o.id;
  return jsonb_build_object('outreach_id', o.id, 'status', 'won', 'replayed', false);
end;
$$;

create or replace function public.sales_mark_lost(p_outreach_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.sales_outreaches;
begin
  perform public.sales_assert_admin();
  o := public.sales_lock_initial(p_outreach_id);
  if o.status = 'lost' then
    return jsonb_build_object('outreach_id', o.id, 'status', o.status, 'replayed', true);
  end if;
  update public.sales_outreaches
    set status = 'lost', closed_at = now(), lost_reason = nullif(left(coalesce(p_reason, ''), 500), '')
    where id = o.id;
  return jsonb_build_object('outreach_id', o.id, 'status', 'lost', 'replayed', false);
end;
$$;

-- Manual DNC (e.g. refusal received by phone) and its removal: admin only.
create or replace function public.sales_set_dnc(p_prospect_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.sales_assert_admin();
  if not exists (select 1 from public.sales_prospects where id = p_prospect_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform public.sales_set_dnc_internal(p_prospect_id, 'admin_manual');
end;
$$;

-- Clearing DNC never re-enables the demo (MVP_SPEC §6 / ARCHITECTURE §4).
create or replace function public.sales_clear_dnc(p_prospect_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.sales_assert_admin();
  update public.sales_prospects
    set do_not_contact = false, dnc_reason = null, dnc_set_at = null
    where id = p_prospect_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.sales_record_reply(uuid, text, boolean)',
    'public.sales_mark_meeting(uuid)',
    'public.sales_mark_won(uuid, integer)',
    'public.sales_mark_lost(uuid, text)',
    'public.sales_set_dnc(uuid)',
    'public.sales_clear_dnc(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
  foreach fn in array array[
    'public.sales_assert_admin()',
    'public.sales_lock_initial(uuid)',
    'public.sales_set_dnc_internal(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
  end loop;
end;
$$;
