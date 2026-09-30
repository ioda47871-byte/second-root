import { expect, test, type Page } from "@playwright/test";

// Concept Works served as static exports from public/works/<slug>/
// (docs/WORKS.md). Each is its own HTML document: none of Second Root's
// layout, CSS, analytics or structured data may reach it, every URL it uses
// stays under its basePath, and its pages survive a reload.

const BASE = "/works/yasashii-beauty-salon";
const PAGES = ["", "/about", "/menu", "/staff", "/first", "/access"];
const WIDTHS = [320, 375, 390, 430, 768, 1280];

/** Collects console errors and failed or 4xx/5xx requests while a page is open. */
function watch(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  // Next's static-export router probes links with HEAD requests and aborts
  // them once the status arrives (200); aborts are not failures. Real misses
  // still show up below as 4xx/5xx responses.
  page.on("requestfailed", (r) => {
    if (r.failure()?.errorText !== "net::ERR_ABORTED") problems.push(`failed: ${r.url()} ${r.failure()?.errorText}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400) problems.push(`${r.status()}: ${r.url()}`);
  });
  return problems;
}

async function loadAll(page: Page) {
  // Scroll through so lazy images and reveal-on-scroll content load too.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 30));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState("networkidle");
}

for (const path of PAGES) {
  test(`${BASE}${path} opens directly and on reload`, async ({ page }) => {
    const problems = watch(page);
    const res = await page.goto(`${BASE}${path}`);
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle(/やさしい美を彩るサロン/);
    await loadAll(page);

    const reloaded = await page.reload();
    expect(reloaded?.status()).toBe(200);
    await loadAll(page);

    // Every image decoded (no broken <img>).
    const broken = await page.$$eval("img", (imgs) =>
      imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.currentSrc || i.src),
    );
    expect(broken).toEqual([]);
    expect(problems).toEqual([]);
  });
}

test("the Concept Work carries nothing of Second Root", async ({ page }) => {
  await page.goto(BASE);
  // Second Root's header / footer / section classes.
  await expect(page.locator(".hdr, .ftr, .cw-card, .section")).toHaveCount(0);
  // No JSON-LD, no GA loader, no Second Root stylesheet rules.
  await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(0);
  expect(await page.locator("script").evaluateAll((s) => s.some((x) => x.textContent?.includes("googletagmanager")))).toBe(false);
  const leak = await page.evaluate(() => ({
    grain: getComputedStyle(document.body, "::before").content,
    srVar: getComputedStyle(document.documentElement).getPropertyValue("--green").trim(),
    lineHeight: getComputedStyle(document.body).lineHeight,
  }));
  expect(leak.grain).toBe("none");
  expect(leak.srVar).toBe("");
  // Second Root's body line-height is 1.85 (29.6px at 16px).
  expect(leak.lineHeight).not.toBe("29.6px");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /^https:\/\/secondroot\.jp\/works\/yasashii-beauty-salon/);
});

test("every link and asset stays under the basePath", async ({ page }) => {
  for (const path of PAGES) {
    await page.goto(`${BASE}${path}`);
    const urls = await page.evaluate(() =>
      [
        ...[...document.querySelectorAll<HTMLAnchorElement>("a[href]")].map((a) => a.getAttribute("href")!),
        ...[...document.querySelectorAll<HTMLImageElement>("img")].map((i) => i.getAttribute("src")!),
        ...[...document.querySelectorAll<HTMLLinkElement>("link[href]")].map((l) => l.getAttribute("href")!),
        ...[...document.querySelectorAll<HTMLScriptElement>("script[src]")].map((s) => s.getAttribute("src")!),
      ].filter((u) => u.startsWith("/")),
    );
    const outside = urls.filter((u) => !u.startsWith(`${BASE}/`) && u !== BASE && !u.startsWith(`${BASE}#`));
    expect(outside, path || "/").toEqual([]);
  }
});

test("client-side navigation inside the Concept Work", async ({ page }) => {
  const problems = watch(page);
  await page.goto(BASE);
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const target of ["/about", "/menu", "/access"]) {
    await page.locator(`header a[href="${BASE}${target}"]`).first().click();
    await expect(page).toHaveURL(`${BASE}${target}`);
  }
  await page.locator(`header a[href="${BASE}"]`).first().click();
  await expect(page).toHaveURL(BASE);
  await page.waitForLoadState("networkidle");
  expect(problems).toEqual([]);
});

test("no horizontal overflow at any width", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "widths are set explicitly");
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["", "/about", "/menu", "/access"]) {
      await page.goto(`${BASE}${path}`);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${width}px ${path || "/"}`).toBeLessThanOrEqual(0);
    }
  }
});

test("Second Root's card opens the Concept Work under /works", async ({ page }) => {
  await page.goto("/");
  const card = page.locator(`a.cw-card[href="${BASE}"]`);
  await expect(card).toHaveCount(1);
  // The other two Concept Works still point at their own deployments.
  await expect(page.locator('a.cw-card[href^="https://"]')).toHaveCount(2);
  // Second Root keeps its own base styles (no Tailwind preflight from the Concept Work).
  const body = await page.evaluate(() => getComputedStyle(document.body).lineHeight);
  expect(body).toBe("29.6px");
});
