// End-to-end tests for the edge functions against the local stack (supabase/tests/local/start.sh).
// Run: node supabase/tests/functions.test.mjs   (needs @supabase/supabase-js installed; see supabase/tests/package.json)
import { createClient } from "@supabase/supabase-js";
import crypto from "node:crypto";

const URL = process.env.GW ?? "http://127.0.0.1:54321";
const { anon } = await (await fetch(`${URL}/__keys`)).json();
let ok = 0, fail = 0;
const check = (name, cond, extra) => { if (cond) ok++; else { fail++; console.log("FAIL:", name, extra ?? ""); } };
const calls = async () => (await fetch(`${URL}/__calls`)).json();
const resetCalls = () => fetch(`${URL}/__reset_calls`);

async function login(email) {
  const sb = createClient(URL, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  const { data, error } = await sb.auth.verifyOtp({ email, token: "123456", type: "email" });
  if (error) throw error;
  return { sb, user: data.user };
}
const invoke = async (sb, name, body, headers) => {
  const { data, error } = await sb.functions.invoke(name, { body, headers });
  let status = 200, msg = null;
  if (error) { status = error.context?.status ?? 500; try { msg = (await error.context.json()).error; } catch { msg = error.message; } }
  return { data, status, msg };
};
const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });

// ---- parent sets up family
const A = await login("amina@example.com");
const { data: fam } = await A.sb.rpc("ensure_family", { p_name: "Amina's family", p_display_name: "Amina" });
check("family created", typeof fam === "string");
await A.sb.from("children").insert({ id: "kAisha1", family_id: fam, profile: { name: "Aisha", interests: ["trains"] } });
await A.sb.from("progress").upsert({ child_id: "kAisha1", family_id: fam, data: { mins: { [today]: 600 }, days: [today], lessons: 4, mastery: { read: 60, num: 40 }, st: { read: [6, 5], num: [7, 3] }, calm: 2 } });
const { error: repErr } = await A.sb.from("families").update({ report_email: "amina@example.com", report_auto: true }).eq("id", fam);
check("parent updates report settings", !repErr, repErr);

// ---- invites
await resetCalls();
let r = await invoke(A.sb, "invite", { family_id: fam, email: "Teacher@School.my", name: "Ms Lim", role: "teacher" });
check("invite created", r.status === 200 && r.data.ok && r.data.emailed, r);
const tToken = r.data?.link?.split("#join-")[1];
let c = await calls();
const mail = c.find((x) => x.url.includes("resend"));
check("invite emailed to the teacher", mail && JSON.parse(mail.body).to[0] === "teacher@school.my");
check("invite email has the accept link", mail && JSON.parse(mail.body).html.includes(`#join-${tToken}`));
r = await invoke(A.sb, "invite", { family_id: fam, email: "amina@example.com", role: "teacher" });
check("cannot invite yourself", r.status === 400);
r = await invoke(A.sb, "invite", { family_id: fam, email: "not-an-email", role: "teacher" });
check("bad email refused", r.status === 400);

const T = await login("teacher@school.my");
r = await invoke(T.sb, "invite", { family_id: fam, email: "x@y.com", role: "teacher" });
check("non-member cannot invite", r.status === 403);
const acc = await T.sb.rpc("accept_invite", { p_token: tToken, p_display_name: "Ms Lim" });
check("teacher accepts invite", acc.data?.ok === true, acc);
r = await invoke(A.sb, "invite", { family_id: fam, email: "teacher@school.my", role: "teacher" });
check("cannot invite an existing member", r.status === 409);
r = await invoke(T.sb, "invite", { family_id: fam, email: "x@y.com", role: "teacher" });
check("teacher cannot invite", r.status === 403);
const { data: tk } = await T.sb.from("children").select("id");
check("teacher sees the child", tk?.length === 1);

r = await invoke(A.sb, "invite", { family_id: fam, email: "therapist@clinic.my", name: "Dr Raj", role: "therapist" });
const R = await login("therapist@clinic.my");
await R.sb.rpc("accept_invite", { p_token: r.data.link.split("#join-")[1], p_display_name: "Dr Raj" });
await R.sb.from("family_members").update({ availability: ["Mon 09:00"] }).eq("family_id", fam).eq("user_id", R.user.id);

// ---- check-ups
const when = new Date(Date.now() + 3 * 864e5).toISOString();
const { data: appt, error: apErr } = await A.sb.from("appointments").insert({ child_id: "kAisha1", family_id: fam, starts_at: when, therapist_user_id: R.user.id, therapist_name: "Dr Raj", booked_by_name: "Amina", mode: "online" }).select().single();
check("parent books a check-up", !apErr && appt, apErr);
await resetCalls();
r = await invoke(A.sb, "checkup", { appointment_id: appt.id, action: "booked" });
c = await calls();
const cm = c.find((x) => x.url.includes("resend")); const cb = cm && JSON.parse(cm.body);
check("check-up email sent", r.status === 200 && r.data.emailed, r);
check("therapist and parent both get it", cb && cb.to.includes("therapist@clinic.my") && cb.to.includes("amina@example.com"), cb?.to);
check("calendar file attached", cb && cb.attachments?.[0]?.filename === "check-up.ics" && Buffer.from(cb.attachments[0].content, "base64").toString().includes("BEGIN:VEVENT"));
const S = await login("stranger@example.com");
r = await invoke(S.sb, "checkup", { appointment_id: appt.id });
check("stranger cannot trigger check-up emails", r.status === 403);

// ---- billing
await resetCalls();
r = await invoke(A.sb, "billing", { action: "checkout", family_id: fam, children: 2, cycle: "year", return_url: "http://127.0.0.1:8768/index.html" });
check("checkout url returned", r.data?.url?.startsWith("https://checkout.stripe.test"), r);
c = await calls();
check("right price looked up", c.some((x) => decodeURIComponent(x.url).includes("lookup_keys[]=family_2_year")));
const sess = c.find((x) => x.url.endsWith("checkout/sessions"));
const sessBody = new URLSearchParams(sess?.body ?? "");
check("session tied to the family", sessBody.get("client_reference_id") === fam && sessBody.get("subscription_data[metadata][family_id]") === fam);
check("return url kept", sessBody.get("success_url") === "http://127.0.0.1:8768/index.html#billing-success");
r = await invoke(T.sb, "billing", { action: "checkout", family_id: fam, children: 1, cycle: "month" });
check("teacher cannot buy for the family", r.status === 403);
const { data: fRow } = await A.sb.from("families").select("plan, plan_status").eq("id", fam).single();
check("plan unchanged until Stripe confirms", fRow.plan === "free");

// ---- webhook
const signed = (payload, secret = "whsec_test", t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
const hook = (evt, sig) => { const p = JSON.stringify(evt); return fetch(`${URL}/functions/v1/stripe-webhook`, { method: "POST", body: p, headers: { "stripe-signature": sig ?? signed(p) } }); };
const sub = { id: "sub_1", customer: "cus_test1", status: "active", cancel_at_period_end: false, metadata: { family_id: fam, children: "2" },
  items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 365 * 864e2, price: { lookup_key: "family_2_year", recurring: { interval: "year" } } }] } };
await fetch(`${URL}/__sub`, { method: "POST", body: JSON.stringify(sub) });
let w = await hook({ id: "evt_1", type: "checkout.session.completed", data: { object: { client_reference_id: fam, customer: "cus_test1", subscription: "sub_1" } } });
check("webhook accepted", w.status === 200);
let { data: f2 } = await A.sb.from("families").select("plan, plan_status, paid_children, billing_cycle, current_period_end").eq("id", fam).single();
check("family plan active after checkout", f2.plan === "family" && f2.plan_status === "active" && f2.paid_children === 2 && f2.billing_cycle === "year" && f2.current_period_end, f2);
w = await hook({ id: "evt_1", type: "checkout.session.completed", data: { object: {} } });
check("duplicate event ignored", (await w.json()).duplicate === true);
w = await hook({ id: "evt_2", type: "customer.subscription.updated", data: { object: sub } }, signed("{}"));
check("bad signature refused", w.status === 400);
w = await hook({ id: "evt_3", type: "customer.subscription.updated", data: { object: sub } }, signed(JSON.stringify({ id: "evt_3", type: "customer.subscription.updated", data: { object: sub } }), "whsec_test", Math.floor(Date.now() / 1000) - 3600));
check("old signature refused", w.status === 400);
w = await hook({ id: "evt_4", type: "customer.subscription.deleted", data: { object: { ...sub, status: "canceled" } } });
({ data: f2 } = await A.sb.from("families").select("plan, plan_status").eq("id", fam).single());
check("cancelled subscription drops to free", f2.plan === "free" && f2.plan_status === "canceled", f2);
const { data: ctx } = await A.sb.rpc("my_context");
check("my_context reports the plan", ctx.memberships[0].plan === "free");

// ---- Pip
await resetCalls();
r = await invoke(A.sb, "pip-chat", { family_id: fam, message: "I like trains", history: [{ role: "assistant", content: "Hi!" }, { role: "user", content: "hello" }, { role: "user", content: "again" }] });
check("Pip replies", r.data?.reply?.includes("train"), r);
c = await calls();
const ai = JSON.parse(c.find((x) => x.url.includes("anthropic")).body);
check("safety rules in system prompt", ai.system.includes("trust"));
check("turns alternate and start with the child", ai.messages[0].role === "user" && ai.messages.every((m, i) => i === 0 || m.role !== ai.messages[i - 1].role), ai.messages);
await invoke(A.sb, "pip-chat", { family_id: fam, message: "two" });
await invoke(A.sb, "pip-chat", { family_id: fam, message: "three" });
r = await invoke(A.sb, "pip-chat", { family_id: fam, message: "four" });
check("daily limit reached", r.data?.limited === true, r);
r = await invoke(S.sb, "pip-chat", { family_id: fam, message: "hi" });
check("stranger cannot use the family's Pip", r.status === 403);

// ---- weekly report
await resetCalls();
r = await invoke(A.sb, "weekly-report", { family_id: fam });
c = await calls();
const rep = c.find((x) => x.url.includes("resend")); const repBody = rep && JSON.parse(rep.body);
check("report sent on demand", r.status === 200 && repBody?.subject?.includes("Aisha"), r);
check("report has this week's minutes", repBody?.text?.includes("10 minutes over 1 day"), repBody?.text);
r = await invoke(T.sb, "weekly-report", { family_id: fam });
check("teacher cannot send the parent report", r.status === 403);
const wd = (new Date().toLocaleDateString("en-US", { timeZone: "Asia/Kuala_Lumpur", weekday: "short" }));
await A.sb.from("families").update({ report_day: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(wd) }).eq("id", fam);
let cron = await fetch(`${URL}/functions/v1/weekly-report`, { method: "POST", headers: { "x-cron-secret": "cron-test" } });
let cj = await cron.json();
check("scheduled run sends due reports", cj.sent === 1, cj);
cron = await fetch(`${URL}/functions/v1/weekly-report`, { method: "POST", headers: { "x-cron-secret": "cron-test" } });
cj = await cron.json();
check("not sent twice in a week", cj.due === 0, cj);
cron = await fetch(`${URL}/functions/v1/weekly-report`, { method: "POST", headers: { "x-cron-secret": "wrong" } });
check("wrong cron secret refused", cron.status === 401);

// ---- admin
r = await invoke(A.sb, "admin-stats", undefined);
check("parents cannot open admin stats", r.status === 403);
const AD = await login("admin@lahlahlearn.test");
r = await invoke(AD.sb, "admin-stats", undefined);
check("admin stats load", r.status === 200 && r.data.totals.families >= 1 && r.data.daily.length === 30, r);
check("admin sees today's activity", r.data?.totals?.active_today >= 1 && r.data?.totals?.minutes_7d >= 10, r.data?.totals);

// ---- delete account
const D = await login("leaving@example.com");
const { data: dfam } = await D.sb.rpc("ensure_family", { p_name: "Leaving" });
await D.sb.from("children").insert({ id: "kLeave1", family_id: dfam, profile: { name: "Leo" } });
r = await invoke(D.sb, "delete-account", { confirm: "nope" });
check("delete needs confirmation", r.status === 400);
r = await invoke(D.sb, "delete-account", { confirm: "DELETE" });
check("account deleted", r.status === 200 && r.data.ok, r);
const { data: gone } = await AD.sb.functions.invoke("admin-stats");
check("deleted family is gone", !gone.families.some((f) => f.id === dfam));

console.log(`${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
