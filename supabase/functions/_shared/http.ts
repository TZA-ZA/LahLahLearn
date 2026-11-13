// Small HTTP helpers shared by every function.
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// Browsers may only call the functions from our own sites (plus local development).
// Add more with the ALLOWED_ORIGINS secret (comma separated). Calls without an Origin (servers, Stripe, cron) are unaffected.
const SITE_ORIGINS = ["https://lahlahlearn.com", "https://www.lahlahlearn.com", "https://lahlahlearn.netlify.app", "https://tza-za.github.io"];
export function allowedOrigin(req: Request): string {
  const o = req.headers.get("Origin") ?? "";
  const extra = (lookup("ALLOWED_ORIGINS") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (SITE_ORIGINS.includes(o) || extra.includes(o)) return o;
  if (/^https:\/\/[a-z0-9-]+--lahlahlearn\.netlify\.app$/.test(o)) return o; // Netlify deploy previews
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) return o;
  return SITE_ORIGINS[0];
}
function withCors(req: Request, res: Response): Response {
  res.headers.set("Access-Control-Allow-Origin", allowedOrigin(req));
  res.headers.append("Vary", "Origin");
  return res;
}

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://lahlahlearn.com",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

/** Wraps a handler with CORS, OPTIONS handling and friendly error responses. */
export function serveJson(handler: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    if (req.method === "OPTIONS") return withCors(req, new Response("ok", { headers: corsHeaders }));
    await loadSettings();
    try {
      return withCors(req, await handler(req));
    } catch (e) {
      if (e instanceof HttpError) return withCors(req, json({ error: e.message }, e.status));
      console.error(e);
      return withCors(req, json({ error: "Something went wrong. Please try again." }, 500));
    }
  };
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try { return (await req.json()) as T; } catch { throw new HttpError(400, "Expected a JSON body."); }
}

// Settings can come from function secrets (Deno env) or, as a fallback, from Supabase Vault:
// any vault secret named "app.<NAME>" is used as <NAME> when the env var is not set.
// They are read once per cold start through public.get_app_settings() (service role only).
const SETTINGS: Record<string, string> = {};
let loading: Promise<void> | null = null;
export function loadSettings(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key || Deno.env.get("LLL_NO_VAULT")) return;
    try {
      const r = await fetch(`${url}/rest/v1/rpc/get_app_settings`, {
        method: "POST", body: "{}", signal: AbortSignal.timeout(4000),
        headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      });
      if (r.ok) Object.assign(SETTINGS, await r.json());
    } catch (e) { console.warn("settings not loaded", e); }
  })();
  return loading;
}
const lookup = (name: string): string | undefined => {
  const v = Deno.env.get(name);
  return v === undefined || v === "" ? (SETTINGS[name] || undefined) : v;
};

export function env(name: string, fallback?: string): string {
  const v = lookup(name);
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new HttpError(500, `Server is missing the ${name} setting.`);
  }
  return v;
}

export const optionalEnv = (name: string): string | undefined => lookup(name);

export const isEmail = (s: unknown): s is string =>
  typeof s === "string" && s.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
