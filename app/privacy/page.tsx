import type { Metadata } from "next";
import LegalPage, { LegalSection } from "@/components/LegalPage";

export const metadata: Metadata = {
  title: "プライバシーポリシー",
  description:
    "Second Rootのプライバシーポリシー。お問い合わせフォームで取得する個人情報の利用目的、第三者提供、Cookieおよびアクセス解析の取り扱いについてご案内します。",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="プライバシーポリシー"
      effectiveDate="2026年8月24日"
      lead={
        <p>
          Second Root(以下「当方」といいます。)は、当方が運営するウェブサイト(以下「本サイト」といいます。)において取得する個人情報について、以下のとおり取り扱います。
        </p>
      }
    >
      <LegalSection heading="1. 取得する情報">
        <p>
          当方は、本サイトのお問い合わせフォーム等を通じて、以下の情報を取得する場合があります。
        </p>
        <ul className="legal-list">
          <li>氏名</li>
          <li>メールアドレス</li>
          <li>会社名、店舗名</li>
          <li>お問い合わせ内容</li>
          <li>その他、お問い合わせ時にご入力いただいた情報</li>
        </ul>
        <p>
          また、本サイトの利用状況を把握するため、Cookieその他の技術を利用して、アクセス情報を取得する場合があります。
        </p>
      </LegalSection>

      <LegalSection heading="2. 個人情報の利用目的">
        <p>取得した個人情報は、以下の目的で利用します。</p>
        <ul className="legal-list">
          <li>お問い合わせへの回答</li>
          <li>ホームページ制作等のご相談、ヒアリングおよびご提案</li>
          <li>見積書、契約書その他必要な書類の作成および連絡</li>
          <li>サービス提供および制作業務の遂行</li>
          <li>サービス改善のための分析</li>
          <li>重要なお知らせその他必要なご連絡</li>
          <li>法令または利用規約に違反する行為への対応</li>
        </ul>
        <p>
          上記の目的を超えて個人情報を利用する場合は、法令で認められる場合を除き、あらかじめご本人の同意を得ます。
        </p>
      </LegalSection>

      <LegalSection heading="3. 個人情報の第三者提供">
        <p>
          当方は、以下の場合を除き、ご本人の同意なく個人情報を第三者へ提供しません。
        </p>
        <ul className="legal-list">
          <li>法令に基づく場合</li>
          <li>人の生命、身体または財産の保護のために必要な場合</li>
          <li>その他、法令により認められる場合</li>
        </ul>
      </LegalSection>

      <LegalSection heading="4. 業務委託">
        <p>
          当方は、サービス提供に必要な範囲で、サーバー、メール送信、クラウドサービスその他の外部サービスを利用する場合があります。
        </p>
        <p>
          その場合、必要な範囲に限って情報を取り扱い、適切なサービスの選定および管理に努めます。
        </p>
      </LegalSection>

      <LegalSection heading="5. Google Analyticsについて">
        <p>
          本サイトでは、サイトの利用状況を把握し、サービスおよびウェブサイトを改善するため、Google LLCが提供するGoogle Analyticsを利用しています。
        </p>
        <p>
          Google Analyticsでは、Cookie等を利用して、ページの閲覧状況、利用端末、ブラウザ、おおよその地域等の情報が収集される場合があります。
        </p>
        <p>
          これらの情報は、Googleのプライバシーポリシーおよび利用規約に基づいて取り扱われます。
        </p>
        <p>
          なお、Google Analyticsにより取得する情報から、当方が直接個人を特定することを目的として利用することはありません。
        </p>
      </LegalSection>

      <LegalSection heading="6. Cookieについて">
        <p>
          本サイトでは、アクセス解析やサイトの利便性向上のためCookieを使用する場合があります。
        </p>
        <p>
          利用者はブラウザの設定によりCookieを無効にすることができます。ただし、Cookieを無効にした場合、本サイトの一部機能が正常に利用できない場合があります。
        </p>
      </LegalSection>

      <LegalSection heading="7. 個人情報の安全管理">
        <p>
          当方は、取得した個人情報について、不正アクセス、漏えい、紛失、改ざん等を防止するため、必要かつ適切な安全管理措置を講じるよう努めます。
        </p>
      </LegalSection>

      <LegalSection heading="8. 個人情報の開示・訂正・削除等">
        <p>
          ご本人から、当方が保有する個人情報について、開示、訂正、追加、削除、利用停止等のご希望があった場合は、ご本人であることを確認したうえで、法令に従い適切に対応します。
        </p>
      </LegalSection>

      <LegalSection heading="9. プライバシーポリシーの変更">
        <p>
          当方は、法令の改正、サービス内容の変更その他必要に応じて、本ポリシーを変更することがあります。
        </p>
        <p>変更後の内容は、本サイトに掲載した時点から適用されます。</p>
      </LegalSection>

      <LegalSection heading="10. お問い合わせ">
        <p>本ポリシーに関するお問い合わせは、以下までお願いいたします。</p>
        <div className="legal-contact">
          <p>Second Root</p>
          <p>
            メール：
            <a href="mailto:info@secondroot.jp">info@secondroot.jp</a>
          </p>
        </div>
      </LegalSection>
    </LegalPage>
  );
}
