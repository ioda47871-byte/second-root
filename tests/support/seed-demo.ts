import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";

// Seeds a fictional shop with a demo straight into the local database for
// integration and e2e tests. Never used against a hosted project.

export async function seedDemo(
  db: pg.Pool | pg.Client,
  opts: { expiresAt: Date | null; disabledAt?: Date | null; keepAlive?: boolean; template?: string; category?: string; description?: string; menuItems?: string[] },
): Promise<{ token: string; prospectId: string; name: string }> {
  const n = randomUUID().slice(0, 8);
  const name = `E2Eテスト工房${n}`;
  const handle = `e2e_${n}`;
  const { rows } = await db.query(
    `insert into public.sales_prospects
       (name, normalized_name, address, normalized_address, ward, category, website_status,
        instagram_url, instagram_handle, recommended_channel)
     values ($1, $2, $3, $4, '中区', $5, 'not_found', $6, $7, 'instagram') returning id`,
    [name, name, `愛知県名古屋市中区栄${n}`, `愛知県名古屋市中区栄${n}`, opts.category ?? "bakery", `https://www.instagram.com/${handle}/`, handle],
  );
  const prospectId = rows[0].id as string;
  const token = randomBytes(32).toString("base64url");
  await db.query(
    `insert into public.sales_demos (prospect_id, public_token, template, content, expires_at, disabled_at, keep_alive)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      prospectId,
      token,
      opts.template ?? "bakery_v1",
      JSON.stringify({
        name,
        category: opts.category ?? "bakery",
        ward: "中区",
        address: `名古屋市中区栄${n}`,
        hours: "8:00〜17:00",
        menu_items: opts.menuItems ?? ["食パン", "クロワッサン"],
        ...(opts.description ? { description: opts.description } : {}),
      }),
      opts.expiresAt,
      opts.disabledAt ?? null,
      opts.keepAlive ?? false,
    ],
  );
  return { token, prospectId, name };
}

/** A fictional Instagram shop with a demo and an unsent initial draft. */
export async function seedDraft(db: pg.Pool | pg.Client, body = "はじめまして。E2E テスト用の営業文です。"): Promise<{ token: string; prospectId: string; name: string; outreachId: string }> {
  const demo = await seedDemo(db, { expiresAt: null });
  const { rows } = await db.query(
    `insert into public.sales_outreaches (prospect_id, kind, channel, body) values ($1, 'initial', 'instagram', $2) returning id`,
    [demo.prospectId, body],
  );
  return { ...demo, outreachId: rows[0].id as string };
}

/** A fictional email shop (own site + first-party contact email) with an unsent draft. */
export async function seedEmailDraft(pool: pg.Pool): Promise<{ token: string; prospectId: string; name: string; outreachId: string; email: string }> {
  const n = randomUUID().slice(0, 8);
  const name = `E2Eメール菓子店${n}`;
  const domain = `e2e-${n}.example.com`;
  const email = `info@${domain}`;
  // The email provenance check runs at commit, so prospect and source must
  // be inserted in one transaction on one connection.
  const client = await pool.connect();
  let prospectId: string;
  try {
    await client.query("begin");
    const { rows } = await client.query(
      `insert into public.sales_prospects
         (name, normalized_name, address, normalized_address, ward, category, website_status,
          website_url, website_domain, public_email, recommended_channel)
       values ($1, $1, $2, $2, '東区', 'baked_goods', 'present', $3, $4, $5, 'email') returning id`,
      [name, `愛知県名古屋市東区${n}`, `https://${domain}/`, domain, email],
    );
    prospectId = rows[0].id as string;
    await client.query(
      `insert into public.sales_sources (prospect_id, field, value, source_url, source_type, verified_at)
       values ($1, 'email', $2, $3, 'official_contact', now())`,
      [prospectId, email, `https://${domain}/contact`],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
  const token = randomBytes(32).toString("base64url");
  await pool.query(`insert into public.sales_demos (prospect_id, public_token, template, content) values ($1, $2, 'baked_goods_v1', $3)`, [
    prospectId,
    token,
    JSON.stringify({ name, category: "baked_goods", ward: "東区" }),
  ]);
  const o = await pool.query(
    `insert into public.sales_outreaches (prospect_id, kind, channel, subject, body) values ($1, 'initial', 'email', 'ホームページのご提案', 'E2E メール本文です。') returning id`,
    [prospectId],
  );
  return { token, prospectId, name, outreachId: o.rows[0].id as string, email };
}
