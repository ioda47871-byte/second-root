-- Second Root Sales Agent — lightweight metrics (DEV-013)
--
-- One row per (dimension, value) with funnel counts for initial outreaches
-- that were sent. Computed by SQL, no AI. security_invoker: row level
-- security applies, so only the allowlisted admin sees numbers.

create view public.sales_metrics
with (security_invoker = true)
as
with facts as (
  select
    o.channel,
    p.category,
    p.website_status,
    case when exists (
      select 1 from public.sales_outreaches f
      where f.prospect_id = o.prospect_id and f.kind = 'follow_up' and f.status = 'sent'
    ) then 'yes' else 'no' end as followed_up,
    o.reply_type is not null as replied,
    o.meeting_at is not null as met,
    o.status = 'won' as won,
    coalesce(o.won_amount_jpy, 0)::bigint as amount
  from public.sales_outreaches o
  join public.sales_prospects p on p.id = o.prospect_id
  where o.kind = 'initial' and o.sent_at is not null
)
select
  case
    when grouping(channel) = 0 then 'channel'
    when grouping(category) = 0 then 'category'
    when grouping(website_status) = 0 then 'website_status'
    when grouping(followed_up) = 0 then 'follow_up'
    else 'total'
  end as dimension,
  coalesce(channel, category, website_status, followed_up, 'all') as value,
  count(*)::integer as sent,
  count(*) filter (where replied)::integer as replied,
  count(*) filter (where met)::integer as meetings,
  count(*) filter (where won)::integer as won,
  coalesce(sum(amount) filter (where won), 0)::bigint as won_amount_jpy
from facts
group by grouping sets ((channel), (category), (website_status), (followed_up), ());

revoke all on public.sales_metrics from public, anon;
grant select on public.sales_metrics to authenticated, service_role;
