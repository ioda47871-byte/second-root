-- Second Root Sales Agent — admin "送信済み" (DEV-010 / DEV-011)
--
-- The human sends the DM / email outside the system, then taps 送信済み.
-- Only the allowlisted admin may call this. It is idempotent (a double tap
-- returns the first result), re-checks DNC and channel eligibility through
-- the outreach triggers, and starts the demo's 30-day public window
-- (MVP_SPEC §7): expires_at = sent_at + 30 days.

create or replace function public.sales_mark_sent(p_outreach_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.sales_outreaches;
  sent timestamptz := now();
begin
  if not public.is_sales_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into o from public.sales_outreaches where id = p_outreach_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if o.status = 'sent' then
    return jsonb_build_object('outreach_id', o.id, 'status', o.status, 'sent_at', o.sent_at, 'replayed', true);
  end if;
  if o.kind <> 'initial' or o.status <> 'drafted' then
    raise exception 'invalid_transition' using errcode = 'P0001';
  end if;

  update public.sales_outreaches set status = 'sent', sent_at = sent where id = o.id;
  update public.sales_demos
    set expires_at = sent + interval '30 days'
    where prospect_id = o.prospect_id and expires_at is null;

  return jsonb_build_object('outreach_id', o.id, 'status', 'sent', 'sent_at', sent, 'replayed', false);
end;
$$;

revoke all on function public.sales_mark_sent(uuid) from public, anon;
grant execute on function public.sales_mark_sent(uuid) to authenticated;
