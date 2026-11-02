// Local stand-in for a Supabase project, for tests only.
//   /rest/v1/*      -> PostgREST (real, against the real migration)
//   /auth/v1/*      -> a tiny fake auth server (email + 6-digit code "123456", JWTs signed with the test secret)
//   /functions/v1/* -> our real edge function handlers, in-process
// Outbound calls to Stripe, Resend and Anthropic are intercepted and recorded at GET /__calls.
import postgres from "npm:postgres@3.4.4";

const PORT = Number(Deno.env.get("GW_PORT") ?? 54321);
const PGREST = Deno.env.get("PGREST_URL") ?? "http://127.0.0.1:3010";
const SECRET = Deno.env.get("JWT_SECRET") ?? "test-secret-test-secret-test-secret-123";
const sql = postgres(Deno.env.get("DB_URL") ?? "postgres://postgres@localhost:54329/lll_e2e", { host: "/tmp", max: 3 });

const b64u = (b: Uint8Array | string) => btoa(typeof b === "string" ? b : String.fromCharCode(...b)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
export async function sign(payload: Record<string, unknown>) {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" })), body = b64u(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64u(sig)}`;
}
async function verify(tok: string) {
  const [h, b, s] = tok.split(".");
  if (!s) return null;
  const sig = Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  if (!(await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(`${h}.${b}`)))) return null;
  const p = JSON.parse(atob(b.replace(/-/g, "+").replace(/_/g, "/")));
  return p.exp && p.exp * 1000 < Date.now() ? null : p;
}

const ANON = await sign({ role: "anon", iss: "supabase", exp: 4102444800 });
const SERVICE = await sign({ role: "service_role", iss: "supabase", exp: 4102444800 });

// edge function environment
const SITE = Deno.env.get("SITE_URL") ?? "http://127.0.0.1:8768/";
Object.entries({
  SUPABASE_URL: `http://127.0.0.1:${PORT}`, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE,
  SITE_URL: SITE, STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", RESEND_API_KEY: "re_test",
  EMAIL_FROM: "LahLahLearn <hello@lahlahlearn.test>", ANTHROPIC_API_KEY: "sk-ant-test", CRON_SECRET: "cron-test",
  ADMIN_EMAILS: "admin@lahlahlearn.test", AI_DAILY_LIMIT: "3",
}).forEach(([k, v]) => Deno.env.set(k, v));

// ---- outbound mocks
const calls: { url: string; method: string; body: string }[] = [];
const realFetch = globalThis.fetch;
const subs: Record<string, any> = {};
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? init.body : "";
  const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
  if (url.startsWith("https://api.stripe.com/")) {
    calls.push({ url, method, body });
    const path = url.slice("https://api.stripe.com/v1/".length).split("?")[0];
    if (path === "prices") return J({ data: [{ id: "price_" + (decodeURIComponent(url).match(/lookup_keys\[\]=([^&]+)/)?.[1] ?? "x") }] });
    if (path === "customers") return J({ id: "cus_test1" });
    if (path === "checkout/sessions") return J({ id: "cs_test1", url: "https://checkout.stripe.test/cs_test1" });
    if (path === "billing_portal/sessions") return J({ id: "bps_1", url: "https://billing.stripe.test/p/1" });
    if (path.startsWith("subscriptions/")) return J(subs[path.split("/")[1]] ?? { id: path.split("/")[1], status: "canceled" });
    return J({ error: { message: "unmocked " + path } }, 400);
  }
  if (url.startsWith("https://api.resend.com/")) { calls.push({ url, method, body }); return J({ id: "email_" + calls.length }); }
  if (url.startsWith("https://api.anthropic.com/")) {
    calls.push({ url, method, body });
    return J({ content: [{ type: "text", text: "Hello! Trains are fun. What colour is your train?" }] });
  }
  return realFetch(input as any, init);
};

// ---- functions
const fnNames = ["invite", "billing", "stripe-webhook", "weekly-report", "checkup", "pip-chat", "admin-stats", "delete-account"];
const fns: Record<string, (r: Request) => Promise<Response>> = {};
for (const n of fnNames) fns[n] = (await import(`../../functions/${n}/handler.ts`)).handler;

// ---- fake auth
const codes: Record<string, string> = {};
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS", "Access-Control-Expose-Headers": "*" };
const J = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "content-type": "application/json" } });
const userObj = (u: any) => ({ id: u.id, email: u.email, aud: "authenticated", role: "authenticated", app_metadata: { provider: "email" }, user_metadata: u.raw_user_meta_data ?? {}, created_at: u.created_at });
async function session(u: any) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const access_token = await sign({ sub: u.id, email: u.email, role: "authenticated", aud: "authenticated", exp });
  return { access_token, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "r_" + u.id, user: userObj(u) };
}

const passwords: Record<string, string> = {}; // email -> password (test only)
const confirmed = new Set<string>();
async function authRoute(req: Request, path: string): Promise<Response> {
  if (path === "/signup" && req.method === "POST") {
    const b = await req.json(); const email = String(b.email).toLowerCase();
    if (String(b.password ?? "").length < 6) return J({ code: 422, error_code: "weak_password", msg: "Password should be at least 6 characters." }, 422);
    const [ex] = await sql`select * from auth.users where email=${email}`;
    if (ex && passwords[email]) return J({ ...userObj(ex), identities: [] }); // like Supabase: existing email, no new identity
    const [u] = ex ? [ex] : await sql`insert into auth.users(email, raw_user_meta_data) values (${email}, ${sql.json(b.data ?? {})}) returning *`;
    passwords[email] = b.password; codes[email] = "123456";
    return J({ ...userObj(u), identities: [{ provider: "email" }] });
  }
  if (path === "/resend" && req.method === "POST") { const b = await req.json(); codes[String(b.email).toLowerCase()] = "123456"; return J({}); }
  if (path.startsWith("/token") && new URL(req.url).searchParams.get("grant_type") === "password") {
    const b = await req.json(); const email = String(b.email).toLowerCase();
    if (!passwords[email] || passwords[email] !== b.password) return J({ code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" }, 400);
    if (!confirmed.has(email)) return J({ code: 400, error_code: "email_not_confirmed", msg: "Email not confirmed" }, 400);
    const [u] = await sql`select * from auth.users where email=${email}`;
    return J(await session(u));
  }
  if (path === "/otp" && req.method === "POST") {
    const b = await req.json(); const email = String(b.email).toLowerCase();
    codes[email] = "123456";
    if (!(await sql`select 1 from auth.users where email=${email}`).length) {
      if (b.create_user === false) return J({ msg: "Signups not allowed for otp", error_code: "otp_disabled" }, 422);
      await sql`insert into auth.users(email, raw_user_meta_data) values (${email}, ${sql.json(b.data ?? {})})`;
    }
    return J({});
  }
  if (path === "/verify" && req.method === "POST") {
    const b = await req.json(); const email = String(b.email ?? "").toLowerCase();
    if (codes[email] !== b.token) return J({ code: 403, error_code: "otp_expired", msg: "Token has expired or is invalid" }, 403);
    confirmed.add(email);
    const [u] = await sql`select * from auth.users where email=${email}`;
    return J(await session(u));
  }
  if (path === "/token") {
    const b = await req.json();
    const id = String(b.refresh_token ?? "").replace(/^r_/, "");
    const [u] = await sql`select * from auth.users where id=${id}::uuid`;
    return u ? J(await session(u)) : J({ msg: "Invalid Refresh Token" }, 400);
  }
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  const claims = await verify(bearer);
  if (path === "/user" && req.method === "GET") {
    if (!claims?.sub) return J({ msg: "invalid JWT" }, 401);
    const [u] = await sql`select * from auth.users where id=${claims.sub}::uuid`;
    return u ? J(userObj(u)) : J({ msg: "User not found" }, 404);
  }
  if (path === "/user" && req.method === "PUT") {
    if (!claims?.sub) return J({ msg: "invalid JWT" }, 401);
    const b = await req.json(); const [u] = await sql`select * from auth.users where id=${claims.sub}::uuid`;
    if (b.password) { if (passwords[u.email] === b.password) return J({ code: 422, error_code: "same_password", msg: "New password should be different from the old password." }, 422); passwords[u.email] = b.password; }
    return J(userObj(u));
  }
  if (path === "/logout") return new Response(null, { status: 204, headers: cors });
  const m = path.match(/^\/admin\/users\/([0-9a-f-]{36})$/);
  if (m && req.method === "DELETE") {
    if (claims?.role !== "service_role") return J({ msg: "forbidden" }, 403);
    await sql`delete from auth.users where id=${m[1]}::uuid`;
    return J({});
  }
  return J({ msg: "not implemented " + path }, 404);
}

Deno.serve({ port: PORT, onListen: () => console.log(`gateway on ${PORT}`) }, async (req) => {
  const u = new URL(req.url);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (u.pathname === "/__keys") return J({ anon: ANON, service: SERVICE });
  if (u.pathname === "/__calls") return J(calls);
  if (u.pathname === "/__reset_calls") { calls.length = 0; return J({}); }
  if (u.pathname === "/__sign") return J({ token: await sign(await req.json()) });
  if (u.pathname === "/__sub" && req.method === "POST") { const s = await req.json(); subs[s.id] = s; return J({}); }
  if (u.pathname.startsWith("/auth/v1")) return authRoute(req, u.pathname.slice(8));
  if (u.pathname.startsWith("/functions/v1/")) {
    const name = u.pathname.slice(14).split("/")[0];
    const fn = fns[name];
    if (!fn) return J({ msg: "no function" }, 404);
    const r = await fn(req);
    const h = new Headers(r.headers); Object.entries(cors).forEach(([k, v]) => h.set(k, v));
    return new Response(r.body, { status: r.status, headers: h });
  }
  if (u.pathname.startsWith("/rest/v1")) {
    const target = PGREST + u.pathname.slice(8) + u.search;
    const h = new Headers(req.headers); h.delete("host");
    const r = await realFetch(target, { method: req.method, headers: h, body: ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer() });
    const rh = new Headers(r.headers); Object.entries(cors).forEach(([k, v]) => rh.set(k, v)); rh.delete("content-encoding");
    const buf = await r.arrayBuffer();
    return new Response([204, 304].includes(r.status) ? null : buf, { status: r.status, headers: rh });
  }
  return J({ msg: "not found" }, 404);
});
