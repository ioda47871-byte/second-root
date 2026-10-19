-- Second Root Sales Agent — sales funnel by preparation day (DEV-057)
--
-- Additive only: sales_metrics (DEV-013) is unchanged. Two read-only views,
-- aggregated by SQL (no AI), one row per Asia/Tokyo preparation day so the
-- admin screen can sum any period (直近 30 日 / 全期間) in plain code:
--
--   * sales_funnel_daily: the initial outreaches (kind = 'initial') created
--     on that JST day — the cohort is the preparation day, so every stage of
--     one period counts the same shops and the rates stay consistent.
--   * sales_design_daily: the AI design result of the same cohort's demos
--     (design_status not null). The screen reads it only with the AI design
--     step on (SALES_AI_DESIGN_ENABLED), like every other design column.
--
-- Stage definitions (docs/MVP_SPEC.md §9), all from the state machine
-- columns of the initial outreach:
--   prepared  every initial outreach (they all start as drafted)
--   skipped   status = 'lost' and sent_at is null   (見送り: closed before sending)
--   unsent    status = 'drafted'                     (still waiting to be sent)
--   sent      sent_at is not null
--   replied   reply_type is not null
--   meetings  meeting_at is not null
--   won       status = 'won' (won_amount_jpy is set exactly then)
--   dnc       the shop is currently do_not_contact
-- sent / replied / meetings / won use the same tests as sales_metrics, so
-- the all-time funnel equals sales_metrics' total row.
--
-- security_invoker: the caller's row level security applies, so only the
-- allowlisted admin sees any row (everyone else sees an empty view).

create view public.sales_funnel_daily
with (security_invoker = true)
as
select
  (o.created_at at time zone 'Asia/Tokyo')::date as prepared_on,
  count(*)::integer as prepared,
  count(*) filter (where o.status = 'lost' and o.sent_at is null)::integer as skipped,
  count(*) filter (where o.status = 'drafted')::integer as unsent,
  count(*) filter (where o.sent_at is not null)::integer as sent,
  count(*) filter (where o.reply_type is not null)::integer as replied,
  count(*) filter (where o.meeting_at is not null)::integer as meetings,
  count(*) filter (where o.status = 'won')::integer as won,
  coalesce(sum(o.won_amount_jpy) filter (where o.status = 'won'), 0)::bigint as won_amount_jpy,
  count(*) filter (where o.reply_type = 'interested')::integer as reply_interested,
  count(*) filter (where o.reply_type = 'question')::integer as reply_question,
  count(*) filter (where o.reply_type = 'meeting_request')::integer as reply_meeting_request,
  count(*) filter (where o.reply_type = 'decline')::integer as reply_decline,
  count(*) filter (where o.reply_type = 'other')::integer as reply_other,
  count(*) filter (where p.do_not_contact)::integer as dnc
from public.sales_outreaches o
join public.sales_prospects p on p.id = o.prospect_id
where o.kind = 'initial'
group by 1;

create view public.sales_design_daily
with (security_invoker = true)
as
select
  (o.created_at at time zone 'Asia/Tokyo')::date as prepared_on,
  d.design_status,
  d.design_error_code,
  count(*)::integer as demos
from public.sales_demos d
join public.sales_outreaches o on o.prospect_id = d.prospect_id and o.kind = 'initial'
where d.design_status is not null
group by 1, 2, 3;

-- Read-only (the views aggregate; no write grant at all, not even the default
-- privileges Supabase gives service_role on new objects).
revoke all on public.sales_funnel_daily, public.sales_design_daily from public, anon, authenticated, service_role;
grant select on public.sales_funnel_daily, public.sales_design_daily to authenticated, service_role;
