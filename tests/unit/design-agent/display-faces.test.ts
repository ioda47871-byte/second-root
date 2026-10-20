import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DISPLAY_FACES } from "@/lib/design-agent/profile";

// DEV-068: every display face draws Japanese in a face of its own, so a
// Japanese shop name looks different per face: editorial_serif,
// condensed_grotesk and light_grotesk name one before the site's fallback;
// mincho keeps the site's Shippori Mincho. (The real fonts load only in a Next
// build; the measurements of that are in .ai/reviews/DEV-068.md.)

const css = readFileSync(join(process.cwd(), "components/demo/profile/profile.module.css"), "utf8");
const fonts = readFileSync(join(process.cwd(), "components/demo/profile/fonts.ts"), "utf8");

function stack(face: string): string[] {
  const m = css.match(new RegExp(`\\.canvas\\[data-display="${face}"\\]\\s*\\{[^}]*--display:\\s*([^;]+);`));
  expect(m, face).not.toBeNull();
  return m![1]!.split(",").map((s) => s.trim());
}

describe("Japanese display faces (DEV-068)", () => {
  it("each face draws Japanese in a face of its own", () => {
    const ja = new Map<string, string>();
    for (const face of DISPLAY_FACES) {
      const s = stack(face);
      const own = face === "mincho" ? s[0] : s.find((v) => /--font-ja-/.test(v));
      expect(own, `${face} has a Japanese face`).toBeDefined();
      if (face === "mincho") expect(own).toBe("var(--font-display)");
      else {
        const fallback = s.findIndex((v) => v === "var(--font-display)" || v === "var(--font-body)");
        expect(s.indexOf(own!), `${face}: the Japanese face before the site's`).toBeLessThan(fallback);
      }
      ja.set(face, own!);
    }
    expect(new Set(ja.values()).size).toBe(DISPLAY_FACES.length);
  });

  it("the variables are defined in fonts.ts, not preloaded, with only the weights needed", () => {
    for (const v of ["--font-ja-editorial", "--font-ja-condensed", "--font-ja-light"]) expect(fonts).toContain(`variable: "${v}"`);
    expect(fonts).not.toContain("--font-ja-mincho");
    expect(fonts.match(/preload: false/g)).toHaveLength(3);
    // a static Japanese face loads two weights (a lighter and a heavier one); M PLUS 1 is variable
    const weights = [...fonts.matchAll(/weight: \[([^\]]*)\]/g)];
    expect(weights).toHaveLength(2);
    for (const w of weights) expect(w[1]!.split(",").length).toBe(2);
    expect(fonts).toContain('weight: "variable"');
  });

  it("the address never asks a two-weight face for a weight it lacks (editorial_serif keeps the site's Mincho)", () => {
    const rule = css.match(/\.canvas\[data-display="editorial_serif"\] \.addressValue\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toContain("font-family: var(--font-editorial), var(--font-display), serif");
    expect(rule![1]).not.toContain("--font-ja-");
  });
});
