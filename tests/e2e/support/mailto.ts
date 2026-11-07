import type { Page } from "@playwright/test";

// PR #239 M1: the today card hands a mailto: link to the device only after the
// server recorded 「送信画面を開いた」, by clicking a transient link. In tests
// that click is captured instead of leaving the browser, so a spec can see
// whether (and with what) the mail app would have been opened.
export async function captureMailto(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __mailto: string[] };
    w.__mailto = [];
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      if (this.href.startsWith("mailto:")) {
        w.__mailto.push(this.href);
        return;
      }
      return original.call(this);
    };
  });
}

export async function openedMailto(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __mailto: string[] }).__mailto ?? []);
}
