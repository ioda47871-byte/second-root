import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildInventory, inventoryCase } from "../../../../lib/design-agent/reference-originals/inventory";
import { currentInventoryText } from "../../../../scripts/design-artifact/reference-inventory";

const REPO = resolve(__dirname, "../../../..");
const A = "a".repeat(64);
const B = "b".repeat(64);

describe("success originals inventory (DEV-154, Issue #193)", () => {
  it("the committed inventory is what the manifest and the images in the repository give now", () => {
    const committed = readFileSync(resolve(REPO, "design-library/research/quality-pipeline/originals-inventory.json"), "utf8");
    expect(committed).toBe(currentInventoryText());
  });

  it("a file counts as in the repository only when its SHA-256 equals the recorded one", () => {
    const r = { id: "CP-900", view: "html_css_js_poc", preview: "assets/x.webp", webp_sha256: A };
    expect(inventoryCase(r, [{ path: "design-library/success-cases/assets/x.webp", sha256: A }]).state).toBe("in_repo");
    expect(inventoryCase(r, [{ path: "design-library/success-cases/assets/x.webp", sha256: B }]).state).toBe("recorded_sha_only");
    expect(inventoryCase(r, []).state).toBe("recorded_sha_only");
  });

  it("archives and HTML are not pictures; rejected versions are kept but never make a case usable", () => {
    const c = inventoryCase({ id: "CP-901", view: "concept_art_only", source_archive_sha256: A, approved_html_sha256: A, v1_rejected_sha256: B }, []);
    expect(c.originals.map((o) => o.key)).toEqual(["v1_rejected_sha256"]);
    expect(c.originals[0]!.rejected).toBe(true);
    expect(c.state).toBe("metadata_only");
  });

  it("views come from the keys; a static concept's generic key is a concept, not a desktop page", () => {
    const poc = inventoryCase({ id: "CP-902", view: "html_css_js_poc", desktop_1440_png_sha256: A, mobile_390_png_sha256: B }, []);
    expect([poc.has_desktop, poc.has_mobile, poc.form]).toEqual([true, true, "web_poc_capture"]);
    const art = inventoryCase({ id: "CP-903", view: "concept_art", original_png_sha256: A }, []);
    expect([art.has_desktop, art.originals[0]!.view, art.form]).toEqual([false, "concept", "static_concept_image"]);
  });

  it("counts every state; a case without any recorded picture is metadata only (not guessed)", () => {
    const inv = buildInventory({ manifestSha256: A, records: [{ id: "CP-1", view: "html_css_js_poc" }, { id: "CP-2", view: "html_css_js_poc", desktop_original_png_sha256: A }], files: [] });
    expect(inv.counts).toEqual({ cases: 2, in_repo: 0, recorded_sha_only: 1, metadata_only: 1, with_desktop_and_mobile: 0 });
  });
});
