import { describe, expect, it } from "vitest";
import {
  compareVersionMeta,
  defaultBaseVersion,
  diffLines,
  diffManifests,
  diffStructure,
  LINE_DIFF_LIMITS,
  rightsCounts,
  validatorCodes,
  type CopyLine,
} from "@/lib/sales/demo-version/compare";
import type { ArtifactManifest } from "@/lib/sales/demo-version/manifest";

const h = (c: string) => c.repeat(64);
const manifest = (files: Array<[string, ArtifactManifest["files"][number]["role"], string, number]>): ArtifactManifest => ({
  version: 1,
  files: files.map(([name, role, sha, bytes]) => ({ name, role, sha256: sha, bytes, content_type: role === "html" ? "text/html" : role === "css" ? "text/css" : "image/webp", ...(role === "photo" || role === "render" ? { width: 10, height: 10 } : {}) })),
});

describe("diffManifests", () => {
  it("classifies added, removed, changed and same files by name and sha256", () => {
    const a = manifest([["page/index.html", "html", h("a"), 10], ["page/style.css", "css", h("b"), 10], ["page/photos/hero-desktop.webp", "photo", h("c"), 10], ["renders/desktop_1440.webp", "render", h("d"), 10]]);
    const b = manifest([["page/index.html", "html", h("a"), 10], ["page/style.css", "css", h("e"), 12], ["page/photos/lead-desktop.webp", "photo", h("f"), 10], ["renders/desktop_1440.webp", "render", h("d"), 10]]);
    const d = diffManifests(a, b);
    expect(d.counts).toEqual({ added: 1, removed: 1, changed: 1, same: 2 });
    expect(d.entries.map((e) => [e.name, e.change])).toEqual([
      ["page/index.html", "same"],
      ["page/photos/hero-desktop.webp", "removed"],
      ["page/photos/lead-desktop.webp", "added"],
      ["page/style.css", "changed"],
      ["renders/desktop_1440.webp", "same"],
    ]);
    expect(d.entries.find((e) => e.change === "removed")!.b).toBeNull();
    expect(d.entries.find((e) => e.change === "added")!.a).toBeNull();
  });

  it("does not depend on file order", () => {
    const files: Array<[string, "html" | "css", string, number]> = [["page/index.html", "html", h("a"), 1], ["page/style.css", "css", h("b"), 1]];
    expect(diffManifests(manifest(files), manifest([...files].reverse())).counts).toEqual({ added: 0, removed: 0, changed: 0, same: 2 });
  });
});

const L = (text: string, kind: CopyLine["kind"] = "fact"): CopyLine => ({ text, kind });

describe("diffLines", () => {
  it("finds the minimal edit with an LCS", () => {
    const r = diffLines([L("店名"), L("住所"), L("営業時間"), L("電話")], [L("店名"), L("営業時間"), L("定休日"), L("電話")]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ops.map((o) => `${o.op}:${o.text}`)).toEqual(["same:店名", "del:住所", "same:営業時間", "add:定休日", "same:電話"]);
    expect([r.added, r.removed]).toEqual([1, 1]);
  });

  it("treats a creative heading turned into a fact line as a change", () => {
    const r = diffLines([L("どこを直すか、先に決める。", "creative")], [L("どこを直すか、先に決める。", "fact")]);
    expect(r.ok && r.ops.map((o) => `${o.op}:${o.kind}`)).toEqual(["add:fact", "del:creative"]);
  });

  it("handles empty sides and identical inputs", () => {
    expect(diffLines([], [])).toEqual({ ok: true, ops: [], added: 0, removed: 0 });
    const same = [L("a"), L("b")];
    expect(diffLines(same, same)).toEqual({ ok: true, ops: same.map((l) => ({ op: "same", ...l })), added: 0, removed: 0 });
    expect(diffLines([], [L("x")])).toEqual({ ok: true, ops: [{ op: "add", text: "x", kind: "fact" }], added: 1, removed: 0 });
  });

  it("refuses inputs over its bounds instead of spending unbounded time", () => {
    const many = Array.from({ length: LINE_DIFF_LIMITS.lines + 1 }, (_, i) => L(`l${i}`));
    expect(diffLines(many, [])).toEqual({ ok: false, reason: "TOO_LARGE" });
    expect(diffLines([L("x".repeat(LINE_DIFF_LIMITS.lineChars + 1))], [])).toEqual({ ok: false, reason: "TOO_LARGE" });
    // 2000 × 2000 distinct lines exceed the DP cell bound
    const a = Array.from({ length: 2000 }, (_, i) => L(`a${i}`));
    const b = Array.from({ length: 2000 }, (_, i) => L(`b${i}`));
    expect(diffLines(a, b)).toEqual({ ok: false, reason: "TOO_LARGE" });
  });

  it("a long common prefix and suffix does not count against the cell bound", () => {
    const common = Array.from({ length: 1990 }, (_, i) => L(`c${i}`));
    const r = diffLines([...common, L("old")], [...common, L("new")]);
    expect(r.ok && [r.added, r.removed]).toEqual([1, 1]);
  });
});

describe("diffStructure", () => {
  const d = (hero: unknown, layouts: unknown) => ({ schema: "structure_descriptor_v0", hero: hero === null ? null : { value: hero, source: "measured" }, section_layouts: layouts === null ? null : { value: layouts, source: "measured" } });

  it("diffs each of the 8 aspects, joining sequences", () => {
    const r = diffStructure(d("object_led", ["full_bleed_media", "vertical_text"]), d("split_copy_media", ["full_bleed_media", "vertical_text"]));
    expect(r).toHaveLength(8);
    expect(r.find((x) => x.aspect === "hero")).toEqual({ aspect: "hero", a: "object_led", b: "split_copy_media", changed: true });
    expect(r.find((x) => x.aspect === "section_layouts")).toEqual({ aspect: "section_layouts", a: "full_bleed_media → vertical_text", b: "full_bleed_media → vertical_text", changed: false });
  });

  it("shows only vocabulary-shaped words, never free text", () => {
    const r = diffStructure(d("<img src=x onerror=alert(1)>", ["ok_word", "Not A Word"]), null);
    expect(r.find((x) => x.aspect === "hero")!.a).toBeNull();
    expect(r.find((x) => x.aspect === "section_layouts")!.a).toBeNull();
    expect(r.every((x) => x.b === null)).toBe(true);
  });
});

describe("validatorCodes / rightsCounts / compareVersionMeta", () => {
  it("keeps only fixed codes and fails closed on a malformed result", () => {
    expect(validatorCodes({ ok: true, codes: ["B_CODE", "A_CODE", "A_CODE", "free text", 3] })).toEqual({ ok: true, codes: ["A_CODE", "B_CODE"] });
    expect(validatorCodes(null)).toEqual({ ok: false, codes: [] });
    expect(validatorCodes({ ok: "true" })).toEqual({ ok: false, codes: [] });
  });

  it("reads rights counts with known shapes only", () => {
    expect(rightsCounts({ version: 1, by_status: { ai_concept_internal: 2, "Bad Key": 1, unknown: -1, owner_provided_internal: 1.5 } })).toEqual({ ai_concept_internal: 2 });
    expect(rightsCounts("x")).toEqual({});
  });

  it("compares hashes, facts, commit, validator codes and rights", () => {
    const base = { id: "a", bundle_sha256: h("1"), facts_sha256: h("2"), worker_commit: "abcdef1", validator_result: { ok: true, codes: ["X_ONE"] }, rights_summary: { by_status: { ai_concept_internal: 1 } } };
    const m = compareVersionMeta(base, { ...base, id: "b", bundle_sha256: h("3"), worker_commit: "not a commit", validator_result: { ok: true, codes: ["X_TWO"] }, rights_summary: { by_status: { owner_provided_internal: 2 } } });
    expect(m.bundleChanged).toBe(true);
    expect(m.factsChanged).toBe(false);
    expect(m.workerCommit).toEqual({ a: "abcdef1", b: null, changed: true });
    expect([m.validator.added, m.validator.removed]).toEqual([["X_TWO"], ["X_ONE"]]);
    expect(m.rights).toEqual([{ status: "ai_concept_internal", a: 1, b: 0 }, { status: "owner_provided_internal", a: 0, b: 2 }]);
  });
});

describe("defaultBaseVersion", () => {
  const versions = [{ id: "v1", parent_version_id: null }, { id: "v2", parent_version_id: "v1" }, { id: "v3", parent_version_id: "v2" }];

  it("prefers the approved version, then the parent", () => {
    expect(defaultBaseVersion({ candidateId: "v3", approvedVersionId: "v1", versions })).toBe("v1");
    expect(defaultBaseVersion({ candidateId: "v3", approvedVersionId: null, versions })).toBe("v2");
    expect(defaultBaseVersion({ candidateId: "v1", approvedVersionId: "v1", versions })).toBeNull();
    expect(defaultBaseVersion({ candidateId: "v3", approvedVersionId: "v3", versions })).toBe("v2");
  });

  it("returns only ids of this demo's versions", () => {
    expect(defaultBaseVersion({ candidateId: "v3", approvedVersionId: "other-demo", versions })).toBe("v2");
    expect(defaultBaseVersion({ candidateId: "nope", approvedVersionId: "v1", versions })).toBeNull();
    expect(defaultBaseVersion({ candidateId: "v1", approvedVersionId: null, versions: [{ id: "v1", parent_version_id: "gone" }] })).toBeNull();
  });
});
