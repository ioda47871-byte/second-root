import Script from "next/script";

/**
 * Loads GA4 only when NEXT_PUBLIC_GA_MEASUREMENT_ID is set and only in
 * production — local/preview builds stay untracked even if the env var
 * leaks into a preview deployment's environment by mistake.
 */
export default function GoogleAnalytics() {
  const gaId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
  if (!gaId || process.env.NODE_ENV !== "production") return null;

  // Demo pages carry a secret token in their URL and admin pages are
  // private: GA is never loaded or sent there (no page views, no Referer).
  return (
    <Script id="ga4-init" strategy="afterInteractive">
      {`
        (function () {
          if (/^\\/(demo|admin)(\\/|$)/.test(window.location.pathname)) return;
          var s = document.createElement("script");
          s.async = true;
          s.src = "https://www.googletagmanager.com/gtag/js?id=${gaId}";
          document.head.appendChild(s);
          window.dataLayer = window.dataLayer || [];
          window.gtag = function () { window.dataLayer.push(arguments); };
          window.gtag("js", new Date());
          window.gtag("config", "${gaId}");
        })();
      `}
    </Script>
  );
}
