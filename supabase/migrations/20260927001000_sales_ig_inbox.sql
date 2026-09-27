-- Second Root Sales Agent — Instagram inbox: matching, classification, drafts (DEV-021)
--
-- docs/INSTAGRAM_MESSAGING.md §4–§5.
--   * A thread is linked to a prospect only when it is unambiguous: the
--     sender's Instagram username (from the official API) equals the handle
--     of the one prospect we already contacted on Instagram. Otherwise it
--     stays unmatched for a human to decide (never guessed).
--   * Operational Claude reads pending conversations and submits a
--     classification and a short reply draft through the ingest API. It
--     cannot send, change DNC or change outcomes. Sending needs a human
--     (DEV-022 / DEV-023).
--   * An explicit refusal of future contact only raises dnc_candidate; a
--     human decides (the existing admin RPCs set DNC).

-- Drafting attempts per conversation: a message the drafter keeps failing
-- on is backed off, so it can never starve newer conversations.
alter table public.sales_ig_threads
  add column draft_attempt_message_id uuid,
  add column draft_attempts integer not null default 0 check (draft_attempts between 0 and 100);

create table public.sales_ig_drafts (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.sales_ig_threads (id) on delete cascade,
  -- The inbound message this draft answers.
  message_id uuid not null references public.sales_ig_messages (id) on delete cascade,
  reply_type text not null check (reply_type in ('interested', 'question', 'meeting_request', 'decline', 'other')),
  body text not null check (char_length(body) >= 1 and octet_length(body) <= 1000),
  dnc_candidate boolean not null default false,
  needs_human_review boolean not null default false,
  review_reasons text[] not null default '{}' check (cardinality(review_reasons) <= 10),
  status text not null default 'pending'
    check (status in ('pending', 'snoozed', 'superseded', 'sending', 'sent', 'failed', 'unknown')),
  snoozed_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (message_id)
);

-- At most one open draft per conversation.
create unique index sales_ig_drafts_open_key
  on public.sales_ig_drafts (thread_id) where status in ('pending', 'snoozed');

create trigger sales_ig_drafts_touch
  before update on public.sales_ig_drafts
  for each row execute function public.sales_touch_updated_at();

alter table public.sales_ig_drafts enable row level security;
create policy sales_ig_drafts_admin_read on public.sales_ig_drafts
  for select to authenticated using ((select public.is_sales_admin()));
revoke all on public.sales_ig_drafts from public, anon, authenticated;
grant select on public.sales_ig_drafts to authenticated;
grant all on public.sales_ig_drafts to service_role;

-- Records the sender's username and links the thread when exactly one
-- prospect we contacted on Instagram has that handle. Never unlinks and
-- never overrides a human decision (matched / ignored stay as they are).
create or replace function public.sales_ig_match_thread(p_thread_id uuid, p_username text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  t public.sales_ig_threads;
  handle text := lower(p_username);
  pid uuid;
begin
  select * into t from public.sales_ig_threads where id = p_thread_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_username is null or p_username !~ '^[A-Za-z0-9._]{1,30}$' then
    return t.match_status;
  end if;
  update public.sales_ig_threads set username = p_username where id = t.id and username is distinct from p_username;
  if t.match_status <> 'unmatched' then
    return t.match_status;
  end if;

  select p.id into pid
    from public.sales_prospects p
    where p.instagram_handle = handle
      and exists (
        select 1 from public.sales_outreaches o
        where o.prospect_id = p.id and o.kind = 'initial' and o.channel = 'instagram' and o.sent_at is not null
      );
  -- instagram_handle is unique, so this is at most one prospect.
  if pid is null then
    return 'unmatched';
  end if;
  update public.sales_ig_threads set prospect_id = pid, match_status = 'matched' where id = t.id;
  return 'matched';
end;
$$;

-- Conversations that need a draft: the latest inbound message has no draft
-- yet, the thread is not ignored, and a matched shop is not DNC. Returns the
-- minimum needed to write a reply: recent messages (text only) and the
-- matched shop's public facts. Oldest first so nothing waits forever.
create or replace function public.sales_ig_inbox_pending(p_limit integer)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with latest as (
    select distinct on (m.thread_id) m.thread_id, m.id as message_id, m.sent_at
    from public.sales_ig_messages m
    where m.direction = 'inbound' and m.deleted_at is null
    -- Same tie-break as sales_ig_save_draft: the newest message wins even
    -- when timestamps are equal.
    order by m.thread_id, m.sent_at desc, m.received_at desc, m.id desc
  ), pending as (
    select l.*, t.match_status, t.prospect_id, t.username
    from latest l
    join public.sales_ig_threads t on t.id = l.thread_id
    left join public.sales_prospects p on p.id = t.prospect_id
    where t.match_status <> 'ignored'
      and coalesce(p.do_not_contact, false) = false
      and not exists (select 1 from public.sales_ig_drafts d where d.message_id = l.message_id)
      -- Backed off after 3 failed drafting attempts on the same message
      -- (still visible to the human in the inbox, just not drafted).
      and not (t.draft_attempt_message_id = l.message_id and t.draft_attempts >= 3)
    -- Conversations still inside Meta's 24-hour reply window first.
    order by (l.sent_at > now() - interval '24 hours') desc, l.sent_at
    limit least(greatest(p_limit, 1), 20)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'thread_id', pe.thread_id,
    'message_id', pe.message_id,
    'match_status', pe.match_status,
    'messages', (
      select coalesce(jsonb_agg(jsonb_build_object('direction', x.direction, 'text', x.text,
                                                   'attachment_types', x.attachment_types, 'sent_at', x.sent_at)
                                order by x.sent_at), '[]'::jsonb)
      from (select * from public.sales_ig_messages mm
            where mm.thread_id = pe.thread_id and mm.deleted_at is null
            order by mm.sent_at desc limit 10) x
    ),
    'shop', case when pe.prospect_id is null then null else (
      select jsonb_build_object(
        'name', p.name, 'category', p.category, 'ward', p.ward,
        'demo_token', (select d.public_token from public.sales_demos d
                       where d.prospect_id = p.id and d.disabled_at is null and d.expires_at is not null
                         and (d.keep_alive or d.expires_at > now())),
        'initial_outreach', (select jsonb_build_object('status', o.status, 'reply_type', o.reply_type, 'body', o.body)
                             from public.sales_outreaches o where o.prospect_id = p.id and o.kind = 'initial')
      ) from public.sales_prospects p where p.id = pe.prospect_id
    ) end
  ) order by (pe.sent_at > now() - interval '24 hours') desc, pe.sent_at), '[]'::jsonb)
  from pending pe
$$;

-- Saves the draft for the latest inbound message of a thread (service role
-- only; validation of the text happens in lib/instagram/draft.ts first).
-- Re-sending the same draft is idempotent; a draft for an older message is
-- refused; a newer message supersedes the open draft.
create or replace function public.sales_ig_save_draft(
  p_thread_id uuid, p_message_id uuid, p_reply_type text, p_body text,
  p_dnc_candidate boolean, p_needs_review boolean, p_review_reasons text[]
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  t public.sales_ig_threads;
  latest uuid;
  existing public.sales_ig_drafts;
  saved public.sales_ig_drafts;
begin
  select * into t from public.sales_ig_threads where id = p_thread_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if t.match_status = 'ignored' or exists (
    select 1 from public.sales_prospects p where p.id = t.prospect_id and p.do_not_contact
  ) then
    raise exception 'not_draftable' using errcode = 'P0001';
  end if;

  select m.id into latest from public.sales_ig_messages m
    where m.thread_id = t.id and m.direction = 'inbound' and m.deleted_at is null
    order by m.sent_at desc, m.received_at desc, m.id desc limit 1;
  if latest is distinct from p_message_id then
    raise exception 'stale_message' using errcode = 'P0001';
  end if;

  select * into existing from public.sales_ig_drafts where message_id = p_message_id;
  if found then
    if existing.status <> 'pending' then
      -- Already approved / sending / sent / snoozed by the human: never overwrite.
      return jsonb_build_object('draft_id', existing.id, 'status', existing.status, 'replayed', true);
    end if;
    -- A re-submission never changes text a human may be reviewing, and a
    -- warning once raised (DNC candidate, needs review) is never cleared.
    update public.sales_ig_drafts
      set dnc_candidate = dnc_candidate or coalesce(p_dnc_candidate, false),
          needs_human_review = needs_human_review or coalesce(p_needs_review, false),
          review_reasons = (select coalesce(array_agg(distinct r), '{}')
                            from unnest(review_reasons || coalesce(p_review_reasons, '{}')) r)
      where id = existing.id
      returning * into saved;
    return jsonb_build_object('draft_id', saved.id, 'status', saved.status, 'replayed', true);
  end if;

  update public.sales_ig_drafts set status = 'superseded'
    where thread_id = t.id and status in ('pending', 'snoozed');
  insert into public.sales_ig_drafts (thread_id, message_id, reply_type, body, dnc_candidate, needs_human_review, review_reasons)
    values (t.id, p_message_id, p_reply_type, p_body, coalesce(p_dnc_candidate, false), coalesce(p_needs_review, false), coalesce(p_review_reasons, '{}'))
    returning * into saved;
  return jsonb_build_object('draft_id', saved.id, 'status', saved.status, 'replayed', false);
end;
$$;

-- Records a failed drafting attempt (invalid draft) for the back-off above.
create or replace function public.sales_ig_note_draft_failure(p_thread_id uuid, p_message_id uuid)
returns void
language sql
set search_path = ''
as $$
  update public.sales_ig_threads
    set draft_attempts = case when draft_attempt_message_id = p_message_id then least(draft_attempts + 1, 100) else 1 end,
        draft_attempt_message_id = p_message_id
    where id = p_thread_id
$$;

revoke all on function public.sales_ig_note_draft_failure(uuid, uuid) from public, anon, authenticated;
grant execute on function public.sales_ig_note_draft_failure(uuid, uuid) to service_role;
revoke all on function public.sales_ig_match_thread(uuid, text) from public, anon, authenticated;
revoke all on function public.sales_ig_inbox_pending(integer) from public, anon, authenticated;
revoke all on function public.sales_ig_save_draft(uuid, uuid, text, text, boolean, boolean, text[]) from public, anon, authenticated;
grant execute on function public.sales_ig_match_thread(uuid, text) to service_role;
grant execute on function public.sales_ig_inbox_pending(integer) to service_role;
grant execute on function public.sales_ig_save_draft(uuid, uuid, text, text, boolean, boolean, text[]) to service_role;
