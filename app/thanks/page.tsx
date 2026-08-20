import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "送信完了",
  robots: { index: false, follow: true },
};

export default function ThanksPage() {
  return (
    <main className="standalone-page">
      <p className="eyebrow">Thank You</p>
      <h1 className="standalone-page-title">送信ありがとうございます。</h1>
      <p className="standalone-page-desc">
        24時間以内を目安にご連絡いたします。
      </p>
      <Link className="btn-primary" href="/">
        トップページへ戻る<span className="arrow">→</span>
      </Link>
    </main>
  );
}
