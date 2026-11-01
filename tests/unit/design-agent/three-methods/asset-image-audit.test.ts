import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FactsPack } from "@/lib/design-agent/artifact/schema";
import { auditIdentity, auditPageText } from "@/lib/design-agent/identity/identity-lock";
import { AssetInspection, auditAssetImage, lockErrors } from "@/lib/design-agent/three-methods/asset-image-audit";

// DEV-150 (Issue #180, owner approval A′): the pilot picture's own check. Pure; MOCK records only; nothing is read from pixels.

const REPO = resolve(__dirname, "../../../..");
const read = (p: string) => JSON.parse(readFileSync(resolve(REPO, "design-library/research/three-methods", p), "utf8"));
const lock = read("identity-lock.json");
const facts = FactsPack.parse(read("facts-pack.json"));
const SHA = "a".repeat(64);
const ORIGIN = { approval_id: "fictional-tm-vf-image-01", kind: "image" };
const record = (o: { observed?: object; answers?: object; extra?: object } = {}) => ({
  schema: "three_method_asset_inspection_v0",
  image_sha256: SHA,
  method: "assistant_visual",
  inspector: "MOCK Claude",
  observed: { visible_text: [], logos_or_marks: [], depicted: "焼きたてのパン", category_cues: ["パン"], ...o.observed },
  inferred: "",
  answers: { other_shop_name_or_logo: "no", category_mismatch: "no", contradicts_facts: "no", contradicted_fact_ids: [], unreadable_text: "no", ...o.answers },
  note: "",
  ...o.extra,
});
const audit = (inspection: unknown, image: { sha256: string | null; origin: typeof ORIGIN | null } = { sha256: SHA, origin: ORIGIN }, l: unknown = lock) => auditAssetImage({ lock: l, facts, image, inspection });

describe("the pilot picture's verdicts", () => {
  it("a recorded inspection of exactly this picture, from an approved call, with nothing seen against the shop: PASS_ASSET_ONLY (the name's absence is normal)", () => {
    const r = audit(record());
    expect(r).toMatchObject({ status: "PASS_ASSET_ONLY", errors: [], pending: [], counts_as_site_identity: false });
    expect(r.status).not.toBe("PASS_IDENTITY_ONLY");
    // the target's own names may be seen
    expect(audit(record({ observed: { visible_text: ["こむぎ灯", "架空パン工房 こむぎ灯"] } })).status).toBe("PASS_ASSET_ONLY");
  });

  it.each<[string, unknown, { sha256: string | null; origin: typeof ORIGIN | null } | undefined, string]>([
    ["another picture inspected", record({ extra: { image_sha256: "b".repeat(64) } }), undefined, "INSPECTION_IMAGE_NOT_MATCHED"],
    ["unknown origin", record(), { sha256: SHA, origin: null }, "ASSET_ORIGIN_UNKNOWN"],
    ["another shop's name in the picture (the Lock's other_shop_names)", record({ observed: { visible_text: ["なごやビーンズ"] } }), undefined, "OTHER_SHOP_VISIBLE"],
    ["another shop's name in a mark", record({ observed: { logos_or_marks: ["看板に「月見湯」"] } }), undefined, "OTHER_SHOP_VISIBLE"],
    ["the inspector saw another shop's name or logo", record({ answers: { other_shop_name_or_logo: "yes" } }), undefined, "OTHER_SHOP_VISIBLE"],
    ["another category", record({ answers: { category_mismatch: "yes" } }), undefined, "CATEGORY_MISMATCH"],
    ["against the facts (which fact is recorded)", record({ answers: { contradicts_facts: "yes", contradicted_fact_ids: ["F2"] } }), undefined, "CONTRADICTS_FACTS"],
  ])("REJECT: %s", (_n, inspection, image, code) => {
    const r = audit(inspection, image);
    expect(r.status).toBe("REJECT");
    expect(r.errors).toContain(code);
  });

  it("round 4 L2: a contradiction is REJECT even without its fact or with an unknown one (the missing ids are noted)", () => {
    for (const ids of [[], ["F99"], ["F2", "F99"]]) {
      const r = audit(record({ answers: { contradicts_facts: "yes", contradicted_fact_ids: ids } }));
      expect(r.status, ids.join()).toBe("REJECT");
      expect(r.errors).toContain("CONTRADICTS_FACTS");
      expect(r.pending).toContain("CONTRADICTED_FACT_IDS_MISSING_OR_UNKNOWN");
      expect(r.contradicted_fact_ids).toEqual(ids.filter((x) => x !== "F99"));
    }
  });

  it("REJECT records the contradicted fact", () => {
    expect(audit(record({ answers: { contradicts_facts: "yes", contradicted_fact_ids: ["F2", "F3"] } })).contradicted_fact_ids).toEqual(["F2", "F3"]);
  });

  it.each<[string, unknown, { sha256: string | null; origin: typeof ORIGIN | null } | undefined, string]>([
    ["no record", undefined, undefined, "ASSET_INSPECTION_REQUIRED"],
    ["a record of another shape (the Lock's own visual_inspection)", { status: "completed", method: "assistant_visual", inspected_image_sha256: SHA }, undefined, "ASSET_INSPECTION_INCOMPLETE"],
    ["an unknown key", record({ extra: { verdict: "PASS" } }), undefined, "ASSET_INSPECTION_INCOMPLETE"],
    ["a missing field", Object.fromEntries(Object.entries(record()).filter(([k]) => k !== "note")), undefined, "ASSET_INSPECTION_INCOMPLETE"],
    ["no SHA of the picture", record(), { sha256: null, origin: ORIGIN }, "IMAGE_HASH_MISSING"],
    ["unreadable text", record({ answers: { unreadable_text: "yes" } }), undefined, "UNREADABLE_TEXT"],
    ["a generic word (the owner decides)", record({ observed: { visible_text: ["BREAD"] } }), undefined, "VISIBLE_TEXT_NOT_TARGET"],
    ["a mark that is not the target's name", record({ observed: { logos_or_marks: ["麦の穂の印"] } }), undefined, "LOGO_OR_MARK_NOT_TARGET"],
    ["unknown: another shop", record({ answers: { other_shop_name_or_logo: "unknown" } }), undefined, "OTHER_SHOP_UNKNOWN"],
    ["unknown: category", record({ answers: { category_mismatch: "unknown" } }), undefined, "CATEGORY_UNKNOWN"],
    ["unknown: facts", record({ answers: { contradicts_facts: "unknown" } }), undefined, "CONTRADICTS_FACTS_UNKNOWN"],
    ["unknown: unreadable", record({ answers: { unreadable_text: "unknown" } }), undefined, "UNREADABLE_TEXT_UNKNOWN"],
    ["fact ids without a contradiction", record({ answers: { contradicted_fact_ids: ["F1"] } }), undefined, "ASSET_INSPECTION_INCOMPLETE"],
  ])("HOLD: %s", (_n, inspection, image, code) => {
    const r = audit(inspection, image);
    expect(r.status).toBe("HOLD");
    expect(r.pending).toContain(code);
  });

  it("the verdict comes only from what was observed and answered: `inferred` is never read", () => {
    expect(audit(record({ extra: { inferred: "別の店 なごやビーンズ の写真に見える。BREAD" } })).status).toBe("PASS_ASSET_ONLY");
  });

  it("the record is strict: method and answers take only their values", () => {
    expect(AssetInspection.safeParse(record({ extra: { method: "ocr" } })).success).toBe(false);
    expect(AssetInspection.safeParse(record({ answers: { category_mismatch: "maybe" } })).success).toBe(false);
    expect(AssetInspection.safeParse(record()).success).toBe(true);
  });
});

describe("the Lock's own checks: re-implemented with the same rules as the Identity Lock", () => {
  const variants: [string, unknown][] = [
    ["the study's lock", lock],
    ["schema_version 2", { ...lock, schema_version: 2 }],
    ["a bad case id", { ...lock, case_id: "X-1" }],
    ["no source url", { ...lock, target: { ...lock.target, official_source_url: "" } }],
    ["no names", { ...lock, target: { ...lock.target, official_name: "♪", allowed_aliases: [] } }],
    ["the prompt names another shop", { ...lock, prompt: { ...lock.prompt, shop_name: "架空菓庵" } }],
    ["the prompt names another category", { ...lock, prompt: { ...lock.prompt, category_code: "cafe" } }],
    ["not research only", { ...lock, prompt: { ...lock.prompt, is_research_only: false } }],
    ["not an object", null],
  ];
  it.each(variants)("%s: the same errors as auditIdentity / auditPageText find in the Lock", (_n, l) => {
    // with no picture and no page, the Lock's audits report only their lock checks as errors
    const fromLock = auditIdentity(l).errors;
    expect(lockErrors(l).errors).toEqual(fromLock);
    const page = auditPageText(l, "架空パン工房 こむぎ灯").errors.filter((e) => fromLock.includes(e));
    expect(page).toEqual(fromLock);
    // and a lock that does not check makes the picture REJECT
    expect(audit(record(), undefined, l).status).toBe(fromLock.length ? "REJECT" : "PASS_ASSET_ONLY");
  });
});
