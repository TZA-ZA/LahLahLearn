#!/usr/bin/env node
// One-time Stripe setup for LahLahLearn.
// Creates the plan products (Family with Pip AI, and Essentials without it; 1, 2, 3 children each), their MYR prices
// (monthly or yearly) with the lookup keys the billing function expects (family_<n>_<cycle>, learn_<n>_<cycle>),
// and the webhook endpoint. Prices match CUR_P / CUR_L in index.html. Safe to run again:
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

// Essentials: a base price plus optional extras. Must match ESS_BASE / ESS_X / ESS_KIDS / essNice in index.html.
const ESS_BASE = 25, ESS_KIDS = [1, 1.75, 2.25];
const ADDONS = { world: ["3D World", 8], care: ["Care Circle", 8], reports: ["Weekly reports", 5], checkups: ["Check-ups", 5], ai: ["Pip AI", 15] };
const BIG = ["jpy", "krw", "vnd", "idr"];
const essNice = (c, v) => (BIG.includes(c) || v >= 1000) ? (v >= 10000 ? Math.round(v / 500) * 500 : Math.round(v / 10) * 10) : Math.round(v);
const essMyr = (myr) => ESS_KIDS.map((k) => essNice("myr", myr * k));
const FAMILY_LOCAL = {"sgd": [18, 30, 39], "usd": [15, 24, 30], "eur": [15, 24, 30], "gbp": [12, 21, 27], "aud": [21, 36, 45], "nzd": [24, 39, 51], "cad": [21, 33, 42], "idr": [205000, 355000, 445000], "thb": [479, 839, 1049], "php": [839, 1439, 1859], "vnd": [355000, 625000, 805000], "inr": [1199, 2099, 2699], "hkd": [117, 207, 255], "jpy": [2099, 3599, 4499], "krw": [20000, 33000, 44000], "cny": [105, 177, 237], "aed": [57, 96, 126]};
const essLocal = (myr) => Object.fromEntries(Object.entries(FAMILY_LOCAL).map(([c, v]) => [c, ESS_KIDS.map((k) => essNice(c, myr * v[0] / 60 * k))]));
const TIERS = {
  family: { name: "Family", desc: "Everything in LahLahLearn, with Pip AI", myr: [60, 105, 135], local: FAMILY_LOCAL },
  learn: { name: "Essentials", desc: "Every lesson, game and story (extras added separately)", myr: essMyr(ESS_BASE), local: essLocal(ESS_BASE) },
};
// [tier, children, cycle, amount in sen]. Yearly = 10 months.
const PRICES = Object.keys(TIERS).flatMap((t) => [1, 2, 3].flatMap((n) => ["month", "year"].map((c) => [t, n, c, TIERS[t].myr[n - 1] * 100 * (c === "year" ? 10 : 1)])));
const ZERO_DECIMAL = ["jpy", "krw", "vnd"];
const localOptions = (tier, n, cycle) => Object.fromEntries(Object.entries(TIERS[tier].local).map(([c, v]) => {
  const a = v[n - 1] * (cycle === "year" ? 10 : 1);
  return [c, { unit_amount: ZERO_DECIMAL.includes(c) ? a : a * 100 }];
}));
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

// Products: one per tier and child count (the customer portal needs one price per interval per product)
const products = {};
const found = await stripe("GET", "products/search?limit=100&query=" + encodeURIComponent("metadata['app']:'lahlahlearn' AND active:'true'"));
for (const tier of Object.keys(TIERS)) for (const n of [1, 2, 3]) {
  const id = `${tier}_${n}`;
  products[id] = found.data.find((p) => p.metadata?.children === String(n) && (p.metadata?.tier || "family") === tier) || await stripe("POST", "products", {
    name: `LahLahLearn ${TIERS[tier].name} · ${n} ${n === 1 ? "child" : "children"}`,
    description: `${TIERS[tier].desc}, for ${["one", "two", "three"][n - 1]} ${n === 1 ? "child" : "children"}.`,
    metadata: { app: "lahlahlearn", children: n, tier }, tax_code: "txcd_10103001",
  });
  console.log("product", id, products[id].id);
}

// Prices
const keys = PRICES.map(([t, n, c]) => `${t}_${n}_${c}`);
const listPrices = async () => (await Promise.all([keys.slice(0, 10), keys.slice(10)].map((ks) => stripe("GET", "prices?active=true&limit=20&" + ks.map((k) => "lookup_keys[]=" + k).join("&"))))).flatMap((r) => r.data);
const existing = await listPrices();
for (const [tier, n, cycle, amount] of PRICES) {
  const key = `${tier}_${n}_${cycle}`, prod = products[`${tier}_${n}`];
  const have = existing.find((p) => p.lookup_key === key);
  if (have && have.unit_amount === amount && have.currency === "myr" && have.product === prod.id) {
    await stripe("POST", "prices/" + have.id, { currency_options: localOptions(tier, n, cycle) });
    console.log("price", key, have.id, "(exists, local currencies updated)"); continue;
  }
  const p = await stripe("POST", "prices", {
    product: prod.id, currency: "myr", unit_amount: amount,
    recurring: { interval: cycle }, lookup_key: key, transfer_lookup_key: "true",
    currency_options: localOptions(tier, n, cycle),
    nickname: `${TIERS[tier].name}, ${n} ${n === 1 ? "child" : "children"}, ${cycle}ly`,
    metadata: { children: n, cycle, tier },
  });
  console.log("price", key, p.id, "(created)");
}

// Essentials extras: one product each, one price per child count and cycle (lookup key addon_<k>_<n>_<cycle>)
const addKeys = Object.keys(ADDONS).flatMap((k) => [1, 2, 3].flatMap((n) => ["month", "year"].map((c) => `addon_${k}_${n}_${c}`)));
const haveAdd = [];
for (let i = 0; i < addKeys.length; i += 10) haveAdd.push(...(await stripe("GET", "prices?active=true&limit=10&" + addKeys.slice(i, i + 10).map((k) => "lookup_keys[]=" + k).join("&"))).data);
for (const [k, [label, myr]] of Object.entries(ADDONS)) {
  const prod = found.data.find((p) => p.metadata?.addon === k) || await stripe("POST", "products", {
    name: `LahLahLearn Essentials extra · ${label}`, metadata: { app: "lahlahlearn", addon: k }, tax_code: "txcd_10103001",
  });
  const local = essLocal(myr), base = essMyr(myr);
  for (const n of [1, 2, 3]) for (const cycle of ["month", "year"]) {
    const key = `addon_${k}_${n}_${cycle}`, mult = cycle === "year" ? 10 : 1, amount = base[n - 1] * 100 * mult;
    const opts = Object.fromEntries(Object.entries(local).map(([c, v]) => [c, { unit_amount: (ZERO_DECIMAL.includes(c) ? 1 : 100) * v[n - 1] * mult }]));
    const have = haveAdd.find((p) => p.lookup_key === key);
    if (have && have.unit_amount === amount && have.product === prod.id) { await stripe("POST", "prices/" + have.id, { currency_options: opts }); console.log("price", key, "(exists)"); continue; }
    const p = await stripe("POST", "prices", { product: prod.id, currency: "myr", unit_amount: amount, recurring: { interval: cycle }, lookup_key: key, transfer_lookup_key: "true", currency_options: opts, nickname: `${label}, ${n} ${n === 1 ? "child" : "children"}, ${cycle}ly`, metadata: { addon: k, children: n, cycle } });
    console.log("price", key, p.id, "(created)");
  }
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
const prices = await listPrices();
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
      products: Object.fromEntries(Object.values(products).map((pr, i) => [i, { product: pr.id, prices: Object.fromEntries(prices.filter((p) => p.product === pr.id).map((p, j) => [j, p.id])) }])),
    },
  },
};
if (cfgs.data[0]) { await stripe("POST", "billing_portal/configurations/" + cfgs.data[0].id, portal); console.log("customer portal updated"); }
else { await stripe("POST", "billing_portal/configurations", portal); console.log("customer portal created"); }

console.log("\nDone.");
