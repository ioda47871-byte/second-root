"use client";

import { useEffect } from "react";

type GtagWindow = Window & {
  gtag?: (command: string, eventName: string, params?: Record<string, unknown>) => void;
};

function send(name: string, params?: Record<string, unknown>) {
  const w = window as GtagWindow;
  // GA4 is env-gated and production-only, so gtag is simply absent in dev
  // and on previews — no-op rather than throw.
  if (typeof w.gtag !== "function") return;
  w.gtag("event", name, params);
}

/**
 * Adds GA4 events without touching the existing GA initialisation or
 * turning every section into a client component: clicks are delegated
 * from [data-ga] attributes, and section views come from one observer.
 */
export default function Analytics() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-ga]");
      if (!el) return;
      const name = el.dataset.ga;
      if (name) send(name, { label: el.textContent?.trim().slice(0, 60) });
    };
    document.addEventListener("click", onClick);

    const views: Array<[string, string]> = [
      ["#works", "works_view"],
      ["#price", "pricing_view"],
    ];
    const seen = new Set<string>();
    let io: IntersectionObserver | undefined;

    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            const hit = views.find(([sel]) => entry.target.matches(sel));
            if (hit && !seen.has(hit[1])) {
              seen.add(hit[1]);
              send(hit[1]);
            }
          });
        },
        { threshold: 0.25 }
      );
      views.forEach(([sel]) => {
        const node = document.querySelector(sel);
        if (node) io!.observe(node);
      });
    }

    return () => {
      document.removeEventListener("click", onClick);
      io?.disconnect();
    };
  }, []);

  return null;
}
