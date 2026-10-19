-- Second Root Sales Agent — the design review summary on demos (DEV-058)
--
-- The worker's visual reviews (DEV-028 / DEV-053) end in a verdict and five
-- scores. A demo that is ready, or blocked because no review accepted its
-- final candidate (QUALITY_NOT_ACCEPTED), now keeps a compact summary of
-- them for the admin (docs/ARCHITECTURE.md §10): fixed keys, numbers and
-- enums only, never Codex's words. Forward only and additive:
--
--   * sales_demos.design_review: null, or the summary. The table bounds its
--     shape (object, version 1, exactly the allowed keys, numbers / the
--     verdict enum, size); the server validates it with ReviewSummarySchema
--     (lib/design-agent/review-summary.ts) before it gets here.
--   * It exists only on a ready or blocked demo, like design_profile on a
--     ready one: a demo going back to pending / processing (a retried or
--     re-claimed job) never carries one.
--   * sales_design_submit takes it as an optional last argument
--     (p_review, default null). A call without it (an older bridge, the
--     claim's own blocked closes) is the same call as before. A summary the
--     table's checks refuse is invalid_result; any other check violation of
--     the update is raised unchanged, as before this migration.
--
-- Nothing reads this column with SALES_AI_DESIGN_ENABLED off, and the public
-- demo never reads it.

alter table public.sales_demos
  add column design_review jsonb
    constraint sales_demos_design_review_shape check (design_review is null or (
      jsonb_typeof(design_review) = 'object'
      and pg_column_size(design_review) <= 512
      -- (jsonb_path_* results are coalesced: an unknown answer must not pass the check)
      -- exactly these keys, nothing else
      and design_review ?& array['version', 'verdict', 'total', 'max', 'scores', 'rounds', 'confidence', 'qualityNotAccepted']
      and (design_review - array['version', 'verdict', 'total', 'max', 'scores', 'rounds', 'confidence', 'qualityNotAccepted']) = '{}'::jsonb
      and design_review->'version' = '1'::jsonb
      and design_review->'max' = '25'::jsonb
      and jsonb_typeof(design_review->'verdict') = 'string'
      and design_review->>'verdict' in ('accept', 'revise')
      and coalesce(jsonb_path_match(design_review, '$.total.type() == "number" && $.total >= 5 && $.total <= 25 && $.total.floor() == $.total'), false)
      and coalesce(jsonb_path_match(design_review, '$.rounds.type() == "number" && $.rounds >= 1 && $.rounds <= 10 && $.rounds.floor() == $.rounds'), false)
      and jsonb_typeof(design_review->'qualityNotAccepted') = 'boolean'
      and (jsonb_typeof(design_review->'confidence') = 'null'
           or coalesce(jsonb_path_match(design_review, '$.confidence.type() == "number" && $.confidence >= 0 && $.confidence <= 1'), false))
      -- the five score axes of the review schema, each an integer 1-5
      and jsonb_typeof(design_review->'scores') = 'object'
      and (design_review->'scores') ?& array['brand_fit', 'visual_quality', 'hierarchy', 'mobile_quality', 'generic_template_feel']
      and (design_review->'scores') - array['brand_fit', 'visual_quality', 'hierarchy', 'mobile_quality', 'generic_template_feel'] = '{}'::jsonb
      -- (strict: lax mode would unwrap a score given as an array)
      and not coalesce(jsonb_path_exists(design_review, 'strict $.scores.* ? (@.type() != "number" || @ < 1 || @ > 5 || @.floor() != @)', '{}', true), true)));

alter table public.sales_demos
  -- A summary only on a finished design (ready, or blocked by the quality gate).
  add constraint sales_demos_design_review_final
    -- (coalesce: a legacy demo's null status must not let a summary through)
    check (design_review is null or coalesce(design_status in ('ready', 'blocked'), false));

-- ---------------------------------------------------------------------------
-- sales_design_submit: the same function (every guard of 20261009000000
-- unchanged), with the optional review summary. The old six-argument
-- function is replaced, not overloaded, so a call with the old arguments
-- resolves to this one (p_review defaults to null) and is never ambiguous.
-- ---------------------------------------------------------------------------

drop function public.sales_design_submit(uuid, text, jsonb, text, text, integer);

create function public.sales_design_submit(
  p_job_id uuid, p_outcome text, p_profile jsonb, p_error_code text, p_worker_commit text,
  p_max_attempts integer default 3, p_review jsonb default null)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  d public.sales_demos;
  outcome text := p_outcome;
  profile jsonb := p_profile;
  code text := p_error_code;
  review jsonb := p_review;
  next_status text;
  violated text;
begin
  if p_job_id is null or outcome is null or outcome not in ('ready', 'blocked', 'failed')
     or (outcome = 'ready') <> (profile is not null)
     or (outcome = 'ready') <> (code is null)
     or p_max_attempts is null or p_max_attempts < 1 or p_max_attempts > 3
     -- DEV-058: a summary only with ready or the quality gate's blocked code
     or (review is not null and not (outcome = 'ready' or (outcome = 'blocked' and code = 'QUALITY_NOT_ACCEPTED'))) then
    raise exception 'invalid_result' using errcode = '22023';
  end if;

  select * into d from public.sales_demos where design_job_id = p_job_id for update;
  if not found then
    raise exception 'job_superseded' using errcode = 'P0001';
  end if;
  if d.design_status <> 'processing' then
    return public.sales_design_state(d, true);
  end if;

  if not exists (
    select 1 from public.sales_outreaches o
    where o.prospect_id = d.prospect_id and o.kind = 'initial' and o.status = 'drafted') then
    outcome := 'blocked';
    profile := null;
    code := public.sales_design_closed_code(d.prospect_id);
    review := null;
  end if;

  next_status := case
    when outcome = 'failed' and d.design_attempts < p_max_attempts then 'pending'
    else outcome
  end;

  begin
    update public.sales_demos
      set design_status = next_status,
          design_profile = case when next_status = 'ready' then profile end,
          design_review = case when next_status in ('ready', 'blocked') then review end,
          design_error_code = code,
          design_worker_commit = p_worker_commit,
          design_claimed_at = null,
          design_updated_at = now()
      where id = d.id
      returning * into d;
  exception when check_violation then
    -- Only a summary the table refuses becomes invalid_result (nothing is
    -- written). Any other check violation is raised unchanged, as before.
    get stacked diagnostics violated = constraint_name;
    if violated in ('sales_demos_design_review_shape', 'sales_demos_design_review_final') then
      raise exception 'invalid_result' using errcode = '22023';
    end if;
    raise;
  end;
  return public.sales_design_state(d, false);
end;
$$;

-- Only the server (service role) may submit design results.
revoke all on function public.sales_design_submit(uuid, text, jsonb, text, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.sales_design_submit(uuid, text, jsonb, text, text, integer, jsonb) to service_role;
