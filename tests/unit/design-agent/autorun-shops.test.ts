/**
 * DEV-188: the fixed per-shop manifest of the worker's approved demo image job (scripts/sales-design-worker/autorun-shops.ts).
 * Offline only: no Codex, no image tool, no network, no browser. Proves that
 *  - root's allowlist in cycle.sh (IMAGE_AUTORUN_SHOPS) and the worker's manifest name the same shops and image counts;
 *  - every implemented entry is complete and pinned (prompt SHA-256 and length, slot inventory + edges of that page,
 *    the swap takes the shop, the rights rules are the intake's);
 *  - the known-but-unimplemented shops are not in the manifest, and the reasons recorded for them hold in the repository.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_BATCH_IMAGES } from "@/lib/design-agent/design-image/image-once";
import { SWAP_SHOP_SPECS } from "@/lib/design-agent/quality-pipeline/photo-swap-shops";
import { AI_DEMO_SHOPS, SWAP_SHOPS } from "../../../scripts/design-artifact/photo-swap";
import { MAX_UPSCALE } from "../../../scripts/design-artifact/tsugute-ai-intake";
import { AUTORUN_SHOP_IDS, AUTORUN_SHOPS, UNIMPLEMENTED_SHOPS } from "../../../scripts/sales-design-worker/autorun-shops";

const REPO = resolve(__dirname, "../../..");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** cycle.sh's fixed allowlist, read from the script itself (one assignment, single-quoted) */
function rootAllowlist(): Record<string, number> {
  const text = readFileSync(join(REPO, "scripts/sales-design-worker/cycle.sh"), "utf8");
  const lines = text.split("\n").filter((l) => /^IMAGE_AUTORUN_SHOPS=/.test(l));
  expect(lines).toHaveLength(1);
  const m = /^IMAGE_AUTORUN_SHOPS='([a-z0-9: -]*)'$/.exec(lines[0]!);
  expect(m).not.toBeNull();
  return Object.fromEntries(m![1]!.split(" ").filter(Boolean).map((p) => {
    const [k, v] = p.split(":");
    return [k!, Number(v)];
  }));
}

describe("DEV-188 the shop allowlist: root and worker agree", () => {
  it("cycle.sh IMAGE_AUTORUN_SHOPS = the manifest's shops with their image counts", () => {
    const fromManifest = Object.fromEntries(AUTORUN_SHOP_IDS.map((id) => [id, AUTORUN_SHOPS[id].maxImages]));
    expect(rootAllowlist()).toEqual(fromManifest);
  });

  it("only つぐ手 is implemented", () => {
    expect(AUTORUN_SHOP_IDS).toEqual(["tsugute"]);
  });

  it("cycle.sh compares the job's shop with that allowlist, not with a literal", () => {
    const text = readFileSync(join(REPO, "scripts/sales-design-worker/cycle.sh"), "utf8");
    expect(text).toContain('if shop not in shops or e.get("shop") != shop');
    expect(text).toContain('"$IMAGE_AUTORUN_SHOPS" 9>&-)" || code=IMAGE_GRANT_CONFIG_INVALID');
    expect(text).not.toMatch(/shop != "tsugute"/);
  });
});

describe("DEV-188 every implemented entry is complete and pinned", () => {
  for (const id of AUTORUN_SHOP_IDS) {
    const shop = AUTORUN_SHOPS[id];
    it(`${id}: ids, page, slots, prompt pin, inventory, swap and rights`, () => {
      expect(shop.shop_id).toBe(id);
      expect(shop.slotIds.length).toBe(shop.maxImages);
      expect(shop.maxImages).toBeLessThanOrEqual(MAX_BATCH_IMAGES);
      expect(new Set(shop.slotIds).size).toBe(shop.slotIds.length);
      for (const s of shop.slotIds) expect(s).toMatch(/^ph-[a-z0-9-]{1,40}$/);
      expect(shop.page).toMatch(/^[a-z0-9][a-z0-9-]{0,40}$/);
      expect(shop.pageDir.endsWith(`/${shop.page}`)).toBe(true);
      expect(existsSync(join(REPO, shop.pageDir, "index.html"))).toBe(true);
      // the whole prompt is built in code from the approved brief and matches its pins
      const prompt = shop.prompt.build();
      expect(sha256(prompt)).toBe(shop.prompt.sha256);
      expect(prompt.length).toBe(shop.prompt.chars);
      expect(existsSync(join(REPO, shop.prompt.source))).toBe(true);
      expect(existsSync(join(REPO, shop.prompt.brief))).toBe(true);
      // the measured inventory of exactly this page, with its edges, holds exactly these slots
      const inv = JSON.parse(readFileSync(join(REPO, shop.slotInventory), "utf8")) as { shop: string; page_dir: string; slots: Array<{ slot_id: string }> };
      expect(inv.shop).toBe(id);
      expect(inv.page_dir).toBe(shop.pageDir);
      expect(inv.slots.map((s) => s.slot_id).sort()).toEqual([...shop.slotIds].sort());
      expect(existsSync(join(REPO, shop.slotEdges))).toBe(true);
      // the swap takes the shop and its ai_generated_demo pictures
      expect((SWAP_SHOPS as readonly string[]).includes(id)).toBe(true);
      expect(AI_DEMO_SHOPS.has(id)).toBe(true);
      expect(shop.rights).toEqual({ sourceKind: "ai_generated_demo", demoOnly: true, publicWeb: false, maxUpscale: MAX_UPSCALE, upscaleMethod: "sharp-lanczos3" });
      expect(shop.rights.maxUpscale).toBeLessThanOrEqual(2);
      expect(shop.out.subdir).toBe("image-autorun");
    });
  }

  it("つぐ手 keeps the DEV-185/186 values (d1-v10, the 6 slots in call order, the approved prompt pin)", () => {
    const t = AUTORUN_SHOPS.tsugute;
    expect(t.page).toBe("d1-v10");
    expect(t.pageDir).toBe("design-library/research/quality-pipeline/poc/tsugute/fidelity/d1-v10");
    expect(t.slotIds).toEqual(["ph-ware", "ph-kake", "ph-hibi", "ph-dry", "ph-hand", "ph-desk"]);
    expect(t.prompt.sha256).toBe("dab7f2603c7495c4381035391a24ae98cc8bd07064295233fab034964ec33ed0");
    expect(t.prompt.chars).toBe(4133);
    expect(t.bundle).toBe("tsugute_ai_photos_v0");
  });
});

describe("DEV-188 unimplemented shops stay out (未対応)", () => {
  it("are not in the manifest nor in root's allowlist", () => {
    const root = rootAllowlist();
    for (const id of Object.keys(UNIMPLEMENTED_SHOPS)) {
      expect(Object.prototype.hasOwnProperty.call(AUTORUN_SHOPS, id)).toBe(false);
      expect(root[id]).toBeUndefined();
    }
  });

  it("the recorded reasons hold: not auto-run, no AI demo (輪 is a research-only swap shop), and no unsuffixed slot edges", () => {
    for (const id of Object.keys(UNIMPLEMENTED_SHOPS)) {
      // DEV-189 (owner GO 2026-11-06 item 3): 輪 is in the swap as a research-only shop (mock photos, no AI demo
      // pictures); ゆげ湯 is not in the swap at all. Neither takes ai_generated_demo pictures nor is an auto-run shop.
      expect((SWAP_SHOPS as readonly string[]).includes(id)).toBe(id === "bicycle");
      expect(AI_DEMO_SHOPS.has(id)).toBe(false);
      const dir = join(REPO, "design-library/research/quality-pipeline/poc", id);
      expect(existsSync(join(dir, "photo-slots.json"))).toBe(true);
      expect(existsSync(join(dir, "photo-slot-edges.json"))).toBe(false);
    }
    // 輪: the only measured inventory is of the old d1-v2
    const wa = JSON.parse(readFileSync(join(REPO, "design-library/research/quality-pipeline/poc/bicycle/photo-slots.json"), "utf8")) as { page_dir: string };
    expect(wa.page_dir.endsWith("/d1-v2")).toBe(true);
  });

  it("DEV-189: 輪's research swap is not an approval — no AI demo pictures, no auto-run, a 未承認 brief", () => {
    expect(SWAP_SHOP_SPECS.bicycle.aiDemoAllowed).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(AUTORUN_SHOPS, "bicycle")).toBe(false);
    expect(rootAllowlist().bicycle).toBeUndefined();
    expect(UNIMPLEMENTED_SHOPS.bicycle).toContain("未承認");
    const brief = readFileSync(join(REPO, "docs/design/bicycle-ai-photo-brief.md"), "utf8");
    expect(brief).toContain("未承認");
    // its page inventory is d1-v7, beside the old d1-v2 one (no photo-slot-edges.json without a page suffix)
    expect(existsSync(join(REPO, "design-library/research/quality-pipeline/poc/bicycle/photo-slots-d1-v7.json"))).toBe(true);
    expect(existsSync(join(REPO, "design-library/research/quality-pipeline/poc/bicycle/photo-slot-edges-d1-v7.json"))).toBe(true);
  });
});
