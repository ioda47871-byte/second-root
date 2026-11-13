import { describe, expect, it } from "vitest";
import { structureAdviceText } from "@/lib/sales/demo-version/admin-messages";
import { parseStructureFindingsInput, structureAdviceOf } from "@/lib/sales/demo-version/structure-findings";

// DEV-196q: the stored structure findings — strict shape on the way in, advice (never blocking) on the way out.

const SIB = "11111111-1111-4111-8111-111111111111";
const findings = [
  { code: "GENERIC_SKELETON", reasons: ["hero:split_copy_media", "flow:stacked_bands"] },
  { code: "SIBLINGS_SAME_SKELETON", sibling: SIB, similarity: 0.82 },
  { code: "TOO_CLOSE_TO_REFERENCE", reference: "CP-003", similarity: 0.9 },
  { code: "ASPECTS_UNKNOWN", aspects: ["transitions"] },
];

describe("parseStructureFindingsInput", () => {
  it("accepts the four codes with exactly their keys", () => {
    const r = parseStructureFindingsInput({ source: "observation_report", findings, siblingsCompared: 20 });
    expect(r.ok).toBe(true);
    expect(parseStructureFindingsInput({ source: "observation_report", findings: [], siblingsCompared: 0 }).ok).toBe(true);
  });
  it.each([
    ["unknown code", { source: "observation_report", findings: [{ code: "PASS" }], siblingsCompared: 0 }],
    ["extra key", { source: "observation_report", findings: [{ ...findings[0], note: "x" }], siblingsCompared: 0 }],
    ["similarity out of range", { source: "observation_report", findings: [{ ...findings[1], similarity: 1.2 }], siblingsCompared: 0 }],
    ["sibling not a uuid", { source: "observation_report", findings: [{ ...findings[1], sibling: "x" }], siblingsCompared: 0 }],
    ["free text reason", { source: "observation_report", findings: [{ code: "GENERIC_SKELETON", reasons: ["Looks generic!"] }], siblingsCompared: 0 }],
    ["unknown aspect", { source: "observation_report", findings: [{ code: "ASPECTS_UNKNOWN", aspects: ["colour"] }], siblingsCompared: 0 }],
    ["too many siblings", { source: "observation_report", findings: [], siblingsCompared: 21 }],
    ["unknown source", { source: "model", findings: [], siblingsCompared: 0 }],
    ["not an object", null],
    // PR #265 review L1: over the byte cap (the database caps the column at 16 KiB)
    ["over the byte cap", { source: "observation_report", findings: Array.from({ length: 64 }, () => ({ code: "GENERIC_SKELETON", reasons: Array.from({ length: 8 }, () => `${"a".repeat(40)}:${"b".repeat(40)}`) })), siblingsCompared: 0 }],
  ])("refuses %s", (_name, raw) => {
    expect(parseStructureFindingsInput(raw)).toEqual({ ok: false, code: "STRUCTURE_FINDINGS_INVALID" });
  });
});

describe("structureAdviceOf / structureAdviceText (advice beside items 3・4, never blocking)", () => {
  it("not stored and unreadable are said plainly, never as 'no warnings'", () => {
    expect(structureAdviceOf(null)).toEqual({ kind: "not_stored" });
    expect(structureAdviceOf({ findings: [{ code: "PASS" }], siblings_compared: 0 })).toEqual({ kind: "unreadable" });
    expect(structureAdviceOf({ findings: [], siblings_compared: -1 })).toEqual({ kind: "unreadable" });
    expect(structureAdviceText({ kind: "not_stored" }).note).toContain("保存されていません");
    expect(structureAdviceText({ kind: "unreadable" }).note).toContain("警告が無いという意味ではありません");
  });
  it("stored findings become the advisory warnings, blocking false", () => {
    const a = structureAdviceOf({ findings, siblings_compared: 12 });
    expect(a.kind).toBe("stored");
    if (a.kind !== "stored") return;
    expect(a.blocking).toBe(false);
    expect(a.warnings.map((w) => w.code)).toEqual(["GENERIC_SKELETON", "SAME_SKELETON_AS_OTHER_SHOP", "TOO_CLOSE_TO_REFERENCE", "ASPECTS_UNKNOWN"]);
    const t = structureAdviceText(a);
    expect(t.lines).toEqual(["汎用 LP の骨格の印があります（参考）。", "ほかの店舗の承認済みの版と骨格が近い（82%、参考）。", "成功例と骨格が近い（90%、参考）。", "構造の一部を計測できませんでした（参考）。"]);
    expect(t.note).toContain("12 件");
    expect(t.note).toContain("止めません");
  });
  it("no finding is not 'a good structure'", () => {
    const t = structureAdviceText(structureAdviceOf({ findings: [], siblings_compared: 3 }));
    expect(t.lines).toEqual([]);
    expect(t.note).toContain("良い構成という意味ではありません");
  });
});
