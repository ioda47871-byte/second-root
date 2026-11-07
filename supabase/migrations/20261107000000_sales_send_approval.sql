-- Second Root Sales Agent — editable drafts, send approval and the two-step
-- manual send (DEV-195, Issue #235 step 2; owner GO 2026-11-07)
--
-- docs/MVP_SPEC.md §3.5.1, §4 and docs/ARCHITECTURE.md §4. Nothing here sends
-- anything: every initial message is still sent by the owner, by hand, from
-- their own mail app or Instagram. What changes is what the database records
-- and refuses around that manual send:
--
--   1. Editable draft. The owner may edit the message (and the email subject)
--      of an unsent initial outreach. Every edit is kept (old and new text,
--      who, when) and bumps sales_outreaches.draft_version.
--   2. Send approval. Before sending, the owner approves one exact snapshot:
--      approver, recipient, the full subject / body as shown (demo URL,
--      disclaimer and opt-out line included), channel, the demo version the
--      recipient will see, mode (always 'manual' here) and timestamps.
--   3. Guards in the database, at approval and again at 送信済み: DNC,
--      eligibility (channel rules, recommended channel), the exclusion list
--      (new: also on every eligibility check, so 送信済み and the follow-up
--      refuse a shop excluded after its draft was made), duplicate recipient,
--      a usable demo and (with the AI design step on) the design gate. Row
--      locks serialise two approvals / sends of one outreach; a unique index
--      keeps at most one live approval per outreach; an advisory lock
--      serialises sends with sales_add_exclusion.
--   4. Two manual states. approve → send_opened (the owner opened the mail
--      app / the Instagram profile / copied the text) → sent (the owner
--      confirms they really sent it). sales_mark_sent now requires an opened
--      approval whose snapshot still matches the draft, the recipient and the
--      demo. Nothing records a send on its own.
--      PR #239 review (M2): a send the owner confirms from send_opened is
--      recorded even if a DNC / exclusion was committed after the send screen
--      was opened (it may really have gone out); the outreach and the
--      approval carry blocked_after_open, and no follow-up is ever offered or
--      recorded for it. Nothing is relaxed for approving or for opening.
--   5. Selection rationale and improvement hypothesis, with provenance
--      (ingest run or owner, who, when). Optional; never filled in by the
--      database.
--
-- Forward-only. Not applied to any hosted project by this change.

-- ---------------------------------------------------------------------------
-- 1. Draft revision and edit history
-- ---------------------------------------------------------------------------

alter table public.sales_outreaches
  add column draft_version integer not null default 1 check (draft_version >= 1),
  add column edited_at timestamptz,
  add column edited_by uuid,
  -- PR #239 M2: confirmed from send_opened while the shop was already DNC /
  -- excluded (the reason at confirm time). Never followed up.
  add column blocked_after_open text check (blocked_after_open in ('do_not_contact', 'excluded')),
  add constraint sales_outreaches_blocked_after_open check (blocked_after_open is null or (kind = 'initial' and status <> 'drafted'));

-- Any change of the text (by the edit function, or anything else) moves the
-- revision on, so an approval of the earlier text can never be confirmed.
create function public.sales_bump_draft_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.draft_version < old.draft_version then
    raise exception 'draft_version_backwards' using errcode = 'check_violation';
  end if;
  if (new.subject is distinct from old.subject or new.body is distinct from old.body)
     and new.draft_version = old.draft_version then
    new.draft_version := old.draft_version + 1;
  end if;
  return new;
end;
$$;

create trigger sales_outreaches_draft_version
  before update of subject, body, draft_version on public.sales_outreaches
  for each row execute function public.sales_bump_draft_version();

create table public.sales_outreach_draft_edits (
  id uuid primary key default gen_random_uuid(),
  outreach_id uuid not null references public.sales_outreaches (id) on delete cascade,
  -- The revision this edit produced (the first stored draft is revision 1).
  draft_version integer not null check (draft_version >= 2),
  previous_subject text check (char_length(previous_subject) <= 200),
  previous_body text not null check (char_length(previous_body) between 1 and 4000),
  subject text check (char_length(subject) <= 200),
  body text not null check (char_length(body) between 1 and 4000),
  edited_by uuid not null,
  edited_at timestamptz not null default now(),
  constraint sales_outreach_draft_edits_version unique (outreach_id, draft_version)
);

-- ---------------------------------------------------------------------------
-- 2. Send approvals (one row per approved snapshot)
-- ---------------------------------------------------------------------------

create table public.sales_outreach_approvals (
  id uuid primary key default gen_random_uuid(),
  outreach_id uuid not null references public.sales_outreaches (id) on delete cascade,
  prospect_id uuid not null references public.sales_prospects (id) on delete cascade,
  -- approved → send_opened → sent; approved / send_opened → superseded.
  state text not null default 'approved'
    check (state in ('approved', 'send_opened', 'sent', 'superseded')),
  -- 'manual': the owner sends from their own app. 'api' is reserved for a
  -- separately approved official send path; nothing writes it today.
  mode text not null default 'manual' check (mode in ('manual', 'api')),
  channel text not null check (channel in ('instagram', 'email')),
  -- The public email (email) or the Instagram handle (instagram) at approval.
  recipient text not null check (char_length(recipient) between 1 and 254),
  subject text check (char_length(subject) <= 200),
  body text not null check (char_length(body) between 1 and 8000),
  draft_version integer not null check (draft_version >= 1),
  demo_token text not null check (demo_token ~ '^[A-Za-z0-9_-]{43,}$'),
  demo_design_status text check (demo_design_status in ('pending', 'processing', 'ready', 'blocked', 'failed')),
  demo_design_updated_at timestamptz,
  -- sales_demo_version(): what the recipient will see on the demo page.
  demo_version text not null check (demo_version ~ '^[0-9a-f]{64}$'),
  -- sha256 over outreach, channel, recipient, subject, body, revision, demo version.
  snapshot_sha256 text not null check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  approved_by uuid not null,
  approved_at timestamptz not null default now(),
  opened_at timestamptz,
  last_opened_at timestamptz,
  opened_via text check (opened_via in ('mailto', 'instagram_profile', 'copy')),
  open_count integer not null default 0 check (open_count >= 0),
  sent_at timestamptz,
  sent_by uuid,
  superseded_at timestamptz,
  superseded_reason text check (superseded_reason in ('draft_edited', 'reapproved', 'withdrawn', 'outreach_closed')),
  -- PR #239 M2: set only when a confirmed send was already blocked (DNC / exclusion).
  blocked_after_open text check (blocked_after_open in ('do_not_contact', 'excluded')),
  constraint sales_outreach_approvals_subject
    check ((channel = 'email') = (subject is not null)),
  constraint sales_outreach_approvals_opened
    check ((state in ('send_opened', 'sent')) <= (opened_at is not null and opened_via is not null and open_count >= 1)),
  constraint sales_outreach_approvals_sent
    check ((state = 'sent') = (sent_at is not null and sent_by is not null)),
  constraint sales_outreach_approvals_superseded
    check ((state = 'superseded') = (superseded_at is not null and superseded_reason is not null)),
  constraint sales_outreach_approvals_blocked
    check (blocked_after_open is null or state = 'sent')
);

-- At most one live (or sent) approval per outreach: two concurrent approvals
-- can never both stand, whatever the code above the database does.
create unique index sales_outreach_approvals_live_key
  on public.sales_outreach_approvals (outreach_id) where state in ('approved', 'send_opened', 'sent');
create index sales_outreach_approvals_recipient_idx
  on public.sales_outreach_approvals (channel, recipient) where state in ('approved', 'send_opened', 'sent');

-- The snapshot is the audit record: it never changes, and the state only
-- moves forward.
create function public.sales_check_approval_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'approved' or new.opened_at is not null or new.sent_at is not null or new.superseded_at is not null then
      raise exception 'approval_must_start_approved' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if row(new.outreach_id, new.prospect_id, new.mode, new.channel, new.recipient, new.subject, new.body,
         new.draft_version, new.demo_token, new.demo_design_status, new.demo_design_updated_at,
         new.demo_version, new.snapshot_sha256, new.approved_by, new.approved_at)
     is distinct from
     row(old.outreach_id, old.prospect_id, old.mode, old.channel, old.recipient, old.subject, old.body,
         old.draft_version, old.demo_token, old.demo_design_status, old.demo_design_updated_at,
         old.demo_version, old.snapshot_sha256, old.approved_by, old.approved_at) then
    raise exception 'approval_snapshot_immutable' using errcode = 'check_violation';
  end if;
  if new.state <> old.state and not (
       (old.state = 'approved' and new.state in ('send_opened', 'superseded'))
       or (old.state = 'send_opened' and new.state in ('sent', 'superseded'))) then
    raise exception 'invalid_approval_transition:%->%', old.state, new.state using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger sales_outreach_approvals_write
  before insert or update on public.sales_outreach_approvals
  for each row execute function public.sales_check_approval_write();

-- ---------------------------------------------------------------------------
-- 5. Selection rationale and improvement hypothesis (with provenance)
-- ---------------------------------------------------------------------------

create table public.sales_prospect_insights (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references public.sales_prospects (id) on delete cascade,
  kind text not null check (kind in ('selection_rationale', 'improvement_hypothesis')),
  -- Short free text; never an email address (same rule as the exclusion notes).
  body text not null check (char_length(body) between 1 and 300 and body !~ '[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+'),
  -- Who wrote it: the ingest run (Operational Claude) or the owner.
  source text not null check (source in ('ingest', 'owner')),
  run_id uuid references public.sales_agent_runs (run_id) on delete set null,
  written_by uuid,
  written_at timestamptz not null default now(),
  constraint sales_prospect_insights_kind unique (prospect_id, kind),
  constraint sales_prospect_insights_owner check ((source = 'owner') = (written_by is not null)),
  constraint sales_prospect_insights_ingest check (source = 'ingest' or run_id is null)
);

-- ---------------------------------------------------------------------------
-- RLS: admin read only; writes only through the functions below.
-- ---------------------------------------------------------------------------

alter table public.sales_outreach_draft_edits enable row level security;
alter table public.sales_outreach_approvals enable row level security;
alter table public.sales_prospect_insights enable row level security;

create policy sales_outreach_draft_edits_admin_read on public.sales_outreach_draft_edits
  for select to authenticated using ((select public.is_sales_admin()));
create policy sales_outreach_approvals_admin_read on public.sales_outreach_approvals
  for select to authenticated using ((select public.is_sales_admin()));
create policy sales_prospect_insights_admin_read on public.sales_prospect_insights
  for select to authenticated using ((select public.is_sales_admin()));

revoke all on public.sales_outreach_draft_edits, public.sales_outreach_approvals, public.sales_prospect_insights
  from public, anon, authenticated;
grant select on public.sales_outreach_draft_edits to authenticated;
grant select on public.sales_outreach_approvals to authenticated;
grant select on public.sales_prospect_insights to authenticated;
grant all on public.sales_outreach_draft_edits to service_role;
grant all on public.sales_outreach_approvals to service_role;
grant all on public.sales_prospect_insights to service_role;

-- ---------------------------------------------------------------------------
-- Helpers (invoker rights; not callable by the API roles)
-- ---------------------------------------------------------------------------

-- What the recipient sees on the demo page: the token (URL), the template and
-- its verified content, and the AI design (status + profile). Columns that
-- change without changing the page (expires_at at 送信済み, the design job's
-- lease and attempts, the review summary) are left out.
create function public.sales_demo_version(d public.sales_demos)
returns text
language sql
stable
set search_path = ''
as $$
  select encode(sha256(convert_to(
    jsonb_build_array(d.public_token, d.template, d.content, d.design_status, d.design_profile)::text, 'UTF8')), 'hex')
$$;

-- DEV-195: the admin's exclusion list against the prospect's stored keys —
-- the same four kinds persist compares: Instagram handle, site key, email
-- digest (lib/sales/email-digest.ts) of each stored email (the public email
-- and the email source rows), and normalised name + address.
create function public.sales_prospect_excluded(p_prospect_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.sales_prospects p
    join public.sales_exclusions e on
         (e.instagram_handle is not null and e.instagram_handle = p.instagram_handle)
      or (e.website_domain is not null and e.website_domain = p.website_domain)
      or (e.normalized_name is not null and e.normalized_name = p.normalized_name
          and e.normalized_address = p.normalized_address)
      or (e.email_digest is not null and e.email_digest in (
            select encode(sha256(convert_to('second-root/exclusion-email/v1' || chr(10) || m.email, 'UTF8')), 'hex')
            from (
              select p.public_email as email
              union
              select lower(s.value) from public.sales_sources s where s.prospect_id = p.id and s.field = 'email'
            ) m
            where m.email is not null))
    where p.id = p_prospect_id
  )
$$;

-- DNC first, then the exclusion list: why a shop must not be contacted now
-- (null when neither applies).
create function public.sales_outreach_block_reason(p_prospect_id uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p.do_not_contact then 'do_not_contact'
    when public.sales_prospect_excluded(p.id) then 'excluded'
  end
  from public.sales_prospects p where p.id = p_prospect_id
$$;

-- The channel rules of 20260927000000 (instagram / email / recommended channel).
create function public.sales_assert_channel_eligible(p_prospect_id uuid, p_kind text, p_channel text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  p public.sales_prospects%rowtype;
begin
  select * into p from public.sales_prospects where id = p_prospect_id;
  if p_channel = 'instagram'
     and not (p.website_status = 'not_found' and p.instagram_handle is not null and p.public_email is null) then
    raise exception 'instagram_not_eligible' using errcode = 'check_violation';
  end if;
  if p_channel = 'email'
     and not (p.public_email is not null and public.sales_has_first_party_email(p.id, p.public_email)) then
    raise exception 'email_not_eligible' using errcode = 'check_violation';
  end if;
  if p_kind = 'initial' and p.recommended_channel is distinct from p_channel then
    raise exception 'channel_mismatch' using errcode = 'check_violation';
  end if;
end;
$$;

-- Unchanged from 20260927000000 except the exclusion check (DEV-195). The
-- triggers run it when a draft is created, when it is marked sent and when a
-- follow-up is recorded, so an excluded shop is refused on every path.
create or replace function public.sales_assert_outreach_eligible(p_prospect_id uuid, p_kind text, p_channel text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  p public.sales_prospects%rowtype;
begin
  select * into p from public.sales_prospects where id = p_prospect_id;
  if p.do_not_contact then
    raise exception 'do_not_contact' using errcode = 'check_violation';
  end if;
  perform public.sales_assert_channel_eligible(p_prospect_id, p_kind, p_channel);
  if public.sales_prospect_excluded(p.id) then
    raise exception 'excluded' using errcode = 'check_violation';
  end if;
end;
$$;

-- Outreach state machine: unchanged from 20260927000000 except PR #239 M2.
-- blocked_after_open is written only on the drafted → sent transition, and
-- then (only then) the DNC / exclusion check of that transition is replaced
-- by the channel rules alone: sales_mark_sent sets it only for an opened,
-- still-current approval whose shop became DNC / excluded meanwhile.
create or replace function public.sales_check_outreach_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  allowed boolean;
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
      perform public.sales_assert_channel_eligible(new.prospect_id, new.kind, new.channel);
    else
      perform public.sales_assert_outreach_eligible(new.prospect_id, new.kind, new.channel);
    end if;
  end if;
  return new;
end;
$$;

-- The recipient of an initial outreach, as the approval records it.
create function public.sales_outreach_recipient(p_prospect_id uuid, p_channel text)
returns text
language sql
stable
set search_path = ''
as $$
  select case p_channel when 'email' then p.public_email when 'instagram' then p.instagram_handle end
  from public.sales_prospects p where p.id = p_prospect_id
$$;

-- Every guard of a manual initial send, in one place, run at approval, when
-- the send screen is opened and again at 送信済み. The caller holds the
-- outreach row lock. Every function that locks an approval, the prospect or
-- the demo for a send takes the outreach row first, so they serialise on it
-- and cannot deadlock with each other.
--   p_design_enabled: SALES_AI_DESIGN_ENABLED as the server reads it (the flag
--   lives in the server's environment, not in the database).
--   p_confirm_opened: PR #239 M2, only from sales_mark_sent for an opened
--   approval. DNC and the exclusion list do not refuse (the caller records
--   them as blocked_after_open), nor does the demo DNC disabled; every other
--   guard still does.
create function public.sales_send_guards(o public.sales_outreaches, p_design_enabled boolean, p_confirm_opened boolean)
returns public.sales_demos
language plpgsql
set search_path = ''
as $$
declare
  d public.sales_demos;
  v_recipient text;
  v_block text;
begin
  if o.kind <> 'initial' or o.status <> 'drafted' then
    raise exception 'invalid_transition' using errcode = 'P0001';
  end if;
  -- Serialises with sales_add_exclusion: an exclusion committed before this
  -- point is always seen; one added later waits for this send to finish.
  perform pg_advisory_xact_lock_shared(hashtext('second_root_sales_exclusions'));
  -- A concurrent DNC (sales_set_dnc locks the same row) is seen after the wait.
  perform 1 from public.sales_prospects where id = o.prospect_id for update;
  if coalesce(p_confirm_opened, false) then
    v_block := public.sales_outreach_block_reason(o.prospect_id);
    perform public.sales_assert_channel_eligible(o.prospect_id, o.kind, o.channel);
  else
    -- DNC, channel rules, recommended channel and the exclusion list.
    perform public.sales_assert_outreach_eligible(o.prospect_id, o.kind, o.channel);
  end if;

  v_recipient := public.sales_outreach_recipient(o.prospect_id, o.channel);
  if v_recipient is null then
    raise exception 'recipient_missing' using errcode = 'P0001';
  end if;
  -- Duplicates: the same address / account already approved or sent for
  -- another outreach (dedupe keys are unique per prospect; this also holds
  -- if a shop's stored keys changed after it was contacted).
  if exists (
    select 1 from public.sales_outreach_approvals a
    where a.channel = o.channel and a.recipient = v_recipient and a.outreach_id <> o.id
      and a.state in ('approved', 'send_opened', 'sent')
  ) then
    raise exception 'duplicate_recipient' using errcode = 'P0001';
  end if;

  select * into d from public.sales_demos where prospect_id = o.prospect_id for update;
  -- (Setting DNC disables the demo: that alone does not stop recording a
  -- send that already happened.)
  if not found or (d.disabled_at is not null and v_block is distinct from 'do_not_contact') then
    raise exception 'demo_unavailable' using errcode = 'P0001';
  end if;
  if coalesce(p_design_enabled, false) and d.design_status in ('pending', 'processing') then
    raise exception 'design_pending' using errcode = 'P0001';
  end if;
  return d;
end;
$$;

-- The approval still describes exactly what would be sent now.
create function public.sales_approval_is_current(a public.sales_outreach_approvals, o public.sales_outreaches, d public.sales_demos)
returns boolean
language sql
stable
set search_path = ''
as $$
  select a.outreach_id = o.id
     and a.channel = o.channel
     and a.draft_version = o.draft_version
     and a.recipient is not distinct from public.sales_outreach_recipient(o.prospect_id, o.channel)
     and a.demo_token = d.public_token
     and a.demo_version = public.sales_demo_version(d)
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.sales_bump_draft_version()',
    'public.sales_check_approval_write()',
    'public.sales_demo_version(public.sales_demos)',
    'public.sales_prospect_excluded(uuid)',
    'public.sales_outreach_recipient(uuid, text)',
    'public.sales_send_guards(public.sales_outreaches, boolean, boolean)',
    'public.sales_outreach_block_reason(uuid)',
    'public.sales_assert_channel_eligible(uuid, text, text)',
    'public.sales_approval_is_current(public.sales_outreach_approvals, public.sales_outreaches, public.sales_demos)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin functions (SECURITY DEFINER, admin checked first)
-- ---------------------------------------------------------------------------

-- 文面を保存. The server action checks the text as the composer does
-- (lib/sales/draft.ts); this re-checks the bounds and refuses links and
-- addresses. The demo URL, disclaimer, opt-out line and signature are not part
-- of the stored message: they are added when the message is composed, so an
-- edit can never remove them.
create function public.sales_update_outreach_draft(p_outreach_id uuid, p_draft_version integer, p_subject text, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.sales_outreaches;
  v_subject text;
begin
  perform public.sales_assert_admin();
  o := public.sales_lock_initial(p_outreach_id);
  if o.status <> 'drafted' then
    raise exception 'not_editable' using errcode = 'P0001';
  end if;
  if o.draft_version is distinct from p_draft_version then
    raise exception 'stale_draft' using errcode = 'P0001';
  end if;
  -- The owner may already have sent the opened text: settle that first.
  if exists (select 1 from public.sales_outreach_approvals a where a.outreach_id = o.id and a.state = 'send_opened') then
    raise exception 'approval_open' using errcode = 'P0001';
  end if;
  v_subject := case when o.channel = 'email' then p_subject end;
  if p_body is null or char_length(p_body) not between 1 and 1200 or p_body <> btrim(p_body)
     or p_body ~* '(https?:|www\.)' or p_body ~ '[^[:space:]@＠]+[@＠][^[:space:]@＠]+\.[^[:space:]@＠]+'
     or (o.channel = 'email' and (v_subject is null or char_length(v_subject) not between 1 and 100
         or v_subject ~ '[\r\n]' or v_subject ~* '(https?:|www\.)'
         or v_subject ~ '[^[:space:]@＠]+[@＠][^[:space:]@＠]+\.[^[:space:]@＠]+'))
     or (o.channel = 'instagram' and p_subject is not null) then
    raise exception 'invalid_draft' using errcode = '22023';
  end if;
  if v_subject is not distinct from o.subject and p_body = o.body then
    return jsonb_build_object('outreach_id', o.id, 'draft_version', o.draft_version, 'replayed', true);
  end if;

  insert into public.sales_outreach_draft_edits (outreach_id, draft_version, previous_subject, previous_body, subject, body, edited_by)
    values (o.id, o.draft_version + 1, o.subject, o.body, v_subject, p_body, auth.uid());
  update public.sales_outreaches
    set subject = v_subject, body = p_body, draft_version = o.draft_version + 1, edited_at = now(), edited_by = auth.uid()
    where id = o.id;
  -- An approval of the earlier text can no longer be used.
  update public.sales_outreach_approvals
    set state = 'superseded', superseded_at = now(), superseded_reason = 'draft_edited'
    where outreach_id = o.id and state = 'approved';
  return jsonb_build_object('outreach_id', o.id, 'draft_version', o.draft_version + 1, 'replayed', false);
end;
$$;

-- この内容で送信を承認. p_subject / p_body are the full texts the server
-- composed from this draft and showed the owner (lib/admin/initial-send.ts);
-- the server action refuses if what the owner saw differs. Here: the draft
-- revision must be the one shown, the text must carry the stored message,
-- this shop's demo URL, the disclaimer and the opt-out line, and every guard
-- must pass. Idempotent for the same snapshot.
create function public.sales_approve_outreach(p_outreach_id uuid, p_draft_version integer, p_subject text, p_body text, p_design_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.sales_outreaches;
  d public.sales_demos;
  a public.sales_outreach_approvals;
  v_recipient text;
  v_demo_version text;
  v_snapshot text;
begin
  perform public.sales_assert_admin();
  o := public.sales_lock_initial(p_outreach_id);
  if o.status <> 'drafted' then
    raise exception 'invalid_transition' using errcode = 'P0001';
  end if;
  if o.draft_version is distinct from p_draft_version then
    raise exception 'stale_snapshot' using errcode = 'P0001';
  end if;
  d := public.sales_send_guards(o, p_design_enabled, false);

  if (o.channel = 'email' and p_subject is distinct from o.subject)
     or (o.channel = 'instagram' and p_subject is not null) then
    raise exception 'stale_snapshot' using errcode = 'P0001';
  end if;
  -- Same markers as composeEmailBody / composeDm (lib/sales/messages.ts):
  -- DEMO_DISCLAIMER and EMAIL_OPT_OUT / DM_OPT_OUT.
  if p_body is null or char_length(p_body) > 8000
     or strpos(p_body, o.body) = 0
     or strpos(p_body, '/demo/' || d.public_token) = 0
     or strpos(p_body, '貴店の公式サイトではありません。') = 0
     or strpos(p_body, '以後ご連絡いたしません。') = 0 then
    raise exception 'invalid_snapshot' using errcode = '22023';
  end if;

  v_recipient := public.sales_outreach_recipient(o.prospect_id, o.channel);
  v_demo_version := public.sales_demo_version(d);
  v_snapshot := encode(sha256(convert_to(jsonb_build_array(
    o.id, o.channel, v_recipient, p_subject, p_body, o.draft_version, v_demo_version)::text, 'UTF8')), 'hex');

  select * into a from public.sales_outreach_approvals
    where outreach_id = o.id and state in ('approved', 'send_opened') for update;
  if found then
    if a.snapshot_sha256 = v_snapshot then
      return jsonb_build_object('approval_id', a.id, 'state', a.state, 'replayed', true);
    end if;
    -- The owner may already have sent the opened text: never replace it silently.
    if a.state = 'send_opened' then
      raise exception 'approval_open' using errcode = 'P0001';
    end if;
    update public.sales_outreach_approvals
      set state = 'superseded', superseded_at = now(), superseded_reason = 'reapproved'
      where id = a.id;
  end if;

  insert into public.sales_outreach_approvals (
    outreach_id, prospect_id, mode, channel, recipient, subject, body, draft_version,
    demo_token, demo_design_status, demo_design_updated_at, demo_version, snapshot_sha256, approved_by)
  values (
    o.id, o.prospect_id, 'manual', o.channel, v_recipient, p_subject, p_body, o.draft_version,
    d.public_token, d.design_status, d.design_updated_at, v_demo_version, v_snapshot, auth.uid())
  returning * into a;
  return jsonb_build_object('approval_id', a.id, 'state', a.state, 'replayed', false);
end;
$$;

-- 送信画面を開いた (mailto / Instagram profile / text copied). Records that
-- the owner opened the send screen; it is NOT a send. Re-runs every guard.
create function public.sales_mark_send_opened(p_approval_id uuid, p_via text, p_design_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.sales_outreach_approvals;
  o public.sales_outreaches;
  d public.sales_demos;
begin
  perform public.sales_assert_admin();
  if p_via is null or p_via not in ('mailto', 'instagram_profile', 'copy') then
    raise exception 'invalid_via' using errcode = '22023';
  end if;
  select * into a from public.sales_outreach_approvals where id = p_approval_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  o := public.sales_lock_initial(a.outreach_id);
  select * into a from public.sales_outreach_approvals where id = p_approval_id for update;
  if a.state = 'sent' then
    return jsonb_build_object('approval_id', a.id, 'state', a.state, 'replayed', true);
  end if;
  if a.state = 'superseded' then
    raise exception 'stale_snapshot' using errcode = 'P0001';
  end if;
  d := public.sales_send_guards(o, p_design_enabled, false);
  if not public.sales_approval_is_current(a, o, d) then
    raise exception 'stale_snapshot' using errcode = 'P0001';
  end if;
  update public.sales_outreach_approvals
    set state = 'send_opened', opened_at = coalesce(opened_at, now()), opened_via = coalesce(opened_via, p_via),
        last_opened_at = now(), open_count = open_count + 1
    where id = a.id
    returning * into a;
  return jsonb_build_object('approval_id', a.id, 'state', a.state, 'replayed', false);
end;
$$;

-- 送らなかった: withdraw an approval that has not been confirmed as sent.
create function public.sales_withdraw_approval(p_approval_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.sales_outreach_approvals;
  o public.sales_outreaches;
begin
  perform public.sales_assert_admin();
  select * into a from public.sales_outreach_approvals where id = p_approval_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  o := public.sales_lock_initial(a.outreach_id);
  select * into a from public.sales_outreach_approvals where id = p_approval_id for update;
  if a.state = 'sent' then
    raise exception 'already_sent' using errcode = 'P0001';
  end if;
  if a.state = 'superseded' then
    return jsonb_build_object('approval_id', a.id, 'state', a.state, 'replayed', true);
  end if;
  update public.sales_outreach_approvals
    set state = 'superseded', superseded_at = now(), superseded_reason = 'withdrawn'
    where id = a.id;
  return jsonb_build_object('approval_id', a.id, 'state', 'superseded', 'replayed', false);
end;
$$;

-- 手動で送信済み (the confirm step). Replaces sales_mark_sent(uuid): a send
-- is recorded only for an opened approval whose snapshot (draft revision,
-- recipient, demo version) still matches, after every guard passes again.
-- Idempotent for the approval that was confirmed. Starts the demo's 30 days
-- (MVP_SPEC §7) as before.
drop function public.sales_mark_sent(uuid);

create function public.sales_mark_sent(p_outreach_id uuid, p_approval_id uuid, p_design_enabled boolean)
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
                              'blocked_after_open', o.blocked_after_open, 'replayed', true);
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
  -- refused. Every other guard and the snapshot check still refuse.
  d := public.sales_send_guards(o, p_design_enabled, true);
  if not public.sales_approval_is_current(a, o, d) then
    raise exception 'stale_snapshot' using errcode = 'P0001';
  end if;
  v_block := public.sales_outreach_block_reason(o.prospect_id);

  update public.sales_outreaches set status = 'sent', sent_at = sent, blocked_after_open = v_block where id = o.id;
  update public.sales_demos
    set expires_at = sent + interval '30 days'
    where prospect_id = o.prospect_id and expires_at is null;
  update public.sales_outreach_approvals
    set state = 'sent', sent_at = sent, sent_by = auth.uid(), blocked_after_open = v_block
    where id = a.id;

  return jsonb_build_object('outreach_id', o.id, 'status', 'sent', 'sent_at', sent, 'approval_id', a.id,
                            'blocked_after_open', v_block, 'replayed', false);
end;
$$;

-- 選んだ理由 / 改善の仮説 (owner). An empty text removes the note (shown as
-- 未確認 again); nothing is ever filled in for the owner.
create function public.sales_set_prospect_insight(p_prospect_id uuid, p_kind text, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_body text := nullif(btrim(coalesce(p_body, '')), '');
begin
  perform public.sales_assert_admin();
  if p_kind is null or p_kind not in ('selection_rationale', 'improvement_hypothesis') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  -- Refused before the insert, so a failing row (with its text) never reaches the log.
  if v_body is not null and (char_length(v_body) > 300 or v_body ~ '[^[:space:]@＠]+[@＠][^[:space:]@＠]+\.[^[:space:]@＠]+') then
    raise exception 'invalid_insight' using errcode = '22023';
  end if;
  perform 1 from public.sales_prospects where id = p_prospect_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_body is null then
    delete from public.sales_prospect_insights where prospect_id = p_prospect_id and kind = p_kind;
    return jsonb_build_object('prospect_id', p_prospect_id, 'kind', p_kind, 'cleared', true);
  end if;
  insert into public.sales_prospect_insights (prospect_id, kind, body, source, run_id, written_by, written_at)
    values (p_prospect_id, p_kind, v_body, 'owner', null, auth.uid(), now())
    on conflict (prospect_id, kind) do update
      set body = excluded.body, source = 'owner', run_id = null, written_by = excluded.written_by, written_at = excluded.written_at;
  return jsonb_build_object('prospect_id', p_prospect_id, 'kind', p_kind, 'cleared', false);
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.sales_update_outreach_draft(uuid, integer, text, text)',
    'public.sales_approve_outreach(uuid, integer, text, text, boolean)',
    'public.sales_mark_send_opened(uuid, text, boolean)',
    'public.sales_withdraw_approval(uuid)',
    'public.sales_mark_sent(uuid, uuid, boolean)',
    'public.sales_set_prospect_insight(uuid, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated', fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- sales_add_exclusion: unchanged from 20261018000000 except the advisory lock
-- (exclusive), so an exclusion and an in-flight send never interleave.
-- (create or replace keeps the existing grants.)
-- ---------------------------------------------------------------------------

create or replace function public.sales_add_exclusion(
  p_label text, p_reason text, p_note text,
  p_instagram_handle text, p_website_domain text, p_email_digest text,
  p_normalized_name text, p_normalized_address text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid;
begin
  perform public.sales_assert_admin();
  -- DEV-050: refuse a malformed digest or an address in the free text before
  -- the insert, so a check violation never writes the failing row (with the
  -- address in it) to the database log.
  if (nullif(p_email_digest, '') is not null and p_email_digest !~ '^[0-9a-f]{64}$')
     or coalesce(p_label, '') ~ '[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+'
     or coalesce(p_note, '') ~ '[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+' then
    raise exception 'invalid_exclusion' using errcode = '22023';
  end if;
  -- DEV-195: wait for in-flight sends (sales_send_guards holds it shared).
  perform pg_advisory_xact_lock(hashtext('second_root_sales_exclusions'));
  insert into public.sales_exclusions (
    label, reason, note, instagram_handle, website_domain, email_digest,
    normalized_name, normalized_address, created_by)
  values (
    p_label, p_reason, nullif(p_note, ''), nullif(p_instagram_handle, ''), nullif(p_website_domain, ''),
    nullif(p_email_digest, ''), nullif(p_normalized_name, ''), nullif(p_normalized_address, ''), auth.uid())
  returning id into new_id;
  return new_id;
exception
  when unique_violation then
    raise exception 'already_excluded' using errcode = '23505';
  when check_violation then
    raise exception 'invalid_exclusion' using errcode = '22023';
end;
$$;

-- ---------------------------------------------------------------------------
-- persist: unchanged from 20261018000000 except that the optional selection
-- rationale / improvement hypothesis of the verified candidate (if any) are
-- stored with the run as their source. A note that does not fit is dropped,
-- never fixed up, and never stops the shop from being prepared.
-- (create or replace keeps the existing grants: service_role only.)
-- ---------------------------------------------------------------------------

create or replace function public.sales_persist_candidate(p_run_id uuid, p_key text, p_design boolean default false)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r public.sales_agent_runs;
  c jsonb;
  cur jsonb;
  m_id uuid;
  m_dnc boolean;
  m_own boolean;
  x_id uuid;
  today_count integer;
  new_prospect uuid;
  result jsonb;
  v_kind text;
begin
  r := public.sales_run_lock(p_run_id);
  if r.status <> 'running' then
    return jsonb_build_object('key', p_key, 'run_status', r.status, 'error_code', r.error_code);
  end if;
  if r.phase <> 'persisting' then
    raise exception 'phase_order_violation' using errcode = 'P0001';
  end if;
  if r.persist_lease_until is null or r.persist_lease_until <= now() then
    raise exception 'lease_lost' using errcode = 'P0001';
  end if;

  cur := r.checkpoint->'candidates'->p_key;
  if cur is null then
    raise exception 'unknown_candidate_key' using errcode = '22023';
  end if;
  if public.sales_stage_is_terminal(cur->>'stage') then
    return jsonb_build_object('key', p_key) || cur;
  end if;
  c := r.checkpoint->'verified'->'candidates'->p_key;
  if c is null then
    raise exception 'missing_candidate' using errcode = '22023';
  end if;

  -- One writer at a time across all runs: the dedupe and daily-cap checks
  -- below must see every committed prospect.
  perform pg_advisory_xact_lock(hashtext('second_root_sales_persist'));

  begin
    select p.id, p.do_not_contact,
           coalesce(p.first_seen_run_id = p_run_id and p.first_seen_candidate_key = p_key, false)
      into m_id, m_dnc, m_own
      from public.sales_prospects p
      where (p.normalized_name = c->>'normalized_name' and p.normalized_address = c->>'normalized_address')
         or (c->>'website_domain' is not null and p.website_domain = c->>'website_domain')
         or (c->>'instagram_handle' is not null and p.instagram_handle = c->>'instagram_handle')
         or (c->>'public_email' is not null and p.public_email = c->>'public_email')
      order by (p.first_seen_run_id = p_run_id and p.first_seen_candidate_key = p_key) desc nulls last,
               p.do_not_contact desc, p.created_at
      limit 1;
  exception when others then
    raise exception 'dedupe_unavailable' using errcode = 'P0001';
  end;

  -- DEV-049: shops on the admin's exclusion list (existing customers and the
  -- like) are never prepared. Checked under the same lock, after the own-run
  -- replay (which keeps returning its earlier result) and before DNC /
  -- duplicate / daily cap. A failed check prepares nothing.
  if not coalesce(m_own, false) then
    begin
      select e.id into x_id
        from public.sales_exclusions e
        where (e.instagram_handle is not null and e.instagram_handle = c->>'instagram_handle')
           or (e.website_domain is not null and e.website_domain = c->>'website_domain')
           -- DEV-050: email by digest only. Any submitted email (first-party or
           -- not) through the candidate's email_digest, and also its first-party
           -- public_email digested the same way (lib/sales/email-digest.ts), so a
           -- checkpoint written before (or with an older) email_digest still matches.
           -- A null public_email gives a null digest, which matches nothing.
           or (e.email_digest is not null and (
                 e.email_digest = c->>'email_digest'
                 or e.email_digest = encode(sha256(convert_to(
                   'second-root/exclusion-email/v1' || chr(10) || (c->>'public_email'), 'UTF8')), 'hex')))
           or (e.normalized_name is not null and e.normalized_name = c->>'normalized_name'
               and e.normalized_address = c->>'normalized_address')
        limit 1;
    exception when others then
      raise exception 'exclusion_unavailable' using errcode = 'P0001';
    end;
    if x_id is not null then
      result := jsonb_build_object('stage', 'rejected', 'reason', 'excluded');
      perform public.sales_run_set_stage(r, p_key, result);
      return jsonb_build_object('key', p_key) || result;
    end if;
  end if;

  if m_id is not null then
    if m_own then
      result := jsonb_build_object('stage', 'outreach_ready', 'prospect_id', m_id);
    elsif m_dnc then
      result := jsonb_build_object('stage', 'rejected', 'reason', 'do_not_contact');
    else
      result := jsonb_build_object('stage', 'duplicate', 'prospect_id', m_id);
    end if;
    perform public.sales_run_set_stage(r, p_key, result);
    return jsonb_build_object('key', p_key) || result;
  end if;

  select count(*) into today_count
    from public.sales_outreaches o
    where o.kind = 'initial' and public.sales_jst_date(o.created_at) = public.sales_jst_date(now());
  if today_count >= 5 then
    result := jsonb_build_object('stage', 'rejected', 'reason', 'daily_cap');
    perform public.sales_run_set_stage(r, p_key, result);
    return jsonb_build_object('key', p_key) || result;
  end if;

  begin
    insert into public.sales_prospects (
      name, normalized_name, address, normalized_address, ward, category,
      website_status, website_url, website_domain, instagram_url, instagram_handle,
      public_email, recommended_channel, first_seen_run_id, first_seen_candidate_key)
    values (
      c->>'name', c->>'normalized_name', c->>'address', c->>'normalized_address', c->>'ward', c->>'category',
      c->>'website_status', c->>'website_url', c->>'website_domain', c->>'instagram_url', c->>'instagram_handle',
      c->>'public_email', c->>'channel', p_run_id, p_key)
    returning id into new_prospect;

    insert into public.sales_sources (prospect_id, field, value, source_url, source_type, verified_at, run_id)
      select new_prospect, s->>'field', s->>'value', s->>'source_url', s->>'source_type',
             (s->>'verified_at')::timestamptz, p_run_id
      from jsonb_array_elements(coalesce(c->'sources', '[]'::jsonb)) s;

    set constraints public.sales_prospects_email_provenance immediate;
  exception when others then
    raise exception 'persist_failed:%', sqlerrm using errcode = 'P0001';
  end;

  begin
    -- DEV-030: with the AI design step on, the demo waits for its design
    -- (pending) in the same transaction; off, it is a legacy demo (null).
    insert into public.sales_demos (prospect_id, public_token, template, content, run_id, design_status, design_updated_at)
      values (new_prospect, public.sales_new_demo_token(), c->'demo'->>'template',
              coalesce(c->'demo'->'content', '{}'::jsonb), p_run_id,
              case when p_design then 'pending' end, case when p_design then now() end);
  exception when others then
    raise exception 'demo_failed:%', sqlerrm using errcode = 'P0001';
  end;

  begin
    insert into public.sales_outreaches (prospect_id, kind, channel, subject, body, run_id)
      values (new_prospect, 'initial', c->>'channel', c->'outreach'->>'subject', c->'outreach'->>'body', p_run_id);
  exception when others then
    raise exception 'outreach_failed:%', sqlerrm using errcode = 'P0001';
  end;

  -- DEV-195: optional notes from the verified candidate (lib/sales/prepare.ts
  -- `insights`), stored only as they were submitted. Best effort: a note the
  -- table refuses is dropped (shown as 未確認), the shop is still prepared.
  if jsonb_typeof(c->'insights') = 'object' then
    foreach v_kind in array array['selection_rationale', 'improvement_hypothesis'] loop
      if jsonb_typeof(c->'insights'->v_kind) = 'string' then
        begin
          insert into public.sales_prospect_insights (prospect_id, kind, body, source, run_id)
            values (new_prospect, v_kind, c->'insights'->>v_kind, 'ingest', p_run_id);
        exception when others then
          null;
        end;
      end if;
    end loop;
  end if;

  result := jsonb_build_object('stage', 'outreach_ready', 'prospect_id', new_prospect);
  perform public.sales_run_set_stage(r, p_key, result);
  return jsonb_build_object('key', p_key) || result;
end;
$$;

-- ---------------------------------------------------------------------------
-- PR #239 M2: an initial send recorded as blocked_after_open is never
-- followed up — not offered (view) and not recorded (function), even if the
-- DNC is cleared or the exclusion removed later.
-- ---------------------------------------------------------------------------

-- Unchanged from 20260927000500 except `o.blocked_after_open is null`.
create or replace view public.sales_followup_due
with (security_invoker = true)
as
select o.id as outreach_id, o.prospect_id, o.sent_at
from public.sales_outreaches o
join public.sales_prospects p on p.id = o.prospect_id
join public.sales_demos d on d.prospect_id = o.prospect_id
where o.kind = 'initial'
  and o.channel = 'email'
  and o.status = 'sent'
  and o.blocked_after_open is null
  and not p.do_not_contact
  and o.sent_at <= now() - interval '5 days'
  and d.disabled_at is null
  and d.expires_at is not null
  and (d.keep_alive or d.expires_at > now())
  and not exists (
    select 1 from public.sales_outreaches f
    where f.prospect_id = o.prospect_id and f.kind = 'follow_up' and f.status = 'sent'
  );

revoke all on public.sales_followup_due from public, anon, authenticated;
grant select on public.sales_followup_due to authenticated, service_role;

-- Unchanged from 20260927000500 except the blocked_after_open refusal.
-- (create or replace keeps the existing grants.)
create or replace function public.sales_mark_follow_up_sent(p_outreach_id uuid, p_body text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.sales_outreaches;
  f public.sales_outreaches;
  d public.sales_demos;
  sent timestamptz := now();
  v_subject text;
begin
  perform public.sales_assert_admin();
  o := public.sales_lock_initial(p_outreach_id);

  select * into f from public.sales_outreaches where prospect_id = o.prospect_id and kind = 'follow_up';
  if found and f.status = 'sent' then
    return jsonb_build_object('outreach_id', f.id, 'status', f.status, 'sent_at', f.sent_at, 'replayed', true);
  end if;

  if o.blocked_after_open is not null then
    raise exception 'blocked_after_open' using errcode = 'P0001';
  end if;
  if o.channel <> 'email' or o.status <> 'sent' or o.sent_at > sent - interval '5 days' then
    raise exception 'not_due' using errcode = 'P0001';
  end if;
  select * into d from public.sales_demos where prospect_id = o.prospect_id;
  if not found or d.disabled_at is not null or d.expires_at is null or not (d.keep_alive or d.expires_at > sent) then
    raise exception 'demo_unavailable' using errcode = 'P0001';
  end if;
  if p_body is null or char_length(p_body) > 4000
     or strpos(p_body, '/demo/' || d.public_token) = 0
     or strpos(p_body, '以後ご連絡いたしません') = 0 then
    raise exception 'invalid_body' using errcode = '22023';
  end if;
  -- Same rule as followUpSubject (lib/sales/messages.ts).
  v_subject := coalesce(o.subject, 'ホームページのご提案（Second Root）');
  v_subject := case when v_subject like 'Re:%' then left(v_subject, 200) else 'Re: ' || left(v_subject, 196) end;

  if f.id is null then
    insert into public.sales_outreaches (prospect_id, kind, channel, subject, body)
      values (o.prospect_id, 'follow_up', 'email', v_subject, p_body)
      returning * into f;
  else
    update public.sales_outreaches set subject = v_subject, body = p_body where id = f.id;
  end if;
  update public.sales_outreaches set status = 'sent', sent_at = sent where id = f.id;

  return jsonb_build_object('outreach_id', f.id, 'status', 'sent', 'sent_at', sent, 'replayed', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- PR #239 L2: closing an outreach as lost (見送る, or any later loss)
-- retires its live approval, so the approval no longer counts as a live
-- recipient for the duplicate check. Unchanged from 20260927000300 otherwise.
-- ---------------------------------------------------------------------------

create or replace function public.sales_mark_lost(p_outreach_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.sales_outreaches;
begin
  perform public.sales_assert_admin();
  o := public.sales_lock_initial(p_outreach_id);
  if o.status = 'lost' then
    return jsonb_build_object('outreach_id', o.id, 'status', o.status, 'replayed', true);
  end if;
  update public.sales_outreaches
    set status = 'lost', closed_at = now(), lost_reason = nullif(left(coalesce(p_reason, ''), 500), '')
    where id = o.id;
  update public.sales_outreach_approvals
    set state = 'superseded', superseded_at = now(), superseded_reason = 'outreach_closed'
    where outreach_id = o.id and state in ('approved', 'send_opened');
  return jsonb_build_object('outreach_id', o.id, 'status', 'lost', 'replayed', false);
end;
$$;
