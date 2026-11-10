-- DEV-197 (DEV-195 final review L2): a real send recorded after a block is
-- never lost because the demo or the recipient changed meanwhile.
--
-- Before: an opened approval (send_opened) whose shop became DNC / excluded
-- could be recorded after the fact (blocked_after_open, PR #239 M2), but only
-- while its snapshot was still current. If the demo (e.g. the AI design) or the
-- recipient had also changed since the send screen was opened, sales_mark_sent
-- refused with stale_snapshot, and the owner — who really did send it — could
-- only press 送らなかった. The send fact was lost.
--
-- Now, only in that case (send_opened, DNC / exclusion found inside this
-- transaction, the outreach's text revision and channel still those of the
-- approval), the send is recorded with the approval's own snapshot (what the
-- owner opened and sent), and sales_outreach_approvals.stale_at_send = true
-- records "recorded after a block, snapshot stale" in the audit trail.
--
-- Review round 1 (L1): on that after-the-fact path the shop's *current*
-- recipient no longer refuses the record (it was cleared, or is now another
-- outreach's address): the approval's own recipient — present and
-- de-duplicated when the send screen was opened — is what was sent, and the
-- channel rules are judged on it (sales_assert_recorded_channel; the outreach
-- trigger does the same with the sent approval's recipient).
--
-- Unchanged:
--   - a normal send (no DNC / exclusion): sales_send_guards and the current
--     snapshot, exactly as 20261107000000; stale without a block is refused;
--   - a changed text revision or channel is refused, also after a block, so
--     the outreach's stored text never contradicts what the approval records;
--   - not opened, superseded, admin, the locks, demo missing / disabled
--     (except by DNC) and the design gate still refuse;
--   - after a block, the channel rules still refuse on the recorded recipient
--     (e.g. its first-party email source was deleted);
--   - the follow-up stays forbidden (blocked_after_open is set, as before).
-- No new send path: nothing here opens, sends or approves anything.
--
-- Forward-only. sales_mark_sent keeps its signature; create or replace keeps
-- its grants, which are restated below exactly as 20261107000000 set them.

alter table public.sales_outreach_approvals
  add column stale_at_send boolean not null default false;

-- Only a sent approval recorded after a block can carry it. A sent approval is
-- final (sales_check_approval_write: approval_final_immutable), so the flag is
-- written once, on the send_opened -> sent transition, and never changed.
alter table public.sales_outreach_approvals
  add constraint sales_outreach_approvals_stale_at_send
  check (not stale_at_send or (state = 'sent' and blocked_after_open is not null));

comment on column public.sales_outreach_approvals.stale_at_send is
  'DEV-197: true when the send was recorded after a block (blocked_after_open) although the demo / recipient had changed since approval; the approval snapshot is what was sent.';

-- Review round 1 L1: the channel rules of an after-the-fact record, judged on
-- the recipient the approval recorded (what was sent), not on the shop's
-- current recipient (which may have been cleared or changed after the send).
--   email:     the recorded address still has a first-party source row
--   instagram: the shop has no website (re-searched), as at approval
-- The recommended channel is not re-checked: it chooses the channel of a new
-- send, and a table check ties it to the current recipient (clearing the
-- public email also clears recommended_channel = 'email'), so re-checking it
-- would refuse exactly the cleared-recipient record this path exists for.
-- Internal: no API role can execute it.
create function public.sales_assert_recorded_channel(p_prospect_id uuid, p_kind text, p_channel text, p_recipient text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  p public.sales_prospects%rowtype;
begin
  select * into p from public.sales_prospects where id = p_prospect_id;
  if p_recipient is null then
    raise exception 'recipient_missing' using errcode = 'P0001';
  end if;
  if p_channel = 'instagram' and p.website_status is distinct from 'not_found' then
    raise exception 'instagram_not_eligible' using errcode = 'check_violation';
  end if;
  if p_channel = 'email' and not public.sales_has_first_party_email(p.id, p_recipient) then
    raise exception 'email_not_eligible' using errcode = 'check_violation';
  end if;
end;
$$;

revoke all on function public.sales_assert_recorded_channel(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.sales_assert_recorded_channel(uuid, text, text, text) to service_role;

create or replace function public.sales_mark_sent(p_outreach_id uuid, p_approval_id uuid, p_design_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.sales_outreaches;
  a public.sales_outreach_approvals;
  d public.sales_demos;
  sent timestamptz := now();
  v_block text;
  v_stale boolean;
begin
  perform public.sales_assert_admin();
  select * into o from public.sales_outreaches where id = p_outreach_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into a from public.sales_outreach_approvals where id = p_approval_id and outreach_id = o.id for update;
  if not found then
    raise exception 'approval_required' using errcode = 'P0001';
  end if;
  if o.status = 'sent' and a.state = 'sent' then
    return jsonb_build_object('outreach_id', o.id, 'status', o.status, 'sent_at', o.sent_at, 'approval_id', a.id,
                              'blocked_after_open', o.blocked_after_open, 'stale_at_send', a.stale_at_send,
                              'replayed', true);
  end if;
  if o.kind <> 'initial' or o.status <> 'drafted' then
    raise exception 'invalid_transition' using errcode = 'P0001';
  end if;
  if a.state = 'approved' then
    raise exception 'not_opened' using errcode = 'P0001';
  end if;
  if a.state <> 'send_opened' then
    raise exception 'stale_snapshot' using errcode = 'P0001';
  end if;
  -- Same lock order as sales_send_guards (exclusion lock shared, then the
  -- prospect, then the demo), so DNC / exclusion read here is final for this
  -- transaction (sales_set_dnc and sales_add_exclusion wait for us).
  perform pg_advisory_xact_lock_shared(hashtext('second_root_sales_exclusions'));
  perform 1 from public.sales_prospects where id = o.prospect_id for update;
  v_block := public.sales_outreach_block_reason(o.prospect_id);

  if v_block is null then
    -- A normal send: every guard of 20261107000000, unchanged (DNC / exclusion
    -- cannot apply here), and the snapshot must be current.
    d := public.sales_send_guards(o, p_design_enabled, true);
    if not coalesce(public.sales_approval_is_current(a, o, d), false) then
      raise exception 'stale_snapshot' using errcode = 'P0001';
    end if;
    v_stale := false;
  else
    -- PR #239 M2 + DEV-197: an after-the-fact record of a send made from this
    -- opened approval before the shop became DNC / excluded. The approval was
    -- checked by every guard (recipient present, no duplicate recipient,
    -- channel rules, demo, design) when the send screen was opened, and its
    -- snapshot (recipient included) is what was sent. The shop's *current*
    -- recipient (cleared, or now another outreach's address) describes the
    -- shop after the send and does not refuse the record of it (review round
    -- 1 L1): no current-recipient / duplicate check; the channel rules are
    -- judged on the approval's recipient.
    -- Still refused: a changed text revision or channel, the channel rules on
    -- the recorded recipient (e.g. its first-party email source deleted), a
    -- missing demo, a demo disabled other than by DNC, a pending design (step on).
    if a.draft_version <> o.draft_version or a.channel <> o.channel then
      raise exception 'stale_snapshot' using errcode = 'P0001';
    end if;
    perform public.sales_assert_recorded_channel(o.prospect_id, o.kind, o.channel, a.recipient);
    select * into d from public.sales_demos where prospect_id = o.prospect_id for update;
    if not found or (d.disabled_at is not null and v_block is distinct from 'do_not_contact') then
      raise exception 'demo_unavailable' using errcode = 'P0001';
    end if;
    if coalesce(p_design_enabled, false) and d.design_status in ('pending', 'processing') then
      raise exception 'design_pending' using errcode = 'P0001';
    end if;
    v_stale := not coalesce(public.sales_approval_is_current(a, o, d), false);
  end if;

  -- The approval first: the outreach trigger judges an after-the-fact record
  -- on the recipient of the sent approval.
  update public.sales_outreach_approvals
    set state = 'sent', sent_at = sent, sent_by = auth.uid(), blocked_after_open = v_block, stale_at_send = v_stale
    where id = a.id;
  update public.sales_outreaches set status = 'sent', sent_at = sent, blocked_after_open = v_block where id = o.id;
  update public.sales_demos
    set expires_at = sent + interval '30 days'
    where prospect_id = o.prospect_id and expires_at is null;

  return jsonb_build_object('outreach_id', o.id, 'status', 'sent', 'sent_at', sent, 'approval_id', a.id,
                            'blocked_after_open', v_block, 'stale_at_send', v_stale, 'replayed', false);
end;
$$;

revoke all on function public.sales_mark_sent(uuid, uuid, boolean) from public, anon;
grant execute on function public.sales_mark_sent(uuid, uuid, boolean) to authenticated;

-- Outreach state machine: identical to 20261107000000 except the
-- blocked_after_open branch of the sent transition, which judges the channel
-- rules on the recipient of the outreach's sent approval instead of the shop's
-- current recipient (review round 1 L1: a cleared or changed public email must
-- not erase the record of a send made before it), and requires that sent
-- approval to exist. It still requires the flag to match the shop's state now
-- (DNC / excluded), the drafted -> sent transition, and that the flag is
-- written only then. API roles cannot write the table.
create or replace function public.sales_check_outreach_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  allowed boolean;
  v_recipient text;
begin
  if new.prospect_id <> old.prospect_id or new.kind <> old.kind or new.channel <> old.channel
     or new.run_id is distinct from old.run_id or new.created_at <> old.created_at then
    raise exception 'outreach_identity_immutable' using errcode = 'check_violation';
  end if;
  if new.blocked_after_open is distinct from old.blocked_after_open
     and not (old.status = 'drafted' and new.status = 'sent' and old.blocked_after_open is null) then
    raise exception 'blocked_after_open_immutable' using errcode = 'check_violation';
  end if;

  if new.status = old.status then
    return new;
  end if;

  allowed := case old.status
    when 'drafted' then new.status in ('sent', 'lost')
    when 'sent' then new.status in ('replied', 'lost')
    when 'replied' then new.status in ('meeting', 'lost')
    when 'meeting' then new.status in ('won', 'lost')
    else false
  end;
  if not allowed then
    raise exception 'invalid_transition:%->%', old.status, new.status using errcode = 'check_violation';
  end if;

  if new.status = 'sent' then
    if new.blocked_after_open is not null then
      if public.sales_outreach_block_reason(new.prospect_id) is distinct from new.blocked_after_open then
        raise exception 'blocked_after_open_mismatch' using errcode = 'check_violation';
      end if;
      select a.recipient into v_recipient
        from public.sales_outreach_approvals a
        where a.outreach_id = new.id and a.state = 'sent' and a.blocked_after_open is not distinct from new.blocked_after_open;
      if not found then
        raise exception 'approval_required' using errcode = 'check_violation';
      end if;
      perform public.sales_assert_recorded_channel(new.prospect_id, new.kind, new.channel, v_recipient);
    else
      perform public.sales_assert_outreach_eligible(new.prospect_id, new.kind, new.channel);
    end if;
  end if;
  return new;
end;
$$;
