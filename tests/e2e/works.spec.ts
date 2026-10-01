import { expect, test, type Page } from "@playwright/test";

// Concept Works served as static exports from public/works/<slug>/
// (docs/WORKS.md). Each is its own HTML document: none of Second Root's
// layout, CSS, analytics or structured data may reach it, every URL it uses
// stays under its basePath, and its pages survive a reload.

const WORKS = [
  {
    base: "/works/yasashii-beauty-salon",
    title: /やさしい美を彩るサロン/,
    pages: ["", "/about", "/menu", "/staff", "/first", "/access"],
    overflowPages: ["", "/about", "/menu", "/staff", "/first", "/access"],
    // Built with NEXT_PUBLIC_SITE_URL, so its canonical names the /works URL.
    canonical: /^https:\/\/secondroot\.jp\/works\/yasashii-beauty-salon/,
    nav: "header",
    jsonLd: 0,
    knownOverflow: [] as string[],
  },
  {
    base: "/works/midori-seitai",
    title: /みどり整体院/,
    pages: ["", "/about", "/approach", "/menu", "/first", "/staff", "/access", "/faq"],
    overflowPages: ["", "/about", "/approach", "/menu", "/first", "/staff", "/access", "/faq"],
    // The original site has no canonical (no metadataBase); none is added.
    canonical: null,
    nav: "header",
    jsonLd: 0,
    knownOverflow: [] as string[],
  },
  {
    base: "/works/hoshi-no-cha",
    title: /星の茶スタンド/,
    pages: ["", "/menu", "/about", "/access"],
    overflowPages: ["", "/menu", "/about", "/access"],
    // The original site has no canonical either.
    canonical: null,
    // From 1280px the navigation lives in the left brand rail.
    nav: "aside",
    // Its own CreativeWork JSON-LD (marks it as a Concept Work).
    jsonLd: 1,
    // Already in the original source (1e9cb0d, the production deployment): at
    // 320px one unbreakable line of the menu copy is 15-20px too wide. Left
    // as is, since the Concept Work's design is not changed here.
    knownOverflow: ["320 /menu"],
  },
];
const WIDTHS = [320, 360, 375, 390, 430, 768, 1024, 1280, 1440];

// 星の茶スタンド loads Google Fonts at runtime. Answer those requests with an
// empty stylesheet so the suite never depends on the network, and so it also
// shows the pages hold up on the fallback fonts.
test.beforeEach(async ({ context }) => {
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: "text/css", body: "" }),
  );
});

/**
 * Collects console errors and failed or 4xx/5xx requests while a page is
 * open. With `base`, also any same-origin request outside it: a URL that lost
 * its basePath would otherwise load one of Second Root's own files with 200.
 */
function watch(page: Page, base?: string) {
  const problems: string[] = [];
  if (base) {
    const origin = new URL(test.info().project.use.baseURL!).origin;
    page.on("request", (r) => {
      const url = new URL(r.url());
      if (url.origin === origin && url.pathname !== base && !url.pathname.startsWith(`${base}/`) && url.pathname !== `${base}.txt`) {
        problems.push(`outside ${base}: ${url.pathname}`);
      }
    });
  }
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

for (const { base: BASE, title, pages: PAGES, overflowPages, canonical, nav, jsonLd, knownOverflow } of WORKS) {
  for (const path of PAGES) {
    test(`${BASE}${path} opens directly and on reload`, async ({ page }) => {
      const problems = watch(page, BASE);
      const res = await page.goto(`${BASE}${path}`);
      expect(res?.status()).toBe(200);
      expect(res?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
      await expect(page).toHaveTitle(title);
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

  test(`${BASE} carries nothing of Second Root`, async ({ page }) => {
    await page.goto(BASE);
    // Second Root's header / footer / section classes.
    await expect(page.locator(".hdr, .ftr, .cw-card, .section")).toHaveCount(0);
    // No Second Root JSON-LD (only the Concept Work's own, if any), no GA
    // loader, no Second Root stylesheet rules.
    const ld = page.locator('script[type="application/ld+json"]');
    await expect(ld).toHaveCount(jsonLd);
    expect((await ld.allTextContents()).join("")).not.toContain("ProfessionalService");
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
    if (canonical) await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", canonical);
    else await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
  });

  // Also proves no other site's stylesheet or script is loaded into the page.
  test(`${BASE}: every link and asset stays under the basePath`, async ({ page }) => {
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

  test(`${BASE}: client-side navigation, back and forward`, async ({ page }) => {
    const problems = watch(page, BASE);
    await page.goto(BASE);
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const target of ["/about", "/menu", "/access"]) {
      await page.locator(`${nav} a[href="${BASE}${target}"]`).first().click();
      await expect(page).toHaveURL(`${BASE}${target}`);
    }
    await page.locator(`${nav} a[href="${BASE}"]`).first().click();
    await expect(page).toHaveURL(BASE);
    await page.goBack();
    await expect(page).toHaveURL(`${BASE}/access`);
    await page.goBack();
    await expect(page).toHaveURL(`${BASE}/menu`);
    await page.goForward();
    await expect(page).toHaveURL(`${BASE}/access`);
    await expect(page).toHaveTitle(title);
    await page.waitForLoadState("networkidle");
    expect(problems).toEqual([]);
  });

  test(`${BASE}: favicon and 404`, async ({ request }) => {
    const html = await (await request.get(BASE)).text();
    const icon = html.match(/<link rel="icon" href="([^"]+)"/)?.[1];
    expect(icon, "favicon link").toMatch(new RegExp(`^${BASE}/`));
    const iconRes = await request.get(icon!);
    expect(iconRes.status()).toBe(200);
    // Every file under /works carries X-Robots-Tag, not only the pages.
    expect(iconRes.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    const payload = await request.get(`${BASE}/index.txt`);
    expect(payload.status()).toBe(200);
    expect(payload.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    expect((await request.get(`${BASE}/no-such-page`)).status()).toBe(404);
  });

  test(`${BASE}: no horizontal overflow at any width`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "widths are set explicitly");
    test.setTimeout(180_000);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      for (const path of overflowPages) {
        if (knownOverflow.includes(`${width} ${path}`)) continue;
        await page.goto(`${BASE}${path}`);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${width}px ${path || "/"}`).toBeLessThanOrEqual(0);
      }
    }
  });

}

test("星の茶スタンド's menu shows all 13 drinks and sweets with photos", async ({ page }) => {
  const problems = watch(page);
  await page.goto("/works/hoshi-no-cha/menu");
  await loadAll(page);
  // The photos are lazy: bring each into view, then wait until all have loaded.
  const photos = () =>
    page.evaluate(() => {
      const imgs = [...document.images].filter((i) =>
        /\/works\/hoshi-no-cha\/images\/(menu\/|tea-)/.test(i.getAttribute("src") ?? ""),
      );
      imgs.forEach((i) => i.scrollIntoView());
      return { count: imgs.length, loaded: imgs.filter((i) => i.naturalWidth > 0).length };
    });
  await expect.poll(photos, { timeout: 15_000 }).toEqual({ count: 13, loaded: 13 });
  expect(problems).toEqual([]);
});

test("X-Robots-Tag stays off Second Root's own pages", async ({ request }) => {
  for (const path of ["/", "/privacy", "/terms", "/thanks", "/robots.txt", "/sitemap.xml"]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    expect(res.headers()["x-robots-tag"], path).toBeUndefined();
  }
  // The private routes keep their own header set.
  const admin = await request.get("/admin/login");
  expect(admin.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(admin.headers()["x-frame-options"]).toBe("DENY");
  expect(admin.headers()["cache-control"]).toContain("no-store");
});

test("Second Root's cards open the Concept Works under /works", async ({ page }) => {
  await page.goto("/");
  for (const { base } of WORKS) await expect(page.locator(`a.cw-card[href="${base}"]`)).toHaveCount(1);
  // No Concept Work card points at an outside deployment any more.
  await expect(page.locator('a.cw-card[href^="https://"]')).toHaveCount(0);
  // Second Root keeps its own base styles (no Tailwind preflight from a Concept Work).
  const body = await page.evaluate(() => getComputedStyle(document.body).lineHeight);
  expect(body).toBe("29.6px");
});
