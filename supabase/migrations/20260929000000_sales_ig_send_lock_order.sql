-- Second Root Sales Agent — Instagram reply sending: one lock order (DEV-027)
--
-- sales_ig_begin_send locks the draft and then its send, but
-- sales_ig_finish_send and sales_ig_resolve_unknown (migration 001100) lock
-- the send and then the draft. On a double tap, the second begin_send
-- (holding the draft, waiting for the send) could overlap the first call's
-- finish_send (holding the send, waiting for the draft): Postgres aborted one
-- of them as a deadlock (40P01). When that was finish_send, a reply Meta had
-- really delivered was left 'sending' and later shown as 'unknown'.
--
-- Both functions now take the draft lock first and the send lock second,
-- the same order as begin_send. A send's draft_id never changes, so it is
-- read without a lock to find the draft, and the send is then re-read under
-- its lock. Everything else is unchanged from 001100.

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
  -- Lock order: draft, then send (as in begin_send).
  select * into s from public.sales_ig_sends where id = p_send_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into d from public.sales_ig_drafts where id = s.draft_id for update;
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
  -- Lock order: draft, then send (as in begin_send).
  select * into s from public.sales_ig_sends where id = p_send_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform 1 from public.sales_ig_drafts where id = s.draft_id for update;
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

-- Same privileges as 001100 (create or replace keeps them; restated so the
-- intent does not depend on that).
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.sales_ig_finish_send(uuid, integer, text, text, text)',
    'public.sales_ig_resolve_unknown(uuid, boolean)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;
