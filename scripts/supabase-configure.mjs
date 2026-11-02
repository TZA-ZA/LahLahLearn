#!/usr/bin/env node
// Sets up Supabase Auth for LahLahLearn through the Management API:
// site URL and redirect list, 6-digit email codes (no passwords), friendly email templates,
// and Resend as the email sender so codes are not limited by Supabase's test mailer.
//
//   SUPABASE_ACCESS_TOKEN=sbp_... SUPABASE_PROJECT_REF=abcd1234 SITE_URL=https://tza-za.github.io/LahLahLearn/ \
//   RESEND_API_KEY=re_... EMAIL_FROM="LahLahLearn <hello@yourdomain.com>" node scripts/supabase-configure.mjs
//
// RESEND_API_KEY and EMAIL_FROM are optional; without them Supabase's built-in mailer is used
// (fine for testing, limited to a few emails an hour).

const TOKEN = process.env.SUPABASE_ACCESS_TOKEN, REF = process.env.SUPABASE_PROJECT_REF;
const SITE = process.env.SITE_URL;
if (!TOKEN || !REF || !SITE) {
  console.error("Set SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF and SITE_URL first.");
  process.exit(1);
}
const extra = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);

const box = (title, body) => `<!doctype html><html><body style="margin:0;background:#f4f8f5;font-family:Lexend,Arial,sans-serif;color:#1b2a22">
<div style="max-width:480px;margin:0 auto;padding:32px 20px"><div style="background:#fff;border-radius:20px;padding:32px 28px;text-align:center">
<p style="margin:0 0 8px;font-size:15px;font-weight:600;color:#178a50">LahLahLearn</p>
<h1 style="margin:0 0 12px;font-size:22px">${title}</h1>${body}
<p style="margin:24px 0 0;font-size:13px;color:#5b6b62">If you did not ask for this, you can ignore this email.</p></div></div></body></html>`;
const code = `<p style="margin:0 0 20px;font-size:15px;line-height:1.6">Type this code in LahLahLearn. It works for 1 hour.</p>
<p style="margin:0;font-size:34px;letter-spacing:10px;font-weight:700">{{ .Token }}</p>`;

const cfg = {
  site_url: SITE,
  uri_allow_list: [SITE, SITE.replace(/\/$/, "") + "/**", ...extra].join(","),
  disable_signup: false,
  external_email_enabled: true,
  mailer_autoconfirm: false,
  mailer_otp_exp: 3600,
  mailer_otp_length: 6,
  mailer_secure_email_change_enabled: true,
  security_update_password_require_reauthentication: true,
  mailer_subjects_magic_link: "Your LahLahLearn code: {{ .Token }}",
  mailer_subjects_confirmation: "Your LahLahLearn code: {{ .Token }}",
  mailer_subjects_email_change: "Confirm your new email for LahLahLearn",
  mailer_templates_magic_link_content: box("Your sign-in code", code),
  mailer_templates_confirmation_content: box("Welcome to LahLahLearn", code),
  mailer_templates_email_change_content: box("Confirm your new email", `<p style="font-size:15px;line-height:1.6">Type this code in LahLahLearn to confirm <b>{{ .NewEmail }}</b>.</p><p style="font-size:34px;letter-spacing:10px;font-weight:700">{{ .Token }}</p>`),
  rate_limit_email_sent: 30,
};
if (process.env.RESEND_API_KEY && process.env.EMAIL_FROM) {
  const m = process.env.EMAIL_FROM.match(/^(.*)<(.+)>$/);
  Object.assign(cfg, {
    smtp_host: "smtp.resend.com", smtp_port: "465", smtp_user: "resend", smtp_pass: process.env.RESEND_API_KEY,
    smtp_admin_email: m ? m[2].trim() : process.env.EMAIL_FROM, smtp_sender_name: m ? m[1].trim() : "LahLahLearn",
    smtp_max_frequency: 30,
  });
}
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  Object.assign(cfg, { external_google_enabled: true, external_google_client_id: process.env.GOOGLE_CLIENT_ID, external_google_secret: process.env.GOOGLE_CLIENT_SECRET });
}

const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/config/auth`, {
  method: "PATCH",
  headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
  body: JSON.stringify(cfg),
});
if (!r.ok) { console.error("Supabase said", r.status, await r.text()); process.exit(1); }
console.log("Auth configured:", Object.keys(cfg).filter((k) => !/pass|secret/.test(k)).join(", "));
