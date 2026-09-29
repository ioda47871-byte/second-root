import type { ReactNode } from "react";
import type { DemoTemplate } from "@/lib/sales/demo-content";
import styles from "./demo.module.css";

// Every demo says, up front and at the end, that it is Second Root's
// proposal and not the shop's official site (MVP_SPEC §7). The notice stays
// pinned like a site's utility bar and takes the page's own colours; the
// art direction (className) sets the tokens it reads.

export default function DemoFrame({
  shopName,
  template,
  variant,
  className,
  children,
}: {
  shopName: string;
  template: DemoTemplate;
  variant?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={className ? `${styles.page} ${className}` : styles.page} data-template={template} data-variant={variant}>
      <p className={styles.notice} role="note">
        <svg className={styles.noticeMark} viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M8 7v4.5M8 4.6v.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <span>
          これは <strong>Second Root</strong> が作成した<strong>ご提案用のデモページ</strong>です。{shopName}
          様の公式サイトではありません。
        </span>
      </p>
      {children}
      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <p className={styles.footerName}>{shopName}</p>
          <span className={styles.footerRule} aria-hidden="true" />
          <p className={styles.footerNote}>
            このページは、{shopName}様に向けて Second Root が公開情報をもとに作成したデモです。
            <br />
            掲載内容は確認できた公開情報のみで、公式サイト・公式情報ではありません。
          </p>
          <p className={styles.footerLink}>
            <a href="https://secondroot.jp" rel="noopener">
              Second Root（セカンドルート）｜名古屋の小さなお店のホームページ制作
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
