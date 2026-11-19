/**
 * DEV-188: the fixed per-shop manifest of the worker's approved demo image job (scripts/sales-design-worker/autorun-shops.ts).
 * Offline only: no Codex, no image tool, no network, no browser. Proves that
 *  - root's allowlist in cycle.sh (IMAGE_AUTORUN_SHOPS) and the worker's manifest name the same shops and image counts;
 *  - every implemented entry is complete and pinned (prompt SHA-256 and length, slot inventory + edges of that page,
 *    the swap takes the shop, the rights rules are the intake's);
 *  - the known-but-unimplemented shops are not in the manifest, and the reasons recorded for them hold in the repository;
 *  - Issue #290 P0: a shop whose one approved run is used (CLOSED_SHOPS: ほし窯) is in neither list, and root's cycle.sh is
 *    byte for byte the file before ほし窯 was listed (the root clone update after the close is checked against it).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_BATCH_IMAGES } from "@/lib/design-agent/design-image/image-once";
import { SWAP_SHOP_SPECS } from "@/lib/design-agent/quality-pipeline/photo-swap-shops";
import { AI_DEMO_SHOPS, SWAP_SHOPS } from "../../../scripts/design-artifact/photo-swap";
import { MAX_UPSCALE } from "../../../scripts/design-artifact/tsugute-ai-intake";
import { HOSHIGAMA_APPROVAL } from "@/lib/design-agent/quality-pipeline/hoshigama-ai-photos";
import { AUTORUN_SHOP_IDS, AUTORUN_SHOPS, CLOSED_SHOPS, UNIMPLEMENTED_SHOPS } from "../../../scripts/sales-design-worker/autorun-shops";

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

  it("つぐ手 and (DEV-192, owner GO 2026-11-07, one approved run) 輪 are listed — no other shop (Issue #290 P0: ほし窯's one run is used, it is out)", () => {
    expect(AUTORUN_SHOP_IDS).toEqual(["tsugute", "bicycle"]);
    expect(rootAllowlist()).toEqual({ tsugute: 6, bicycle: 6 });
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
      // DEV-192: a slot that takes two pictures (輪's bench PC + SP) maps its photo ids to the one slot; every photo maps
      // to a slot of the inventory and every slot gets at least one photo
      const photoToSlot: Readonly<Record<string, string>> = "photoToSlot" in shop ? shop.photoToSlot : Object.fromEntries(shop.slotIds.map((s) => [s, s]));
      expect(Object.keys(photoToSlot)).toEqual([...shop.slotIds]);
      expect(inv.slots.map((s) => s.slot_id).sort()).toEqual([...new Set(shop.slotIds.map((s) => photoToSlot[s]!))].sort());
      expect(existsSync(join(REPO, shop.slotEdges))).toBe(true);
      // the swap takes the shop and its ai_generated_demo pictures
      expect((SWAP_SHOPS as readonly string[]).includes(id)).toBe(true);
      expect(AI_DEMO_SHOPS.has(id)).toBe(true);
      expect(shop.rights).toEqual({ sourceKind: "ai_generated_demo", demoOnly: true, publicWeb: false, maxUpscale: MAX_UPSCALE, upscaleMethod: "sharp-lanczos3" });
      // DEV-139: a shop with a separate run approval record pins the same run prompt there
      if ("promptApproval" in shop) expect([shop.promptApproval.run_prompt_sha256, shop.promptApproval.run_prompt_chars]).toEqual([shop.prompt.sha256, shop.prompt.chars]);
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

  it("DEV-192 (owner GO 2026-11-07, comment 6689664215): 輪 left the unimplemented list for one approved run — swap, worker and root agree", () => {
    expect(Object.prototype.hasOwnProperty.call(UNIMPLEMENTED_SHOPS, "bicycle")).toBe(false);
    expect(SWAP_SHOP_SPECS.bicycle.aiDemoAllowed).toBe(true);
    expect(AUTORUN_SHOPS.bicycle.page).toBe("d1-v9");
    expect(rootAllowlist().bicycle).toBe(6);
    const brief = readFileSync(join(REPO, "docs/design/bicycle-ai-photo-brief.md"), "utf8");
    expect(brief).toContain("6689664215");
    // its older page inventories stay beside d1-v9's (no photo-slot-edges.json without a page suffix)
    expect(existsSync(join(REPO, "design-library/research/quality-pipeline/poc/bicycle/photo-slots-d1-v7.json"))).toBe(true);
    expect(existsSync(join(REPO, "design-library/research/quality-pipeline/poc/bicycle/photo-slot-edges-d1-v7.json"))).toBe(true);
  });

  it("Issue #290 P0: ほし窯 is closed, not unimplemented — its photos stay usable offline (swap/intake), the generation route is gone", () => {
    expect(Object.prototype.hasOwnProperty.call(UNIMPLEMENTED_SHOPS, "bakery")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(AUTORUN_SHOPS, "bakery")).toBe(false);
    expect(rootAllowlist().bakery).toBeUndefined();
    // kept for the already-generated photos: the swap takes ほし窯's AI demo pictures of the approved prompt only
    expect(SWAP_SHOP_SPECS.bakery.aiDemoAllowed).toBe(true);
    expect(AI_DEMO_SHOPS.has("bakery")).toBe(true);
  });
});

describe("Issue #290 P0 closed shops: a used one-time run never comes back, not under a new id", () => {
  it("ほし窯 is recorded as closed with the used approval record and the run's verification report", () => {
    expect(Object.keys(CLOSED_SHOPS)).toEqual(["bakery"]);
    expect(CLOSED_SHOPS.bakery).toMatchObject({ approval_record: HOSHIGAMA_APPROVAL!.approval_record, consumed_on: "2026-11-19" });
    expect(CLOSED_SHOPS.bakery!.approval_record).toBe("hoshigama-one-time-run-20261118");
    expect(CLOSED_SHOPS.bakery!.evidence).toContain("6990007019");
  });

  it("a closed shop is in neither the worker's manifest nor root's allowlist, nor the unimplemented list", () => {
    const root = rootAllowlist();
    for (const id of Object.keys(CLOSED_SHOPS)) {
      expect(Object.prototype.hasOwnProperty.call(AUTORUN_SHOPS, id), id).toBe(false);
      expect((AUTORUN_SHOP_IDS as readonly string[]).includes(id), id).toBe(false);
      expect(root[id], id).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(UNIMPLEMENTED_SHOPS, id), id).toBe(false);
    }
  });

  it("the manifest refuses to load while a closed shop is listed (fail closed, not only this test)", () => {
    const src = readFileSync(join(REPO, "scripts/sales-design-worker/autorun-shops.ts"), "utf8");
    expect(src).toContain("if (Object.prototype.hasOwnProperty.call(AUTORUN_SHOPS, id)) throw new Error(`AUTORUN_SHOP_CLOSED:${id}`);");
  });

  it("nothing in the worker builds ほし窯's run prompt or writes its run bundle any more", () => {
    const dir = join(REPO, "scripts/sales-design-worker");
    for (const f of ["autorun-shops.ts", "image-autorun.ts", "worker.ts", "cycle.sh", "run.sh"]) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, f).not.toMatch(/buildHoshigamaRunPrompt|writeHoshigamaPhotosForRun|hoshigama_ai_photos_v0|from "[^"]*hoshigama[^"]*"/);
    }
  });

  it("root's cycle.sh is byte for byte the file before ほし窯 was listed (334f771, SHA-256 8beb350d…)", () => {
    const text = readFileSync(join(REPO, "scripts/sales-design-worker/cycle.sh"));
    expect(sha256(text.toString("utf8"))).toBe("8beb350dcc7b85a78c0ea060638d4922362d02d25e8eba1d798152fe2d146dab");
    expect(text.toString("utf8")).not.toMatch(/bakery|hoshigama|ほし窯/);
  });
});
