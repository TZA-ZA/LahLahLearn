import type { SupabaseClient } from "npm:@supabase/supabase-js@2.117.3";
import nodemailer from "npm:nodemailer@6.9.16";
import { esc, optionalEnv } from "./http.ts";

export interface Attachment { filename: string; content: string /* base64 */; content_type?: string }
export interface Mail {
  to: string | string[]; subject: string; html: string; text: string;
  kind: string; familyId?: string | null; attachments?: Attachment[]; replyTo?: string;
}

/** Sends through Resend (RESEND_API_KEY) or, failing that, SMTP such as Gmail (SMTP_USER + SMTP_PASS). With neither it logs and skips. */
export async function sendMail(admin: SupabaseClient | null, m: Mail): Promise<{ sent: boolean; id?: string; error?: string }> {
  const key = optionalEnv("RESEND_API_KEY");
  const from = optionalEnv("EMAIL_FROM") ?? "LahLahLearn <onboarding@resend.dev>";
  const to = Array.isArray(m.to) ? m.to : [m.to];
  let result: { sent: boolean; id?: string; error?: string };
  const smtpPass = optionalEnv("SMTP_PASS");
  if (!key && smtpPass) {
    // Gmail (or any SMTP server) on port 465. Supabase blocks ports 25 and 587 for functions, so 465 it is.
    try {
      const user = optionalEnv("SMTP_USER") ?? "";
      const tx = nodemailer.createTransport({
        host: optionalEnv("SMTP_HOST") ?? "smtp.gmail.com", port: Number(optionalEnv("SMTP_PORT") ?? 465), secure: true,
        auth: { user, pass: smtpPass.replace(/\s+/g, "") },
      });
      const info = await tx.sendMail({
        from: optionalEnv("EMAIL_FROM") ?? `LahLahLearn <${user}>`, to: to.join(", "), subject: m.subject, html: m.html, text: m.text, replyTo: m.replyTo,
        attachments: (m.attachments ?? []).map((a) => ({ filename: a.filename, content: a.content, encoding: "base64", contentType: a.content_type })),
      });
      result = { sent: true, id: String(info.messageId ?? "") };
    } catch (e) {
      console.error("smtp", e);
      result = { sent: false, error: e instanceof Error ? e.message : String(e) };
    }
  } else if (!key) {
    result = { sent: false, error: "No email sender set (RESEND_API_KEY or SMTP_PASS)" };
  } else {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject: m.subject, html: m.html, text: m.text, reply_to: m.replyTo, attachments: m.attachments }),
    });
    const body = await r.json().catch(() => ({}));
    result = r.ok ? { sent: true, id: body.id } : { sent: false, error: body?.message ?? `HTTP ${r.status}` };
  }
  if (admin) {
    for (const addr of to) {
      await admin.from("email_log").insert({ family_id: m.familyId ?? null, kind: m.kind, to_email: addr, status: result.sent ? "sent" : "failed", detail: result.error ?? result.id ?? null });
    }
  }
  return result;
}

export const siteUrl = (): string => (optionalEnv("SITE_URL") ?? "https://lahlahlearn.netlify.app/").replace(/\/?$/, "/");

/** Calm, simple branded email shell. `body` is trusted HTML built by our own code (values escaped by callers). */
export function layout(title: string, body: string, cta?: { label: string; url: string }): string {
  const button = cta
    ? `<p style="margin:28px 0 8px"><a href="${esc(cta.url)}" style="display:inline-block;background:#1e3a2f;color:#fffdf9;text-decoration:none;padding:13px 26px;border-radius:999px;font-weight:600">${esc(cta.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f4f2ec;font-family:Lexend,Segoe UI,Helvetica,Arial,sans-serif;color:#1c2520">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fffdf9;border:1px solid #e3dfd3;border-radius:18px">
<tr><td style="padding:32px 32px 8px"><p style="margin:0 0 18px;font-size:14px;color:#a8843f;font-weight:600">LahLahLearn</p>
<h1 style="margin:0 0 14px;font-size:24px;line-height:1.25;font-weight:500">${esc(title)}</h1>
<div style="font-size:15px;line-height:1.6;color:#2b342f">${body}</div>${button}</td></tr>
<tr><td style="padding:20px 32px 28px;font-size:12px;color:#6c746d;border-top:1px solid #e3dfd3">Calm learning for every child. You can change emails in the Care Circle settings.</td></tr>
</table></td></tr></table></body></html>`;
}
