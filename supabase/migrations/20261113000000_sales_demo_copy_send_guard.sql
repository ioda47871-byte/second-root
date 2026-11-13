-- Second Root Sales Agent — the copy quality review store, the owner's copy
-- confirmation and the copy send guard of a demo version (DEV-199e; owner
-- Issue #258 decision ①, 2026-11-13: send blocking adopted; the DB change,
-- the guard code and local tests approved. Staging / Production need their
-- own approval — this migration is applied to the local stack only).
--
-- What this adds:
--   1. sales_demo_copy_reviews: every copy quality review
--      (copy_quality_review_v1, lib/design-agent/quality-pipeline/
--      copy-quality-review.ts) the server checked on import, append-only, with
--      the exact bytes it reviewed (review, copy record, facts pack, page HTML
--      and CSS). The trigger re-hashes every text, derives every column from
--      the review JSON (verdict, copy verdict, next step, hashes, round) and
--      enforces the revision chain per shop + lane + facts CONTENT hash
--      (copyReviewAppendBlockers): no second round 0 (no replay of a revision
--      as a fresh first audit), rounds in order, linked to the last copy record,
--      the same facts bytes, and only after a round that allows a revision
--      (the audit asked for one, or the owner asked for one, below).
--   2. sales_demo_copy_facts_checks: evidence that the server compared the
--      review's facts pack with the facts pack from the facts path (never the
--      generator's package). Separate and append-only, so a chain recorded
--      before a facts path existed can still be confirmed later without
--      changing the review.
--   3. sales_demo_version_copy_links: which stored review describes a demo
--      version's page (its HTML and CSS must be the version's files).
--   4. sales_demo_copy_owner_decisions: the owner's explicit, immutable copy
--      decision (approve / revise / reject) for one stored review shown on one
--      version, bound to the review id, the review's sha256 and the four input
--      hashes (facts / copy / HTML / CSS). Written only by a signed-in sales
--      admin as themself (auth.uid()) through sales_decide_copy_review; the
--      service role (the importer, the generator) can never write one.
--   5. The copy send guard: sales_copy_send_block(version) and, in
--      sales_demo_version_send_block (the versioned send path of
--      sales_send_guards → sales_approve_outreach / sales_mark_send_opened /
--      sales_mark_sent), a send of an approved version is refused unless its
--      copy review exists, is for the real-shop lane with copy verdict
--      approve_candidate, its facts came from the facts path, it is the
--      version's own page and the last round of its chain, the server's gate
--      found nothing but the missing owner approval, and the owner approved
--      exactly this review on this version.
--
-- What does not change: a demo with no approved version (the React demo:
-- template + facts text) is sent exactly as before — sales_demo_version_send_block
-- returns null for it before any copy check. Versioned sharing stays disabled
-- (the copy check comes after demo_not_shareable, so every versioned send is
-- still refused with today's reason while DEV-196g is pending). Fact, rights
-- and image checks are unchanged. Existing versions are not backfilled: they
-- have no copy review, so on the versioned path they are not sendable until a
-- review is imported and the owner confirms it.
--
-- The database cannot run the audit itself: the server re-runs it on import
-- (lib/demo-version-package/import.ts → lib/sales/demo-version/copy-store.ts)
-- and again before a send approval (app/admin/sales/_actions/send.ts). The
-- rules below hold whoever writes.
--
-- Nothing is deleted: no API role has DELETE or TRUNCATE on these tables
-- (scripts/staging/lib.mjs NO_DELETE_TABLES). Forward-only; the rollback SQL
-- for a local or later approved revert is in .ai/reviews/DEV-199e.md.

-- ---------------------------------------------------------------------------
-- 1. Value checks
-- ---------------------------------------------------------------------------

-- A list of finding / blocker codes: at most 80, each like REVIEW_NOT_PASSED.
create function public.sales_copy_codes_valid(c text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select c is not null and coalesce(cardinality(c), 0) <= 80
     and not exists (select 1 from unnest(c) x where x is null or x !~ '^[A-Z][A-Z0-9_]{1,60}$')
$$;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

create table public.sales_demo_copy_reviews (
  id uuid primary key default gen_random_uuid(),
  -- The order the store received the reviews (copyReviewAppendBlockers reads them in this order).
  seq bigint generated always as identity unique,
  prospect_id uuid not null references public.sales_prospects (id) on delete restrict,
  demo_id uuid not null references public.sales_demos (id) on delete restrict,
  -- Everything below is derived from review_text by the trigger.
  shop_id text not null check (char_length(shop_id) between 1 and 80),
  lane text not null check (lane in ('real_shop_proposal', 'quality_research_fictional')),
  round integer not null check (round between 0 and 2),
  previous_review_id uuid references public.sales_demo_copy_reviews (id) on delete restrict,
  previous_copy_sha256 text check (previous_copy_sha256 ~ '^[0-9a-f]{64}$'),
  auditor_version text not null check (auditor_version = 'copy_quality_rules_v1'),
  verdict text not null check (verdict in ('fail', 'hold', 'revise', 'approve_candidate')),
  -- The verdict with COPY_APPROVAL_MISSING set aside (copyVerdict).
  copy_verdict text not null check (copy_verdict in ('fail', 'hold', 'revise', 'approve_candidate')),
  next_step text not null check (next_step in ('stop_fail', 'stop_hold', 'revise', 'owner_review')),
  unresolved text[] not null check (public.sales_copy_codes_valid(unresolved)),
  revision_findings jsonb not null check (jsonb_typeof(revision_findings) = 'array' and jsonb_array_length(revision_findings) <= 80),
  facts_sha256 text not null check (facts_sha256 ~ '^[0-9a-f]{64}$'),
  facts_content_sha256 text not null check (facts_content_sha256 ~ '^[0-9a-f]{64}$'),
  copy_sha256 text not null check (copy_sha256 ~ '^[0-9a-f]{64}$'),
  page_html_sha256 text not null check (page_html_sha256 ~ '^[0-9a-f]{64}$'),
  page_css_sha256 text not null check (page_css_sha256 ~ '^[0-9a-f]{64}$'),
  review_sha256 text not null check (review_sha256 ~ '^[0-9a-f]{64}$'),
  -- copyGateSendBlockers(review, files, null, { previous: the stored chain, photoUrls }) as the server computed it on
  -- import: always holds OWNER_APPROVAL_MISSING (the owner's decision is a separate record, never part of a review).
  gate_blockers text[] not null check (public.sales_copy_codes_valid(gate_blockers)),
  -- The exact bytes reviewed (UTF-8). Re-hashed by the trigger against the review's hashes.
  review_text text not null check (octet_length(review_text) between 2 and 1048576),
  copy_record_text text not null check (octet_length(copy_record_text) between 2 and 1048576),
  facts_pack_text text not null check (octet_length(facts_pack_text) between 2 and 1048576),
  page_html_text text not null check (octet_length(page_html_text) between 1 and 393216),
  page_css_text text not null check (octet_length(page_css_text) between 1 and 262144),
  recorded_at timestamptz not null default now(),
  constraint sales_demo_copy_reviews_round_link check (
    (round = 0) = (previous_review_id is null) and (round = 0) = (previous_copy_sha256 is null)),
  -- One review per round of a chain: a second round 0 for the same shop, lane and facts content is refused.
  constraint sales_demo_copy_reviews_chain_round unique (prospect_id, lane, facts_content_sha256, round),
  constraint sales_demo_copy_reviews_gate check (
    'OWNER_APPROVAL_MISSING' = any (gate_blockers)
    and (lane <> 'quality_research_fictional' or 'FICTIONAL_RESEARCH_NOT_SENDABLE' = any (gate_blockers))
    and (copy_verdict = 'approve_candidate' or 'REVIEW_NOT_PASSED' = any (gate_blockers)))
);
create index sales_demo_copy_reviews_prospect_idx on public.sales_demo_copy_reviews (prospect_id, seq);

create table public.sales_demo_copy_facts_checks (
  review_id uuid primary key references public.sales_demo_copy_reviews (id) on delete restrict,
  -- the review's facts pack, equal to the facts pack read from the facts path when the server checked it
  facts_sha256 text not null check (facts_sha256 ~ '^[0-9a-f]{64}$'),
  checked_at timestamptz not null default now()
);

create table public.sales_demo_version_copy_links (
  version_id uuid primary key references public.sales_demo_versions (id) on delete restrict,
  review_id uuid not null references public.sales_demo_copy_reviews (id) on delete restrict,
  demo_id uuid not null references public.sales_demos (id) on delete restrict,
  linked_at timestamptz not null default now()
);
create index sales_demo_version_copy_links_review_idx on public.sales_demo_version_copy_links (review_id);

create table public.sales_demo_copy_owner_decisions (
  id uuid primary key default gen_random_uuid(),
  -- One decision per stored review: approve, revise (the next round may follow) or reject.
  review_id uuid not null unique references public.sales_demo_copy_reviews (id) on delete restrict,
  -- The version whose page the owner looked at.
  version_id uuid not null references public.sales_demo_versions (id) on delete restrict,
  demo_id uuid not null references public.sales_demos (id) on delete restrict,
  decision text not null check (decision in ('approve', 'revise', 'reject')),
  -- What the owner's screen showed: the review and its four inputs (OwnerCopyApproval + the review itself).
  review_sha256 text not null check (review_sha256 ~ '^[0-9a-f]{64}$'),
  facts_sha256 text not null check (facts_sha256 ~ '^[0-9a-f]{64}$'),
  copy_sha256 text not null check (copy_sha256 ~ '^[0-9a-f]{64}$'),
  page_html_sha256 text not null check (page_html_sha256 ~ '^[0-9a-f]{64}$'),
  page_css_sha256 text not null check (page_css_sha256 ~ '^[0-9a-f]{64}$'),
  note text check (public.sales_demo_note_valid(note)),
  decided_by uuid not null,
  decided_at timestamptz not null default now()
);
create index sales_demo_copy_owner_decisions_version_idx on public.sales_demo_copy_owner_decisions (version_id);

-- ---------------------------------------------------------------------------
-- 3. Write rules (triggers; they hold whatever role writes)
-- ---------------------------------------------------------------------------

-- Reviews: insert-only. Every column is derived from the review JSON and the
-- texts are re-hashed; the chain rules of copyReviewAppendBlockers hold.
create function public.sales_check_copy_review_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  r jsonb;
  v_worst integer;
  v_copy_worst integer;
  v_prospect uuid;
  v_n integer;
  last public.sales_demo_copy_reviews;
begin
  if tg_op = 'DELETE' then
    raise exception 'copy_review_delete_forbidden' using errcode = 'check_violation';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'copy_review_immutable' using errcode = 'check_violation';
  end if;

  begin
    r := new.review_text::jsonb;
  exception when others then
    raise exception 'copy_review_invalid' using errcode = 'check_violation';
  end;
  if jsonb_typeof(r) is distinct from 'object'
     or r->>'schema' is distinct from 'copy_quality_review_v1'
     or jsonb_typeof(r->'shop_id') is distinct from 'string'
     or jsonb_typeof(r->'lane') is distinct from 'string'
     or jsonb_typeof(r->'round') is distinct from 'number' or (r->>'round') !~ '^[0-2]$'
     or jsonb_typeof(r->'verdict') is distinct from 'string'
     or jsonb_typeof(r->'auditor_version') is distinct from 'string'
     or jsonb_typeof(r->'findings') is distinct from 'array'
     or jsonb_typeof(r->'unresolved') is distinct from 'array'
     or jsonb_typeof(r->'revision_findings') is distinct from 'array'
     or (r->'previous_copy_sha256' is distinct from 'null'::jsonb and jsonb_typeof(r->'previous_copy_sha256') is distinct from 'string')
     or exists (select 1 from jsonb_array_elements(r->'findings') f
                where jsonb_typeof(f) is distinct from 'object' or jsonb_typeof(f->'code') is distinct from 'string'
                   or (f->>'severity') is null or (f->>'severity') not in ('fail', 'hold', 'revise'))
     or exists (select 1 from jsonb_array_elements(r->'unresolved') u where jsonb_typeof(u) is distinct from 'string') then
    raise exception 'copy_review_invalid' using errcode = 'check_violation';
  end if;

  new.shop_id := r->>'shop_id';
  new.lane := r->>'lane';
  new.round := (r->>'round')::integer;
  new.previous_copy_sha256 := r->>'previous_copy_sha256';
  new.auditor_version := r->>'auditor_version';
  new.verdict := r->>'verdict';
  new.facts_sha256 := r->>'facts_sha256';
  new.facts_content_sha256 := r->>'facts_content_sha256';
  new.copy_sha256 := r->>'copy_sha256';
  new.page_html_sha256 := r->>'page_html_sha256';
  new.page_css_sha256 := r->>'page_css_sha256';
  new.unresolved := array(select jsonb_array_elements_text(r->'unresolved'));
  new.revision_findings := r->'revision_findings';

  -- verdict = the worst severity of all findings; copy verdict = the same without COPY_APPROVAL_MISSING
  select coalesce(max(case f->>'severity' when 'revise' then 1 when 'hold' then 2 when 'fail' then 3 end), 0),
         coalesce(max(case f->>'severity' when 'revise' then 1 when 'hold' then 2 when 'fail' then 3 end)
                  filter (where f->>'code' <> 'COPY_APPROVAL_MISSING'), 0)
    into v_worst, v_copy_worst
    from jsonb_array_elements(r->'findings') f;
  if new.verdict is distinct from (array['approve_candidate', 'revise', 'hold', 'fail'])[v_worst + 1] then
    raise exception 'copy_review_invalid' using errcode = 'check_violation';
  end if;
  new.copy_verdict := (array['approve_candidate', 'revise', 'hold', 'fail'])[v_copy_worst + 1];
  new.next_step := case new.copy_verdict
    when 'fail' then 'stop_fail'
    when 'hold' then 'stop_hold'
    when 'revise' then case when new.round < 2 then 'revise' else 'stop_hold' end
    else 'owner_review' end;

  -- the texts are exactly what the review names
  new.review_sha256 := encode(sha256(convert_to(new.review_text, 'UTF8')), 'hex');
  if encode(sha256(convert_to(new.facts_pack_text, 'UTF8')), 'hex') is distinct from new.facts_sha256
     or encode(sha256(convert_to(new.copy_record_text, 'UTF8')), 'hex') is distinct from new.copy_sha256
     or encode(sha256(convert_to(new.page_html_text, 'UTF8')), 'hex') is distinct from new.page_html_sha256
     or encode(sha256(convert_to(new.page_css_text, 'UTF8')), 'hex') is distinct from new.page_css_sha256 then
    raise exception 'copy_review_hash_mismatch' using errcode = 'check_violation';
  end if;

  select prospect_id into v_prospect from public.sales_demos where id = new.demo_id;
  if v_prospect is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  new.prospect_id := v_prospect;
  new.recorded_at := now();

  -- copyReviewAppendBlockers, serialised per shop
  perform pg_advisory_xact_lock(hashtext('second_root_copy_reviews:' || v_prospect::text));
  if exists (select 1 from public.sales_demo_copy_reviews q where q.prospect_id = v_prospect and q.shop_id <> new.shop_id) then
    raise exception 'copy_review_other_shop' using errcode = 'P0001';
  end if;
  select count(*)::integer into v_n from public.sales_demo_copy_reviews q
    where q.prospect_id = v_prospect and q.lane = new.lane and q.facts_content_sha256 = new.facts_content_sha256;
  select * into last from public.sales_demo_copy_reviews q
    where q.prospect_id = v_prospect and q.lane = new.lane and q.facts_content_sha256 = new.facts_content_sha256
    order by q.round desc limit 1;
  if v_n = 0 then
    if new.round <> 0 then
      raise exception 'copy_review_first_not_round_0' using errcode = 'P0001';
    end if;
    new.previous_review_id := null;
    return new;
  end if;
  if new.round = 0 then
    raise exception 'copy_review_round_0_replay' using errcode = 'P0001';
  end if;
  if new.round <> v_n or last.round <> v_n - 1 then
    raise exception 'copy_review_round_not_next' using errcode = 'P0001';
  end if;
  if new.previous_copy_sha256 is distinct from last.copy_sha256 then
    raise exception 'copy_review_not_linked' using errcode = 'P0001';
  end if;
  if new.facts_sha256 is distinct from last.facts_sha256 then
    raise exception 'copy_review_facts_changed_in_chain' using errcode = 'P0001';
  end if;
  if not (last.next_step = 'revise'
          or (last.next_step = 'owner_review' and last.lane = 'real_shop_proposal' and last.round < 2
              and exists (select 1 from public.sales_demo_copy_owner_decisions o where o.review_id = last.id and o.decision = 'revise'))) then
    raise exception 'copy_review_revision_not_allowed' using errcode = 'P0001';
  end if;
  new.previous_review_id := last.id;
  return new;
end;
$$;

create trigger sales_demo_copy_reviews_write
  before insert or update or delete on public.sales_demo_copy_reviews
  for each row execute function public.sales_check_copy_review_write();

-- Facts checks: insert-only, for exactly the review's facts pack.
create function public.sales_check_copy_facts_check_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'copy_facts_check_immutable' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.sales_demo_copy_reviews q where q.id = new.review_id and q.facts_sha256 = new.facts_sha256) then
    raise exception 'copy_facts_check_mismatch' using errcode = 'check_violation';
  end if;
  new.checked_at := now();
  return new;
end;
$$;

create trigger sales_demo_copy_facts_checks_write
  before insert or update or delete on public.sales_demo_copy_facts_checks
  for each row execute function public.sales_check_copy_facts_check_write();

-- Version links: insert-only; the review's page is the version's page.
create function public.sales_check_version_copy_link_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v public.sales_demo_versions;
  q public.sales_demo_copy_reviews;
begin
  if tg_op <> 'INSERT' then
    raise exception 'version_copy_link_immutable' using errcode = 'check_violation';
  end if;
  select * into v from public.sales_demo_versions where id = new.version_id;
  select * into q from public.sales_demo_copy_reviews where id = new.review_id;
  if v.id is null or q.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v.demo_id <> new.demo_id or q.demo_id <> new.demo_id then
    raise exception 'version_copy_other_demo' using errcode = 'check_violation';
  end if;
  if v.status not in ('draft', 'approved', 'superseded') then
    raise exception 'version_copy_version_unavailable' using errcode = 'P0001';
  end if;
  if (select f.sha256 from public.sales_demo_version_files f where f.version_id = v.id and f.path = 'page/index.html') is distinct from q.page_html_sha256
     or (select f.sha256 from public.sales_demo_version_files f where f.version_id = v.id and f.path = 'page/style.css') is distinct from q.page_css_sha256 then
    raise exception 'version_copy_stale' using errcode = 'P0001';
  end if;
  new.linked_at := now();
  return new;
end;
$$;

create trigger sales_demo_version_copy_links_write
  before insert or update or delete on public.sales_demo_version_copy_links
  for each row execute function public.sales_check_version_copy_link_write();

-- Owner decisions: insert-only, only by a signed-in sales admin as themself,
-- for a review linked to the version, bound to the review's hashes, real-shop
-- lane, facts from the facts path, at owner review, and the last round.
create function public.sales_check_copy_decision_write()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  q public.sales_demo_copy_reviews;
begin
  if tg_op <> 'INSERT' then
    raise exception 'copy_decision_immutable' using errcode = 'check_violation';
  end if;
  if not public.is_sales_admin() or new.decided_by is distinct from auth.uid() then
    raise exception 'admin_identity_required' using errcode = '42501';
  end if;
  select * into q from public.sales_demo_copy_reviews where id = new.review_id;
  if q.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.sales_demo_version_copy_links l
                 where l.version_id = new.version_id and l.review_id = q.id and l.demo_id = new.demo_id) then
    raise exception 'copy_review_not_linked_to_version' using errcode = 'P0001';
  end if;
  if row(new.review_sha256, new.facts_sha256, new.copy_sha256, new.page_html_sha256, new.page_css_sha256)
     is distinct from row(q.review_sha256, q.facts_sha256, q.copy_sha256, q.page_html_sha256, q.page_css_sha256) then
    raise exception 'copy_decision_snapshot_mismatch' using errcode = 'check_violation';
  end if;
  if q.lane <> 'real_shop_proposal' then
    raise exception 'copy_decision_fictional_lane' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.sales_demo_copy_facts_checks c where c.review_id = q.id) then
    raise exception 'copy_facts_not_from_facts_path' using errcode = 'P0001';
  end if;
  if q.next_step <> 'owner_review' then
    raise exception 'copy_review_not_at_owner_review' using errcode = 'P0001';
  end if;
  if new.decision = 'revise' and q.round >= 2 then
    raise exception 'copy_revision_cap' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.sales_demo_copy_reviews n
             where n.prospect_id = q.prospect_id and n.lane = q.lane and n.facts_content_sha256 = q.facts_content_sha256 and n.round > q.round) then
    raise exception 'copy_review_superseded' using errcode = 'P0001';
  end if;
  new.decided_at := now();
  return new;
end;
$$;

create trigger sales_demo_copy_owner_decisions_write
  before insert or update or delete on public.sales_demo_copy_owner_decisions
  for each row execute function public.sales_check_copy_decision_write();

-- ---------------------------------------------------------------------------
-- 4. The copy send guard (invoker rights; service_role only)
-- ---------------------------------------------------------------------------

-- Why a send of this version must be refused because of its copy (null: the
-- copy gate does not block). Re-derived from the rows at every call.
create function public.sales_copy_send_block(p_version_id uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  q public.sales_demo_copy_reviews;
  o public.sales_demo_copy_owner_decisions;
begin
  select r.* into q from public.sales_demo_version_copy_links l
    join public.sales_demo_copy_reviews r on r.id = l.review_id
    where l.version_id = p_version_id;
  if q.id is null then
    return 'demo_copy_review_missing';
  end if;
  if not exists (select 1 from public.sales_demo_copy_facts_checks c where c.review_id = q.id and c.facts_sha256 = q.facts_sha256) then
    return 'demo_copy_facts_not_from_facts_path';
  end if;
  -- the review's page must still be the version's page, and nothing may have followed it in its chain
  if (select f.sha256 from public.sales_demo_version_files f where f.version_id = p_version_id and f.path = 'page/index.html') is distinct from q.page_html_sha256
     or (select f.sha256 from public.sales_demo_version_files f where f.version_id = p_version_id and f.path = 'page/style.css') is distinct from q.page_css_sha256
     or exists (select 1 from public.sales_demo_copy_reviews n
                where n.prospect_id = q.prospect_id and n.lane = q.lane and n.facts_content_sha256 = q.facts_content_sha256 and n.round > q.round) then
    return 'demo_copy_review_stale';
  end if;
  if q.lane <> 'real_shop_proposal' or q.copy_verdict <> 'approve_candidate' then
    return 'demo_copy_review_not_passed';
  end if;
  if exists (select 1 from unnest(q.gate_blockers) b where b <> 'OWNER_APPROVAL_MISSING') then
    return 'demo_copy_send_blocked';
  end if;
  select * into o from public.sales_demo_copy_owner_decisions where review_id = q.id;
  if o.id is null or o.decision <> 'approve' or o.version_id <> p_version_id then
    return 'demo_copy_owner_confirmation_missing';
  end if;
  if row(o.review_sha256, o.facts_sha256, o.copy_sha256, o.page_html_sha256, o.page_css_sha256)
     is distinct from row(q.review_sha256, q.facts_sha256, q.copy_sha256, q.page_html_sha256, q.page_css_sha256) then
    return 'demo_copy_owner_confirmation_mismatch';
  end if;
  return null;
end;
$$;

-- §9.2 (20261111000000), unchanged except the copy guard after the existing
-- checks: a send of a quality-approved version also needs its copy reviewed
-- and confirmed by the owner (sales_copy_send_block). A demo with no approved
-- version (the React demo) returns null exactly as before.
create or replace function public.sales_demo_version_send_block(d public.sales_demos)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v public.sales_demo_versions;
  v_code text;
begin
  if d.approved_version_id is null then
    return null;
  end if;
  select * into v from public.sales_demo_versions where id = d.approved_version_id;
  if not found or v.demo_id <> d.id or v.status <> 'approved' or v.revoked_at is not null or v.expires_at <= now() then
    return 'demo_version_unavailable';
  end if;
  if not exists (
    select 1 from public.sales_demo_quality_reviews r
    where r.version_id = v.id and r.decision = 'approved' and r.state = 'active'
      and r.bundle_sha256 = v.bundle_sha256 and r.facts_sha256 = v.facts_sha256) then
    return 'demo_quality_not_approved';
  end if;
  if v.facts_sha256 <> public.sales_demo_facts_sha256(d) then
    return 'demo_facts_changed';
  end if;
  if not public.sales_demo_version_shareable(v.id) then
    return 'demo_not_shareable';
  end if;
  -- DEV-199e: the copy of the version (Issue #258 decision ①).
  v_code := public.sales_copy_send_block(v.id);
  if v_code is not null then
    return v_code;
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. RLS: admin read only; writes only through the functions
-- ---------------------------------------------------------------------------

alter table public.sales_demo_copy_reviews enable row level security;
alter table public.sales_demo_copy_facts_checks enable row level security;
alter table public.sales_demo_version_copy_links enable row level security;
alter table public.sales_demo_copy_owner_decisions enable row level security;

create policy sales_demo_copy_reviews_admin_read on public.sales_demo_copy_reviews
  for select to authenticated using ((select public.is_sales_admin()));
create policy sales_demo_copy_facts_checks_admin_read on public.sales_demo_copy_facts_checks
  for select to authenticated using ((select public.is_sales_admin()));
create policy sales_demo_version_copy_links_admin_read on public.sales_demo_version_copy_links
  for select to authenticated using ((select public.is_sales_admin()));
create policy sales_demo_copy_owner_decisions_admin_read on public.sales_demo_copy_owner_decisions
  for select to authenticated using ((select public.is_sales_admin()));

revoke all on public.sales_demo_copy_reviews, public.sales_demo_copy_facts_checks,
  public.sales_demo_version_copy_links, public.sales_demo_copy_owner_decisions from public, anon, authenticated, service_role;
grant select on public.sales_demo_copy_reviews to authenticated;
grant select on public.sales_demo_copy_facts_checks to authenticated;
grant select on public.sales_demo_version_copy_links to authenticated;
grant select on public.sales_demo_copy_owner_decisions to authenticated;
-- The server (service role) reads, inserts and updates like every sales_* table (scripts/staging/lib.mjs
-- REQUIRED_CHECKS); the triggers still refuse every update, every owner decision without a sales admin identity,
-- and every review that breaks the chain. Never deleted: no DELETE and no TRUNCATE for any API role.
grant select, insert, update on public.sales_demo_copy_reviews to service_role;
grant select, insert, update on public.sales_demo_copy_facts_checks to service_role;
grant select, insert, update on public.sales_demo_version_copy_links to service_role;
grant select, insert, update on public.sales_demo_copy_owner_decisions to service_role;

-- ---------------------------------------------------------------------------
-- 6. Server path: record a checked review (service_role only)
-- ---------------------------------------------------------------------------

-- Called by the importer (lib/demo-version-package/import.ts) after its own
-- checks (verifyPackageCopy; copyReviewAppendBlockers against every stored
-- review of the shop; checkCopyQualityReview with the stored chain and the
-- page's photo URLs). One round per call, in order. The same review again
-- replays. With p_facts_from_facts_path, records that the server compared the
-- facts pack with the facts path. With p_version_id, links the review to that
-- version (its page must be the version's page; one review per version).
-- It can never write an owner decision.
create function public.sales_record_copy_review(
  p_demo_id uuid,
  p_version_id uuid,
  p_review text,
  p_copy_record text,
  p_facts_pack text,
  p_page_html text,
  p_page_css text,
  p_gate_blockers text[],
  p_facts_from_facts_path boolean)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  d public.sales_demos;
  q public.sales_demo_copy_reviews;
  v_sha text;
  v_replayed boolean := false;
  v_linked uuid;
begin
  if p_demo_id is null or p_review is null or p_copy_record is null or p_facts_pack is null or p_page_html is null
     or p_page_css is null or p_facts_from_facts_path is null or not public.sales_copy_codes_valid(p_gate_blockers) then
    raise exception 'invalid_copy_review' using errcode = '22023';
  end if;
  select * into d from public.sales_demos where id = p_demo_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtext('second_root_copy_reviews:' || d.prospect_id::text));
  v_sha := encode(sha256(convert_to(p_review, 'UTF8')), 'hex');
  select * into q from public.sales_demo_copy_reviews r where r.prospect_id = d.prospect_id and r.review_sha256 = v_sha;
  if found then
    -- the same review: a replay only for exactly the same bytes and the same gate result
    if q.demo_id <> p_demo_id or q.copy_record_text <> p_copy_record or q.facts_pack_text <> p_facts_pack
       or q.page_html_text <> p_page_html or q.page_css_text <> p_page_css
       or (select array_agg(x order by x) from unnest(q.gate_blockers) x) is distinct from (select array_agg(x order by x) from unnest(p_gate_blockers) x) then
      raise exception 'copy_review_replay_differs' using errcode = 'P0001';
    end if;
    v_replayed := true;
  else
    insert into public.sales_demo_copy_reviews (prospect_id, demo_id, shop_id, lane, round, auditor_version, verdict, copy_verdict,
      next_step, unresolved, revision_findings, facts_sha256, facts_content_sha256, copy_sha256, page_html_sha256, page_css_sha256,
      review_sha256, gate_blockers, review_text, copy_record_text, facts_pack_text, page_html_text, page_css_text)
    -- placeholders: the trigger derives every column from the review text
    values (d.prospect_id, p_demo_id, '-', 'real_shop_proposal', 0, 'copy_quality_rules_v1', 'fail', 'fail', 'stop_fail', '{}', '[]',
      repeat('0', 64), repeat('0', 64), repeat('0', 64), repeat('0', 64), repeat('0', 64), repeat('0', 64),
      p_gate_blockers, p_review, p_copy_record, p_facts_pack, p_page_html, p_page_css)
    returning * into q;
  end if;
  if p_facts_from_facts_path and not exists (select 1 from public.sales_demo_copy_facts_checks c where c.review_id = q.id) then
    insert into public.sales_demo_copy_facts_checks (review_id, facts_sha256) values (q.id, q.facts_sha256);
  end if;
  if p_version_id is not null then
    select review_id into v_linked from public.sales_demo_version_copy_links where version_id = p_version_id;
    if v_linked is null then
      insert into public.sales_demo_version_copy_links (version_id, review_id, demo_id) values (p_version_id, q.id, p_demo_id);
    elsif v_linked <> q.id then
      raise exception 'version_copy_already_linked' using errcode = 'P0001';
    end if;
  end if;
  return jsonb_build_object(
    'review_id', q.id, 'round', q.round, 'previous_review_id', q.previous_review_id, 'replayed', v_replayed,
    'copy_verdict', q.copy_verdict, 'next_step', q.next_step,
    'facts_from_facts_path', exists (select 1 from public.sales_demo_copy_facts_checks c where c.review_id = q.id),
    'linked_version_id', p_version_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Admin function (SECURITY DEFINER, admin checked first)
-- ---------------------------------------------------------------------------

-- 文章を確認した (承認) / 書き直しを依頼 / 不採用: the owner's copy decision for
-- the stored review shown on a version. The hashes are what the owner's screen
-- showed and must be the review's (stale_copy_review otherwise). Never changes
-- a send approval or the demo's hash; it only makes the copy gate pass
-- (approve) or lets the next round follow (revise).
create function public.sales_decide_copy_review(
  p_version_id uuid, p_review_id uuid, p_decision text, p_review_sha256 text, p_facts_sha256 text,
  p_copy_sha256 text, p_page_html_sha256 text, p_page_css_sha256 text, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.sales_demo_copy_reviews;
  o public.sales_demo_copy_owner_decisions;
  v_demo uuid;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform public.sales_assert_admin();
  if p_decision is null or p_decision not in ('approve', 'revise', 'reject') then
    raise exception 'invalid_decision' using errcode = '22023';
  end if;
  if not public.sales_demo_note_valid(v_note) then
    raise exception 'invalid_note' using errcode = '22023';
  end if;
  select * into q from public.sales_demo_copy_reviews where id = p_review_id;
  select demo_id into v_demo from public.sales_demo_versions where id = p_version_id;
  if q.id is null or v_demo is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if row(p_review_sha256, p_facts_sha256, p_copy_sha256, p_page_html_sha256, p_page_css_sha256)
     is distinct from row(q.review_sha256, q.facts_sha256, q.copy_sha256, q.page_html_sha256, q.page_css_sha256) then
    raise exception 'stale_copy_review' using errcode = 'P0001';
  end if;
  begin
    insert into public.sales_demo_copy_owner_decisions (review_id, version_id, demo_id, decision, review_sha256, facts_sha256,
      copy_sha256, page_html_sha256, page_css_sha256, note, decided_by)
    values (q.id, p_version_id, v_demo, p_decision, q.review_sha256, q.facts_sha256, q.copy_sha256, q.page_html_sha256,
      q.page_css_sha256, v_note, auth.uid())
    returning * into o;
  exception when unique_violation then
    raise exception 'copy_decision_exists' using errcode = 'P0001';
  end;
  return jsonb_build_object('decision_id', o.id, 'review_id', q.id, 'version_id', p_version_id, 'decision', o.decision);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Function privileges
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.sales_copy_codes_valid(text[])',
    'public.sales_check_copy_review_write()',
    'public.sales_check_copy_facts_check_write()',
    'public.sales_check_version_copy_link_write()',
    'public.sales_check_copy_decision_write()',
    'public.sales_copy_send_block(uuid)',
    'public.sales_record_copy_review(uuid, uuid, text, text, text, text, text, text[], boolean)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

revoke all on function public.sales_decide_copy_review(uuid, uuid, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.sales_decide_copy_review(uuid, uuid, text, text, text, text, text, text, text) to authenticated, service_role;
