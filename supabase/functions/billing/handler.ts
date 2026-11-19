// POST { action: "checkout" | "portal" | "credits" | "features", family_id, features?: string[] (Essentials add-ons), children?: 1-3, cycle?: "month" | "year", tier?: "family" | "learn", pack?: "s"|"m"|"l", currency?, return_url? }
// Starts Stripe Checkout for a Family plan, or opens the Stripe customer portal to change or cancel.
import { HttpError, json, optionalEnv, readJson, serveJson } from "../_shared/http.ts";
import { adminClient, requireParent, requireUser } from "../_shared/clients.ts";
import { siteUrl } from "../_shared/email.ts";
import { addonKey, FEATURES, priceKey, stripe } from "../_shared/stripe.ts";

// Currencies set up on every plan price (Stripe currency_options). The family pays in the currency shown to them.
const CURRENCIES = ["myr", "sgd", "usd", "eur", "gbp", "aud", "nzd", "cad", "idr", "thb", "php", "vnd", "inr", "hkd", "jpy", "krw", "cny", "aed"];

// Pip AI credit packs (one-off payments). Amounts in each currency's display units.
export const PACKS: Record<string, { n: number; i: number }> = { s: { n: 500, i: 0 }, m: { n: 2000, i: 1 }, l: { n: 6000, i: 2 } };
export const PACK_PRICE: Record<string, number[]> = { myr: [49, 179, 499], sgd: [14.5, 54, 154], usd: [12.0, 45, 125], eur: [12.0, 45, 125], gbp: [10.0, 36, 102], aud: [19.5, 72, 192], nzd: [19.5, 78, 218], cad: [17.0, 63, 173], idr: [167000, 620000, 1725000], thb: [379, 1419, 3829], php: [679, 2489, 6899], vnd: [285000, 1060000, 2930000], inr: [969, 3569, 9969], hkd: [93, 346, 960], jpy: [1749, 6309, 17639], krw: [16000, 57000, 160000], cny: [83, 298, 832], aed: [44, 167, 461] };
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
  const b = await readJson<{ action?: string; family_id?: string; children?: number; cycle?: string; tier?: string; features?: string[]; currency?: string; return_url?: string; pack?: string }>(req);
  const fid = await requireParent(db, b.family_id);
  const admin = adminClient();
  const { data: fam, error } = await admin.from("families").select("*").eq("id", fid).single();
  if (error || !fam) throw new HttpError(404, "Family not found.");
  const base = returnBase(b.return_url);

  const live = ["active", "trialing", "past_due"].includes(fam.plan_status) && fam.stripe_subscription_id;
  const wantFeatures = (Array.isArray(b.features) ? b.features : []).filter((f): f is string => (FEATURES as readonly string[]).includes(f));
  const lookup = async (keys: string[]) => {
    const r = await stripe<{ data: { id: string; lookup_key: string }[] }>("prices", { lookup_keys: keys, active: "true", limit: 10 }, "GET");
    const miss = keys.filter((k) => !r.data.some((p) => p.lookup_key === k));
    if (miss.length) throw new HttpError(500, "Plans are not set up in Stripe yet. Run scripts/stripe-setup.mjs.");
    return Object.fromEntries(r.data.map((p) => [p.lookup_key, p.id]));
  };

  // Essentials families switch add-ons on or off without a new checkout: change the lines on their subscription.
  if (b.action === "features") {
    if (!live || fam.plan !== "learn") throw new HttpError(400, "Choose Essentials first.");
    // deno-lint-ignore no-explicit-any
    const sub = await stripe<any>(`subscriptions/${fam.stripe_subscription_id}`, undefined, "GET");
    const m = /^learn_([1-3])_(month|year)$/.exec(sub.items.data.map((i: { price: { lookup_key: string } }) => i.price.lookup_key).find((k: string) => /^learn_/.test(k ?? "")) ?? "");
    if (!m) throw new HttpError(400, "This subscription is not Essentials.");
    const n = Number(m[1]), cyc = m[2] as "month" | "year";
    const want = wantFeatures.map((f) => addonKey(f, n, cyc));
    const ids = want.length ? await lookup(want) : {};
    const items: Record<string, unknown>[] = [];
    for (const it of sub.items.data) if (/^addon_/.test(it.price.lookup_key ?? "") && !want.includes(it.price.lookup_key)) items.push({ id: it.id, deleted: "true" });
    for (const k of want) if (!sub.items.data.some((it: { price: { lookup_key: string } }) => it.price.lookup_key === k)) items.push({ price: ids[k], quantity: 1 });
    if (items.length) await stripe(`subscriptions/${sub.id}`, { items, proration_behavior: "create_prorations" });
    await admin.from("families").update({ features: Object.fromEntries(wantFeatures.map((f) => [f, true])) }).eq("id", fid);
    return json({ ok: true });
  }
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
  const tier = b.tier === "learn" ? "learn" : "family";
  const key = priceKey(children, cycle, tier);
  const addKeys = tier === "learn" ? wantFeatures.map((f) => addonKey(f, children, cycle)) : [];
  const ids = await lookup([key, ...addKeys]);

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
    line_items: [key, ...addKeys].map((k) => ({ price: ids[k], quantity: 1 })),
    allow_promotion_codes: "true",
    success_url: `${base}#billing-success`,
    cancel_url: `${base}#pricing`,
    metadata: { family_id: fid },
    subscription_data: {
      metadata: { family_id: fid, children: String(children), tier, features: wantFeatures.join(",") },
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

