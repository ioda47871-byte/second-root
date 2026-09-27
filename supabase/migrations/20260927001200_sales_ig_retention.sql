-- Second Root Sales Agent — Instagram conversation retention (DEV-024)
--
-- docs/INSTAGRAM_MESSAGING.md §8. Conversations are kept only as long as the
-- sales follow-up needs them:
--   * a conversation (thread, messages, drafts, send records) is deleted
--     180 days after its last message, unless a send is still waiting for
--     the human to confirm whether it went out ('sending' / 'unknown');
--   * webhook delivery fingerprints are deleted after 30 days. The webhook
--     ignores events older than 7 days (Meta retries for at most 36 hours),
--     so a replayed old delivery can never re-create deleted messages.
-- Sales outcomes live in sales_outreaches / sales_prospects and are not
-- touched here.

create or replace function public.sales_ig_purge()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  events integer;
  threads integer;
begin
  delete from public.sales_ig_webhook_events where received_at < now() - interval '30 days';
  get diagnostics events = row_count;

  delete from public.sales_ig_threads t
    where coalesce(
            (select max(greatest(m.sent_at, m.received_at)) from public.sales_ig_messages m where m.thread_id = t.id),
            t.created_at
          ) < now() - interval '180 days'
      and t.created_at < now() - interval '180 days'
      and not exists (
        select 1 from public.sales_ig_drafts d where d.thread_id = t.id and d.status in ('sending', 'unknown')
      )
      and not exists (
        select 1 from public.sales_ig_sends s join public.sales_ig_drafts d on d.id = s.draft_id
          where d.thread_id = t.id and s.status in ('sending', 'unknown')
      );
  get diagnostics threads = row_count;

  return jsonb_build_object('events', events, 'threads', threads);
end;
$$;

revoke all on function public.sales_ig_purge() from public, anon, authenticated;
grant execute on function public.sales_ig_purge() to service_role;
