update public.sales_demos set design_status = 'pending', design_profile = null, design_review = null, design_job_id = null, design_claimed_at = null, design_error_code = null, design_worker_commit = null, design_updated_at = now()
where id = 'efb4bdb2-5fb8-4575-b2e1-76217a832485' and design_status = 'ready'
  and not exists (select 1 from public.sales_demos x where x.design_status in ('pending', 'processing'))
  and exists (select 1 from public.sales_outreaches o where o.prospect_id = sales_demos.prospect_id and o.kind = 'initial' and o.status = 'drafted')
returning id, design_status, design_attempts;
