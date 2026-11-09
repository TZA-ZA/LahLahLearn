// Stripe -> database. Deployed without JWT checks; every request must carry a valid Stripe signature.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.117.3";
import { env, json, loadSettings } from "../_shared/http.ts";
import { adminClient } from "../_shared/clients.ts";
import { stripe, verifyStripeSignature } from "../_shared/stripe.ts";

const LIVE = ["active", "trialing", "past_due"];
const STATUSES = ["none", "trialing", "active", "past_due", "canceled", "unpaid", "incomplete", "incomplete_expired", "paused"];

// deno-lint-ignore no-explicit-any
export async function applySubscription(admin: SupabaseClient, sub: any, familyHint?: string | null, deleted = false) {
  let fid: string | null = familyHint ?? sub?.metadata?.family_id ?? null;
  if (!fid && sub?.customer) {
    const { data } = await admin.from("families").select("id").eq("stripe_customer_id", sub.customer).maybeSingle();
    fid = data?.id ?? null;
  }
  if (!fid) { console.warn("subscription without a family", sub?.id); return; }
  const item = sub?.items?.data?.[0];
  const price = item?.price ?? {};
  const m = /^family_([1-3])_(month|year)$/.exec(price.lookup_key ?? "");
  const children = m ? Number(m[1]) : Math.min(3, Math.max(1, Number(sub?.metadata?.children) || 1));
  const cycle = m ? m[2] : price?.recurring?.interval === "year" ? "year" : "month";
  const status = deleted ? "canceled" : (STATUSES.includes(sub.status) ? sub.status : "incomplete");
  const end = sub.current_period_end ?? item?.current_period_end ?? null;
  const live = LIVE.includes(status);
  const { error } = await admin.from("families").update({
    plan: live ? "family" : "free",
    plan_status: status,
    billing_cycle: cycle,
    paid_children: children,
    current_period_end: end ? new Date(end * 1000).toISOString() : null,
    cancel_at_period_end: !!sub.cancel_at_period_end,
    stripe_customer_id: sub.customer ?? undefined,
    stripe_subscription_id: deleted ? null : sub.id,
  }).eq("id", fid);
  if (error) throw error;
}

// deno-lint-ignore no-explicit-any
export async function handleEvent(admin: SupabaseClient, evt: any, fetchSub = (id: string) => stripe(`subscriptions/${id}`)) {
  const o = evt.data?.object ?? {};
  switch (evt.type) {
    case "checkout.session.completed": {
      const fid = o.client_reference_id ?? o.metadata?.family_id ?? null;
      if (o.metadata?.kind === "ai_credits") {
        const n = Math.max(0, Math.min(100000, Number(o.metadata?.credits) || 0));
        if (fid && n && o.payment_status === "paid") {
          const { error } = await admin.rpc("ai_add_bonus", { p_family: fid, p_n: n });
          if (error) throw error;
        }
        break;
      }
      if (fid && o.customer) await admin.from("families").update({ stripe_customer_id: o.customer }).eq("id", fid);
      if (o.subscription) await applySubscription(admin, await fetchSub(o.subscription), fid);
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      await applySubscription(admin, o);
      break;
    case "customer.subscription.deleted":
      await applySubscription(admin, o, null, true);
      break;
    case "invoice.paid": {
      // Renewal went through: re-read the subscription so access and the period end stay current.
      const sid = o.subscription ?? o.parent?.subscription_details?.subscription ?? null;
      if (sid) await applySubscription(admin, await fetchSub(typeof sid === "string" ? sid : sid.id));
      break;
    }
    case "invoice.payment_failed":
      if (o.customer) await admin.from("families").update({ plan_status: "past_due" }).eq("stripe_customer_id", o.customer).in("plan_status", ["active", "trialing"]);
      break;
  }
}

export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("Use POST", { status: 405 });
  await loadSettings();
  const payload = await req.text();
  if (!(await verifyStripeSignature(payload, req.headers.get("stripe-signature"), env("STRIPE_WEBHOOK_SECRET")))) {
    return new Response("Bad signature", { status: 400 });
  }
  const evt = JSON.parse(payload);
  const admin = adminClient();
  const { error: dup } = await admin.from("stripe_events").insert({ id: evt.id, type: evt.type });
  if (dup) {
    if (dup.code === "23505") return json({ received: true, duplicate: true });
    throw dup;
  }
  try {
    await handleEvent(admin, evt);
  } catch (e) {
    await admin.from("stripe_events").delete().eq("id", evt.id); // let Stripe retry
    console.error("webhook failed", evt.type, e);
    return new Response("Failed", { status: 500 });
  }
  return json({ received: true });
}

