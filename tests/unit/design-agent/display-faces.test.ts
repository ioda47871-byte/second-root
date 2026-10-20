import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DISPLAY_FACES } from "@/lib/design-agent/profile";

// DEV-068: every display face sets a Japanese face of its own before the site's
// fallbacks, so a Japanese shop name looks different per face. (The real fonts
// load only in a Next build; the screenshots of that are in .ai/reviews/DEV-068.md.)

const css = readFileSync(join(process.cwd(), "components/demo/profile/profile.module.css"), "utf8");
const fonts = readFileSync(join(process.cwd(), "components/demo/profile/fonts.ts"), "utf8");

function stack(face: string): string[] {
  const m = css.match(new RegExp(`\\.canvas\\[data-display="${face}"\\]\\s*\\{[^}]*--display:\\s*([^;]+);`));
  expect(m, face).not.toBeNull();
  return m![1]!.split(",").map((s) => s.trim());
}

describe("Japanese display faces (DEV-068)", () => {
  it("each face names a Japanese face of its own, ahead of the site's fallback", () => {
    const ja = new Map<string, string>();
    for (const face of DISPLAY_FACES) {
      const s = stack(face);
      const own = s.find((v) => /--font-ja-/.test(v));
      expect(own, `${face} has a Japanese face`).toBeDefined();
      const fallback = s.findIndex((v) => v === "var(--font-display)" || v === "var(--font-body)");
      expect(s.indexOf(own!), `${face}: the Japanese face before the site's`).toBeLessThan(fallback);
      ja.set(face, own!);
    }
    expect(new Set(ja.values()).size).toBe(DISPLAY_FACES.length);
  });

  it("the variables are defined in fonts.ts, not preloaded, with only the weights needed", () => {
    for (const v of ["--font-ja-editorial", "--font-ja-mincho", "--font-ja-condensed", "--font-ja-light"]) expect(fonts).toContain(`variable: "${v}"`);
    expect(fonts.match(/preload: false/g)).toHaveLength(4);
    // a static Japanese face loads two weights (a lighter and a heavier one)
    for (const w of fonts.matchAll(/weight: \[([^\]]*)\]/g)) expect(w[1]!.split(",").length).toBe(2);
  });
});
