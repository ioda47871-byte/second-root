/**
 * DEV-196q: recording and reading the stored structure findings of a version, with whatever Supabase client the caller
 * has (recording: the service role — sales_record_structure_findings is executable by service_role only; reading: the
 * signed-in admin, whose RLS allows it). No environment is read here. The database checks the shape again.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseStructureFindingsInput, structureAdviceOf, type StructureAdvice } from "@/lib/sales/demo-version/structure-findings";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class StructureFindingsError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/** Store one version's findings (the same findings again replay; other findings for the same version are refused). */
export async function recordStructureFindings(client: SupabaseClient, versionId: string, raw: unknown): Promise<{ versionId: string; replayed: boolean }> {
  if (!UUID.test(versionId)) throw new StructureFindingsError("STRUCTURE_FINDINGS_VERSION_INVALID");
  const parsed = parseStructureFindingsInput(raw);
  if (!parsed.ok) throw new StructureFindingsError(parsed.code);
  const { data, error } = await client.rpc("sales_record_structure_findings", {
    p_version_id: versionId,
    p_findings: parsed.value.findings,
    p_siblings_compared: parsed.value.siblingsCompared,
    p_source: parsed.value.source,
  });
  if (error || !data) throw new StructureFindingsError(`STRUCTURE_FINDINGS_REFUSED:${(error?.message ?? "no_result").split(":")[0]}`);
  const r = data as { version_id?: unknown; replayed?: unknown };
  return { versionId, replayed: r.replayed === true };
}

/**
 * PR #265 review L1: everything the database would refuse, checked BEFORE the importer writes anything — the shape
 * (with the byte cap), every sibling is an approved / superseded version of another shop's demo, and when this bundle
 * is already a version of the demo, it has no findings yet or exactly these (a replay). Throws StructureFindingsError.
 */
export async function precheckStructureFindings(client: SupabaseClient, o: { demoId: string; bundleSha256: string; raw: unknown }): Promise<void> {
  const parsed = parseStructureFindingsInput(o.raw);
  if (!parsed.ok) throw new StructureFindingsError(parsed.code);
  const siblings = [...new Set(parsed.value.findings.flatMap((f) => (f.code === "SIBLINGS_SAME_SKELETON" ? [f.sibling] : [])))];
  if (siblings.length) {
    const { data, error } = await client.from("sales_demo_versions").select("id, demo_id, status").in("id", siblings);
    const rows = (data ?? []) as { id: string; demo_id: string; status: string }[];
    if (error) throw new StructureFindingsError("STRUCTURE_FINDINGS_PRECHECK_FAILED");
    const ok = siblings.every((id) => rows.some((r) => r.id === id && r.demo_id !== o.demoId && (r.status === "approved" || r.status === "superseded")));
    if (!ok) throw new StructureFindingsError("STRUCTURE_FINDINGS_SIBLING_INVALID");
  }
  const existing = await client.from("sales_demo_versions").select("id").eq("demo_id", o.demoId).eq("bundle_sha256", o.bundleSha256).maybeSingle();
  if (existing.error) throw new StructureFindingsError("STRUCTURE_FINDINGS_PRECHECK_FAILED");
  const versionId = (existing.data as { id?: string } | null)?.id;
  if (!versionId) return;
  const f = await client.from("sales_demo_structure_findings").select("findings, siblings_compared, source").eq("version_id", versionId).maybeSingle();
  if (f.error) throw new StructureFindingsError("STRUCTURE_FINDINGS_PRECHECK_FAILED");
  const row = f.data as { findings: unknown; siblings_compared: number; source: string } | null;
  if (!row) return;
  const same = row.source === parsed.value.source && row.siblings_compared === parsed.value.siblingsCompared && canonical(row.findings) === canonical(parsed.value.findings);
  if (!same) throw new StructureFindingsError("STRUCTURE_FINDINGS_EXIST");
}

/** JSON with sorted object keys (jsonb does not keep key order). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** The advice the admin screen shows for one version. A read failure is "unreadable", never "no warnings". */
export async function loadStructureAdvice(client: SupabaseClient, versionId: string): Promise<StructureAdvice> {
  if (!UUID.test(versionId)) return { kind: "unreadable" };
  try {
    const { data, error } = await client.from("sales_demo_structure_findings").select("findings, siblings_compared").eq("version_id", versionId).maybeSingle();
    if (error) return { kind: "unreadable" };
    return structureAdviceOf((data as { findings: unknown; siblings_compared: unknown } | null) ?? null);
  } catch {
    return { kind: "unreadable" };
  }
}
