import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAssets } from "@/lib/design-agent/assets/serve";
import { verifyAnalyses, verifyImages, AnalysesArtifactSchema } from "@/lib/design-agent/assets/lineage";
import { CATEGORY_DEFAULT_PROFILES } from "@/lib/design-agent/defaults";
import { availableMiB, drawPng, runPreviewCheck, writeFixture } from "@/lib/design-agent/worker/preview-check";

// DEV-029: the production preview check (`sales:design-worker -- preview-check`).
// The full build + Chromium path is run by hand before a photo PoC; here: its
// resource stop and that its temporary fixture passes the real checks.

describe("preview check", () => {
  it("stops before building when less than 3 GiB is available", async () => {
    const meminfo = join(mkdtempSync(join(tmpdir(), "pc-mem-")), "meminfo");
    writeFileSync(meminfo, "MemTotal: 4000000 kB\nMemAvailable: 2867000 kB\n");
    expect(availableMiB(meminfo)).toBe(2799);
    const result = await runPreviewCheck({ repoDir: process.cwd(), env: process.env, launch: () => Promise.reject(new Error("no browser")), log: () => undefined, meminfo });
    expect(result).toEqual({ code: "RESOURCE_STOP", availableMiB: 2799 });
  });

  it("draws valid PNGs and writes a fixture the preview accepts (store, manifest, lineage)", async () => {
    const png = drawPng(720, 900, 1);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([720, 900]);
    const home = mkdtempSync(join(tmpdir(), "pc-home-"));
    const store = join(home, "store");
    const previewRoot = join(home, "preview");
    const { manifest, direction } = await writeFixture(previewRoot, store, "preview-check-test1");
    expect(manifest.assets.every((a) => a.sourceKind === "generated_concept" && a.people === "none")).toBe(true);
    expect(readdirSync(join(store, "preview-check-test1")).sort()).toEqual([...manifest.assets.map((a) => a.file), "manifest.json"].sort());
    const runDir = join(previewRoot, "preview-check-test1");
    const run = await runAssets(runDir, { env: { SR_DESIGN_ASSETS_ROOT: store, TMPDIR: join(home, "tmp") }, repoDir: process.cwd() });
    expect(run?.jobId).toBe("preview-check-test1");
    const analyses = JSON.parse(readFileSync(join(runDir, "photo-analyses.json"), "utf8")) as unknown;
    expect(verifyAnalyses(analyses, "preview-check-test1", manifest)).not.toBeNull();
    const images = JSON.parse(readFileSync(join(runDir, "candidate-0.images.json"), "utf8")) as unknown;
    expect(verifyImages(images, "preview-check-test1", "candidate-0", manifest, AnalysesArtifactSchema.parse(analyses), CATEGORY_DEFAULT_PROFILES.baked_goods)).toEqual(direction);
  });
});
