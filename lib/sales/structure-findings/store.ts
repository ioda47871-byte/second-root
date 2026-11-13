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
