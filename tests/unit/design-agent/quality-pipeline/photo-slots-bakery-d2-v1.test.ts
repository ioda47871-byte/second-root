/**
 * DEV-139 (visual-first, offline): ほし窯 d2-hearth-floor — the research C page fidelity/d2-v1 and its measured photo
 * slots. No photo is made, fetched or committed; the slots are placeholder boards.
 *
 * Pins: the inventory and the range edges are of the current page (HTML / CSS / copy hashes), one slot per 写真｜ caption
 * and per ph-* copy item, exactly the direction's image_slots (石窯の口, 田舎パン), the 2× rule, a photo request per slot,
 * and the boards as the browser measures them now (within 2px).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EDGE_VIEWPORTS, edgesFor, PhotoSlotEdges, PhotoSlotInventory, requestFor, SLOT_VIEWPORTS } from "@/lib/design-agent/quality-pipeline/photo-slots";
import { deriveEdges, deriveSlots } from "../../../../scripts/design-artifact/photo-slots";

const REPO = resolve(__dirname, "../../../..");
const POC = "design-library/research/quality-pipeline/poc/bakery";
const DIR = `${POC}/fidelity/d2-v1`;
const read = (p: string) => readFileSync(resolve(REPO, p));
const sha = (p: string) => createHash("sha256").update(read(p)).digest("hex");
const inv = PhotoSlotInventory.parse(JSON.parse(read(`${POC}/photo-slots-d2-v1.json`).toString("utf8")));
const edgesFile = PhotoSlotEdges.parse(JSON.parse(read(`${POC}/photo-slot-edges-d2-v1.json`).toString("utf8")));

describe("ほし窯 d2-v1 photo slots", () => {
  it("are of the current page, one per 写真｜ caption and ph-* copy item, and exactly the direction's image slots", () => {
    expect(inv.shop).toBe("bakery");
    expect(inv.page_dir).toBe(DIR);
    expect(inv.evaluation_label).toBe("placeholder_limited");
    expect([inv.html_sha256, inv.css_sha256, inv.copy_sha256]).toEqual([sha(`${DIR}/index.html`), sha(`${DIR}/style.css`), sha(`${DIR}/copy.json`)]);
    const copy = JSON.parse(read(`${DIR}/copy.json`).toString("utf8")) as { shop_id: string; items: Array<{ id: string; text: string }> };
    expect(inv.shop_id).toBe(copy.shop_id);
    const ph = copy.items.filter((i) => i.id.startsWith("ph-"));
    expect(inv.slots.map((s) => s.slot_id)).toEqual(["ph-mouth", "ph-loaf"]);
    expect(ph.map((i) => i.id).sort()).toEqual(["ph-loaf", "ph-mouth"]);
    for (const s of inv.slots) expect(ph.find((i) => i.id === s.slot_id)!.text).toBe(`写真｜${s.role}`);
    const set = JSON.parse(read(`${POC}/direction-set.json`).toString("utf8")) as { directions: Array<{ id: string; sections: Array<{ id: string; image_slots: Array<{ role: string }> }> }> };
    const d2 = set.directions.find((d) => d.id === "d2-hearth-floor")!;
    const declared = d2.sections.flatMap((sec) => sec.image_slots.map((x) => [sec.id, x.role]));
    expect(inv.slots.map((s) => [s.section, s.role])).toEqual(declared);
  });

  it("keep the 2× rule at every measured width and at the range edges, and each slot has a photo request", () => {
    const edges = edgesFor(inv, edgesFile);
    expect(edges).not.toBeNull();
    expect(edgesFile.edge_viewports).toBeUndefined();
    for (const s of inv.slots) {
      expect(s.variants.map((v) => v.viewport)).toEqual([...SLOT_VIEWPORTS]);
      expect(edges!.get(s.slot_id)!.map((v) => v.viewport)).toEqual([...EDGE_VIEWPORTS]);
      for (const v of [...s.variants, ...edges!.get(s.slot_id)!]) {
        expect(Math.abs(v.min_width_px - 2 * v.width_px), `${s.slot_id} ${v.viewport}`).toBeLessThanOrEqual(2);
        expect(Math.abs(v.min_height_px - 2 * v.height_px), `${s.slot_id} ${v.viewport}`).toBeLessThanOrEqual(2);
      }
      expect(requestFor(s, { edges: edges!.get(s.slot_id) }).ok, s.slot_id).toBe(true);
    }
  });

  describe("re-measured in the browser", () => {
    let browser: Browser;
    beforeAll(async () => {
      browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
    });
    afterAll(async () => {
      await browser?.close();
    });
    it("the committed inventory and edges are what the page measures now (boards, selectors, sizes within 2px)", async () => {
      const now = await deriveSlots(browser, "bakery", DIR);
      expect(now.slots.map((s) => [s.slot_id, s.board_selector, s.section, s.placeholder])).toEqual(inv.slots.map((s) => [s.slot_id, s.board_selector, s.section, s.placeholder]));
      for (const [i, s] of now.slots.entries())
        for (const [j, v] of s.variants.entries()) {
          const w = inv.slots[i]!.variants[j]!;
          expect(Math.abs(v.width_px - w.width_px), `${s.slot_id} ${v.viewport}`).toBeLessThanOrEqual(2);
          expect(Math.abs(v.height_px - w.height_px), `${s.slot_id} ${v.viewport}`).toBeLessThanOrEqual(2);
        }
      const e = await deriveEdges(browser, inv);
      for (const [i, s] of e.slots.entries())
        for (const [j, v] of s.edges.entries()) {
          const w = edgesFile.slots[i]!.edges[j]!;
          expect(Math.abs(v.width_px - w.width_px), `${s.slot_id} ${v.viewport}`).toBeLessThanOrEqual(2);
          expect(Math.abs(v.height_px - w.height_px), `${s.slot_id} ${v.viewport}`).toBeLessThanOrEqual(2);
        }
    }, 120_000);
  });
});
