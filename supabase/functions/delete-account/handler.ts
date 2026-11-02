// POST { confirm: "DELETE" } — deletes the caller's family (children, progress, notes, check-ups), cancels billing, removes the login.
import { HttpError, json, readJson, serveJson } from "../_shared/http.ts";
import { adminClient, requireUser } from "../_shared/clients.ts";
import { stripe } from "../_shared/stripe.ts";

export const handler = serveJson(async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "Use POST.");
  const { user } = await requireUser(req);
  const b = await readJson<{ confirm?: string }>(req);
  if (b.confirm !== "DELETE") throw new HttpError(400, "Please confirm the deletion.");
  const admin = adminClient();
  const { data: fam } = await admin.from("families").select("id, stripe_subscription_id, plan_status").eq("owner_id", user.id).maybeSingle();
  if (fam?.stripe_subscription_id && ["active", "trialing", "past_due", "unpaid", "paused"].includes(fam.plan_status)) {
    try { await stripe(`subscriptions/${fam.stripe_subscription_id}`, undefined, "DELETE"); } catch (e) { console.error("cancel failed", e); }
  }
  if (fam) await admin.from("families").delete().eq("id", fam.id);
  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) throw new HttpError(500, "Your data was removed, but the login could not be deleted. Please contact us.");
  return json({ ok: true });
});

