import type { CSSProperties, ReactNode } from "react";
import type { DemoTemplate } from "@/lib/sales/demo-content";
import styles from "./demo.module.css";

// Every demo says, up front and at the end, that it is Second Root's
// proposal and not the shop's official site (MVP_SPEC §7).

export default function DemoFrame({
  shopName,
  template,
  className,
  style,
  children,
}: {
  shopName: string;
  template: DemoTemplate;
  /** Extra class and custom properties (a design profile's tokens). */
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div className={className ? `${styles.page} ${className}` : styles.page} data-template={template} style={style}>
      <p className={styles.notice} role="note">
        これは <strong>Second Root</strong> が作成した<strong>ご提案用のデモページ</strong>です。{shopName}
        様の公式サイトではありません。
      </p>
      {children}
      <footer className={styles.footer}>
        <p>
          このページは、{shopName}様に向けて Second Root が公開情報をもとに作成したデモです。
          <br />
          掲載内容は確認できた公開情報のみで、公式サイト・公式情報ではありません。
        </p>
        <p>
          <a href="https://secondroot.jp" rel="noopener">
            Second Root（セカンドルート）｜名古屋の小さなお店のホームページ制作
          </a>
        </p>
      </footer>
    </div>
  );
}
