#!/usr/bin/env node
// One-time Stripe setup for LahLahLearn.
// Creates three Family products (1, 2, 3 children), six MYR prices (1, 2 or 3 children; monthly or yearly) with the
// lookup keys the billing function expects, and the webhook endpoint. Safe to run again:
// anything that already exists is reused.
//
//   STRIPE_SECRET_KEY=sk_test_... SUPABASE_URL=https://xxxx.supabase.co node scripts/stripe-setup.mjs
//
// It prints the webhook signing secret (whsec_...). Save it as the STRIPE_WEBHOOK_SECRET secret.

const KEY = process.env.STRIPE_SECRET_KEY;
const SB = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
if (!KEY || !SB) {
  console.error("Set STRIPE_SECRET_KEY and SUPABASE_URL first.");
  process.exit(1);
}

const PRICES = [
  // [children, cycle, amount in sen]
  [1, "month", 2000], [2, "month", 3500], [3, "month", 4500],
  [1, "year", 20000], [2, "year", 35000], [3, "year", 45000],
];
const EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
];

function form(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === "object") form(v, key, out);
    else if (v !== undefined) out.append(key, String(v));
  }
  return out;
}
async function stripe(method, path, body) {
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    method,
    headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/x-www-form-urlencoded", "Stripe-Version": "2024-06-20" },
    body: body ? form(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${j.error?.message || r.status}`);
  return j;
}

const mode = KEY.startsWith("sk_live") ? "LIVE" : "test";
console.log(`Stripe ${mode} mode`);

// Products: one per child count (the customer portal needs one price per interval per product)
const products = {};
const found = await stripe("GET", "products/search?query=" + encodeURIComponent("metadata['app']:'lahlahlearn' AND active:'true'"));
for (const n of [1, 2, 3]) {
  products[n] = found.data.find((p) => p.metadata?.children === String(n)) || await stripe("POST", "products", {
    name: `LahLahLearn Family · ${n} ${n === 1 ? "child" : "children"}`,
    description: `Everything in LahLahLearn for ${["one", "two", "three"][n - 1]} ${n === 1 ? "child" : "children"}.`,
    metadata: { app: "lahlahlearn", children: n }, tax_code: "txcd_10103001",
  });
  console.log("product", n, products[n].id);
}

// Prices
const keys = PRICES.map(([n, c]) => `family_${n}_${c}`);
const existing = await stripe("GET", "prices?active=true&limit=20&" + keys.map((k) => "lookup_keys[]=" + k).join("&"));
for (const [n, cycle, amount] of PRICES) {
  const key = `family_${n}_${cycle}`;
  const have = existing.data.find((p) => p.lookup_key === key);
  if (have && have.unit_amount === amount && have.currency === "myr" && have.product === products[n].id) { console.log("price", key, have.id, "(exists)"); continue; }
  const p = await stripe("POST", "prices", {
    product: products[n].id, currency: "myr", unit_amount: amount,
    recurring: { interval: cycle }, lookup_key: key, transfer_lookup_key: "true",
    nickname: `${n} ${n === 1 ? "child" : "children"}, ${cycle}ly`,
    metadata: { children: n, cycle },
  });
  console.log("price", key, p.id, "(created)");
}

// Webhook
const url = `${SB}/functions/v1/stripe-webhook`;
const hooks = await stripe("GET", "webhook_endpoints?limit=100");
const hook = hooks.data.find((h) => h.url === url);
if (hook) {
  await stripe("POST", "webhook_endpoints/" + hook.id, { enabled_events: Object.fromEntries(EVENTS.map((e, i) => [i, e])) });
  console.log("webhook", hook.id, "(exists, events updated). Its signing secret is shown in the Stripe dashboard.");
} else {
  const h = await stripe("POST", "webhook_endpoints", {
    url, api_version: "2024-06-20", description: "LahLahLearn billing",
    enabled_events: Object.fromEntries(EVENTS.map((e, i) => [i, e])),
  });
  console.log("webhook", h.id, "(created)");
  console.log("\nSTRIPE_WEBHOOK_SECRET=" + h.secret + "\n");
}

// Customer portal: let families switch between 1, 2 or 3 children and monthly or yearly, and cancel.
const prices = (await stripe("GET", "prices?active=true&limit=20&" + keys.map((k) => "lookup_keys[]=" + k).join("&"))).data;
const cfgs = await stripe("GET", "billing_portal/configurations?is_default=true&limit=1");
const portal = {
  business_profile: { headline: "Manage your LahLahLearn plan" },
  features: {
    customer_update: { enabled: "true", allowed_updates: { 0: "email", 1: "name" } },
    invoice_history: { enabled: "true" },
    payment_method_update: { enabled: "true" },
    subscription_cancel: { enabled: "true", mode: "at_period_end" },
    subscription_update: {
      enabled: "true", default_allowed_updates: { 0: "price" }, proration_behavior: "create_prorations",
      products: Object.fromEntries([1, 2, 3].map((n, i) => [i, { product: products[n].id, prices: Object.fromEntries(prices.filter((p) => p.product === products[n].id).map((p, j) => [j, p.id])) }])),
    },
  },
};
if (cfgs.data[0]) { await stripe("POST", "billing_portal/configurations/" + cfgs.data[0].id, portal); console.log("customer portal updated"); }
else { await stripe("POST", "billing_portal/configurations", portal); console.log("customer portal created"); }

console.log("\nDone.");
