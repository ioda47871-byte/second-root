import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadPublicDemo } from "@/lib/sales/demo-data";
import { db, resetSalesData, serviceClient } from "./helpers";
import { seedDemo } from "../support/seed-demo";

// Public demo visibility against the real database (MVP_SPEC §7).

beforeEach(resetSalesData);
afterAll(resetSalesData);

const now = new Date();
const day = 86_400_000;

describe("loadPublicDemo", () => {
  it("does not show an unsent demo (expires_at null)", async () => {
    const { token } = await seedDemo(db, { expiresAt: null });
    expect(await loadPublicDemo(serviceClient(), token, now)).toBeNull();
  });

  it("shows a sent demo until 30 days after sending, with verified content only", async () => {
    const { token } = await seedDemo(db, { expiresAt: new Date(now.getTime() + 5 * day) });
    const loaded = await loadPublicDemo(serviceClient(), token, now);
    // DEV-030: the AI design step is off by default, so there is never a profile.
    expect(loaded?.profile).toBeNull();
    const demo = loaded?.view;
    expect(demo).toMatchObject({ template: "bakery_v1", name: expect.stringContaining("E2Eテスト"), hours: "8:00〜17:00" });
    expect(Object.keys(demo!).sort()).toEqual(
      ["access", "address", "category", "closedDays", "description", "hours", "menuItems", "name", "phone", "template", "ward"],
    );
    expect(JSON.stringify(demo)).not.toMatch(/@/);
  });

  it("hides expired and disabled demos; keep_alive extends only a sent demo", async () => {
    const expired = await seedDemo(db, { expiresAt: new Date(now.getTime() - day) });
    expect(await loadPublicDemo(serviceClient(), expired.token, now)).toBeNull();
    const kept = await seedDemo(db, { expiresAt: new Date(now.getTime() - day), keepAlive: true });
    expect(await loadPublicDemo(serviceClient(), kept.token, now)).not.toBeNull();
    const disabled = await seedDemo(db, { expiresAt: new Date(now.getTime() + day), disabledAt: now });
    expect(await loadPublicDemo(serviceClient(), disabled.token, now)).toBeNull();
  });

  it("treats malformed and unknown tokens the same as hidden ones", async () => {
    expect(await loadPublicDemo(serviceClient(), "short", now)).toBeNull();
    expect(await loadPublicDemo(serviceClient(), "a".repeat(43), now)).toBeNull();
    expect(await loadPublicDemo(serviceClient(), "' or 1=1 --", now)).toBeNull();
  });
});
