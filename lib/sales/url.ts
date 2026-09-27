// URL validation (docs/SECURITY.md §3). Only http(s) URLs without
// credentials are accepted; everything else (javascript:, data:, file:, …)
// is rejected. The server never fetches these URLs.

const MAX_URL_LENGTH = 2048;

export function parseSafeHttpUrl(input: unknown): URL | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (!url.hostname || !url.hostname.includes(".")) return null;
  return url;
}

export function isSafeHttpUrl(input: unknown): input is string {
  return parseSafeHttpUrl(input) !== null;
}

// Hosts where many unrelated shops live under one domain: the site key is
// host + the leading path segments that identify the shop's own page.
const SHARED_HOST_PATH_SEGMENTS: Record<string, number> = {
  "sites.google.com": 2, // /view/<site>
  "ameblo.jp": 1,
  "note.com": 1,
  "linktr.ee": 1,
  "lit.link": 1,
  "peraichi.com": 3, // /landing_pages/view/<id>
  "hp.peraichi.com": 1,
  "profile.ameba.jp": 2,
  "blog.goo.ne.jp": 1,
  "blog.livedoor.jp": 1,
  "jimdofree.com": 1,
};

// Social networks, portals and map/review sites are never a shop's
// official website (MVP_SPEC §3.3): a URL on these hosts must not make
// website_status "present".
const NOT_OFFICIAL_SITE_HOSTS = [
  "instagram.com", "facebook.com", "fb.com", "twitter.com", "x.com", "threads.net", "tiktok.com",
  "youtube.com", "line.me", "lin.ee", "tabelog.com", "hotpepper.jp", "retty.me", "gnavi.co.jp",
  "google.com", "google.co.jp", "goo.gl", "maps.app.goo.gl", "yelp.com", "tripadvisor.com",
  "tripadvisor.jp", "jalan.net", "ikyu.com", "hitosara.com", "favy.jp", "instagr.am",
  // Shorteners and delivery / review portals never identify one shop's own site.
  "bit.ly", "t.co", "g.page", "tinyurl.com", "ow.ly", "is.gd", "ubereats.com", "demae-can.com",
  "wolt.com", "ekiten.jp", "rakuten.co.jp", "amazon.co.jp", "mercari.com",
  // Marketplaces: a shop page inside a mall is not the shop's own site.
  "minne.com", "creema.jp", "shopping.yahoo.co.jp", "paypaymall.yahoo.co.jp",
];

function bareHost(url: URL): string {
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

export function isOfficialSiteCandidate(input: string): boolean {
  const url = parseSafeHttpUrl(input);
  if (!url) return false;
  const host = bareHost(url);
  if (host in SHARED_HOST_PATH_SEGMENTS) return true;
  return !NOT_OFFICIAL_SITE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * Dedupe key for a shop's official site: the host without "www.", or for
 * shared hosts host + the path segments naming the shop. Null for unsafe
 * URLs, social/portal pages, or shared-host URLs without the shop segment.
 * The database checks the key is a prefix of the stored URL.
 */
export function websiteKey(input: string): string | null {
  const url = parseSafeHttpUrl(input);
  if (!url || !isOfficialSiteCandidate(input)) return null;
  const host = bareHost(url);
  const segments = SHARED_HOST_PATH_SEGMENTS[host];
  if (!segments) return host;
  const path = url.pathname.split("/").filter(Boolean).slice(0, segments).map((p) => p.toLowerCase());
  if (path.length < segments) return null;
  return `${host}/${path.join("/")}`;
}

const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com"]);
const INSTAGRAM_RESERVED = new Set(["p", "reel", "reels", "explore", "stories", "tv", "accounts", "direct", "about", "developer", "legal"]);
const HANDLE_PATTERN = /^[a-z0-9._]{1,30}$/;

/** Canonical Instagram profile: { url: https://www.instagram.com/<handle>/, handle }. */
export function parseInstagramProfile(input: unknown): { url: string; handle: string } | null {
  const url = parseSafeHttpUrl(input);
  if (!url || url.protocol !== "https:" || !INSTAGRAM_HOSTS.has(url.hostname.toLowerCase())) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) return null;
  const handle = segments[0].toLowerCase();
  if (!HANDLE_PATTERN.test(handle) || INSTAGRAM_RESERVED.has(handle)) return null;
  return { url: `https://www.instagram.com/${handle}/`, handle };
}
