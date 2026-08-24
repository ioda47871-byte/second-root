import Link from "next/link";
import { RootMark, LeafSpray } from "./Decor";
import { NAV } from "./nav";

export default function SiteFooter() {
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
              パン屋・カフェ・美容室・整体院など、
              <br />
              地域のお店のホームページを制作しています。
            </p>
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
