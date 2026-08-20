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
        <label htmlFor="cf-shop">お店名</label>
        <input id="cf-shop" name="shop" type="text" required disabled={disabled} />
      </div>
      <div className="form-row">
        <label htmlFor="cf-email">メールアドレス</label>
        <input id="cf-email" name="email" type="email" required disabled={disabled} />
      </div>
      <div className="form-row">
        <label htmlFor="cf-message">ご相談内容</label>
        <textarea
          id="cf-message"
          name="message"
          placeholder="今、困っていることを教えてください"
          aria-required="true"
          disabled={disabled}
        />
      </div>
      <div>
        <button type="submit" className="btn-stamp form-submit" disabled={disabled}>
          <span className="mark">
            <svg viewBox="0 0 24 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <line x1="12" y1="4" x2="12" y2="24" strokeWidth="2.5" strokeLinecap="round" />
              <circle cx="12" cy="31" r="4" />
            </svg>
          </span>
          <span className="label">{status === "loading" ? "送信しています…" : "無料診断を申し込む"}</span>
        </button>
        {status === "success" && (
          <p className="form-status is-success" role="status">
            送信ありがとうございます。24時間以内にご連絡します。
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
