// POST { action: "checkout" | "portal" | "credits", family_id, children?: 1-3, cycle?: "month" | "year", pack?: "s"|"m"|"l", currency?, return_url? }
// Starts Stripe Checkout for a Family plan, or opens the Stripe customer portal to change or cancel.
import { HttpError, json, optionalEnv, readJson, serveJson } from "../_shared/http.ts";
import { adminClient, requireParent, requireUser } from "../_shared/clients.ts";
import { siteUrl } from "../_shared/email.ts";
import { priceKey, stripe } from "../_shared/stripe.ts";

// Currencies set up on every plan price (Stripe currency_options). The family pays in the currency shown to them.
const CURRENCIES = ["myr", "sgd", "usd", "eur", "gbp", "aud", "nzd", "cad", "idr", "thb", "php", "vnd", "inr", "hkd", "jpy", "krw", "cny", "aed"];

// Pip AI credit packs (one-off payments). Amounts in each currency's display units.
export const PACKS: Record<string, { n: number; i: number }> = { s: { n: 500, i: 0 }, m: { n: 2000, i: 1 }, l: { n: 6000, i: 2 } };
export const PACK_PRICE: Record<string, number[]> = { myr: [5, 15, 39], sgd: [1.5, 4.5, 12], usd: [1.25, 3.75, 9.75], eur: [1.25, 3.75, 9.75], gbp: [1, 3, 8], aud: [2, 6, 15], nzd: [2, 6.5, 17], cad: [1.75, 5.25, 13.5], idr: [17000, 52000, 135000], thb: [39, 119, 299], php: [69, 209, 539], vnd: [29000, 89000, 229000], inr: [99, 299, 779], hkd: [9.5, 29, 75], jpy: [179, 529, 1379], krw: [1600, 4800, 12500], cny: [8.5, 25, 65], aed: [4.5, 14, 36] };
const ZERO_DECIMAL = ["jpy", "krw", "vnd"];
export const minorUnits = (cur: string, v: number) => ZERO_DECIMAL.includes(cur) ? Math.round(v) : Math.round(v * 100);

function returnBase(candidate: unknown): string {
  const allowed = [siteUrl(), ...(optionalEnv("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean)];
  if (typeof candidate === "string" && allowed.some((a) => candidate.startsWith(a))) return candidate.split("#")[0];
  return siteUrl();
}

export const handler = serveJson(async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "Use POST.");
  const { user, db } = await requireUser(req);
  const b = await readJson<{ action?: string; family_id?: string; children?: number; cycle?: string; currency?: string; return_url?: string; pack?: string }>(req);
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
  if (b.action === "credits") {
    const pack = PACKS[String((b as { pack?: string }).pack ?? "")];
    if (!pack) throw new HttpError(400, "Unknown credit pack.");
    const cur = typeof b.currency === "string" && PACK_PRICE[b.currency.toLowerCase()] ? b.currency.toLowerCase() : "myr";
    let customer = fam.stripe_customer_id as string | null;
    if (!customer) {
      const c = await stripe("customers", { email: user.email, name: fam.name ?? undefined, metadata: { family_id: fid } });
      customer = c.id;
      await admin.from("families").update({ stripe_customer_id: customer }).eq("id", fid);
    }
    const session = await stripe("checkout/sessions", {
      mode: "payment",
      customer,
      client_reference_id: fid,
      line_items: [{ quantity: 1, price_data: { currency: cur, unit_amount: minorUnits(cur, PACK_PRICE[cur][pack.i]), product_data: { name: `${pack.n.toLocaleString("en")} Pip AI credits` } } }],
      success_url: `${base}#billing-success`,
      cancel_url: `${base}#pricing-credits`,
      metadata: { family_id: fid, kind: "ai_credits", credits: String(pack.n) },
      payment_intent_data: { metadata: { family_id: fid, kind: "ai_credits", credits: String(pack.n) } },
    });
    return json({ url: session.url });
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
  const te = fam.trial_ends_at ? Math.floor(new Date(fam.trial_ends_at).getTime() / 1000) : 0;
  const trialEnd = te > Date.now() / 1000 + 48 * 3600 ? te : 0; // Stripe needs at least 48 hours
  const cur = typeof b.currency === "string" && CURRENCIES.includes(b.currency.toLowerCase()) ? b.currency.toLowerCase() : "myr";
  const params = {
    mode: "subscription",
    customer,
    client_reference_id: fid,
    line_items: [{ price: prices.data[0].id, quantity: 1 }],
    allow_promotion_codes: "true",
    success_url: `${base}#billing-success`,
    cancel_url: `${base}#pricing`,
    metadata: { family_id: fid },
    subscription_data: {
      metadata: { family_id: fid, children: String(children) },
      // Someone who subscribes during the free week keeps the rest of it: the first charge waits until it ends.
      ...(trialEnd ? { trial_end: trialEnd } : {}),
    },
  };
  let session;
  try {
    session = await stripe("checkout/sessions", { ...params, currency: cur });
  } catch (e) {
    // A customer who already paid in another currency must keep it: fall back to the price's default.
    if (cur === "myr") throw e;
    console.warn("checkout in", cur, "failed, using the default currency", e);
    session = await stripe("checkout/sessions", params);
  }
  return json({ url: session.url });
});

