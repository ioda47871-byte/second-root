-- Second Root Sales Agent — exclusion list (DEV-049)
--
-- Shops the admin never wants prepared for sales (existing customers,
-- partners, ...). Checked inside sales_persist_candidate under the same
-- advisory lock as dedupe / DNC / daily cap; a match becomes
-- rejected(excluded) and creates no prospect, demo or outreach. Values are
-- stored with the same normalisation as ingest (lib/sales/exclusions.ts).
-- An email exclusion also matches a candidate whose submitted email is not
-- first-party, through the candidate's email_digest (no raw email kept).
-- Read: admin only (RLS). Write: admin SECURITY DEFINER functions only.
-- Operational Claude never sees this table. Existing drafts are not touched.

create table public.sales_exclusions (
  id uuid primary key default gen_random_uuid(),
  label text not null check (char_length(label) between 1 and 200),
  reason text not null check (reason in ('existing_customer', 'partner', 'other')),
  note text check (note is null or char_length(note) <= 500),
  instagram_handle text check (instagram_handle is null or instagram_handle ~ '^[a-z0-9._]{1,30}$'),
  website_domain text check (website_domain is null or char_length(website_domain) between 3 and 253),
  public_email text check (public_email is null or (char_length(public_email) <= 254 and public_email like '%_@_%')),
  normalized_name text check (normalized_name is null or char_length(normalized_name) between 1 and 200),
  normalized_address text check (normalized_address is null or char_length(normalized_address) between 1 and 300),
  created_at timestamptz not null default now(),
  created_by uuid,
  constraint sales_exclusions_name_address_pair
    check ((normalized_name is null) = (normalized_address is null)),
  constraint sales_exclusions_has_key
    check (instagram_handle is not null or website_domain is not null or public_email is not null or normalized_name is not null)
);

create unique index sales_exclusions_handle_key on public.sales_exclusions (instagram_handle) where instagram_handle is not null;
create unique index sales_exclusions_domain_key on public.sales_exclusions (website_domain) where website_domain is not null;
create unique index sales_exclusions_email_key on public.sales_exclusions (public_email) where public_email is not null;
create unique index sales_exclusions_name_address_key on public.sales_exclusions (normalized_name, normalized_address) where normalized_name is not null;

alter table public.sales_exclusions enable row level security;
create policy sales_exclusions_admin_read on public.sales_exclusions
  for select to authenticated using ((select public.is_sales_admin()));
revoke all on public.sales_exclusions from public, anon, authenticated;
grant select on public.sales_exclusions to authenticated;
grant all on public.sales_exclusions to service_role;

create function public.sales_add_exclusion(
  p_label text, p_reason text, p_note text,
  p_instagram_handle text, p_website_domain text, p_public_email text,
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
  insert into public.sales_exclusions (
    label, reason, note, instagram_handle, website_domain, public_email,
    normalized_name, normalized_address, created_by)
  values (
    p_label, p_reason, nullif(p_note, ''), nullif(p_instagram_handle, ''), nullif(p_website_domain, ''),
    nullif(p_public_email, ''), nullif(p_normalized_name, ''), nullif(p_normalized_address, ''), auth.uid())
  returning id into new_id;
  return new_id;
exception
  when unique_violation then
    raise exception 'already_excluded' using errcode = '23505';
  when check_violation then
    raise exception 'invalid_exclusion' using errcode = '22023';
end;
$$;

create function public.sales_remove_exclusion(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.sales_assert_admin();
  delete from public.sales_exclusions where id = p_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.sales_add_exclusion(text, text, text, text, text, text, text, text) from public, anon;
revoke all on function public.sales_remove_exclusion(uuid) from public, anon;
grant execute on function public.sales_add_exclusion(text, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.sales_remove_exclusion(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- persist: unchanged from 20261009000000 except the exclusion check.
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
           or (e.public_email is not null and e.public_email = c->>'public_email')
           -- Any submitted email (not only a first-party one), by digest only:
           -- an existing customer registered by email is excluded even when
           -- the candidate comes through Instagram.
           or (e.public_email is not null and c->>'email_digest' is not null
               and encode(sha256(convert_to(e.public_email, 'UTF8')), 'hex') = c->>'email_digest')
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

  result := jsonb_build_object('stage', 'outreach_ready', 'prospect_id', new_prospect);
  perform public.sales_run_set_stage(r, p_key, result);
  return jsonb_build_object('key', p_key) || result;
end;
$$;
