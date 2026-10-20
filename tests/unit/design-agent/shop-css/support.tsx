import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { renderToStaticMarkup } from "react-dom/server";
import demoStyles from "@/components/demo/demo.module.css";
import ProfileRenderer from "@/components/demo/profile/ProfileRenderer";
import profileStyles from "@/components/demo/profile/profile.module.css";
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
export const BASE_CSS = [
  "*, *::before, *::after { box-sizing: border-box; } body { margin: 0; }",
  moduleCss("components/demo/demo.module.css", demoStyles as Record<string, string>),
  moduleCss("components/demo/profile/profile.module.css", profileStyles as Record<string, string>),
].join("\n");

export function pageBuilder(demo: DemoView, profile: DesignProfile): ShopCssPageBuilder {
  return (css: GuardedShopCss | null) => {
    const html = renderToStaticMarkup(<ProfileRenderer demo={demo} profile={profile} shopCss={css} />);
    return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${BASE_CSS}</style></head><body>${html}</body></html>`;
  };
}

export function launch(): Promise<Browser> {
  return chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
}
