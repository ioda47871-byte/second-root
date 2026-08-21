"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

type Status = "idle" | "loading" | "success" | "error";

export default function ContactForm() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState("");

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrorMessage("");

    const form = e.currentTarget;
    const formData = new FormData(form);
    const payload = {
      name: String(formData.get("name") || ""),
      shop: String(formData.get("shop") || ""),
      email: String(formData.get("email") || ""),
      category: String(formData.get("category") || ""),
      websiteUrl: String(formData.get("websiteUrl") || ""),
      instagram: String(formData.get("instagram") || ""),
      gbp: String(formData.get("gbp") || ""),
      message: String(formData.get("message") || ""),
    };

    if (!payload.message.trim()) {
      setStatus("error");
      setErrorMessage("ご相談内容をご記入ください。");
      return;
    }

    setStatus("loading");

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(json.error || "送信に失敗しました。時間をおいて再度お試しください。");
      }

      setStatus("success");
      form.reset();
      router.push("/thanks");
    } catch (err) {
      setStatus("error");
      setErrorMessage(
        err instanceof Error ? err.message : "送信に失敗しました。時間をおいて再度お試しください。"
      );
    }
  }

  const disabled = status === "loading";

  return (
    <form className="contact-form" onSubmit={handleSubmit} noValidate={false}>
      <div className="form-row">
        <label htmlFor="cf-name">お名前</label>
        <input id="cf-name" name="name" type="text" required disabled={disabled} />
      </div>
      <div className="form-row">
        <label htmlFor="cf-shop">店舗名・事業名</label>
        <input id="cf-shop" name="shop" type="text" required disabled={disabled} />
      </div>
      <div className="form-row">
        <label htmlFor="cf-email">メールアドレス</label>
        <input id="cf-email" name="email" type="email" required disabled={disabled} />
      </div>
      <div className="form-row">
        <label htmlFor="cf-category">業種</label>
        <select id="cf-category" name="category" required disabled={disabled} defaultValue="">
          <option value="" disabled>選択してください</option>
          <option value="パン屋">パン屋</option>
          <option value="カフェ">カフェ</option>
          <option value="美容室">美容室</option>
          <option value="整体">整体</option>
          <option value="その他">その他</option>
        </select>
      </div>
      <details className="form-more form-row--full">
        <summary>Web・SNS情報を入力する(任意)<span className="arrow">→</span></summary>
        <div className="form-more-body">
          <div className="form-row">
            <label htmlFor="cf-website">現在のホームページURL(任意)</label>
            <input id="cf-website" name="websiteUrl" type="text" disabled={disabled} />
          </div>
          <div className="form-row">
            <label htmlFor="cf-instagram">Instagram URLまたはアカウント名(任意)</label>
            <input id="cf-instagram" name="instagram" type="text" disabled={disabled} />
          </div>
          <div className="form-row">
            <label htmlFor="cf-gbp">GoogleビジネスプロフィールURL(任意・分からなければ空欄で大丈夫です)</label>
            <input id="cf-gbp" name="gbp" type="text" disabled={disabled} />
          </div>
        </div>
      </details>
      <div className="form-row form-row--full">
        <label htmlFor="cf-message">現在困っていること・ご相談内容</label>
        <textarea
          id="cf-message"
          name="message"
          placeholder="今、困っていることを教えてください"
          aria-required="true"
          disabled={disabled}
        />
      </div>
      <div className="form-actions">
        <button type="submit" className="btn-primary form-submit" disabled={disabled}>
          {status === "loading" ? "送信しています…" : "無料診断を申し込む"}
        </button>
        {status === "success" && (
          <p className="form-status is-success" role="status">
            お問い合わせありがとうございます。内容を確認し、原則24時間以内にご連絡します。
          </p>
        )}
        {status === "error" && (
          <p className="form-status is-error" role="alert">
            {errorMessage}
          </p>
        )}
      </div>
    </form>
  );
}
