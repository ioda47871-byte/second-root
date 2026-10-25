/**
 * DEV-112: OFFLINE seam between the *existing* Sales Design Bridge worker job
 * and the evidence-first Design DNA research flow.
 *
 * This is a traceability inventory, NOT verification that a webpage says what
 * a claim says. A Claude-written evidence row cannot prove itself. Nothing
 * here fetches URLs, reads screenshots, calls a model or authorizes G1/G2.
 * The live bridge contract, worker/renderer and their result states are unchanged.
 */
import { z } from "zod";
import { DesignFactsSchema } from "@/lib/sales/design-bridge-schema";
import { shopFactsFromFixture, type ShopFacts } from "@/lib/design-agent/design-image/shop-proposals";
import { JobSchema } from "@/lib/design-agent/worker/queue";
import { parseInstagramProfileUrl } from "@/lib/design-agent/worker/source-url";
import { parseWebsiteUrl } from "@/lib/design-agent/worker/website";

const EvidenceRow = z.strictObject({
  // "menu_items.0" etc. refer to one precisely positioned item, not an inferred product.
  fact_key: z.string().min(1).max(40),
  source_url: z.url().max(300),
  quote: z.string().min(1).max(1000),
  checked_at: z.iso.datetime({ offset: true }),
});
const EvidenceRows = z.array(EvidenceRow).max(32);
export type G0EvidenceRow = z.infer<typeof EvidenceRow>;

export type G0Result =
  | { status: "invalid_job" | "invalid_facts" | "invalid_source" | "invalid_evidence"; data: null }
  | { status: "missing_evidence" | "inconsistent_evidence"; missing: string[]; data: null }
  | {
      status: "traceable_not_verified";
      data: {
        job_id: string;
        // This is exactly the worker's fact-only input, minus category; no shop claims
        // are inferred from industry or a blurred Instagram screenshot.
        shop_facts: ShopFacts;
        traced_keys: string[];
        source_count: number;
        // Explicit negative authorizations; a future orchestrator must independently
        // verify quotations and obtain asset rights and model-call approval.
        independent_source_verification_required: true;
        owner_review_required: true;
        image_model_input_authorized: false;
        image_edit_authorized: false;
        image_generation_authorized: false;
        comp_to_site_authorized: false;
        publish_authorized: false;
        outreach_authorized: false;
      };
    };

function claims(facts: z.infer<typeof DesignFactsSchema>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(facts)) {
    if (key === "category") continue; // classified by ingest; not a verbatim shop quotation
    if (typeof value === "string") out.set(key, value);
    else if (key === "menu_items" && Array.isArray(value)) {
      value.forEach((item, i) => out.set(`menu_items.${i}`, item));
    }
  }
  return out;
}

/**
 * Trace individual worker job facts back to URLs that were already allowed by
 * that job. The caller must check original content separately. Passing this
 * function NEVER grants any image rights or permission to execute the pipeline.
 */
export function traceBridgeJobFacts(rawJob: unknown, rawEvidence: unknown): G0Result {
  const jobParsed = JobSchema.safeParse(rawJob);
  if (!jobParsed.success) return { status: "invalid_job", data: null };
  const job = jobParsed.data;
  const factsParsed = DesignFactsSchema.safeParse(job.facts);
  if (!factsParsed.success) return { status: "invalid_facts", data: null };
  if (
    (job.source.instagram_url !== undefined && !parseInstagramProfileUrl(job.source.instagram_url)) ||
    (job.source.website_url !== undefined && !parseWebsiteUrl(job.source.website_url))
  ) return { status: "invalid_source", data: null };
  const parsed = EvidenceRows.safeParse(rawEvidence);
  if (!parsed.success) return { status: "invalid_evidence", data: null };

  const sourceUrls = new Set([job.source.website_url, job.source.instagram_url].filter((s): s is string => s !== undefined));
  const expected = claims(factsParsed.data);
  const seen = new Set<string>();
  const missing: string[] = [];
  let inconsistent = false;
  for (const evidence of parsed.data) {
    const original = expected.get(evidence.fact_key);
    if (
      original === undefined ||
      seen.has(evidence.fact_key) ||
      !sourceUrls.has(evidence.source_url) ||
      !evidence.quote.includes(original)
    ) {
      inconsistent = true;
      break;
    }
    seen.add(evidence.fact_key);
  }
  if (inconsistent) return { status: "inconsistent_evidence", missing: [], data: null };
  for (const key of expected.keys()) if (!seen.has(key)) missing.push(key);
  if (missing.length) return { status: "missing_evidence", missing, data: null };

  return {
    status: "traceable_not_verified",
    data: {
      job_id: job.job_id,
      shop_facts: shopFactsFromFixture({ facts: factsParsed.data }),
      traced_keys: [...expected.keys()],
      source_count: new Set(parsed.data.map((e) => e.source_url)).size,
      independent_source_verification_required: true,
      owner_review_required: true,
      image_model_input_authorized: false,
      image_edit_authorized: false,
      image_generation_authorized: false,
      comp_to_site_authorized: false,
      publish_authorized: false,
      outreach_authorized: false,
    },
  };
}
