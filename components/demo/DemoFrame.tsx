import type { ReactNode } from "react";
import type { DemoTemplate } from "@/lib/sales/demo-content";
import styles from "./demo.module.css";

// Every demo says, up front and at the end, that it is Second Root's
// proposal and not the shop's official site (MVP_SPEC §7). The notice stays
// pinned while scrolling; colours follow the template so it reads as part
// of the page rather than a warning banner.

export default function DemoFrame({ shopName, template, children }: { shopName: string; template: DemoTemplate; children: ReactNode }) {
  return (
    <div className={styles.page} data-template={template}>
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
          <svg className={styles.footerRule} viewBox="0 0 240 10" preserveAspectRatio="none" aria-hidden="true">
            <path d="M0 5h108M132 5h108" stroke="currentColor" strokeWidth="1" />
            <path d="M120 1l4 4-4 4-4-4 4-4Z" fill="currentColor" />
          </svg>
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
