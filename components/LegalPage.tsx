import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Shared chrome for the legal pages (/privacy, /terms).
 *
 * These pages deliberately don't reuse the home page's header/footer: the
 * section nav and the "無料診断を申し込む" CTA would compete with a document
 * that exists to be read. Same tokens and hairlines, quieter arrangement,
 * plus a reading measure narrow enough that long clauses stay legible on a
 * wide screen.
 */
export default function LegalPage({
  title,
  lead,
  children,
  effectiveDate,
}: {
  title: string;
  lead: ReactNode;
  children: ReactNode;
  effectiveDate: string;
}) {
  return (
    <>
      <header className="legal-header">
        <div className="legal-header-inner">
          <Link className="logo" href="/">
            <span className="logo-name">Second Root</span>
            <span className="logo-sub">WEB DESIGN STUDIO</span>
          </Link>
          <Link className="legal-back" href="/">
            トップページへ戻る
          </Link>
        </div>
      </header>

      <main className="legal-main">
        <h1 className="legal-title">{title}</h1>
        <div className="legal-lead">{lead}</div>
        <div className="legal-body">{children}</div>
        <p className="legal-date">制定日：{effectiveDate}</p>
      </main>

      <footer className="legal-footer">
        <div className="legal-footer-inner">
          <span className="site-footer-copy">© 2026 Second Root</span>
          <nav className="site-footer-nav">
            <Link href="/">ホーム</Link>
            <Link href="/privacy">プライバシーポリシー</Link>
            <Link href="/terms">利用規約</Link>
          </nav>
        </div>
      </footer>
    </>
  );
}

/** One numbered clause: heading plus its body. */
export function LegalSection({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <section className="legal-section">
      <h2 className="legal-heading">{heading}</h2>
      {children}
    </section>
  );
}
