import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildInventory, inventoryCase, isPictureKey, kindOf } from "../../../../lib/design-agent/reference-originals/inventory";
import { currentInventoryText } from "../../../../scripts/design-artifact/reference-inventory";

const REPO = resolve(__dirname, "../../../..");
const A = "a".repeat(64);
const B = "b".repeat(64);
const manifest = JSON.parse(readFileSync(resolve(REPO, "design-library/success-cases/manifest.json"), "utf8")) as { registered_case_count: number; records: Array<Record<string, unknown> & { id: string }> };

describe("success originals inventory (DEV-154, Issue #193)", () => {
  it("the committed inventory is what the manifest and the images in the repository give now", () => {
    const committed = readFileSync(resolve(REPO, "design-library/research/quality-pipeline/originals-inventory.json"), "utf8");
    expect(committed).toBe(currentInventoryText());
  });

  it("counts every registered case, exactly as the manifest says (never guessed)", () => {
    const inv = JSON.parse(currentInventoryText());
    expect(inv.counts.cases).toBe(manifest.registered_case_count);
    expect(inv.counts.cases).toBe(manifest.records.length);
  });

  it("a registered preview counts as in the repository only when its SHA-256 equals the recorded one", () => {
    const r = { id: "CP-900", view: "html_css_js_poc", preview: "assets/x.webp", webp_sha256: A };
    expect(inventoryCase(r, [{ path: "design-library/success-cases/assets/x.webp", sha256: A }]).state).toBe("preview_in_repo");
    expect(inventoryCase(r, [{ path: "design-library/success-cases/assets/x.webp", sha256: B }]).state).toBe("recorded_sha_only");
    expect(inventoryCase(r, []).state).toBe("recorded_sha_only");
  });

  it("archives, HTML and offline preview pages are not pictures; CP-015's note captures are its PC/SP pages", () => {
    for (const k of ["source_archive_sha256", "approved_html_sha256", "approved_offline_preview_sha256", "offline_preview_sha256", "research_zip_sha256"]) expect(isPictureKey(k)).toBe(false);
    const cp015 = manifest.records.find((r) => r.id === "CP-015")!;
    const c = inventoryCase(cp015, []);
    expect(c.originals.map((o) => [o.key, o.kind, o.view])).toEqual([
      ["approved_hero_sha256", "original", "concept"],
      ["desktop_note_png_sha256", "original", "desktop"],
      ["mobile_note_png_sha256", "original", "mobile"],
    ]);
    expect([c.has_desktop, c.has_mobile]).toEqual([true, true]);
  });

  it("kinds keep originals, previews, comparisons, earlier versions and rejected versions apart", () => {
    expect(kindOf("desktop_original_png_sha256")).toBe("original");
    expect(kindOf("webp_sha256")).toBe("registered_preview");
    expect(kindOf("preview_webp_sha256")).toBe("registered_preview");
    expect(kindOf("hero_comparison_png_sha256")).toBe("comparison");
    expect(kindOf("before_after_png_sha256")).toBe("comparison");
    expect(kindOf("visual_reference_sha256")).toBe("comparison");
    expect(kindOf("first_concept_png_sha256")).toBe("superseded");
    expect(kindOf("original_b_png_sha256")).toBe("superseded");
    expect(kindOf("V1_Rejected_sha256")).toBe("rejected");
    expect(kindOf("v5_not_preferred_sha256")).toBe("rejected");
    // a case with only counter-examples recorded has no adopted picture: no view is claimed for it
    const c = inventoryCase({ id: "CP-901", view: "concept_art_only", v1_rejected_sha256: B, first_concept_png_sha256: A }, []);
    expect([c.state, c.has_desktop, c.has_mobile]).toEqual(["recorded_sha_only", false, false]);
  });

  it("views come from the keys; a static concept's generic key is a concept, not a desktop page", () => {
    const poc = inventoryCase({ id: "CP-902", view: "html_css_js_poc", desktop_1440_png_sha256: A, mobile_390_png_sha256: B }, []);
    expect([poc.has_desktop, poc.has_mobile, poc.form]).toEqual([true, true, "web_poc_capture"]);
    const art = inventoryCase({ id: "CP-903", view: "concept_art", original_png_sha256: A }, []);
    expect([art.has_desktop, art.originals[0]!.view, art.form]).toEqual([false, "concept", "static_concept_image"]);
  });

  it("counts every state", () => {
    const inv = buildInventory({ manifestSha256: A, records: [{ id: "CP-1", view: "html_css_js_poc" }, { id: "CP-2", view: "html_css_js_poc", desktop_original_png_sha256: A }], files: [] });
    expect(inv.counts).toEqual({ cases: 2, preview_in_repo: 0, recorded_sha_only: 1, metadata_only: 1, with_desktop_and_mobile: 0, originals_in_repo: 0 });
  });

  /**
   * Every SHA-256 the manifest and the case notes record (pictures, previews kept in the conversations, archives,
   * HTML), except the manifest's own `webp_sha256` / `mobile_webp_sha256` of the cases that register a preview path,
   * and only where the file at that path still has that SHA-256 (a replaced file is not allowed by its path alone).
   */
  function guarded(records: typeof manifest.records): { guarded: Set<string>; allowed: Set<string> } {
    const allowed = new Set<string>();
    for (const r of records)
      for (const [pathKey, shaKey] of [["preview", "webp_sha256"], ["mobile_preview", "mobile_webp_sha256"]] as const) {
        const p = r[pathKey];
        const v = r[shaKey];
        if (typeof p !== "string" || typeof v !== "string") continue;
        const onDisk = createHash("sha256").update(readFileSync(resolve(REPO, "design-library/success-cases", p))).digest("hex");
        if (onDisk === v) allowed.add(v);
      }
    const fromManifest = records.flatMap((r) => Object.entries(r).filter(([k, v]) => k.toLowerCase().endsWith("sha256") && typeof v === "string" && /^[0-9a-f]{64}$/.test(v)).map(([, v]) => v as string));
    const notes = spawnSync("git", ["ls-files", "-z", "--", "design-library/success-cases/*.md"], { cwd: REPO, encoding: "utf8" }).stdout.split("\0").filter(Boolean);
    const fromNotes = notes.flatMap((p) => (readFileSync(resolve(REPO, p), "utf8").match(/\b[0-9a-f]{64}\b/gi) ?? []).map((v) => v.toLowerCase()));
    return { guarded: new Set([...fromManifest, ...fromNotes].filter((v) => !allowed.has(v))), allowed };
  }

  it("the guard covers previews kept outside GitHub and archives; only the registered in-repo previews are allowed", () => {
    const { guarded: set, allowed } = guarded(manifest.records);
    const cp009 = manifest.records.find((r) => r.id === "CP-009")!;
    expect(set.has(cp009.preview_webp_sha256 as string)).toBe(true);
    expect(set.has(cp009.source_archive_sha256 as string)).toBe(true);
    expect(allowed.size).toBe(4);
  });

  it("no tracked file is a recorded original, preview kept outside GitHub, archive or HTML (the repository is public)", { timeout: 60_000 }, () => {
    const { guarded: set } = guarded(manifest.records);
    // every tracked file, whatever its name or case (a picture renamed .bin is still the picture)
    const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" }).stdout.split("\0").filter(Boolean);
    const hits = tracked.filter((p) => set.has(createHash("sha256").update(readFileSync(resolve(REPO, p))).digest("hex")));
    expect(hits).toEqual([]);
  });
});
