import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import demoStyles from "@/components/demo/demo.module.css";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import profileStyles from "@/components/demo/profile/profile.module.css";
import {
  emWidth,
  fitWidth,
  nameTokens,
  PHONE_LINE_EM,
  phoneNameLines,
  setsInPieces,
} from "@/components/demo/profile/text";
import {
  DISPLAY_FACES,
  HERO_LAYOUTS,
  TRACKINGS,
  type DesignProfile,
} from "@/lib/design-agent/profile";
import type { DemoView } from "@/lib/sales/demo-content";
import { AMERICAN_EDITORIAL, SHOP } from "./fixtures";

// DEV-034: an unspaced (Japanese) shop name in the hero. The Staging PoC's
// reviewer found the name broken in the middle of a word on a phone
// ("ベー / カリー"). The renderer now keeps the name on one line when it stays
// large, and otherwise breaks it only between its pieces, sized to fit.
// Fictional names only; real shop names never go into fixtures.

vi.setConfig({ testTimeout: 180_000 });

function moduleCss(file: string, names: Record<string, string>): string {
  const css = readFileSync(join(process.cwd(), file), "utf8");
  return css.replace(/\.(-?[_a-zA-Z][\w-]*)/g, (whole, name: string) =>
    names[name] ? `.${names[name]}` : whole,
  );
}
// next/font's faces are not loaded here; each display face gets a different,
// wide local face instead (from the fonts Playwright's Chromium depends on),
// so the loop measures really different faces (checked below), not one fallback.
const FACES = `:root { --font-editorial: "Liberation Serif", "DejaVu Serif"; --font-grotesk: "DejaVu Sans", "Liberation Sans"; --font-display: "WenQuanYi Zen Hei", "IPAGothic"; --font-body: "IPAGothic", "WenQuanYi Zen Hei"; }`;
const CSS = [
  "*, *::before, *::after { box-sizing: border-box; } body { margin: 0; }",
  FACES,
  moduleCss(
    "components/demo/demo.module.css",
    demoStyles as Record<string, string>,
  ),
  moduleCss(
    "components/demo/profile/profile.module.css",
    profileStyles as Record<string, string>,
  ),
].join("\n");

const NAMES = {
  // place name + katakana word: the shape of the PoC's name (fictional)
  short: "架空ベーカリー",
  katakanaOnly: "テストベーカリー",
  medium: "名古屋テスト珈琲店",
  long: "架空の焼菓子とコーヒーのテスト店",
  dot: "カフェ・テストベーカリー",
  latinWord: "EXAMPLEBAKERY",
  latinLower: "examplewonderbakery",
  latinWide: "MMWWMMWWMMWW",
  mixed: "café工房テスト",
  longVowel: "らーめん架空",
  smallKa: "架空ヶ丘ベーカリー",
  bracket: "（架空）テスト菓子店",
  halfWidth: "ﾃｽﾄﾍﾞｰｶﾘｰ",
  // a decomposed name (combining dakuten), as text copied from some sources arrives
  decomposed: "架空ベーカリー".normalize("NFD"),
  emoji: "テストカフェ☕🍞",
  emojiMany: "架空🍞🍞🍞🍞🍞",
  emojiJoined: "架空👩‍🍳テスト",
  roman: "Ⅲテスト",
  star: "テスト★ベーカリー★カフェ",
  // a Japanese name with a space is set in pieces too (the space does not make its words breakable)
  spacedJa: "テスト　ベーカリーアンドカフェ",
  spacedMixed: "ア ベーカリーカフェテスト",
  spacedShort: "パン工房　テスト",
  keycaps: "1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣",
  keycapJa: "カフェ1️⃣2️⃣3️⃣号店",
  hashKeycap: "#️⃣テスト",
  flag: "テスト🇯🇵カフェ",
} as const;
const LATIN = new Set<string>([
  NAMES.latinWord,
  NAMES.latinLower,
  NAMES.latinWide,
  NAMES.mixed,
]);

const shop = (name: string): DemoView => ({ ...SHOP, name, ward: "千種区" });
const profile = (over: Partial<DesignProfile>): DesignProfile => ({
  ...AMERICAN_EDITORIAL,
  heroLayout: {
    layout: "stacked_oversized",
    height: "medium",
    alignment: "left",
  },
  motifs: ["monogram", "location_labels"],
  motion: { intro: "none", sectionFade: false },
  ...over,
});
const typo = (
  display: DesignProfile["typography"]["display"],
  tracking: DesignProfile["typography"]["tracking"],
  displayCase: DesignProfile["typography"]["displayCase"] = "as_is",
): DesignProfile["typography"] => ({
  ...AMERICAN_EDITORIAL.typography,
  display,
  tracking,
  displayCase,
  displayWeight: display === "condensed_grotesk" ? "black" : "bold",
});

const PHONES = {
  phone390: { width: 390, height: 844 },
  phone360: { width: 360, height: 780 },
} as const;

type Piece = {
  text: string;
  rects: number;
  top: number;
  left: number;
  right: number;
};
type NameMeasure = {
  pieces: Piece[];
  fontPx: number;
  titleLeft: number;
  titleRight: number;
  overflowX: boolean;
  lineTops: number[];
  family: string;
  probe: number;
  text: string;
};

let browser: Browser;
// One page per viewport, reused for every case (a new context per case made this file slow under CI load).
const pages = new Map<string, Page>();
beforeAll(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  });
});
afterAll(async () => {
  await browser?.close();
});

async function pageFor(
  viewport: { width: number; height: number },
  mobile: boolean,
): Promise<Page> {
  const key = `${viewport.width}x${viewport.height}/${mobile}`;
  let page = pages.get(key);
  if (!page) {
    const context = await browser.newContext({
      viewport,
      ...(mobile
        ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true }
        : {}),
      reducedMotion: "reduce",
    });
    page = await context.newPage();
    pages.set(key, page);
  }
  return page;
}

async function measure(
  name: string,
  p: DesignProfile,
  viewport: { width: number; height: number },
  mobile: boolean,
): Promise<NameMeasure> {
  const page = await pageFor(viewport, mobile);
  const body = renderToStaticMarkup(
    <ProfileRenderer demo={shop(name)} profile={p} />,
  );
  await page.setContent(
    `<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${CSS}</style></head><body>${body}</body></html>`,
  );
  return await page.evaluate(
    ({ piece, title }) => {
      const h1 = document.querySelector("h1")!;
      const t = document.querySelector(`.${title}`)!;
      const cs = getComputedStyle(t);
      const tr = t.getBoundingClientRect();
      const pieces = [...h1.querySelectorAll(`.${piece}`)].map((e) => {
        const rects = [...e.getClientRects()];
        const r = e.getBoundingClientRect();
        return {
          text: e.textContent ?? "",
          rects: rects.length,
          top: Math.round(r.top),
          left: r.left,
          right: r.right,
        };
      });
      return {
        pieces,
        fontPx: parseFloat(getComputedStyle(h1).fontSize),
        titleLeft: tr.left + parseFloat(cs.paddingLeft),
        titleRight: tr.right - parseFloat(cs.paddingRight),
        overflowX: document.documentElement.scrollWidth > innerWidth,
        lineTops: [...new Set(pieces.map((x) => x.top))],
        text: h1.textContent ?? "",
        family: getComputedStyle(h1).fontFamily,
        probe: (() => {
          // width of a fixed Latin string in the name's own face, at a fixed size
          const span = document.createElement("span");
          span.textContent = "Hamburgefonstiv";
          span.style.cssText =
            "font-size:100px;letter-spacing:0;white-space:nowrap;position:absolute";
          h1.appendChild(span);
          const w = span.getBoundingClientRect().width;
          span.remove();
          return Math.round(w);
        })(),
      };
    },
    { piece: profileStyles.piece, title: profileStyles.title },
  );
}

describe("unspaced shop names (text helpers)", () => {
  it("cuts a name into pieces that join back to it and never split a word", () => {
    expect(nameTokens(NAMES.short)).toEqual(["架空", "ベーカリー"]);
    expect(nameTokens(NAMES.long)).toEqual([
      "架空の",
      "焼菓子と",
      "コーヒーの",
      "テスト店",
    ]);
    expect(nameTokens(NAMES.dot)).toEqual(["カフェ・", "テストベーカリー"]);
    expect(nameTokens(NAMES.latinWord)).toEqual(["EXAMPLEBAKERY"]);
    // a long-vowel mark, small kana and ヶ stay with the character before them; brackets with their word
    expect(nameTokens(NAMES.longVowel)).toEqual(["らーめん", "架空"]);
    expect(nameTokens(NAMES.smallKa)).toEqual(["架空ヶ丘", "ベーカリー"]);
    expect(nameTokens(NAMES.bracket)).toEqual(["（架空）", "テスト", "菓子店"]);
    expect(nameTokens("架空カフェ（テスト店）")).toEqual([
      "架空",
      "カフェ",
      "（テスト店）",
    ]);
    expect(nameTokens(NAMES.mixed)).toEqual(["café", "工房", "テスト"]);
    expect(nameTokens(NAMES.halfWidth)).toEqual([NAMES.halfWidth]);
    // a decomposed ベ stays one character: the same pieces as the composed name
    expect(nameTokens(NAMES.decomposed).map((t) => t.normalize("NFC"))).toEqual(["架空", "ベーカリー"]);
    expect(phoneNameLines(NAMES.decomposed)).toHaveLength(1);
    expect(emWidth(NAMES.decomposed)).toBe(emWidth(NAMES.short));
    expect(nameTokens(NAMES.star)).toEqual(["テスト★", "ベーカリー★", "カフェ"]);
    expect(nameTokens(NAMES.emoji)).toEqual(["テストカフェ", "☕", "🍞"]);
    expect(nameTokens(NAMES.emojiJoined)).toEqual(["架空", "👩‍🍳", "テスト"]);
    expect(nameTokens(NAMES.spacedJa)).toEqual(["テスト　", "ベーカリーアンドカフェ"]);
    // a keycap or a flag is one emoji: a piece of its own
    expect(nameTokens(NAMES.keycapJa)).toEqual(["カフェ", "1️⃣", "2️⃣", "3️⃣", "号店"]);
    expect(nameTokens(NAMES.flag)).toEqual(["テスト", "🇯🇵", "カフェ"]);
    for (const name of Object.values(NAMES))
      expect(nameTokens(name).join("")).toBe(name);
  });

  it("keeps a short name on one phone line, and splits a long one only between pieces, balanced", () => {
    expect(phoneNameLines(NAMES.short)).toEqual([NAMES.short]);
    expect(phoneNameLines(NAMES.medium)).toHaveLength(2);
    expect(phoneNameLines(NAMES.long)).toEqual([
      "架空の焼菓子と",
      "コーヒーの",
      "テスト店",
    ]);
    for (const name of Object.values(NAMES)) {
      const lines = phoneNameLines(name);
      expect(lines.join("")).toBe(name);
      // every line is a whole number of pieces
      const pieces = nameTokens(name);
      let at = 0;
      for (const line of lines) {
        let built = "";
        while (built.length < line.length) built += pieces[at++];
        expect(built).toBe(line);
      }
      if (lines.length > 1)
        expect(Math.max(...lines.map(emWidth))).toBeLessThan(emWidth(name));
    }
    expect(emWidth(NAMES.short)).toBeLessThanOrEqual(PHONE_LINE_EM);
    expect(emWidth(NAMES.halfWidth)).toBe(4.5);
  });

  it("sets Japanese names in pieces with or without a space, and spaced Latin names as before", () => {
    expect(setsInPieces(NAMES.spacedJa)).toBe(true);
    expect(setsInPieces(NAMES.spacedMixed)).toBe(true);
    expect(setsInPieces(NAMES.short)).toBe(true);
    expect(setsInPieces("EXAMPLE TEST BAKE")).toBe(false);
  });

  it("sizes from an upper bound: Latin counted as wide capitals, never below the estimate", () => {
    for (const name of Object.values(NAMES))
      expect(fitWidth(name)).toBeGreaterThanOrEqual(emWidth(name));
    expect(fitWidth("w")).toBeGreaterThan(fitWidth("W") - 0.001);
    expect(fitWidth(NAMES.latinLower)).toBeGreaterThan(
      fitWidth(NAMES.latinLower.toUpperCase()) - 0.001,
    );
  });
});

describe("unspaced shop names in the hero (Chromium)", () => {
  it("never breaks inside a piece and never overflows a phone, for every display face, tracking and hero layout", async () => {
    for (const [key, name] of Object.entries(NAMES)) {
      for (const display of DISPLAY_FACES) {
        for (const tracking of TRACKINGS) {
          for (const layout of HERO_LAYOUTS) {
            for (const displayCase of LATIN.has(name)
              ? (["as_is", "uppercase"] as const)
              : (["as_is"] as const)) {
              const p = profile({
                typography: typo(display, tracking, displayCase),
                heroLayout: {
                  layout,
                  height: "medium",
                  alignment: layout === "centered_cover" ? "center" : "left",
                },
              });
              for (const [vp, viewport] of Object.entries(PHONES)) {
                const label = `${key}/${display}/${tracking}/${layout}/${displayCase}/${vp}`;
                const m = await measure(name, p, viewport, true);
                expect(m.text, label).toBe(name);
                // the pieces are the name without its spaces (a space stays outside them, free to hang)
                expect(m.pieces.map((x) => x.text).join(""), label).toBe(name.replace(/\s+/gu, ""));
                for (const piece of m.pieces)
                  expect(
                    piece.rects,
                    `${label}: "${piece.text}" broken across lines`,
                  ).toBe(1);
                for (const piece of m.pieces) {
                  expect(
                    piece.right,
                    `${label}: "${piece.text}" past the right edge`,
                  ).toBeLessThanOrEqual(m.titleRight + 1);
                  expect(
                    piece.left,
                    `${label}: "${piece.text}" past the left edge`,
                  ).toBeGreaterThanOrEqual(m.titleLeft - 1);
                }
                expect(m.overflowX, `${label}: sideways scroll`).toBe(false);
                // the rendered lines are exactly the planned phone lines
                expect(m.lineTops.length, label).toBe(
                  phoneNameLines(name).length,
                );
              }
            }
          }
        }
      }
    }
  });

  it("keeps the PoC-shaped name whole and large on a phone, and a long name readable", async () => {
    for (const display of DISPLAY_FACES) {
      const p = profile({ typography: typo(display, "normal") });
      const short = await measure(NAMES.short, p, PHONES.phone390, true);
      expect(short.lineTops, display).toHaveLength(1);
      expect(
        short.fontPx,
        `${display}: one line, still a display size`,
      ).toBeGreaterThanOrEqual(40);
      const long = await measure(NAMES.long, p, PHONES.phone390, true);
      expect(long.lineTops, display).toHaveLength(3);
      expect(
        long.fontPx,
        `${display}: responsive sizing keeps a long name large`,
      ).toBeGreaterThanOrEqual(40);
    }
  });

  it("measures the display faces in really different fonts", async () => {
    const seen = new Map<string, { family: string; probe: number }>();
    for (const display of DISPLAY_FACES) {
      const m = await measure(
        NAMES.latinWord,
        profile({ typography: typo(display, "normal") }),
        PHONES.phone390,
        true,
      );
      seen.set(display, { family: m.family, probe: m.probe });
    }
    expect(seen.get("editorial_serif")!.family).not.toBe(
      seen.get("condensed_grotesk")!.family,
    );
    expect(seen.get("editorial_serif")!.probe).not.toBe(
      seen.get("condensed_grotesk")!.probe,
    );
    expect(seen.get("mincho")!.probe).not.toBe(
      seen.get("editorial_serif")!.probe,
    );
  });

  it("keeps desktop on one line, without overflow (long names included)", async () => {
    const names = {
      ...NAMES,
      veryLong: "架空の焼菓子とコーヒーと季節のテストケーキの店",
    };
    for (const [key, name] of Object.entries(names)) {
      for (const layout of HERO_LAYOUTS) {
        for (const tracking of TRACKINGS) {
          const label = `${key}/${layout}/${tracking}`;
          const m = await measure(
            name,
            profile({
              typography: typo("light_grotesk", tracking, "uppercase"),
              heroLayout: { layout, height: "medium", alignment: "left" },
            }),
            { width: 1440, height: 900 },
            false,
          );
          expect(m.lineTops, label).toHaveLength(1);
          for (const piece of m.pieces) {
            expect(piece.rects, `${label}: ${piece.text}`).toBe(1);
            expect(
              piece.right,
              `${label}: past the right edge`,
            ).toBeLessThanOrEqual(m.titleRight + 1);
          }
          expect(m.overflowX, label).toBe(false);
        }
      }
    }
  });
});
