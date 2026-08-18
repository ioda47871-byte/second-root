import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest) {
  let body: { name?: string; shop?: string; email?: string; message?: string };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が正しくありません。" }, { status: 400 });
  }

  const name = (body.name || "").trim();
  const shop = (body.shop || "").trim();
  const email = (body.email || "").trim();
  const message = (body.message || "").trim();

  if (!name || !shop || !email) {
    return NextResponse.json(
      { error: "お名前・お店名・メールアドレスは必須です。" },
      { status: 400 }
    );
  }
  if (!EMAIL_PATTERN.test(email)) {
    return NextResponse.json(
      { error: "メールアドレスの形式が正しくありません。" },
      { status: 400 }
    );
  }

  const apiKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.CONTACT_TO_EMAIL;
  const fromEmail = process.env.CONTACT_FROM_EMAIL || "Second Root <info@secondroot.jp>";

  if (!apiKey || !toEmail) {
    console.error(
      "Contact form is not configured: set RESEND_API_KEY and CONTACT_TO_EMAIL in the environment."
    );
    return NextResponse.json(
      { error: "現在お問い合わせを受け付けられません。時間をおいて再度お試しください。" },
      { status: 500 }
    );
  }

  const resend = new Resend(apiKey);

  try {
    const { error } = await resend.emails.send({
      from: fromEmail,
      to: toEmail,
      replyTo: email,
      subject: `【Second Root】無料診断のお申し込み(${shop}様)`,
      text: [
        `お名前: ${name}`,
        `お店名: ${shop}`,
        `メールアドレス: ${email}`,
        "",
        "ご相談内容:",
        message || "(未記入)",
      ].join("\n"),
    });

    if (error) {
      console.error("Resend error:", error);
      return NextResponse.json(
        { error: "送信に失敗しました。時間をおいて再度お試しください。" },
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Contact form send failed:", err);
    return NextResponse.json(
      { error: "送信に失敗しました。時間をおいて再度お試しください。" },
      { status: 500 }
    );
  }
}
