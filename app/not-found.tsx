import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "ページが見つかりません",
};

export default function NotFound() {
  return (
    <main className="standalone-page">
      <p className="eyebrow">404</p>
      <h1 className="standalone-page-title">ページが見つかりません。</h1>
      <p className="standalone-page-desc">
        お探しのページは、移動または削除された可能性があります。
      </p>
      <Link className="btn-primary" href="/">
        トップページへ戻る<span className="arrow">→</span>
      </Link>
    </main>
  );
}
