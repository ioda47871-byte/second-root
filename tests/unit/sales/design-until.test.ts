import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { aiDesignEnabled, designEnabledUntil } from "@/lib/sales/design";
import { authorizeBridge } from "@/lib/sales/design-bridge-auth";

// DEV-064: the optional time box of the design flag. A controlled-run window closes on
// its own at SALES_AI_DESIGN_ENABLED_UNTIL even if nobody turns the flag off.

const T = Date.UTC(2026, 9, 20, 12, 0, 0);
const on = (until?: string) => ({ SALES_AI_DESIGN_ENABLED: "true", ...(until === undefined ? {} : { SALES_AI_DESIGN_ENABLED_UNTIL: until }) });

describe("aiDesignEnabled with SALES_AI_DESIGN_ENABLED_UNTIL", () => {
  it("unset: as before (the flag alone decides)", () => {
    expect(aiDesignEnabled(on(), T)).toBe(true);
    expect(aiDesignEnabled({ SALES_AI_DESIGN_ENABLED: "false" }, T)).toBe(false);
    expect(aiDesignEnabled({}, T)).toBe(false);
  });

  it("before the instant: on; at and after it: off", () => {
    expect(aiDesignEnabled(on("2026-10-20T12:00:01Z"), T)).toBe(true);
    expect(aiDesignEnabled(on("2026-10-20T12:00:00Z"), T)).toBe(false);
    expect(aiDesignEnabled(on("2026-10-20T11:59:59Z"), T)).toBe(false);
  });

  it("never turns a false flag on", () => {
    expect(aiDesignEnabled({ SALES_AI_DESIGN_ENABLED: "false", SALES_AI_DESIGN_ENABLED_UNTIL: "2099-01-01T00:00:00Z" }, T)).toBe(false);
  });

  it.each([
    "2026-10-20T13:00:00",
    "2026-10-20T13:00:00.000Z",
    "2026-10-20T22:00:00+09:00",
    "2026-10-20 13:00:00Z",
    "2026-02-31T13:00:00Z",
    "2026-10-20T24:00:00Z",
    "tomorrow",
    " 2026-10-20T13:00:00Z",
    "1792473600000",
    "",
  ])("set but not exactly YYYY-MM-DDTHH:MM:SSZ (%j): off, fail closed", (raw) => {
    expect(Number.isNaN(designEnabledUntil({ SALES_AI_DESIGN_ENABLED_UNTIL: raw }))).toBe(true);
    expect(aiDesignEnabled(on(raw), T)).toBe(false);
  });

  it("uses the clock by default", () => {
    expect(aiDesignEnabled(on("2000-01-01T00:00:00Z"))).toBe(false);
    expect(aiDesignEnabled(on("2999-01-01T00:00:00Z"))).toBe(true);
  });

  it("the bridge API: ok inside the window, disabled once the instant has passed", () => {
    const token = "bridge-token-0123456789abcdef-0123456789";
    const sha = createHash("sha256").update(token).digest("hex");
    const header = `Bearer ${token}`;
    expect(authorizeBridge(header, { ...on("2999-01-01T00:00:00Z"), SALES_DESIGN_BRIDGE_TOKEN_SHA256: sha })).toBe("ok");
    expect(authorizeBridge(header, { ...on("2000-01-01T00:00:00Z"), SALES_DESIGN_BRIDGE_TOKEN_SHA256: sha })).toBe("disabled");
    expect(authorizeBridge(header, { ...on("not a time"), SALES_DESIGN_BRIDGE_TOKEN_SHA256: sha })).toBe("disabled");
  });
});
