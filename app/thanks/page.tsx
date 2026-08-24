import type { Metadata } from "next";
import Link from "next/link";
import ThanksTracker from "@/components/ThanksTracker";

export const metadata: Metadata = {
  title: "送信完了",
  robots: { index: false, follow: true },
};

export default function ThanksPage() {
  return (
    <main className="standalone-page">
      <ThanksTracker />
      <p className="eyebrow">Thank You</p>
      <h1 className="standalone-page-title">お問い合わせありがとうございます。</h1>
      <p className="standalone-page-desc">
        内容を確認し、原則24時間以内にご連絡します。
      </p>
      <Link className="btn-primary" href="/">
        トップページへ戻る<span className="arrow">→</span>
      </Link>
    </main>
  );
}
