/**
 * DEV-139 Stage 0 (A-4): the LOCAL database seed for the Stage 0 fictional bakery (S0_FACTS_PATH, made by A-2) — a
 * fictional shop whose registry row can equal its facts pack EXACTLY, so PR #280's identity check
 * (loadVerifiedGenerationFacts: prospect name / address === the facts pack's name / address) passes without being
 * loosened.
 *
 * Why not 環: the registry schema requires a Nagoya address (sales_prospects_nagoya: normalized_address like
 * '愛知県名古屋市%' and address like '%名古屋市%'). 環's facts say 「架空市架空区…」, which the registry can never hold, so
 * 環's seed (seed-sendable.ts) uses a placeholder address and #280 HOLDs it with PROSPECT_FACTS_IDENTITY_HOLD. The S0
 * bakery's facts carry a fictional town in the Nagoya format and service_N keys (the facts path maps only service_ /
 * statement_ keys), so the registry row here is DERIVED from the facts (s0RegistryRow): name and address are the facts'
 * values byte for byte. The shop id is the pack's own (a `fictional-` id); nothing about the shop is hard-coded here.
 *
 * What is written (one transaction, the database owner's local connection — assertLocalDbUrl — only):
 *   sales_prospects 1 · sales_sources 1 (the example.com email's first-party source) · sales_demos 1 and
 *   sales_demo_facts_packs 1 (both by the existing onboarding step sales_onboard_facts_demo, 'operator_cli', with an
 *   admin in sales_admins; the owner's switch sales_facts_registration_settings.operator_cli_enabled is turned on
 *   INSIDE the transaction for that step and off again before commit, so a rollback restores it) · sales_outreaches 1
 *   (an unsent initial email draft, so the today card exists). Refused while the owner's test-recipient switch
 *   (sales_local_test_settings.local_test_recipients_enabled) is on, so the database keeps refusing every send approval
 *   of this fictional shop. Nothing is sent, published or generated; no auth user is created.
 *
 * Every inserted id goes into an S0SeedRecord. cleanupS0Seed deletes exactly the recorded rows (and, only when asked,
 * the rows a later local import / admin review created under the same prospect), then proves nothing is left.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type pg from "pg";
import { demoContentFromFactsBytes, demoContentWithFactsSha, factsPackSha256 } from "./facts-content";
import { assertLocalDbUrl, type LocalDbConfig } from "./seed-rin";
import { isNagoyaAddress, normalizeAddress, normalizeName } from "@/lib/sales/normalize";

export class S0SeedError extends Error {
  constructor(public readonly code: string, public readonly detail?: Record<string, number>) {
    super(code);
    this.name = "S0SeedError";
  }
}

/** The explicit flag every writing sub-command (seed / cleanup) requires. */
export const S0_SEED_FLAG = "--owner-approved-local-seed";
/** The committed facts pack of the Stage 0 fictional bakery (A-2's; the same bytes on both branches). */
export const S0_FACTS_PATH = "design-library/research/quality-pipeline/poc/bakery/facts-pack.json";
/** The fixed id of the fictional prospect (only this seed creates a prospect with this id). */
export const S0_PROSPECT_ID = "13900000-5e00-4d00-8a00-000000000001";
export const S0_DOMAIN = "s0-bakery.example.com";
export const S0_EMAIL = `info@${S0_DOMAIN}`;
export const S0_SITE = `https://${S0_DOMAIN}/`;
export const S0_DRAFT = { subject: "ホームページのご提案", body: "はじめまして。ホームページのご提案用に、貴店のデモページを作りました。（架空の店の確認用の下書き。送信しない）" } as const;
const CATEGORIES = new Set(["bakery", "baked_goods", "cafe"]);
const FICTIONAL_SHOP = /^fictional-[a-z0-9_-]{1,30}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The tables the seed writes, in insert order, with the row count each gets. */
export const S0_SEED_TABLES = ["sales_prospects", "sales_sources", "sales_demos", "sales_demo_facts_packs", "sales_outreaches"] as const;
export type S0SeedTable = (typeof S0_SEED_TABLES)[number];

export type S0SeedRecord = {
  schema: "s0_local_seed_record_v1";
  prospect_id: string;
  shop_id: string;
  facts_sha256: string;
  rows: Record<S0SeedTable, string[]>;
};

/**
 * The guard of the writing sub-commands, checked before any connection: the explicit flag, and SUPABASE_DB_URL a local
 * stack (127.0.0.1 / localhost; no query string, no PG* host variable — assertLocalDbUrl). Returns the checked config.
 */
export function assertS0WriteAllowed(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): LocalDbConfig {
  if (!argv.includes(S0_SEED_FLAG)) throw new S0SeedError("S0_OWNER_APPROVAL_FLAG_MISSING");
  try {
    return assertLocalDbUrl(env.SUPABASE_DB_URL, env);
  } catch (e) {
    throw new S0SeedError(e instanceof Error ? (/^DB_URL_[A-Z_]+/.exec(e.message)?.[0] ?? "DB_URL_INVALID") : "DB_URL_INVALID");
  }
}

/**
 * The verify sub-command's API origin: http://127.0.0.1 or http://localhost only, no credentials (the same rule as the
 * importer's assertLocalSupabaseUrl, kept here so this module does not import the package importer).
 */
export function assertS0LocalApiUrl(raw: string | undefined): string {
  let u: URL;
  try {
    u = new URL(raw ?? "");
  } catch {
    throw new S0SeedError("SUPABASE_URL_INVALID");
  }
  if (u.protocol !== "http:" || !(u.hostname === "127.0.0.1" || u.hostname === "localhost") || u.username || u.password) throw new S0SeedError("SUPABASE_URL_NOT_LOCAL");
  return u.origin;
}

/**
 * The seed record file (inserted row ids) lives OUTSIDE the repository, never through a symbolic link: it is local
 * state, not a repo artifact. Returns the absolute path.
 */
export function assertS0RecordPath(repo: string, path: string | undefined, cwd: string = process.cwd()): string {
  if (!path) throw new S0SeedError("S0_RECORD_PATH_MISSING");
  const abs = resolve(cwd, path);
  const outside = (p: string, base: string) => {
    const rel = relative(base, p);
    return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  };
  if (!outside(abs, resolve(repo))) throw new S0SeedError("S0_RECORD_PATH_IN_REPO");
  if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) throw new S0SeedError("S0_RECORD_PATH_SYMLINK");
  const dir = dirname(abs);
  if (!existsSync(dir)) throw new S0SeedError("S0_RECORD_DIR_MISSING");
  if (!outside(join2(realpathSync(dir), abs), realpathSync(repo))) throw new S0SeedError("S0_RECORD_PATH_IN_REPO");
  return abs;
}
const join2 = (realDir: string, abs: string) => resolve(realDir, relative(dirname(abs), abs));

/** Before seeding (no connection yet): an existing record file must be an S0 record (a re-run), never anything else. */
export function precheckS0RecordFile(path: string): void {
  if (!existsSync(path)) return;
  try {
    parseS0SeedRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new S0SeedError("S0_RECORD_FILE_NOT_S0");
  }
}

/**
 * Writes the record (PR #284 L5): a new file is created exclusively ('wx', mode 0600); an existing file is left as it
 * is only when it already holds exactly this record, and is never overwritten otherwise (S0_RECORD_FILE_DIFFERS).
 */
export function writeS0RecordFile(path: string, rec: S0SeedRecord): "written" | "unchanged" {
  const text = `${JSON.stringify(rec, null, 2)}\n`;
  if (existsSync(path)) {
    let cur: S0SeedRecord;
    try {
      cur = parseS0SeedRecord(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      throw new S0SeedError("S0_RECORD_FILE_NOT_S0");
    }
    if (JSON.stringify(cur) !== JSON.stringify(parseS0SeedRecord(rec))) throw new S0SeedError("S0_RECORD_FILE_DIFFERS");
    return "unchanged";
  }
  writeFileSync(path, text, { flag: "wx", mode: 0o600 });
  return "written";
}

export type S0RegistryRow = {
  id: string;
  shop_id: string;
  name: string;
  normalized_name: string;
  address: string;
  normalized_address: string;
  ward: string | null;
  category: string;
  website_status: "present";
  website_url: string;
  website_domain: string;
  public_email: string;
  recommended_channel: "email";
};

/**
 * The registry row DERIVED from the facts pack bytes (pure). name / address are the facts' values unchanged (the #280
 * identity check compares them exactly); the normalised keys use the ingest's own normalisation. Refuses a pack the
 * facts path refuses (demoContentFromFactsBytes), another shop, an address the registry cannot hold, or a category
 * outside the registry's — before anything is written.
 */
export function s0RegistryRow(factsPack: Uint8Array): S0RegistryRow {
  const content = demoContentFromFactsBytes(factsPack);
  // only a fictional shop, and never 環 / 輪 (their facts address is not a registry address anyway)
  if (typeof content.facts_pack !== "string" || !FICTIONAL_SHOP.test(content.facts_pack) || content.facts_pack.startsWith("fictional-bicycle-repair-"))
    throw new S0SeedError("S0_FACTS_NOT_S0_SHOP");
  const name = String(content.name);
  const address = String(content.address);
  const category = String(content.category);
  const normalized_address = normalizeAddress(address);
  // the database's sales_prospects_nagoya, checked here so a pack it would refuse never reaches it
  if (!isNagoyaAddress(address) || !address.includes("名古屋市") || !normalized_address.startsWith("愛知県名古屋市"))
    throw new S0SeedError("S0_FACTS_ADDRESS_NOT_NAGOYA");
  if (!CATEGORIES.has(category)) throw new S0SeedError("S0_FACTS_CATEGORY_UNSUPPORTED");
  const ward = typeof content.ward === "string" && content.ward.length <= 20 ? content.ward : null;
  return {
    id: S0_PROSPECT_ID, shop_id: content.facts_pack, name, normalized_name: normalizeName(name), address, normalized_address, ward, category,
    website_status: "present", website_url: S0_SITE, website_domain: S0_DOMAIN, public_email: S0_EMAIL, recommended_channel: "email",
  };
}

/** What the seed would write, without a connection (the `plan` sub-command and the doc). Pure. */
export function s0SeedPlan(factsPack: Uint8Array) {
  const row = s0RegistryRow(factsPack);
  const { shop_id, ...prospect } = row;
  return {
    shop_id,
    prospect: { ...prospect },
    source: { prospect_id: row.id, field: "email", value: S0_EMAIL, source_url: `${S0_SITE}contact`, source_type: "official_contact" },
    demo: { prospect_id: row.id, template: `${row.category}_v1`, expires_at: null, disabled_at: null, content: demoContentWithFactsSha(factsPack) },
    facts_pack: { prospect_id: row.id, shop_id, facts_sha256: factsPackSha256(factsPack), recorded_via: "operator_cli" },
    outreach: { prospect_id: row.id, kind: "initial", channel: "email", status: "drafted", ...S0_DRAFT },
    counts: Object.fromEntries(S0_SEED_TABLES.map((t) => [t, 1])) as Record<S0SeedTable, number>,
  };
}

/** Validates a record read back from disk (the cleanup's only input). Only the S0 prospect is ever accepted. */
export function parseS0SeedRecord(raw: unknown): S0SeedRecord {
  const r = raw as S0SeedRecord;
  const ok =
    r && typeof r === "object" && r.schema === "s0_local_seed_record_v1" && r.prospect_id === S0_PROSPECT_ID && typeof r.shop_id === "string" && FICTIONAL_SHOP.test(r.shop_id) &&
    Object.keys(r).length === 5 &&
    typeof r.facts_sha256 === "string" && /^[0-9a-f]{64}$/.test(r.facts_sha256) && r.rows && typeof r.rows === "object" &&
    Object.keys(r.rows).length === S0_SEED_TABLES.length &&
    S0_SEED_TABLES.every((t) => Array.isArray(r.rows[t]) && r.rows[t].length === 1 && r.rows[t].every((id) => typeof id === "string" && UUID.test(id))) &&
    r.rows.sales_prospects[0] === S0_PROSPECT_ID;
  if (!ok) throw new S0SeedError("S0_RECORD_INVALID");
  return { schema: r.schema, prospect_id: r.prospect_id, shop_id: r.shop_id, facts_sha256: r.facts_sha256, rows: Object.fromEntries(S0_SEED_TABLES.map((t) => [t, [...r.rows[t]]])) as S0SeedRecord["rows"] };
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** The ids of the seeded rows of the S0 prospect, if it is still exactly the seed (else S0_SEED_ID_TAKEN). */
async function existingSeed(db: pg.ClientBase, plan: ReturnType<typeof s0SeedPlan>): Promise<S0SeedRecord | null> {
  const p = await db.query("select name, address, normalized_name, normalized_address, public_email, do_not_contact from public.sales_prospects where id = $1", [S0_PROSPECT_ID]);
  if (!p.rows[0]) return null;
  const row = p.rows[0];
  const d = await db.query("select id, content from public.sales_demos where prospect_id = $1", [S0_PROSPECT_ID]);
  const s = await db.query("select id from public.sales_sources where prospect_id = $1 order by created_at, id", [S0_PROSPECT_ID]);
  const f = await db.query("select id, facts_sha256, demo_id from public.sales_demo_facts_packs where prospect_id = $1 order by seq", [S0_PROSPECT_ID]);
  const o = await db.query("select id from public.sales_outreaches where prospect_id = $1 order by created_at, id", [S0_PROSPECT_ID]);
  const same =
    row.name === plan.prospect.name && row.address === plan.prospect.address && row.normalized_name === plan.prospect.normalized_name &&
    row.normalized_address === plan.prospect.normalized_address && row.public_email === S0_EMAIL && row.do_not_contact === false &&
    d.rows.length === 1 && canonical(d.rows[0].content) === canonical(plan.demo.content) && s.rows.length === 1 && o.rows.length === 1 &&
    f.rows.length === 1 && f.rows[0].facts_sha256 === plan.facts_pack.facts_sha256 && f.rows[0].demo_id === d.rows[0].id;
  if (!same) throw new S0SeedError("S0_SEED_ID_TAKEN");
  return record(plan, { sales_sources: s.rows[0].id, sales_demos: d.rows[0].id, sales_demo_facts_packs: f.rows[0].id, sales_outreaches: o.rows[0].id });
}

function record(plan: ReturnType<typeof s0SeedPlan>, ids: Record<Exclude<S0SeedTable, "sales_prospects">, string>): S0SeedRecord {
  return {
    schema: "s0_local_seed_record_v1", prospect_id: S0_PROSPECT_ID, shop_id: plan.shop_id, facts_sha256: plan.facts_pack.facts_sha256,
    rows: { sales_prospects: [S0_PROSPECT_ID], sales_sources: [ids.sales_sources], sales_demos: [ids.sales_demos], sales_demo_facts_packs: [ids.sales_demo_facts_packs], sales_outreaches: [ids.sales_outreaches] },
  };
}

/**
 * Creates (or finds) the S0 fictional prospect, its email source, its demo + stored facts (the existing onboarding step)
 * and an unsent draft, in ONE transaction on this owner connection. Idempotent: a second run returns the same ids
 * (created: false); a row with the fixed id that is not exactly the seed is refused (S0_SEED_ID_TAKEN).
 *
 * The owner's facts CLI switch is set on inside the transaction just for the onboarding step and off before commit
 * (PR #284 L2): a failure anywhere rolls the switch back with the rows. Refused while the test-recipient switch is on
 * (PR #284 L3), so "send approval refused" holds for this fictional shop.
 */
export async function seedS0Shop(db: pg.ClientBase, a: { factsPack: Uint8Array; adminId: string }): Promise<{ record: S0SeedRecord; created: boolean }> {
  if (!UUID.test(a.adminId)) throw new S0SeedError("S0_ADMIN_INVALID");
  const plan = s0SeedPlan(a.factsPack);
  const tr = await db.query("select local_test_recipients_enabled from public.sales_local_test_settings where id");
  if (tr.rows[0]?.local_test_recipients_enabled !== false) throw new S0SeedError("S0_LOCAL_TEST_RECIPIENTS_ON");
  const found = await existingSeed(db, plan);
  if (found) return { record: found, created: false };
  // a read-only precondition, so a refusal names the missing step (the database re-checks it)
  if (!(await db.query("select 1 from public.sales_admins where user_id = $1", [a.adminId])).rows[0]) throw new S0SeedError("S0_ADMIN_NOT_FOUND");
  const p = plan.prospect;
  await db.query("begin");
  try {
    await db.query(
      `insert into public.sales_prospects (id, name, normalized_name, address, normalized_address, ward, category, website_status, website_url, website_domain, public_email, recommended_channel)
       values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [p.id, p.name, p.normalized_name, p.address, p.normalized_address, p.ward, p.category, p.website_status, p.website_url, p.website_domain, p.public_email, p.recommended_channel],
    );
    const s = await db.query(
      `insert into public.sales_sources (prospect_id, field, value, source_url, source_type, verified_at)
       values ($1::uuid, 'email', $2, $3, 'official_contact', now()) returning id`,
      [p.id, plan.source.value, plan.source.source_url],
    );
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(a.factsPack);
    await db.query("update public.sales_facts_registration_settings set operator_cli_enabled = true where id");
    const ob = await db.query("select public.sales_onboard_facts_demo($1::uuid, $2::text, false, $3::uuid, 'operator_cli') as r", [p.id, text, a.adminId]);
    await db.query("update public.sales_facts_registration_settings set operator_cli_enabled = false where id");
    const r = ob.rows[0].r as { demo_id: string; facts_pack_id: string; facts_sha256: string; demo_created: boolean };
    if (!r.demo_created || r.facts_sha256 !== plan.facts_pack.facts_sha256) throw new S0SeedError("S0_ONBOARDING_UNEXPECTED");
    const o = await db.query(
      `insert into public.sales_outreaches (prospect_id, kind, channel, subject, body) values ($1::uuid, 'initial', 'email', $2, $3) returning id`,
      [p.id, S0_DRAFT.subject, S0_DRAFT.body],
    );
    await db.query("commit");
    return { record: record(plan, { sales_sources: s.rows[0].id, sales_demos: r.demo_id, sales_demo_facts_packs: r.facts_pack_id, sales_outreaches: o.rows[0].id }), created: true };
  } catch (e) {
    await db.query("rollback");
    throw e;
  }
}

/** Rows a later local import / admin flow may create under the prospect (never by the seed), in delete order. */
const IMPORTED: readonly [string, string][] = [
  ["sales_outreach_draft_edits", "outreach_id in (select id from public.sales_outreaches where prospect_id = $1)"],
  ["sales_outreach_approvals", "prospect_id = $1"],
  ["sales_demo_copy_owner_decisions", "demo_id in (select id from public.sales_demos where prospect_id = $1)"],
  ["sales_demo_version_copy_links", "demo_id in (select id from public.sales_demos where prospect_id = $1)"],
  ["sales_demo_copy_facts_checks", "review_id in (select id from public.sales_demo_copy_reviews where prospect_id = $1)"],
  ["sales_demo_structure_findings", "demo_id in (select id from public.sales_demos where prospect_id = $1)"],
  ["sales_demo_quality_reviews", "demo_id in (select id from public.sales_demos where prospect_id = $1)"],
  ["sales_demo_version_files", "version_id in (select v.id from public.sales_demo_versions v join public.sales_demos d on d.id = v.demo_id where d.prospect_id = $1)"],
  ["sales_demo_copy_reviews", "prospect_id = $1"],
  ["sales_demo_versions", "demo_id in (select id from public.sales_demos where prospect_id = $1)"],
  ["sales_demo_images", "prospect_id = $1"],
  ["sales_prospect_insights", "prospect_id = $1"],
];
/** Seed tables: rows of the prospect that are NOT the recorded ones. */
const UNRECORDED: readonly [S0SeedTable, string][] = [
  ["sales_sources", "prospect_id = $1 and id <> all($2::uuid[])"],
  ["sales_demo_facts_packs", "prospect_id = $1 and id <> all($2::uuid[])"],
  ["sales_outreaches", "prospect_id = $1 and id <> all($2::uuid[])"],
  ["sales_demos", "prospect_id = $1 and id <> all($2::uuid[])"],
];

async function countAll(db: pg.ClientBase, rec: S0SeedRecord): Promise<{ imported: Record<string, number>; unrecorded: Record<string, number> }> {
  const imported: Record<string, number> = {};
  for (const [t, where] of IMPORTED) {
    const n = (await db.query(`select count(*)::int as n from public.${t} where ${where}`, [rec.prospect_id])).rows[0].n as number;
    if (n > 0) imported[t] = n;
  }
  const unrecorded: Record<string, number> = {};
  for (const [t, where] of UNRECORDED) {
    const n = (await db.query(`select count(*)::int as n from public.${t} where ${where}`, [rec.prospect_id, rec.rows[t]])).rows[0].n as number;
    if (n > 0) unrecorded[t] = n;
  }
  return { imported, unrecorded };
}

/** Append-only tables (a user trigger refuses every delete); their user triggers are off only around their own delete. */
const APPEND_ONLY = new Set([
  "sales_demo_facts_packs", "sales_demo_images", "sales_demo_versions", "sales_demo_version_files", "sales_demo_quality_reviews",
  "sales_demo_copy_reviews", "sales_demo_copy_facts_checks", "sales_demo_version_copy_links", "sales_demo_copy_owner_decisions", "sales_demo_structure_findings",
]);

type ForeignKey = { table: string; column: string; ref: S0SeedTable };
const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new S0SeedError("S0_CLEANUP_FK_UNCOUNTABLE");
  return s;
};
/** Every foreign key in the database that references one of the five seed tables (pg_constraint). */
async function foreignKeysToSeedTables(db: pg.ClientBase): Promise<ForeignKey[]> {
  const r = await db.query(
    `select n.nspname as nsp, t.relname as tbl, a.attname as col, rt.relname as ref, array_length(c.conkey, 1) as cols
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
       join pg_class rt on rt.oid = c.confrelid join pg_namespace rn on rn.oid = rt.relnamespace
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.contype = 'f' and rn.nspname = 'public' and rt.relname = any($1::text[])
      order by 2, 3`,
    [S0_SEED_TABLES],
  );
  // a multi-column key, or one from outside public, is not counted here: refuse rather than assume
  if (r.rows.some((x) => x.nsp !== "public" || x.cols !== 1)) throw new S0SeedError("S0_CLEANUP_FK_UNCOUNTABLE");
  return r.rows.map((x) => ({ table: ident(String(x.tbl)), column: ident(String(x.col)), ref: x.ref as S0SeedTable }));
}
/** Rows referencing the seeded ids through each foreign key ("table.column" → count), except the keys `skip` accepts. */
async function referencing(db: pg.ClientBase, fks: ForeignKey[], ids: Record<S0SeedTable, string[]>, skip: (fk: ForeignKey) => boolean): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const fk of fks) {
    if (skip(fk)) continue;
    const n = (await db.query(`select count(*)::int as n from public.${fk.table} where ${fk.column} = any($1::uuid[])`, [ids[fk.ref]])).rows[0].n as number;
    if (n > 0) out[`${fk.table}.${fk.column}`] = n;
  }
  return out;
}

/**
 * Deletes exactly the recorded rows (each delete must hit exactly one row of this prospect) in one transaction as the
 * database owner. Foreign keys stay enforced throughout (PR #284 L1): only the user triggers of the append-only table
 * being emptied are disabled, around that one delete. Before deleting, every foreign key in the database that references
 * the five seed tables (pg_constraint, so tables such as sales_ig_threads are covered) is counted: a reference from
 * anywhere but the seed tables and the known import tables refuses (S0_CLEANUP_UNKNOWN_REFERENCES). After deleting, the
 * same foreign keys must find nothing and no row of the prospect may be left, before commit.
 * Refuses, writing nothing, when the prospect is not the seed any more, or when other rows exist under it: rows a local
 * import / admin review made (S0_CLEANUP_IMPORTED_ROWS, unless includeImported) or seed-table rows not in the record
 * (S0_CLEANUP_UNRECORDED_ROWS, always). Returns the deleted counts per table and the storage prefixes of imported
 * versions (their files are not removed here).
 */
export async function cleanupS0Seed(db: pg.ClientBase, raw: unknown, o: { factsPack: Uint8Array; includeImported?: boolean }): Promise<{ deleted: Record<string, number>; storagePrefixesLeft: string[] }> {
  const rec = parseS0SeedRecord(raw);
  const row = s0RegistryRow(o.factsPack);
  if (factsPackSha256(o.factsPack) !== rec.facts_sha256 || row.shop_id !== rec.shop_id) throw new S0SeedError("S0_RECORD_FACTS_MISMATCH");
  await db.query("begin");
  try {
    const p = await db.query("select 1 from public.sales_prospects where id = $1 and name = $2 and address = $3 and public_email = $4 for update", [rec.prospect_id, row.name, row.address, S0_EMAIL]);
    if (!p.rows[0]) throw new S0SeedError("S0_CLEANUP_PROSPECT_NOT_SEED");
    const before = await countAll(db, rec);
    if (Object.keys(before.unrecorded).length) throw new S0SeedError("S0_CLEANUP_UNRECORDED_ROWS", before.unrecorded);
    if (Object.keys(before.imported).length && !o.includeImported) throw new S0SeedError("S0_CLEANUP_IMPORTED_ROWS", before.imported);
    const fks = await foreignKeysToSeedTables(db);
    const known = new Set<string>([...S0_SEED_TABLES, ...IMPORTED.map(([t]) => t)]);
    const unknown = await referencing(db, fks, rec.rows, (fk) => known.has(fk.table));
    if (Object.keys(unknown).length) throw new S0SeedError("S0_CLEANUP_UNKNOWN_REFERENCES", unknown);
    const prefixes = (await db.query(
      "select v.storage_prefix from public.sales_demo_versions v join public.sales_demos d on d.id = v.demo_id where d.prospect_id = $1 order by v.storage_prefix",
      [rec.prospect_id],
    )).rows.map((r) => String(r.storage_prefix));
    /** One delete; an append-only table's user triggers are off for this statement only (its FK triggers stay on). */
    const del = async (table: string, sql: string, params: unknown[]) => {
      const off = APPEND_ONLY.has(table);
      if (off) await db.query(`alter table public.${ident(table)} disable trigger user`);
      const n = (await db.query(sql, params)).rowCount ?? 0;
      if (off) await db.query(`alter table public.${ident(table)} enable trigger user`);
      return n;
    };
    const deleted: Record<string, number> = {};
    for (const [t, where] of IMPORTED) {
      if (!before.imported[t]) continue;
      // the demo's pin on an imported version is released first (sales_demos keeps its triggers; no send is open by now)
      if (t === "sales_demo_versions") await db.query("update public.sales_demos set approved_version_id = null where prospect_id = $1 and approved_version_id is not null", [rec.prospect_id]);
      deleted[t] = await del(t, `delete from public.${t} where ${where}`, [rec.prospect_id]);
      if (deleted[t] !== before.imported[t]) throw new S0SeedError("S0_CLEANUP_COUNT_MISMATCH");
    }
    for (const t of ["sales_outreaches", "sales_demo_facts_packs", "sales_demos", "sales_sources"] as const) {
      const n = await del(t, `delete from public.${t} where id = $1 and prospect_id = $2`, [rec.rows[t][0], rec.prospect_id]);
      if (n !== 1) throw new S0SeedError("S0_CLEANUP_ROW_MISSING");
      deleted[t] = n;
    }
    const n = await del("sales_prospects", "delete from public.sales_prospects where id = $1", [rec.prospect_id]);
    if (n !== 1) throw new S0SeedError("S0_CLEANUP_ROW_MISSING");
    deleted.sales_prospects = n;
    // nothing references the deleted ids through any foreign key, and nothing of the prospect is left
    const refsLeft = await referencing(db, fks, rec.rows, () => false);
    const left = await countAll(db, { ...rec, rows: Object.fromEntries(S0_SEED_TABLES.map((t) => [t, []])) as unknown as S0SeedRecord["rows"] });
    const prospectLeft = (await db.query("select count(*)::int as n from public.sales_prospects where id = $1", [rec.prospect_id])).rows[0].n as number;
    if (Object.keys(refsLeft).length || Object.keys(left.imported).length || Object.keys(left.unrecorded).length || prospectLeft !== 0)
      throw new S0SeedError("S0_CLEANUP_ROWS_LEFT");
    await db.query("commit");
    return { deleted, storagePrefixesLeft: prefixes };
  } catch (e) {
    await db.query("rollback");
    throw e;
  }
}
