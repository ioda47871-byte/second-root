import Link from "next/link";
import { RootMark, LeafSpray, IconInstagram } from "./Decor";
import { NAV } from "./nav";
import Jp from "./Jp";

export default function SiteFooter() {
  // Rendered only once a real account URL is configured — no placeholder link.
  const instagram = process.env.NEXT_PUBLIC_INSTAGRAM_URL;
  return (
    <footer className="ftr">
      <LeafSpray className="decor ftr-leaf" />
      <div className="container ftr-in">
        <div className="ftr-top">
          <div>
            <span className="hdr-logo" style={{ marginRight: 0 }}>
              <RootMark className="logo-mark" style={{ color: "var(--gold-soft)" }} />
              <span>
                <span className="logo-name">Second Root</span>
                <br />
                <span className="logo-sub">WEB DESIGN STUDIO</span>
              </span>
            </span>
            <p className="ftr-tag">
              <Jp t="名古屋・金山駅周辺を｜拠点に、｜パン屋・カフェなど｜地域のお店の｜ホームページを｜制作しています。" />
              <br />
              <Jp t="名古屋市内は対面相談可／｜全国オンライン対応。" />
            </p>
            {instagram && (
              <a
                className="ftr-sns"
                href={instagram}
                target="_blank"
                rel="noopener noreferrer"
                data-ga="instagram_click"
              >
                <IconInstagram className="" />
                Instagram
              </a>
            )}
          </div>

          <nav className="ftr-nav" aria-label="フッターナビゲーション">
            {NAV.map((n) => (
              <a key={n.href} href={n.href}>
                {n.label}
              </a>
            ))}
          </nav>
        </div>

        <div className="ftr-bot">
          <span>© 2026 Second Root</span>
          <span className="ftr-legal">
            <Link href="/privacy">プライバシーポリシー</Link>
            <Link href="/terms">利用規約</Link>
          </span>
        </div>
      </div>
    </footer>
  );
}
