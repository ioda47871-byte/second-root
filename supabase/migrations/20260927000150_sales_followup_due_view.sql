-- Second Root Sales Agent — due email follow-ups (DEV-009 / DEV-014)
--
-- Computed in SQL so the admin queue never truncates before filtering:
-- initial email outreaches sent 5+ days ago, still unanswered (status
-- sent), with no follow-up sent yet, for shops that are not DNC. The view
-- runs with the caller's rights, so row level security still applies (only
-- the allowlisted admin sees rows).

create view public.sales_followup_due
with (security_invoker = true)
as
select o.id as outreach_id, o.prospect_id, o.sent_at
from public.sales_outreaches o
join public.sales_prospects p on p.id = o.prospect_id
where o.kind = 'initial'
  and o.channel = 'email'
  and o.status = 'sent'
  and not p.do_not_contact
  and o.sent_at <= now() - interval '5 days'
  and not exists (
    select 1 from public.sales_outreaches f
    where f.prospect_id = o.prospect_id and f.kind = 'follow_up' and f.status = 'sent'
  );

revoke all on public.sales_followup_due from public, anon;
grant select on public.sales_followup_due to authenticated, service_role;
