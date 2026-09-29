import { describe, expect, it } from "vitest";
import { CATEGORY_DEFAULT_PROFILES } from "@/lib/design-agent/defaults";
import { checkProfile, contrastRatio, designProfileJsonSchema, looseJsonSchema } from "@/lib/design-agent/profile";
import { visualReviewJsonSchema, VisualReviewSchema } from "@/lib/design-agent/review";
import { AMERICAN_EDITORIAL, review } from "./fixtures";

// Codex may only combine the renderer's own values. Anything else is refused
// and the demo keeps the existing template.

/** Every object in a schema is closed and lists all its properties as required (Codex structured output). */
function assertStrict(node: unknown, path = "$"): void {
  if (Array.isArray(node)) return node.forEach((n, i) => assertStrict(n, `${path}[${i}]`));
  if (!node || typeof node !== "object") return;
  const o = node as Record<string, unknown>;
  if (o.type === "object") {
    expect(o.additionalProperties, path).toBe(false);
    expect([...(o.required as string[])].sort(), path).toEqual(Object.keys(o.properties as object).sort());
  }
  for (const [k, v] of Object.entries(o)) assertStrict(v, `${path}.${k}`);
}

describe("DesignProfile", () => {
  it("accepts the fixtures and every category default", () => {
    expect(checkProfile(AMERICAN_EDITORIAL)).toMatchObject({ ok: true });
    for (const p of Object.values(CATEGORY_DEFAULT_PROFILES)) expect(checkProfile(p), p.direction).toMatchObject({ ok: true });
  });

  it("refuses unknown values, extra fields (e.g. copy or CSS) and repeated motifs", () => {
    expect(checkProfile({ ...AMERICAN_EDITORIAL, direction: "cyberpunk" }).ok).toBe(false);
    expect(checkProfile({ ...AMERICAN_EDITORIAL, tagline: "Best muffins in Nagoya" }).ok).toBe(false);
    expect(checkProfile({ ...AMERICAN_EDITORIAL, css: "body{}" }).ok).toBe(false);
    expect(checkProfile({ ...AMERICAN_EDITORIAL, heroLayout: { ...AMERICAN_EDITORIAL.heroLayout, layout: "carousel" } }).ok).toBe(false);
    expect(checkProfile({ ...AMERICAN_EDITORIAL, palette: { ...AMERICAN_EDITORIAL.palette, text: "red" } }).ok).toBe(false);
    expect(checkProfile({ ...AMERICAN_EDITORIAL, motifs: ["monogram", "monogram"] }).ok).toBe(false);
    expect(checkProfile({ ...AMERICAN_EDITORIAL, motifs: ["monogram", "dot_grid", "stamp_ring", "corner_marks", "ruled_frame"] }).ok).toBe(false);
    expect(checkProfile({ ...AMERICAN_EDITORIAL, rationale: ["x".repeat(161)] }).ok).toBe(false);
    expect(checkProfile(null).ok).toBe(false);
  });

  it("refuses unreadable colour pairs", () => {
    const low = checkProfile({ ...AMERICAN_EDITORIAL, palette: { ...AMERICAN_EDITORIAL.palette, text: "#E8DCC6" } });
    expect(low).toEqual({ ok: false, problems: expect.arrayContaining(["text on background contrast below 4.5:1"]) });
    // Secondary sets the "not official" notice text: AA for small text.
    expect(checkProfile({ ...AMERICAN_EDITORIAL, palette: { ...AMERICAN_EDITORIAL.palette, secondary: "#9C7F62" } })).toEqual({ ok: false, problems: expect.arrayContaining(["secondary on background contrast below 4.5:1"]) });
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 0);
  });

  it("gives Codex a strict JSON Schema; the loose form only drops limits", () => {
    const strict = designProfileJsonSchema();
    assertStrict(strict);
    assertStrict(visualReviewJsonSchema());
    expect(JSON.stringify(strict)).not.toContain("$schema");
    const loose = JSON.stringify(looseJsonSchema(strict));
    expect(loose).not.toMatch(/maxItems|maxLength|minimum|maximum|pattern/);
    expect(loose).toContain('"additionalProperties":false');
  });
});

describe("VisualReview", () => {
  it("accepts a review with a complete revised profile, refuses free-form changes", () => {
    expect(VisualReviewSchema.safeParse(review({ recommended_profile_changes: { summary: ["x"], revised_profile: AMERICAN_EDITORIAL } })).success).toBe(true);
    expect(VisualReviewSchema.safeParse({ ...review(), recommended_profile_changes: { summary: [], revised_profile: { css: "x" } } }).success).toBe(false);
    expect(VisualReviewSchema.safeParse({ ...review(), brand_fit: 6 }).success).toBe(false);
    expect(VisualReviewSchema.safeParse({ ...review(), chain_of_thought: "..." }).success).toBe(false);
  });
});
