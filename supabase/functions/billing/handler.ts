// POST { action: "checkout" | "portal", family_id, children?: 1-3, cycle?: "month" | "year", return_url? }
// Starts Stripe Checkout for a Family plan, or opens the Stripe customer portal to change or cancel.
import { HttpError, json, optionalEnv, readJson, serveJson } from "../_shared/http.ts";
import { adminClient, requireParent, requireUser } from "../_shared/clients.ts";
import { siteUrl } from "../_shared/email.ts";
import { priceKey, stripe } from "../_shared/stripe.ts";

function returnBase(candidate: unknown): string {
  const allowed = [siteUrl(), ...(optionalEnv("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
  if (typeof candidate === "string" && allowed.some((a) => candidate.startsWith(a))) return candidate.split("#")[0];
  return siteUrl();
}

export const handler = serveJson(async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "Use POST.");
  const { user, db } = await requireUser(req);
  const b = await readJson<{ action?: string; family_id?: string; children?: number; cycle?: string; return_url?: string }>(req);
  const fid = await requireParent(db, b.family_id);
  const admin = adminClient();
  const { data: fam, error } = await admin.from("families").select("*").eq("id", fid).single();
  if (error || !fam) throw new HttpError(404, "Family not found.");
  const base = returnBase(b.return_url);

  const live = ["active", "trialing", "past_due"].includes(fam.plan_status) && fam.stripe_subscription_id;
  if (b.action === "portal" || (b.action === "checkout" && live)) {
    if (!fam.stripe_customer_id) throw new HttpError(400, "There is no subscription to manage yet.");
    const portal = await stripe("billing_portal/sessions", { customer: fam.stripe_customer_id, return_url: `${base}#pricing` });
    return json({ url: portal.url, portal: true });
  }
  if (b.action !== "checkout") throw new HttpError(400, "Unknown action.");

  const children = Math.min(3, Math.max(1, Math.round(Number(b.children) || 1)));
  const cycle = b.cycle === "year" ? "year" : "month";
  const key = priceKey(children, cycle);
  const prices = await stripe<{ data: { id: string }[] }>("prices", { "lookup_keys[]": key, active: "true", limit: 1 }, "GET");
  if (!prices.data.length) throw new HttpError(500, "Plans are not set up in Stripe yet. Run scripts/stripe-setup.mjs.");

  let customer = fam.stripe_customer_id as string | null;
  if (!customer) {
    const c = await stripe("customers", { email: user.email, name: fam.name ?? undefined, metadata: { family_id: fid } });
    customer = c.id;
    await admin.from("families").update({ stripe_customer_id: customer }).eq("id", fid);
  }
  const session = await stripe("checkout/sessions", {
    mode: "subscription",
    customer,
    client_reference_id: fid,
    line_items: [{ price: prices.data[0].id, quantity: 1 }],
    allow_promotion_codes: "true",
    success_url: `${base}#billing-success`,
    cancel_url: `${base}#pricing`,
    metadata: { family_id: fid },
    subscription_data: { metadata: { family_id: fid, children: String(children) } },
  });
  return json({ url: session.url });
});

