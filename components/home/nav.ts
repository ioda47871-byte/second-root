/**
 * Shared nav model. Kept out of SiteHeader because that file is a client
 * component — re-exporting a plain array across the client boundary does
 * not survive the server build.
 */
export const NAV = [
  { href: "#home", label: "ホーム" },
  { href: "#works", label: "制作事例" },
  { href: "#service", label: "サービス" },
  { href: "#price", label: "料金" },
  { href: "#process", label: "制作の流れ" },
  { href: "#faq", label: "よくあるご質問" },
  { href: "#about", label: "私たちについて" },
];
