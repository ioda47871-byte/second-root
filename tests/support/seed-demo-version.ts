import { randomInt, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";
import { bundleSha256, sha256Hex, validateManifest } from "@/lib/sales/demo-version/manifest";
import { seedDemo } from "./seed-demo";
import { solidWebp } from "./solid-webp";

// DEV-196d: a fictional shop's demo with one ingested version, for integration and e2e tests against the LOCAL
// Supabase stack only. The version goes in through sales_ingest_demo_version (service role, as the server would),
// and its files are uploaded to the local private bucket when the storage API is running. Never used against a
// hosted project.

export const DEMO_VERSIONS_BUCKET = "sales-demo-versions";

export const DEFAULT_HTML =
  '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>架空の店</title><link rel="stylesheet" href="style.css"></head>' +
  '<body><main><h1 id="shop">架空の焼き菓子店</h1><p>テスト用の版です。</p><img id="hero" src="photos/hero-desktop.webp" alt="店の写真" width="40" height="30"></main></body></html>';
export const DEFAULT_CSS = "body{margin:0;font-family:sans-serif;background:#faf7f2}h1{color:#5a3e2b}";

export type StorageStatus = { available: true } | { available: false; reason: string };

/**
 * Whether the local storage API is running, decided narrowly (review of #247): it counts as unavailable ONLY when the
 * gateway cannot reach it — a network error, or an answer from the gateway itself (Kong: a body with only `message`)
 * with a gateway / no-route status. CI starts Supabase with `-x storage-api`, which looks exactly like that. Any other
 * answer (the bucket missing, an auth error, a storage-api error) THROWS, so a broken setup never turns into a skip.
 */
export async function storageStatus(url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY): Promise<StorageStatus> {
  if (!url || !key) throw new Error("storageStatus: the local Supabase URL and service key are not set");
  let res: Response;
  try {
    res = await fetch(`${url}/storage/v1/bucket/${DEMO_VERSIONS_BUCKET}`, { headers: { Authorization: `Bearer ${key}`, apikey: key } });
  } catch (e) {
    return { available: false, reason: `storage API unreachable (${(e as Error).name})` };
  }
  const text = await res.text();
  if (res.status === 200) {
    const body = JSON.parse(text) as { id?: string; public?: boolean };
    if (body.id !== DEMO_VERSIONS_BUCKET || body.public !== false) throw new Error("storageStatus: the bucket is not the private sales-demo-versions bucket");
    return { available: true };
  }
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // not JSON: not the gateway's own error either
  }
  const gatewayOnly = Object.keys(body).length === 1 && typeof body.message === "string";
  if (gatewayOnly && [404, 500, 502, 503, 504].includes(res.status)) {
    return { available: false, reason: `storage API not running behind the gateway (HTTP ${res.status}: ${String(body.message).slice(0, 80)})` };
  }
  throw new Error(`storageStatus: unexpected answer from the storage API (HTTP ${res.status})`);
}

/** Boolean form of storageStatus (throws on anything but "running" / "not running"). */
export async function storageAvailable(): Promise<boolean> {
  return (await storageStatus()).available;
}

export type SeededVersion = {
  prospectId: string;
  demoId: string;
  versionId: string;
  prefix: string;
  imageId: string;
  /** manifest name → bytes */
  objects: Record<string, Uint8Array>;
  uploaded: boolean;
};

const rgb = (): [number, number, number, number] => [randomInt(256), randomInt(256), randomInt(256), 255];

export async function seedDemoVersion(
  db: pg.Pool | pg.Client,
  svc: SupabaseClient,
  opts: {
    html?: string;
    css?: string;
    upload?: boolean;
    renderHeights?: { desktop: number; mobile: number };
    /** a new shop's name (stored as its fact before the first ingest), e.g. one without 「テスト」, which the server's HTML check refuses */
    shopName?: string;
    /** add the version to this shop's demo (with this parent) instead of seeding a new shop */
    into?: { prospectId: string; demoId: string; parentVersionId?: string };
  } = {},
): Promise<SeededVersion> {
  let prospectId: string;
  let demoId: string;
  if (opts.into) {
    ({ prospectId, demoId } = opts.into);
  } else {
    ({ prospectId } = await seedDemo(db, { expiresAt: null }));
    const { rows } = await db.query("select id from public.sales_demos where prospect_id = $1", [prospectId]);
    demoId = rows[0].id as string;
    if (opts.shopName) {
      await db.query("update public.sales_prospects set name = $2, normalized_name = $2 where id = $1", [prospectId, opts.shopName]);
      await db.query("update public.sales_demos set content = jsonb_set(content, '{name}', to_jsonb($2::text)) where id = $1", [demoId, opts.shopName]);
    }
  }

  const photo = solidWebp(40 + randomInt(200), 30 + randomInt(200), rgb());
  const desktop = solidWebp(1440, opts.renderHeights?.desktop ?? 900 + randomInt(100), rgb());
  const mobile = solidWebp(390, opts.renderHeights?.mobile ?? 1600 + randomInt(100), rgb());
  const objects: Record<string, Uint8Array> = {
    "page/index.html": new TextEncoder().encode(opts.html ?? DEFAULT_HTML),
    "page/style.css": new TextEncoder().encode(opts.css ?? DEFAULT_CSS),
    "page/photos/hero-desktop.webp": photo,
    "renders/desktop_1440.webp": desktop,
    "renders/mobile_390.webp": mobile,
  };
  const dims = (b: Uint8Array) => {
    // VP8L: 14-bit width-1 and height-1 after the signature byte at offset 20
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  };
  const m = validateManifest({
    version: 1,
    files: [
      { name: "page/index.html", role: "html", sha256: sha256Hex(objects["page/index.html"]!), bytes: objects["page/index.html"]!.byteLength, content_type: "text/html" },
      { name: "page/style.css", role: "css", sha256: sha256Hex(objects["page/style.css"]!), bytes: objects["page/style.css"]!.byteLength, content_type: "text/css" },
      { name: "page/photos/hero-desktop.webp", role: "photo", sha256: sha256Hex(photo), bytes: photo.byteLength, content_type: "image/webp", ...dims(photo) },
      { name: "renders/desktop_1440.webp", role: "render", sha256: sha256Hex(desktop), bytes: desktop.byteLength, content_type: "image/webp", ...dims(desktop) },
      { name: "renders/mobile_390.webp", role: "render", sha256: sha256Hex(mobile), bytes: mobile.byteLength, content_type: "image/webp", ...dims(mobile) },
    ],
  });
  if (!m.ok) throw new Error(`fixture manifest invalid: ${m.codes.join(",")}`);

  const image = {
    sha256: sha256Hex(photo), bytes: photo.byteLength, ...dims(photo), format: "webp", record_schema: "photo_rights_v0", source_kind: "owner_provided",
    rights_status: "owner_provided_internal", depicts_real_shop: true, depicts_identifiable_person: false, depicts_real_product: true,
    depicts_real_interior: false, depicts_real_equipment: false, allowed_uses: { edit: true, crop: true, commercial: true, public_web: false },
  };
  const res = await svc.rpc("sales_ingest_demo_version", {
    p_demo_id: demoId,
    p_generation_job_id: `job-${randomUUID()}`,
    p_parent_version_id: opts.into?.parentVersionId ?? null,
    p_origin: "manual_import",
    p_worker_commit: "abcdef1",
    p_direction_sha256: sha256Hex("direction"),
    p_bundle_sha256: bundleSha256(m.manifest),
    p_manifest: m.manifest,
    p_images: [image],
    p_validator_result: { version: 1, ok: true, codes: [], validator_commit: "abcdef1", checked_at: new Date().toISOString() },
    p_worker_checks: { checkPrototype: "ok" },
    p_structure_descriptor: null,
    p_rights_summary: { version: 1, photos: 1, by_status: { owner_provided_internal: 1 }, earliest_expiry: null, label_required: false },
  });
  if (res.error) throw new Error(`ingest failed: ${res.error.message}`);
  const versionId = (res.data as { version_id: string }).version_id;
  const v = await db.query("select storage_prefix from public.sales_demo_versions where id = $1", [versionId]);
  const img = await db.query("select id from public.sales_demo_images where sha256 = $1", [image.sha256]);
  const prefix = v.rows[0].storage_prefix as string;

  let uploaded = false;
  if (opts.upload !== false && (await storageAvailable())) {
    for (const [name, bytes] of Object.entries(objects)) {
      const type = name.endsWith(".html") ? "text/html" : name.endsWith(".css") ? "text/css" : "image/webp";
      const up = await svc.storage.from(DEMO_VERSIONS_BUCKET).upload(`${prefix}${name}`, bytes, { contentType: type, upsert: true });
      if (up.error) throw new Error(`upload failed: ${up.error.message}`);
    }
    uploaded = true;
  }
  return { prospectId, demoId, versionId, prefix, imageId: img.rows[0].id as string, objects, uploaded };
}
