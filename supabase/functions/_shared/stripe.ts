// Minimal Stripe REST client (no SDK needed) + webhook signature check.
import { env, HttpError } from "./http.ts";

const API = "https://api.stripe.com/v1/";
export const STRIPE_VERSION = "2024-06-20";

function encode(params: Record<string, unknown>, prefix = "", out: string[] = []): string[] {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => typeof item === "object" ? encode(item as Record<string, unknown>, `${key}[${i}]`, out) : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`));
    else if (typeof v === "object") encode(v as Record<string, unknown>, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

export async function stripe<T = any>(path: string, params?: Record<string, unknown>, method: "GET" | "POST" | "DELETE" = params ? "POST" : "GET"): Promise<T> {
  const body = params ? encode(params).join("&") : undefined;
  const url = method === "GET" && body ? `${API}${path}?${body}` : `${API}${path}`;
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${env("STRIPE_SECRET_KEY")}`, "Content-Type": "application/x-www-form-urlencoded", "Stripe-Version": STRIPE_VERSION },
    body: method === "GET" ? undefined : body,
  });
  const data = await r.json();
  if (!r.ok) {
    console.error("stripe", path, data?.error?.message);
    throw new HttpError(502, data?.error?.message ?? "Payment service error.");
  }
  return data as T;
}

export const priceKey = (children: number, cycle: "month" | "year") => `family_${children}_${cycle}`;

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Verifies the Stripe-Signature header (v1, HMAC-SHA256). */
export async function verifyStripeSignature(payload: string, header: string | null, secret: string, toleranceSec = 300, now = Date.now()): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]).filter((p) => p.length === 2).map(([k, v]) => [k, v]));
  const sigs = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length) return false;
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  return sigs.some((s) => safeEqual(s, mac));
}
