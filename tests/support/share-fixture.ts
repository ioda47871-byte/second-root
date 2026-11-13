import type pg from "pg";
import { QUALITY_CHECKLIST_ITEMS } from "@/lib/sales/demo-version/quality";

// DEV-196g: fixtures for versioned sharing, against the LOCAL Supabase stack only (never a hosted project).
//
// - setShareSwitch: the database half of the switch (sales_demo_share_settings), flipped as the database owner — the
//   way the owner would in the SQL editor. Tests turn it back off when they finish.
// - pinSentApproval: a `sent` initial-outreach approval that pinned `versionId` (or no version: a legacy demo), written
//   straight into the table as the database owner with triggers off, and the demo made public (sent 30 days). The real
//   path (quality approval → copy confirmation from the facts path → send approval → 送信済み) needs the facts path
//   (DEV-263a); the share decision only reads the sent row, so this is what it sees after a real send.

export async function setShareSwitch(db: pg.Pool, on: boolean): Promise<void> {
  await db.query("update public.sales_demo_share_settings set versioned_sharing_enabled = $1", [on]);
}

export async function pinSentApproval(db: pg.Pool, o: { prospectId: string; versionId: string | null; userId: string }): Promise<string> {
  const c = await db.connect();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    // the pin carries the version's quality approval (sales_outreach_approvals_demo_pin): an approved review of it
    if (o.versionId !== null) {
      await c.query(
        `insert into public.sales_demo_quality_reviews (version_id, demo_id, decision, checklist, viewed_renders_sha256, bundle_sha256, facts_sha256, reviewed_by)
         select v.id, v.demo_id, 'approved', (select jsonb_object_agg(k, 'ok') from unnest($3::text[]) k),
                (select jsonb_object_agg(replace(replace(f.path, 'renders/', ''), '.webp', ''), f.sha256) from public.sales_demo_version_files f where f.version_id = v.id and f.role = 'render'),
                v.bundle_sha256, v.facts_sha256, $2
           from public.sales_demo_versions v where v.id = $1
            and not exists (select 1 from public.sales_demo_quality_reviews r where r.version_id = $1 and r.decision = 'approved' and r.state = 'active')`,
        [o.versionId, o.userId, QUALITY_CHECKLIST_ITEMS],
      );
    }
    const out = await c.query(`insert into public.sales_outreaches (prospect_id, kind, channel, body, status, sent_at) values ($1, 'initial', 'instagram', 'E2E テスト用の営業文です。', 'sent', now()) returning id`, [o.prospectId]);
    const { rows } = await c.query(
      `insert into public.sales_outreach_approvals (outreach_id, prospect_id, channel, recipient, body, draft_version, demo_token, demo_version,
         snapshot_sha256, approved_by, demo_version_id, demo_bundle_sha256, demo_quality_review_id, demo_share_eligible,
         state, opened_at, last_opened_at, opened_via, open_count, sent_at, sent_by)
       select o.id, o.prospect_id, o.channel, coalesce(p.instagram_handle, 'example'), o.body || ' /demo/' || d.public_token, o.draft_version, d.public_token,
              public.sales_demo_version(d), encode(sha256(convert_to(o.id::text, 'UTF8')), 'hex'), $3,
              v.id, v.bundle_sha256,
              (select r.id from public.sales_demo_quality_reviews r where r.version_id = v.id and r.decision = 'approved' and r.state = 'active' limit 1),
              case when v.id is null then null else true end,
              'sent', now(), now(), 'instagram_profile', 1, now(), $3
         from public.sales_outreaches o join public.sales_prospects p on p.id = o.prospect_id join public.sales_demos d on d.prospect_id = p.id
         left join public.sales_demo_versions v on v.id = $2
        where o.id = $1
       returning id`,
      [out.rows[0].id, o.versionId, o.userId],
    );
    await c.query("update public.sales_demos set expires_at = now() + interval '30 days' where prospect_id = $1", [o.prospectId]);
    await c.query("commit");
    return rows[0].id as string;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}
