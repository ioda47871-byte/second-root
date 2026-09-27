-- Second Root Sales Agent — Instagram inbound messages (DEV-020)
--
-- docs/INSTAGRAM_MESSAGING.md §3, §7, §8. Messages that people send TO the
-- Second Root Instagram Professional Account arrive through the official
-- Meta webhook (app/api/webhooks/instagram). They are stored here,
-- idempotently, before anything else happens with them:
--   * a webhook delivery is recorded once (sha256 of the raw body; the body
--     itself is never stored),
--   * a message is stored once (Meta's message id `mid`), so Meta's retries,
--     batching and re-deliveries never duplicate anything,
--   * a thread is the conversation with one Instagram-scoped user (IGSID),
--     unmatched until DEV-021 links it to a prospect safely.
-- No token, secret, signature or raw payload is stored. Attachments are kept
-- as their types only (their URLs expire and are not needed).

create table public.sales_ig_webhook_events (
  id uuid primary key default gen_random_uuid(),
  body_sha256 text not null unique check (body_sha256 ~ '^[0-9a-f]{64}$'),
  message_count integer not null check (message_count between 0 and 1000),
  received_at timestamptz not null default now()
);

create table public.sales_ig_threads (
  id uuid primary key default gen_random_uuid(),
  -- Our Instagram professional account id and the other person's IGSID.
  ig_account_id text not null check (ig_account_id ~ '^[0-9]{1,32}$'),
  igsid text not null check (igsid ~ '^[0-9]{1,32}$'),
  username text check (username ~ '^[A-Za-z0-9._]{1,30}$'),
  prospect_id uuid references public.sales_prospects (id) on delete set null,
  match_status text not null default 'unmatched'
    check (match_status in ('unmatched', 'matched', 'ignored')),
  last_inbound_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_ig_threads_matched check ((match_status = 'matched') = (prospect_id is not null)),
  unique (ig_account_id, igsid)
);

create table public.sales_ig_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.sales_ig_threads (id) on delete cascade,
  mid text not null unique check (char_length(mid) between 1 and 512),
  -- inbound: the person wrote to us. outbound: an echo of a message sent from
  -- our account (by the human in the Instagram app, or later by DEV-023).
  direction text not null check (direction in ('inbound', 'outbound')),
  text text check (char_length(text) <= 4000),
  attachment_types text[] not null default '{}'
    check (cardinality(attachment_types) <= 10),
  sent_at timestamptz not null,
  received_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint sales_ig_messages_deleted_text check (deleted_at is null or text is null)
);

create index sales_ig_messages_thread_idx on public.sales_ig_messages (thread_id, sent_at);
create index sales_ig_threads_inbound_idx on public.sales_ig_threads (last_inbound_at desc);

create trigger sales_ig_threads_touch
  before update on public.sales_ig_threads
  for each row execute function public.sales_touch_updated_at();

-- Only the allowlisted admin may read; nothing may be written by API roles.
alter table public.sales_ig_webhook_events enable row level security;
alter table public.sales_ig_threads enable row level security;
alter table public.sales_ig_messages enable row level security;

create policy sales_ig_threads_admin_read on public.sales_ig_threads
  for select to authenticated using ((select public.is_sales_admin()));
create policy sales_ig_messages_admin_read on public.sales_ig_messages
  for select to authenticated using ((select public.is_sales_admin()));
create policy sales_ig_webhook_events_admin_read on public.sales_ig_webhook_events
  for select to authenticated using ((select public.is_sales_admin()));

revoke all on public.sales_ig_webhook_events, public.sales_ig_threads, public.sales_ig_messages
  from public, anon, authenticated;
grant select on public.sales_ig_webhook_events, public.sales_ig_threads, public.sales_ig_messages
  to authenticated;
grant all on public.sales_ig_webhook_events, public.sales_ig_threads, public.sales_ig_messages
  to service_role;

-- Stores one verified webhook delivery in one transaction (service role
-- only, called by the webhook route after the signature check).
--   p_events: [{ account_id, igsid, mid, direction, text, attachment_types,
--                sent_at_ms, is_deleted }]
-- A delivery seen before (same body hash) is a no-op. A message seen before
-- (same mid) is skipped. Returns counts only.
create or replace function public.sales_ig_ingest(p_body_sha256 text, p_events jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  e jsonb;
  t_id uuid;
  m_id uuid;
  inserted integer := 0;
  duplicates integer := 0;
  deleted integer := 0;
  n integer := coalesce(jsonb_array_length(p_events), 0);
begin
  if jsonb_typeof(p_events) is distinct from 'array' or n > 1000 then
    raise exception 'invalid_events' using errcode = '22023';
  end if;

  insert into public.sales_ig_webhook_events (body_sha256, message_count)
    values (p_body_sha256, n)
    on conflict (body_sha256) do nothing;
  if not found then
    return jsonb_build_object('replayed', true, 'inserted', 0, 'duplicates', 0, 'deleted', 0);
  end if;

  for e in select * from jsonb_array_elements(p_events) loop
    insert into public.sales_ig_threads (ig_account_id, igsid)
      values (e->>'account_id', e->>'igsid')
      on conflict (ig_account_id, igsid) do update set igsid = excluded.igsid
      returning id into t_id;

    if coalesce((e->>'is_deleted')::boolean, false) then
      -- The sender unsent the message: keep the record, drop the text.
      update public.sales_ig_messages
        set text = null, deleted_at = coalesce(deleted_at, now())
        where mid = e->>'mid';
      if found then deleted := deleted + 1; end if;
      continue;
    end if;

    insert into public.sales_ig_messages (thread_id, mid, direction, text, attachment_types, sent_at)
      values (
        t_id,
        e->>'mid',
        e->>'direction',
        e->>'text',
        coalesce((select array_agg(x) from jsonb_array_elements_text(e->'attachment_types') x), '{}'),
        to_timestamp((e->>'sent_at_ms')::bigint / 1000.0)
      )
      on conflict (mid) do nothing
      returning id into m_id;

    if m_id is null then
      duplicates := duplicates + 1;
    else
      inserted := inserted + 1;
      if e->>'direction' = 'inbound' then
        update public.sales_ig_threads
          set last_inbound_at = greatest(coalesce(last_inbound_at, '-infinity'::timestamptz),
                                         to_timestamp((e->>'sent_at_ms')::bigint / 1000.0))
          where id = t_id;
      end if;
    end if;
    m_id := null;
  end loop;

  return jsonb_build_object('replayed', false, 'inserted', inserted, 'duplicates', duplicates, 'deleted', deleted);
end;
$$;

revoke all on function public.sales_ig_ingest(text, jsonb) from public, anon, authenticated;
grant execute on function public.sales_ig_ingest(text, jsonb) to service_role;
