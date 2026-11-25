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
const generated = readFileSync(join(process.cwd(), "components/demo/profile/fonts.generated.ts"), "utf8");
const manifest = JSON.parse(readFileSync(join(process.cwd(), "components/demo/profile/fonts/manifest.json"), "utf8")) as {
  families: { variable: string; faces: { weight: string; preload: boolean }[] }[];
};

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

  it("the variables are defined for the fonts, not preloaded, with only the weights needed", () => {
    // DEV-303: the faces are declared in fonts.generated.ts from fonts/manifest.json (next/font/local).
    const ja = new Map(manifest.families.map((f) => [f.variable, f]));
    for (const v of ["--font-ja-editorial", "--font-ja-condensed", "--font-ja-light"]) {
      expect(ja.has(v), v).toBe(true);
      expect(generated).toContain(`variable: "${v}"`);
      expect(ja.get(v)!.faces.every((f) => !f.preload), `${v} is not preloaded`).toBe(true);
    }
    expect(fonts + generated).not.toContain("--font-ja-mincho");
    // a static Japanese face loads two weights (a lighter and a heavier one); M PLUS 1 is variable
    const weights = (v: string) => [...new Set(ja.get(v)!.faces.map((f) => f.weight))];
    expect(weights("--font-ja-editorial")).toEqual(["400", "900"]);
    expect(weights("--font-ja-condensed")).toEqual(["400", "900"]);
    expect(weights("--font-ja-light")).toEqual(["100 900"]);
  });

  it("the address never asks a two-weight face for a weight it lacks (editorial_serif keeps the site's Mincho)", () => {
    const rule = css.match(/\.canvas\[data-display="editorial_serif"\] \.addressValue\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toContain("font-family: var(--font-editorial), var(--font-display), serif");
    expect(rule![1]).not.toContain("--font-ja-");
  });
});
