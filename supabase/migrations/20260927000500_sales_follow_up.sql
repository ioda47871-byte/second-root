-- Second Root Sales Agent — 5-day email follow-up (DEV-014, MVP_SPEC §4.3)
--
-- Email only, once, 5+ days after the initial email, while the shop has
-- not replied and is not DNC. The human sends it from their mail app
-- (mailto) and taps 送信済み; this records the follow-up as its own
-- outreach row (kind = follow_up). The initial outreach keeps the state.

-- The follow-up carries the demo URL, so a disabled or expired demo means
-- no follow-up (otherwise the item would hold a queue slot forever).
create or replace view public.sales_followup_due
with (security_invoker = true)
as
select o.id as outreach_id, o.prospect_id, o.sent_at
from public.sales_outreaches o
join public.sales_prospects p on p.id = o.prospect_id
join public.sales_demos d on d.prospect_id = o.prospect_id
where o.kind = 'initial'
  and o.channel = 'email'
  and o.status = 'sent'
  and not p.do_not_contact
  and o.sent_at <= now() - interval '5 days'
  and d.disabled_at is null
  and d.expires_at > now()
  and not exists (
    select 1 from public.sales_outreaches f
    where f.prospect_id = o.prospect_id and f.kind = 'follow_up' and f.status = 'sent'
  );

revoke all on public.sales_followup_due from public, anon;
grant select on public.sales_followup_due to authenticated, service_role;

-- 送信済み for a follow-up. p_outreach_id is the initial outreach. The
-- subject and body are composed by the server (never typed by the client)
-- and stored as the record of what was sent. Idempotent: a double tap
-- returns the first result. DNC and email eligibility are re-checked by the
-- outreach triggers; the unique index keeps it to one follow-up per shop.
create or replace function public.sales_mark_follow_up_sent(p_outreach_id uuid, p_subject text, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.sales_outreaches;
  f public.sales_outreaches;
  d public.sales_demos;
  sent timestamptz := now();
begin
  perform public.sales_assert_admin();
  o := public.sales_lock_initial(p_outreach_id);

  select * into f from public.sales_outreaches where prospect_id = o.prospect_id and kind = 'follow_up';
  if found and f.status = 'sent' then
    return jsonb_build_object('outreach_id', f.id, 'status', f.status, 'sent_at', f.sent_at, 'replayed', true);
  end if;

  if o.channel <> 'email' or o.status <> 'sent' or o.sent_at > sent - interval '5 days' then
    raise exception 'not_due' using errcode = 'P0001';
  end if;
  select * into d from public.sales_demos where prospect_id = o.prospect_id;
  if not found or d.disabled_at is not null or d.expires_at is null or d.expires_at <= sent then
    raise exception 'demo_unavailable' using errcode = 'P0001';
  end if;

  if f.id is null then
    insert into public.sales_outreaches (prospect_id, kind, channel, subject, body)
      values (o.prospect_id, 'follow_up', 'email', p_subject, p_body)
      returning * into f;
  else
    update public.sales_outreaches set subject = p_subject, body = p_body where id = f.id;
  end if;
  update public.sales_outreaches set status = 'sent', sent_at = sent where id = f.id;

  return jsonb_build_object('outreach_id', f.id, 'status', 'sent', 'sent_at', sent, 'replayed', false);
end;
$$;

revoke all on function public.sales_mark_follow_up_sent(uuid, text, text) from public, anon;
grant execute on function public.sales_mark_follow_up_sent(uuid, text, text) to authenticated;
