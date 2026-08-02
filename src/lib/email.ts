import nodemailer from "nodemailer";
import { sqlite } from "@/lib/db/client";
import { getSiteSettings } from "@/lib/site-settings/service";
import { DEFAULT_LOCALE, type AppLocale } from "@/lib/i18n/locales";
import { translate } from "@/lib/i18n/messages";

type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

function smtpConfig() {
  const settings = getSiteSettings(sqlite);
  const host = settings.smtp.host;
  const user = settings.smtp.user;
  const password = process.env.SMTP_PASSWORD;
  if (!host || !user || !password) {
    throw new Error("SMTP_HOST, SMTP_USER, and SMTP_PASSWORD are required.");
  }

  return {
    host,
    port: settings.smtp.port,
    secure: settings.smtp.secure,
    auth: { user, pass: password },
    from: settings.smtp.from || `Nyxdoc <${user}>`,
  };
}

export async function sendEmail(message: EmailMessage) {
  const config = smtpConfig();
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
    requireTLS: !config.secure,
  });

  await transport.sendMail({
    from: config.from,
    ...message,
  });
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function emailShell(
  locale: AppLocale,
  title: string,
  body: string,
  actionLabel: string,
  url: string,
) {
  return `
    <!doctype html>
    <html lang="${locale}">
      <body style="margin:0;background:#f6faf6;font-family:Arial,'Noto Sans',sans-serif;color:#20312b">
        <div style="max-width:560px;margin:40px auto;padding:36px;background:white;border:1px solid #dfe8e2;border-radius:24px">
          <div style="font-size:20px;font-weight:800;margin-bottom:28px">nyxdoc</div>
          <h1 style="font-size:28px;line-height:1.3;margin:0 0 16px">${escapeHtml(title)}</h1>
          <p style="font-size:15px;line-height:1.8;color:#62716b;margin:0 0 28px">${escapeHtml(body)}</p>
          <a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 20px;background:#3b9977;color:white;text-decoration:none;border-radius:14px;font-weight:700">${escapeHtml(actionLabel)}</a>
          <p style="font-size:12px;line-height:1.6;color:#89958f;margin:28px 0 0">${escapeHtml(translate(locale, "email.ignore"))}</p>
        </div>
      </body>
    </html>
  `;
}

export function sendVerificationMessage(
  email: string,
  url: string,
  locale: AppLocale = DEFAULT_LOCALE,
) {
  return sendEmail({
    to: email,
    subject: translate(locale, "email.verify.subject"),
    text: translate(locale, "email.verify.text", { url }),
    html: emailShell(
      locale,
      translate(locale, "email.verify.title"),
      translate(locale, "email.verify.body"),
      translate(locale, "email.verify.action"),
      url,
    ),
  });
}

export function sendPasswordResetMessage(
  email: string,
  url: string,
  locale: AppLocale = DEFAULT_LOCALE,
) {
  return sendEmail({
    to: email,
    subject: translate(locale, "email.reset.subject"),
    text: translate(locale, "email.reset.text", { url }),
    html: emailShell(
      locale,
      translate(locale, "email.reset.title"),
      translate(locale, "email.reset.body"),
      translate(locale, "email.reset.action"),
      url,
    ),
  });
}
