import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { renderToStaticMarkup } from "react-dom/server";
import demoStyles from "@/components/demo/demo.module.css";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import profileStyles from "@/components/demo/profile/profile.module.css";
import sectionStyles from "@/components/demo/profile/sections.module.css";
import type { DesignProfile } from "@/lib/design-agent/profile";
import type { GuardedShopCss } from "@/lib/design-agent/shop-css/guard";
import type { ShopCssPageBuilder } from "@/lib/design-agent/shop-css/render-check";
import type { DemoView } from "@/lib/sales/demo-content";

// The profile renderer's page as a static document, with its module CSS (as
// the app bundles it), for the shop-CSS render check (DEV-072). Fictional
// shops only; nothing is fetched.

function moduleCss(file: string, names: Record<string, string>): string {
  const css = readFileSync(join(process.cwd(), file), "utf8");
  return css.replace(/\.(-?[_a-zA-Z][\w-]*)/g, (whole, name: string) => (names[name] ? `.${names[name]}` : whole));
}
// Local stand-ins for the app's self-hosted faces (next/font is not available here). The
// Japanese stand-in is IPA Gothic: WenQuanYi has no vertical metrics and sets vertical text
// with overlapping glyphs, which the pixel proof rightly reports.
const FACES = `:root { --font-editorial: "Liberation Serif", "DejaVu Serif"; --font-grotesk: "DejaVu Sans", "Liberation Sans"; --font-display: "IPAGothic"; --font-body: "IPAGothic"; --font-ja-editorial: "IPAGothic"; --font-ja-condensed: "IPAGothic"; --font-ja-light: "IPAGothic"; --serif: "IPAGothic", serif; --sans: "IPAGothic", sans-serif; } body { font-family: "IPAGothic", sans-serif; }`;

/**
 * A second set of stand-ins, for checking that the render check does not depend on the
 * faces: DejaVu for Latin and WenQuanYi for Japanese (horizontal layouts only, see above).
 */
export const OTHER_FACES = `:root { --font-editorial: "DejaVu Serif"; --font-grotesk: "DejaVu Sans"; --font-display: "WenQuanYi Zen Hei"; --font-body: "WenQuanYi Zen Hei"; --font-ja-editorial: "WenQuanYi Zen Hei"; --font-ja-condensed: "WenQuanYi Zen Hei"; --font-ja-light: "WenQuanYi Zen Hei"; --serif: "WenQuanYi Zen Hei", serif; --sans: "WenQuanYi Zen Hei", sans-serif; } body { font-family: "WenQuanYi Zen Hei", sans-serif; }`;

const pageCss = (faces: string) =>
  [
    "*, *::before, *::after { box-sizing: border-box; } body { margin: 0; }",
    faces,
    moduleCss("components/demo/demo.module.css", demoStyles as Record<string, string>),
    moduleCss("components/demo/profile/profile.module.css", profileStyles as Record<string, string>),
    moduleCss("components/demo/profile/sections.module.css", sectionStyles as Record<string, string>),
  ].join("\n");
export const BASE_CSS = pageCss(FACES);

export function pageBuilder(demo: DemoView, profile: DesignProfile, faces: string = FACES): ShopCssPageBuilder {
  const css = faces === FACES ? BASE_CSS : pageCss(faces);
  return (shop: GuardedShopCss | null) => {
    const html = renderToStaticMarkup(<ProfileRenderer demo={demo} profile={profile} shopCss={shop} />);
    return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>${html}</body></html>`;
  };
}

/** Chromium for the tests; env (e.g. FONTCONFIG_FILE) for a second font environment. */
export function launch(env?: Record<string, string>): Promise<Browser> {
  return chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
    ...(env ? { env: { ...(process.env as Record<string, string>), ...env } } : {}),
  });
}

/**
 * A fontconfig that renders differently from the default here: subpixel (LCD)
 * antialiasing and full hinting, as some CI runners and desktops do. Written
 * to dir; it includes the system configuration, so no font is fetched.
 */
export function lcdFontconfig(dir: string): string {
  const file = join(dir, "fonts-lcd.conf");
  writeFileSync(
    file,
    `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>\n  <match target="font">\n    <edit name="rgba" mode="assign"><const>rgb</const></edit>\n    <edit name="hinting" mode="assign"><bool>true</bool></edit>\n    <edit name="hintstyle" mode="assign"><const>hintfull</const></edit>\n    <edit name="antialias" mode="assign"><bool>true</bool></edit>\n  </match>\n</fontconfig>\n`,
  );
  return file;
}
