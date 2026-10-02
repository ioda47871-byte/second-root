import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/design-preview/[runId]/asset/[assetId]/route";
import { fakePng, writeStore, type FakeAsset } from "./photo-fixtures";

// The asset route of the local design preview (DEV-029): 404 unless the
// preview is switched on and the asset is allowed; a PNG that is never cached.
// connection() needs a Next request scope, which a unit test does not have.
vi.mock("next/server", () => ({ connection: async () => undefined }));

const A = "asset-aaaaaaaaaaaaaaaaaaaaaaaa";
const ASSETS: FakeAsset[] = [{ id: A, png: fakePng(320, 400), sourceKind: "generated_concept" }];
const saved = { ...process.env };
let base: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "asset-route-"));
  await writeStore(join(base, "store"), "job-001", ASSETS);
  await mkdir(join(base, "preview", "run-route-1"), { recursive: true });
  await writeFile(join(base, "preview", "run-route-1", "assets.json"), JSON.stringify({ jobId: "job-001" }));
});
afterAll(async () => {
  process.env = saved;
  await rm(base, { recursive: true, force: true });
});

const get = (runId: string, assetId: string) => GET(new Request(`http://127.0.0.1/design-preview/${runId}/asset/${assetId}`), { params: Promise.resolve({ runId, assetId }) });

describe("design preview asset route", () => {
  it("is a 404 where the preview is off (Vercel, the e2e server)", async () => {
    delete process.env.SR_DESIGN_PREVIEW_ROOT;
    expect((await get("run-route-1", A)).status).toBe(404);
  });

  it("serves an allowed photo as a PNG that is never cached, and 404 for anything else", async () => {
    process.env.SR_DESIGN_PREVIEW_ROOT = join(base, "preview");
    process.env.SR_DESIGN_ASSETS_ROOT = join(base, "store");
    process.env.TMPDIR = join(base, "tmp");
    const ok = await get("run-route-1", A);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await ok.arrayBuffer()).equals(ASSETS[0].png)).toBe(true);
    for (const [runId, id] of [["run-route-1", "../store/job-001/manifest.json"], ["run-route-1", "asset-bbbbbbbbbbbbbbbbbbbbbbbb"], ["../preview", A], ["run-route-1", `${A}.png`]]) {
      const r = await get(runId, id);
      expect(r.status, `${runId} ${id}`).toBe(404);
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
  });
});
