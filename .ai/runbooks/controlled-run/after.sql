select d.design_status, d.design_attempts, d.design_job_id, d.design_error_code, d.design_worker_commit, d.design_updated_at,
  md5(d.design_profile::text) as profile_md5, d.design_review->>'verdict' as review_verdict, d.design_review->>'total' as review_total,
  (select json_agg(json_build_object('kind', o.kind, 'status', o.status, 'sent', o.sent_at is not null)) from public.sales_outreaches o where o.prospect_id = d.prospect_id) as outreaches,
  (select count(*) from public.sales_demos x where x.design_status in ('pending', 'processing')) as queue_open
from public.sales_demos d
where d.id = 'efb4bdb2-5fb8-4575-b2e1-76217a832485';
