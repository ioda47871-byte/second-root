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
-- Every other guard is unchanged:
--   - stale without a block is still refused (stale_snapshot);
--   - a changed text revision or channel is still refused, so the outreach's
--     stored text never contradicts what the approval records as sent;
--   - not opened, superseded, admin, duplicate recipient, channel rules,
--     demo missing / disabled (except by DNC, as before) and the design gate
--     still refuse (sales_send_guards with p_confirm_opened, unchanged);
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
  -- PR #239 M2: from send_opened the owner may already have sent it, so a
  -- DNC / exclusion committed since is recorded (blocked_after_open), not
  -- refused. Every other guard still refuses.
  d := public.sales_send_guards(o, p_design_enabled, true);
  v_block := public.sales_outreach_block_reason(o.prospect_id);
  v_stale := not coalesce(public.sales_approval_is_current(a, o, d), false);
  -- DEV-197: a stale snapshot is accepted only for an after-the-fact record
  -- of a blocked shop whose text revision and channel are still the
  -- approval's (the demo or the recipient changed). Otherwise refused as before.
  if v_stale and (v_block is null or a.draft_version <> o.draft_version or a.channel <> o.channel) then
    raise exception 'stale_snapshot' using errcode = 'P0001';
  end if;

  update public.sales_outreaches set status = 'sent', sent_at = sent, blocked_after_open = v_block where id = o.id;
  update public.sales_demos
    set expires_at = sent + interval '30 days'
    where prospect_id = o.prospect_id and expires_at is null;
  update public.sales_outreach_approvals
    set state = 'sent', sent_at = sent, sent_by = auth.uid(), blocked_after_open = v_block, stale_at_send = v_stale
    where id = a.id;

  return jsonb_build_object('outreach_id', o.id, 'status', 'sent', 'sent_at', sent, 'approval_id', a.id,
                            'blocked_after_open', v_block, 'stale_at_send', v_stale, 'replayed', false);
end;
$$;

revoke all on function public.sales_mark_sent(uuid, uuid, boolean) from public, anon;
grant execute on function public.sales_mark_sent(uuid, uuid, boolean) to authenticated;
