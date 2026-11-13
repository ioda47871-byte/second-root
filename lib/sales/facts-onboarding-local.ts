/**
 * DEV-263h: the LOCAL development equivalent of the admin screen's デモの事実を facts pack から作る
 * (scripts/sales/demo-version/onboard-local.ts). The caller connects to a local stack only (assertLocalDbUrl) as the
 * database owner; the database still requires the owner's local CLI switch (sales_facts_registration_settings, default
 * off) and an admin identity in sales_admins, and runs the same step (sales_onboard_facts_demo, 'operator_cli').
 *
 * A real shop's facts pack never lives in a tracked place: the file must be outside the repository, or inside its
 * gitignored working directory LOCAL_SHOPS_DIR; never a symbolic link.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type pg from "pg";
import { FactsOnboardingError, planFactsOnboarding, type OnboardedDemo, type OnboardingAction, type OnboardingDemoState } from "./facts-onboarding";

/** The repository's gitignored working directory for real shops' files (docs/operations/real-shop-demo-workflow.md). */
export const LOCAL_SHOPS_DIR = ".local-shops";
const MAX_BYTES = 1_048_576;

const inside = (p: string, base: string) => {
  const rel = relative(base, p);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

/** Reads a facts pack file for onboarding: outside the repository or under LOCAL_SHOPS_DIR, a regular file, no link. */
export function readOnboardingFacts(repo: string, path: string, cwd: string = process.cwd()): string {
  const abs = resolve(cwd, path);
  if (!existsSync(abs)) throw new FactsOnboardingError("FACTS_FILE_MISSING");
  if (lstatSync(abs).isSymbolicLink()) throw new FactsOnboardingError("FACTS_FILE_SYMLINK");
  const real = realpathSync(abs);
  if (!lstatSync(real).isFile()) throw new FactsOnboardingError("FACTS_FILE_MISSING");
  const repoAbs = resolve(repo);
  const repoReal = realpathSync(repo);
  for (const [p, base] of [
    [abs, repoAbs],
    [real, repoReal],
  ] as const) {
    if (inside(p, base) && !inside(p, resolve(base, LOCAL_SHOPS_DIR))) throw new FactsOnboardingError("FACTS_FILE_IN_REPO");
  }
  const bytes = readFileSync(real);
  if (bytes.length < 2 || bytes.length > MAX_BYTES) throw new FactsOnboardingError("FACTS_FILE_SIZE");
  try {
    // the exact bytes (a BOM is kept, and then refused as JSON): the stored sha256 is of these bytes
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new FactsOnboardingError("TRUSTED_FACTS_INVALID");
  }
}

/** The prospect and its demo as the onboarding plan needs them (owner connection), or null when there is no prospect. */
export async function loadOnboardingState(db: pg.ClientBase, prospectId: string, shopId: string | null): Promise<OnboardingDemoState | null> {
  const p = await db.query("select name, address, do_not_contact from public.sales_prospects where id = $1", [prospectId]);
  if (!p.rows[0]) return null;
  const d = await db.query("select content, expires_at, disabled_at, design_status from public.sales_demos where prospect_id = $1", [prospectId]);
  const a = await db.query("select 1 from public.sales_outreach_approvals where prospect_id = $1 and state in ('approved', 'send_opened', 'sent') limit 1", [prospectId]);
  let other: boolean | null = null;
  if (shopId) {
    const o = await db.query(
      `select 1 from public.sales_demos where prospect_id <> $1 and content->>'facts_pack' = $2
       union all select 1 from public.sales_demo_facts_packs where prospect_id <> $1 and shop_id = $2 limit 1`,
      [prospectId, shopId],
    );
    other = o.rows.length > 0;
  }
  const demo = d.rows[0] as { content: unknown; expires_at: Date | null; disabled_at: Date | null; design_status: string | null } | undefined;
  return {
    doNotContact: p.rows[0].do_not_contact === true,
    prospect: { name: String(p.rows[0].name), address: String(p.rows[0].address) },
    approvalInFlight: a.rows.length > 0,
    shopOnOtherProspect: other,
    demo: demo ? { content: demo.content, expiresAt: demo.expires_at?.toISOString() ?? null, disabledAt: demo.disabled_at?.toISOString() ?? null, designStatus: demo.design_status } : null,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Plans, then runs sales_onboard_facts_demo as the local owner ('operator_cli'). A replacement needs replaceContent; a
 * pack whose name / address differ from the prospect row needs identityConfirmed.
 * Throws FactsOnboardingError with the plan's or the database's code; writes nothing on a refusal.
 */
export async function onboardFactsLocal(
  db: pg.ClientBase,
  a: { prospectId: string; factsPack: string; adminId: string; replaceContent: boolean; identityConfirmed?: boolean },
): Promise<OnboardedDemo & { action: OnboardingAction }> {
  if (!UUID.test(a.prospectId) || !UUID.test(a.adminId)) throw new FactsOnboardingError("invalid_input");
  let shopId: string | null = null;
  try {
    const v = (JSON.parse(a.factsPack) as { shop_id?: unknown }).shop_id;
    shopId = typeof v === "string" ? v : null;
  } catch {
    // planFactsOnboarding refuses it
  }
  const state = await loadOnboardingState(db, a.prospectId, shopId);
  if (!state) throw new FactsOnboardingError("not_found");
  const plan = planFactsOnboarding(a.factsPack, state);
  if (!plan.ok) throw new FactsOnboardingError(plan.code);
  // PR #271 L3: a pack whose name / address differ from the prospect row needs the explicit confirmation
  if (plan.identity.mismatch && !a.identityConfirmed) throw new FactsOnboardingError("facts_onboarding_identity_unconfirmed");
  if (plan.needsConfirm && !a.replaceContent) throw new FactsOnboardingError("facts_onboarding_replace_unconfirmed");
  try {
    const r = await db.query("select public.sales_onboard_facts_demo($1::uuid, $2::text, $3::boolean, $4::uuid, 'operator_cli') as r", [
      a.prospectId,
      a.factsPack,
      plan.needsConfirm && a.replaceContent,
      a.adminId,
    ]);
    return { ...(r.rows[0].r as OnboardedDemo), action: plan.action };
  } catch (e) {
    const code = e instanceof Error ? e.message.split(":")[0]!.trim() : "unknown";
    throw new FactsOnboardingError(/^[a-z_]+$/.test(code) ? code : "onboarding_failed");
  }
}
