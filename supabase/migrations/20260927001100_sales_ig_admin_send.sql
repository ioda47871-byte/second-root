-- Second Root Sales Agent — Instagram reply inbox and human-approved sending (DEV-022 / DEV-023)
--
-- docs/INSTAGRAM_MESSAGING.md §5–§6. Every reply is approved by the human
-- admin (「この内容で返信」) and sent through the official Send API by the
-- server. The database makes that safe to retry:
--   * one send per (draft, exact text): the idempotency key; a sent reply is
--     never sent again, whatever is tapped or retried,
--   * a send whose outcome is unknown (timeout, error after Meta accepted
--     it, crash) is never retried automatically — the human checks
--     Instagram and tells us whether it went out,
--   * a clear failure may be retried with the same key.
-- The Send API is only allowed inside Meta's 24-hour window after the
-- person's last message, to a matched shop that is not DNC.

create table public.sales_ig_sends (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.sales_ig_drafts (id) on delete cascade,
  idempotency_key text not null unique check (idempotency_key ~ '^[0-9a-f-]{36}:[0-9a-f]{64}$'),
  body text not null check (char_length(body) >= 1 and octet_length(body) <= 1000),
  status text not null check (status in ('sending', 'sent', 'failed', 'unknown')),
  attempts integer not null default 1 check (attempts between 1 and 10),
  meta_message_id text check (char_length(meta_message_id) <= 512),
  error_code text check (error_code ~ '^[a-z0-9_]{1,64}$'),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_ig_sends_sent check ((status = 'sent') = (sent_at is not null))
);

create trigger sales_ig_sends_touch
  before update on public.sales_ig_sends
  for each row execute function public.sales_touch_updated_at();

alter table public.sales_ig_sends enable row level security;
create policy sales_ig_sends_admin_read on public.sales_ig_sends
  for select to authenticated using ((select public.is_sales_admin()));
revoke all on public.sales_ig_sends from public, anon, authenticated;
grant select on public.sales_ig_sends to authenticated;
grant all on public.sales_ig_sends to service_role;

-- 返信文を編集 (the server action re-checks the text first).
create or replace function public.sales_ig_update_draft(p_draft_id uuid, p_body text, p_needs_review boolean, p_review_reasons text[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.sales_ig_drafts;
begin
  perform public.sales_assert_admin();
  select * into d from public.sales_ig_drafts where id = p_draft_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if d.status not in ('pending', 'snoozed', 'failed') then
    raise exception 'not_editable' using errcode = 'P0001';
  end if;
  update public.sales_ig_drafts
    set body = p_body, needs_human_review = coalesce(p_needs_review, false),
        review_reasons = coalesce(p_review_reasons, '{}'), status = 'pending', snoozed_until = null
    where id = d.id;
  return jsonb_build_object('draft_id', d.id, 'status', 'pending');
end;
$$;

-- 後で対応 / 戻す.
create or replace function public.sales_ig_snooze_draft(p_draft_id uuid, p_snooze boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.sales_ig_drafts;
begin
  perform public.sales_assert_admin();
  select * into d from public.sales_ig_drafts where id = p_draft_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if d.status not in ('pending', 'snoozed') then
    raise exception 'not_editable' using errcode = 'P0001';
  end if;
  update public.sales_ig_drafts
    set status = case when p_snooze then 'snoozed' else 'pending' end,
        snoozed_until = case when p_snooze then now() + interval '24 hours' else null end
    where id = d.id;
  return jsonb_build_object('draft_id', d.id, 'status', case when p_snooze then 'snoozed' else 'pending' end);
end;
$$;

-- 未照合の返信: the human links it to the shop (one we contacted on
-- Instagram, not DNC) or marks it as unrelated.
create or replace function public.sales_ig_resolve_thread(p_thread_id uuid, p_prospect_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.sales_ig_threads;
begin
  perform public.sales_assert_admin();
  select * into t from public.sales_ig_threads where id = p_thread_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_prospect_id is null then
    -- A reply whose outcome is still open must be settled first.
    if exists (select 1 from public.sales_ig_drafts d where d.thread_id = t.id and d.status in ('sending', 'unknown')) then
      raise exception 'send_open' using errcode = 'P0001';
    end if;
    update public.sales_ig_threads set match_status = 'ignored', prospect_id = null where id = t.id;
    update public.sales_ig_drafts set status = 'superseded' where thread_id = t.id and status in ('pending', 'snoozed', 'failed');
    return jsonb_build_object('thread_id', t.id, 'match_status', 'ignored');
  end if;
  if not exists (
    select 1 from public.sales_prospects p
    where p.id = p_prospect_id and not p.do_not_contact
      and exists (select 1 from public.sales_outreaches o
                  where o.prospect_id = p.id and o.kind = 'initial' and o.channel = 'instagram' and o.sent_at is not null)
  ) then
    raise exception 'invalid_prospect' using errcode = 'P0001';
  end if;
  -- Only an unmatched conversation is linked here; a matched one is never
  -- moved to another shop (its drafts may mention the first shop's demo).
  if t.match_status <> 'unmatched' then
    raise exception 'already_resolved' using errcode = 'P0001';
  end if;
  update public.sales_ig_threads set match_status = 'matched', prospect_id = p_prospect_id where id = t.id;
  return jsonb_build_object('thread_id', t.id, 'match_status', 'matched');
end;
$$;

-- この内容で返信 (1): reserve the send. Returns what the server needs to call
-- the Send API, or the earlier outcome for a replay.
create or replace function public.sales_ig_begin_send(p_draft_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  d public.sales_ig_drafts;
  t public.sales_ig_threads;
  s public.sales_ig_sends;
  key text;
begin
  perform public.sales_assert_admin();
  select * into d from public.sales_ig_drafts where id = p_draft_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  key := d.id::text || ':' || encode(extensions.digest(d.body, 'sha256'), 'hex');

  select * into s from public.sales_ig_sends where idempotency_key = key for update;
  if found then
    if s.status = 'sent' or s.status = 'unknown' then
      return jsonb_build_object('send_id', s.id, 'status', s.status, 'replayed', true);
    end if;
    if s.status = 'sending' then
      -- Another tap is in flight, or the server died mid-call: never resend
      -- on our own. After 2 minutes it becomes unknown for the human.
      if s.updated_at < now() - interval '2 minutes' then
        update public.sales_ig_sends set status = 'unknown', error_code = 'interrupted' where id = s.id;
        update public.sales_ig_drafts set status = 'unknown' where id = d.id;
        return jsonb_build_object('send_id', s.id, 'status', 'unknown', 'replayed', true);
      end if;
      return jsonb_build_object('send_id', s.id, 'status', 'sending', 'replayed', true);
    end if;
  end if;

  if d.status not in ('pending', 'snoozed', 'failed') then
    raise exception 'not_sendable' using errcode = 'P0001';
  end if;
  select * into t from public.sales_ig_threads where id = d.thread_id for update;
  if t.match_status <> 'matched' then
    raise exception 'unmatched' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.sales_prospects p where p.id = t.prospect_id and not p.do_not_contact) then
    raise exception 'do_not_contact' using errcode = 'P0001';
  end if;
  -- Only a reply to the latest message: a draft (e.g. an earlier failed
  -- one) for an older message is retired once a newer message arrived.
  if d.message_id is distinct from (
    select m.id from public.sales_ig_messages m
      where m.thread_id = t.id and m.direction = 'inbound' and m.deleted_at is null
      order by m.sent_at desc, m.received_at desc, m.id desc limit 1
  ) then
    update public.sales_ig_drafts set status = 'superseded' where id = d.id;
    return jsonb_build_object('status', 'stale_draft', 'replayed', true);
  end if;
  if t.last_inbound_at is null or t.last_inbound_at < now() - interval '24 hours' then
    raise exception 'window_closed' using errcode = 'P0001';
  end if;

  if s.id is null then
    insert into public.sales_ig_sends (draft_id, idempotency_key, body, status)
      values (d.id, key, d.body, 'sending') returning * into s;
  else
    -- A clear failure before: retry with the same key.
    if s.attempts >= 10 then
      raise exception 'too_many_attempts' using errcode = 'P0001';
    end if;
    update public.sales_ig_sends set status = 'sending', attempts = attempts + 1, error_code = null
      where id = s.id returning * into s;
  end if;
  update public.sales_ig_drafts set status = 'sending', snoozed_until = null where id = d.id;
  return jsonb_build_object(
    'send_id', s.id, 'attempt', s.attempts, 'status', 'sending', 'replayed', false,
    'account_id', t.ig_account_id, 'igsid', t.igsid, 'body', s.body
  );
end;
$$;

-- この内容で返信 (2): record the outcome of the Send API call.
--   p_attempt: the attempt number begin_send returned; a result for an
--              earlier attempt of the same send is ignored.
--   p_outcome: 'sent' (with Meta's message id) | 'failed' (certainly not sent)
--              | 'unknown' (may have been sent)
create or replace function public.sales_ig_finish_send(p_send_id uuid, p_attempt integer, p_outcome text, p_meta_message_id text, p_error_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.sales_ig_sends;
  d public.sales_ig_drafts;
  follow boolean;
begin
  perform public.sales_assert_admin();
  if p_outcome not in ('sent', 'failed', 'unknown') then
    raise exception 'invalid_outcome' using errcode = '22023';
  end if;
  select * into s from public.sales_ig_sends where id = p_send_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- Only the current attempt of an open send takes a result: 'sending', or
  -- a definite answer for 'unknown' (or for one the human recorded as not
  -- sent, if Meta says it was). Anything else (a duplicate, or a late answer
  -- for an earlier attempt) is a replay and changes nothing.
  if p_attempt is distinct from s.attempts or not (
    s.status = 'sending'
    or (s.status = 'unknown' and p_outcome in ('sent', 'failed'))
    or (s.status = 'failed' and s.error_code = 'confirmed_not_sent' and p_outcome = 'sent')
  ) then
    return jsonb_build_object('send_id', s.id, 'status', s.status, 'replayed', true);
  end if;
  select * into d from public.sales_ig_drafts where id = s.draft_id for update;
  -- The draft follows this send unless another send of it is open (a draft
  -- has at most one open send: begin_send only starts one from an idle draft).
  -- Meta contradicting the human's "not sent": the draft is answered even if
  -- it was edited since (pending / snoozed), so it is not offered again.
  follow := (d.status in ('sending', 'unknown', 'failed')
             or (s.status = 'failed' and d.status in ('pending', 'snoozed'))) and not exists (
    select 1 from public.sales_ig_sends x where x.draft_id = d.id and x.id <> s.id and x.status in ('sending', 'unknown')
  );

  if p_outcome = 'sent' then
    update public.sales_ig_sends
      set status = 'sent', sent_at = now(), meta_message_id = p_meta_message_id, error_code = null
      where id = s.id;
    if follow then
      update public.sales_ig_drafts set status = 'sent' where id = d.id;
    end if;
    -- Record our reply in the conversation (the echo webhook for the same
    -- message id is then skipped as a duplicate).
    if p_meta_message_id is not null then
      insert into public.sales_ig_messages (thread_id, mid, direction, text, sent_at)
        values (d.thread_id, p_meta_message_id, 'outbound', s.body, now())
        on conflict (mid) do nothing;
    end if;
  else
    update public.sales_ig_sends set status = p_outcome, error_code = p_error_code where id = s.id;
    if follow then
      update public.sales_ig_drafts set status = p_outcome where id = d.id;
    end if;
  end if;
  return jsonb_build_object('send_id', s.id, 'status', p_outcome, 'replayed', false);
end;
$$;

-- 送信結果が不明: the human checked Instagram. Sent → recorded as sent
-- (never resent); not sent → the draft can be sent again.
create or replace function public.sales_ig_resolve_unknown(p_send_id uuid, p_was_sent boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.sales_ig_sends;
begin
  perform public.sales_assert_admin();
  select * into s from public.sales_ig_sends where id = p_send_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if s.status <> 'unknown' then
    return jsonb_build_object('send_id', s.id, 'status', s.status, 'replayed', true);
  end if;
  if p_was_sent then
    update public.sales_ig_sends set status = 'sent', sent_at = now(), error_code = 'confirmed_by_admin' where id = s.id;
    update public.sales_ig_drafts set status = 'sent' where id = s.draft_id;
    return jsonb_build_object('send_id', s.id, 'status', 'sent', 'replayed', false);
  end if;
  update public.sales_ig_sends set status = 'failed', error_code = 'confirmed_not_sent' where id = s.id;
  update public.sales_ig_drafts set status = 'failed' where id = s.draft_id;
  return jsonb_build_object('send_id', s.id, 'status', 'failed', 'replayed', false);
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.sales_ig_update_draft(uuid, text, boolean, text[])',
    'public.sales_ig_snooze_draft(uuid, boolean)',
    'public.sales_ig_resolve_thread(uuid, uuid)',
    'public.sales_ig_begin_send(uuid)',
    'public.sales_ig_finish_send(uuid, integer, text, text, text)',
    'public.sales_ig_resolve_unknown(uuid, boolean)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
