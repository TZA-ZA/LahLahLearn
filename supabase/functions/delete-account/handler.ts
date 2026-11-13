// Deleting an account takes two calls, so nobody can wipe a family from an unlocked screen alone:
//   POST { action: "request" }             — emails a 6-digit code to the account's own address (valid 15 minutes)
//   POST { confirm: "DELETE", code: "…" }  — checks the code, then deletes the family (children, progress, notes,
//                                            check-ups), cancels billing and removes the login.
import { esc, HttpError, json, readJson, serveJson } from "../_shared/http.ts";
import { adminClient, requireUser } from "../_shared/clients.ts";
import { layout, sendMail } from "../_shared/email.ts";
import { stripe } from "../_shared/stripe.ts";

const TTL_MIN = 15, MAX_TRIES = 5, RESEND_WAIT_S = 60;

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sixDigits(): string {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(a[0] % 1_000_000).padStart(6, "0");
}
function maskEmail(e: string): string {
  const [u, d] = e.split("@");
  return (u.length <= 2 ? u[0] + "*" : u.slice(0, 2) + "*".repeat(Math.min(6, u.length - 2))) + "@" + d;
}

export const handler = serveJson(async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "Use POST.");
  const { user } = await requireUser(req);
  const b = await readJson<{ action?: string; confirm?: string; code?: string }>(req);
  const admin = adminClient();

  if (b.action === "request") {
    if (!user.email) throw new HttpError(400, "This account has no email address. Please contact us to delete it.");
    const { data: old } = await admin.from("delete_codes").select("created_at").eq("user_id", user.id).maybeSingle();
    if (old && Date.now() - new Date(old.created_at).getTime() < RESEND_WAIT_S * 1000) {
      throw new HttpError(429, "We just sent a code. Please wait a minute before asking for another.");
    }
    const code = sixDigits();
    const { error } = await admin.from("delete_codes").upsert({
      user_id: user.id, code_hash: await sha256(`${user.id}:${code}`), attempts: 0,
      expires_at: new Date(Date.now() + TTL_MIN * 60_000).toISOString(), created_at: new Date().toISOString(),
    });
    if (error) throw new HttpError(500, "We could not start the deletion. Please try again.");
    const { data: fam } = await admin.from("families").select("id").eq("owner_id", user.id).maybeSingle();
    const sent = await sendMail(admin, {
      to: user.email, kind: "delete_code", familyId: fam?.id ?? null,
      subject: `${code} is your code to delete your LahLahLearn account`,
      text: `Someone asked to delete the LahLahLearn account for ${user.email}.\n\nYour code is ${code}. It works for ${TTL_MIN} minutes.\n\nIf this was not you, ignore this email. Nothing will be deleted, and you may want to change your password.`,
      html: layout("Confirm deleting your account",
        `<p>Someone asked to delete the LahLahLearn account for <b>${esc(user.email)}</b>.</p>
         <p style="font-size:30px;letter-spacing:6px;font-weight:600;margin:18px 0">${code}</p>
         <p>Type this code in LahLahLearn to finish. It works for ${TTL_MIN} minutes.</p>
         <p>If this was not you, ignore this email. Nothing will be deleted, and you may want to change your password.</p>`),
    });
    if (!sent.sent) {
      await admin.from("delete_codes").delete().eq("user_id", user.id);
      throw new HttpError(502, "We could not send the email. Please try again later or contact us.");
    }
    return json({ ok: true, sent_to: maskEmail(user.email), minutes: TTL_MIN });
  }

  if (b.confirm !== "DELETE") throw new HttpError(400, "Please confirm the deletion.");
  const code = String(b.code ?? "").replace(/\D/g, "");
  if (code.length !== 6) throw new HttpError(400, "Please type the 6-digit code from the email.");
  const { data: row } = await admin.from("delete_codes").select("code_hash, attempts, expires_at").eq("user_id", user.id).maybeSingle();
  if (!row) throw new HttpError(400, "Please ask for a new code first.");
  if (new Date(row.expires_at).getTime() < Date.now() || row.attempts >= MAX_TRIES) {
    await admin.from("delete_codes").delete().eq("user_id", user.id);
    throw new HttpError(400, "That code has expired. Please ask for a new one.");
  }
  if ((await sha256(`${user.id}:${code}`)) !== row.code_hash) {
    await admin.from("delete_codes").update({ attempts: row.attempts + 1 }).eq("user_id", user.id);
    throw new HttpError(400, "That code is not right. Please check the email and try again.");
  }

  const { data: fam } = await admin.from("families").select("id, stripe_subscription_id, plan_status").eq("owner_id", user.id).maybeSingle();
  if (fam?.stripe_subscription_id && ["active", "trialing", "past_due", "unpaid", "paused"].includes(fam.plan_status)) {
    try { await stripe(`subscriptions/${fam.stripe_subscription_id}`, undefined, "DELETE"); } catch (e) { console.error("cancel failed", e); }
  }
  if (fam) await admin.from("families").delete().eq("id", fam.id);
  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) throw new HttpError(500, "Your data was removed, but the login could not be deleted. Please contact us.");
  return json({ ok: true });
});
