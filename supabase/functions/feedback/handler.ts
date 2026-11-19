// POST { kind, name?, email?, message, page?, bot-field? } -> { ok }
// The feedback form on the Community page. Anyone can send (no login). Saved in public.feedback and emailed to the team.
import { HttpError, isEmail, json, optionalEnv, readJson, serveJson } from "../_shared/http.ts";
import { adminClient } from "../_shared/clients.ts";
import { layout, sendMail } from "../_shared/email.ts";
import { esc } from "../_shared/http.ts";

const KINDS = ["idea", "problem", "praise", "other"];

export const handler = serveJson(async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "Use POST.");
  const b = await readJson<Record<string, unknown>>(req);
  if (b["bot-field"]) return json({ ok: true }); // a bot filled the hidden field
  const message = String(b.message ?? "").trim().slice(0, 2000);
  if (message.length < 2) throw new HttpError(400, "Please write a message.");
  const kind = KINDS.includes(String(b.kind)) ? String(b.kind) : "other";
  const name = String(b.name ?? "").trim().slice(0, 60);
  const email = String(b.email ?? "").trim().slice(0, 120);
  if (email && !isEmail(email)) throw new HttpError(400, "Please check the email address.");
  const page = String(b.page ?? "").slice(0, 200);
  const admin = adminClient();

  // at most 5 messages in 10 minutes from one address (stored as a one-way hash, never the address itself)
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const ipHash = ip ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("lll:" + ip)))).slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("") : null;
  if (ipHash) {
    const { count } = await admin.from("feedback").select("id", { count: "exact", head: true }).eq("ip_hash", ipHash).gte("created_at", new Date(Date.now() - 600000).toISOString());
    if ((count ?? 0) >= 5) throw new HttpError(429, "Thank you! That is a lot of messages. Please try again in a few minutes.");
  }
  const { error } = await admin.from("feedback").insert({ kind, name: name || null, email: email || null, message, page: page || null, ip_hash: ipHash });
  if (error) { console.error(error); throw new HttpError(500, "Could not save your feedback. Please try again."); }

  const to = optionalEnv("FEEDBACK_TO") ?? optionalEnv("SMTP_USER") ?? "lahlahlearn@gmail.com";
  const label = kind[0].toUpperCase() + kind.slice(1);
  await sendMail(admin, {
    to, kind: "feedback", replyTo: email || undefined,
    subject: `Feedback (${label})${name ? " from " + name : ""}`,
    html: layout(`New feedback: ${label}`, `<p style="white-space:pre-wrap;margin:0 0 14px">${esc(message)}</p><p style="margin:0;color:#6c746d;font-size:13px">From: ${esc(name || "Someone")} ${email ? "&lt;" + esc(email) + "&gt;" : "(no email)"}<br>Page: ${esc(page)}</p>`),
    text: `${label}\n\n${message}\n\nFrom: ${name || "Someone"} ${email}\nPage: ${page}`,
  }).catch((e) => console.error("feedback mail", e));
  return json({ ok: true });
});
