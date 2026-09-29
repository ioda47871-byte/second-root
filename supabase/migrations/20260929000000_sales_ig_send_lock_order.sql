-- Second Root Sales Agent — Instagram reply sending: one lock order (DEV-027)
--
-- The send RPCs of migration 001100 took row locks in different orders:
--   * sales_ig_begin_send: draft, then thread, then send,
--   * sales_ig_finish_send / sales_ig_resolve_unknown: send, then draft,
--   * sales_ig_save_draft / sales_ig_resolve_thread (001000 / 001100): thread,
--     then the thread's drafts.
-- On a double tap, the second begin_send (holding the draft, waiting for the
-- send) could overlap the first call's finish_send (holding the send, waiting
-- for the draft): Postgres aborted one of them as a deadlock (40P01). When
-- that was finish_send, a reply Meta had really delivered was left 'sending'
-- and later shown as 'unknown'. The same kind of deadlock was possible
-- between begin_send and save_draft / resolve_thread on the thread.
--
-- The send RPCs now lock in the order the thread-level functions already
-- use: thread, then draft, then send (skipping what they do not need).
-- New functions touching these rows must keep this order. A draft's
-- thread_id and a send's draft_id never change, so they are read first
-- without a lock to know what to lock; every row used afterwards is read
-- under its lock. Otherwise the three functions behave as in 001100;
-- replays and refusals now also wait for those locks.

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
  thread_id_ uuid;
begin
  perform public.sales_assert_admin();
  -- Lock order: thread, draft, send (see the header).
  select x.thread_id into thread_id_ from public.sales_ig_drafts x where x.id = p_draft_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into t from public.sales_ig_threads where id = thread_id_ for update;
  select * into d from public.sales_ig_drafts where id = p_draft_id and thread_id = t.id for update;
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
  draft_id_ uuid;
  thread_id_ uuid;
begin
  perform public.sales_assert_admin();
  if p_outcome not in ('sent', 'failed', 'unknown') then
    raise exception 'invalid_outcome' using errcode = '22023';
  end if;
  -- Lock order: thread, draft, send (see the header). The thread is only
  -- key-share locked: the lock the outbound message insert takes anyway.
  select x.draft_id, y.thread_id into draft_id_, thread_id_
    from public.sales_ig_sends x join public.sales_ig_drafts y on y.id = x.draft_id
    where x.id = p_send_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform 1 from public.sales_ig_threads where id = thread_id_ for key share;
  select * into d from public.sales_ig_drafts where id = draft_id_ for update;
  select * into s from public.sales_ig_sends where id = p_send_id and draft_id = d.id for update;
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
  draft_id_ uuid;
begin
  perform public.sales_assert_admin();
  -- Lock order: draft, then send (see the header; the thread is not touched).
  select x.draft_id into draft_id_ from public.sales_ig_sends x where x.id = p_send_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform 1 from public.sales_ig_drafts where id = draft_id_ for update;
  select * into s from public.sales_ig_sends where id = p_send_id and draft_id = draft_id_ for update;
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

-- Same privileges as 001100 (create or replace keeps them; restated so the
-- intent does not depend on that).
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.sales_ig_begin_send(uuid)',
    'public.sales_ig_finish_send(uuid, integer, text, text, text)',
    'public.sales_ig_resolve_unknown(uuid, boolean)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
