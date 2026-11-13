/**
 * DEV-263a / DEV-263f: a shop's demo content derived from its facts pack BYTES, and the check that a demo row was derived
 * from exactly those bytes. Pure (sha256 only): used by the local CLIs (./local-inputs.ts re-exports it) and by the
 * owner's facts registration (lib/sales/facts-store.ts, the admin screen).
 *
 *   - demoContentFromFactsBytes: FactsPack (strict) → every key mapped, none twice → demoContentFromFacts.
 *   - assertDemoContentFromFacts: the demo's sales_demos.content must hold the sha256 of exactly these bytes
 *     (content.facts_pack_sha256) and equal the content derived from them, compared as canonical JSON (jsonb does not
 *     keep key order). A 輪 demo (content.facts_pack = RIN_SHOP_ID) is refused: its photo packages are ai_demo_internal.
 */
import { createHash } from "node:crypto";
import { FactsPack } from "@/lib/design-agent/quality-pipeline/facts-pack";
import { LocalInputError } from "./local-input-error";
import { demoContentFromFacts, RIN_SHOP_ID } from "./seed-rin";

type Bytes = Uint8Array;

/** The fact keys the demo content maps (demoContentFromFacts): one of each, and numbered services / statements. */
const SINGLE_KEYS = new Set(["name", "category", "ward", "address", "hours", "closed_days", "access", "phone", "description", "workshop"]);
const MANY_KEY = /^(service|statement)_[1-9][0-9]{0,2}$/;

export const factsPackSha256 = (b: Bytes) => createHash("sha256").update(b).digest("hex");

/**
 * The demo content derived from facts pack bytes (FactsPack schema — strict, no extra field —, every key mapped, no
 * key twice, then demoContentFromFacts). An unmapped key (a fact the demo would not carry) is refused.
 */
export function demoContentFromFactsBytes(b: Bytes): Record<string, unknown> {
  let pack: FactsPack;
  try {
    pack = FactsPack.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b)));
  } catch {
    throw new LocalInputError("TRUSTED_FACTS_INVALID");
  }
  const seen = new Set<string>();
  for (const f of pack.facts) {
    if (!SINGLE_KEYS.has(f.key) && !MANY_KEY.test(f.key)) throw new LocalInputError("TRUSTED_FACTS_UNMAPPED_KEY");
    if (seen.has(f.key)) throw new LocalInputError("TRUSTED_FACTS_DUPLICATE_KEY");
    seen.add(f.key);
  }
  try {
    return demoContentFromFacts(pack);
  } catch {
    throw new LocalInputError("TRUSTED_FACTS_INCOMPLETE");
  }
}

/** The content a demo seeded from these facts pack bytes holds: the derived content and the bytes' sha256. */
export function demoContentWithFactsSha(b: Bytes): Record<string, unknown> {
  return { ...demoContentFromFactsBytes(b), facts_pack_sha256: factsPackSha256(b) };
}

/** JSON with object keys sorted at every level (jsonb's key order is not the writer's). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

/**
 * Refuses unless the demo's content is exactly demoContentWithFactsSha of these facts pack bytes (it names their
 * sha256 and holds what they derive to). A 輪 demo is refused first.
 */
export function assertDemoContentFromFacts(content: unknown, factsPack: Bytes): void {
  const c = content && typeof content === "object" && !Array.isArray(content) ? (content as Record<string, unknown>) : null;
  if (c?.facts_pack === RIN_SHOP_ID) throw new LocalInputError("TRUSTED_FACTS_RIN_DEMO");
  if (!c || c.facts_pack_sha256 !== factsPackSha256(factsPack)) throw new LocalInputError("TRUSTED_FACTS_SHA_MISMATCH");
  if (canonicalJson(c) !== canonicalJson(demoContentWithFactsSha(factsPack))) throw new LocalInputError("TRUSTED_FACTS_CONTENT_MISMATCH");
}
