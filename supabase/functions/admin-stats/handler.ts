// GET -> numbers for the private admin page. Allowed for profiles.is_admin or emails in ADMIN_EMAILS.
import { HttpError, json, optionalEnv, serveJson } from "../_shared/http.ts";
import { adminClient, requireUser } from "../_shared/clients.ts";
import { dayStr } from "../_shared/report.ts";

// deno-lint-ignore no-explicit-any
export function effectivePlan(f: any, now = Date.now()): string {
  if (["active", "trialing", "past_due"].includes(f.plan_status) && f.plan !== "free") return f.plan;
  if (f.trial_ends_at && new Date(f.trial_ends_at).getTime() > now) return "trial";
  return "free";
}

export const handler = serveJson(async (req) => {
  const { user } = await requireUser(req);
  const admin = adminClient();
  const allow = (optionalEnv("ADMIN_EMAILS") ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const { data: me } = await admin.from("profiles").select("is_admin").eq("id", user.id).maybeSingle();
  if (!me?.is_admin && !allow.includes((user.email ?? "").toLowerCase())) throw new HttpError(403, "This page is for the LahLahLearn team.");

  const since = new Date(Date.now() - 29 * 864e5);
  const [fams, kids, members, invites, act, profiles, mails] = await Promise.all([
    admin.from("families").select("id, owner_id, name, plan, plan_status, trial_started_at, trial_ends_at, created_at, report_auto, paid_children, billing_cycle").limit(5000),
    admin.from("children").select("id, family_id, created_at").limit(5000),
    admin.from("family_members").select("family_id, role").limit(10000),
    admin.from("invites").select("accepted_at, expires_at").limit(5000),
    admin.from("daily_activity").select("child_id, family_id, day, seconds").gte("day", dayStr(since)).limit(50000),
    admin.from("profiles").select("id, email, created_at").limit(10000),
    admin.from("email_log").select("kind, status, created_at").gte("created_at", new Date(Date.now() - 7 * 864e5).toISOString()).limit(5000),
  ]);
  for (const r of [fams, kids, members, invites, act, profiles, mails]) if (r.error) throw r.error;

  const days = Array.from({ length: 30 }, (_, i) => dayStr(new Date(since.getTime() + i * 864e5)));
  const signups: Record<string, number> = Object.fromEntries(days.map((d) => [d, 0]));
  for (const f of fams.data!) { const d = dayStr(new Date(f.created_at)); if (d in signups) signups[d]++; }
  const activeKids: Record<string, Set<string>> = Object.fromEntries(days.map((d) => [d, new Set<string>()]));
  const minutes: Record<string, number> = Object.fromEntries(days.map((d) => [d, 0]));
  const famLast: Record<string, string> = {}, fam7: Record<string, number> = {};
  const week = days.slice(-7);
  for (const a of act.data!) {
    if (a.seconds <= 0) continue;
    if (activeKids[a.day]) { activeKids[a.day].add(a.child_id); minutes[a.day] += a.seconds / 60; }
    if (!famLast[a.family_id] || famLast[a.family_id] < a.day) famLast[a.family_id] = a.day;
    if (week.includes(a.day)) fam7[a.family_id] = (fam7[a.family_id] ?? 0) + a.seconds / 60;
  }
  const plans: Record<string, number> = { free: 0, trial: 0, family: 0, school: 0 };
  for (const f of fams.data!) plans[effectivePlan(f)] = (plans[effectivePlan(f)] ?? 0) + 1;
  const roles: Record<string, number> = { parent: 0, teacher: 0, therapist: 0 };
  for (const m of members.data!) roles[m.role] = (roles[m.role] ?? 0) + 1;
  const emailOf = Object.fromEntries(profiles.data!.map((p) => [p.id, p.email]));
  const kidsPer: Record<string, number> = {};
  for (const k of kids.data!) kidsPer[k.family_id] = (kidsPer[k.family_id] ?? 0) + 1;
  const today = dayStr(new Date());

  return json({
    generated_at: new Date().toISOString(),
    totals: {
      families: fams.data!.length, children: kids.data!.length, teachers: roles.teacher, therapists: roles.therapist,
      active_today: activeKids[today]?.size ?? 0,
      active_7d: new Set(act.data!.filter((a) => week.includes(a.day) && a.seconds > 0).map((a) => a.child_id)).size,
      minutes_7d: Math.round(week.reduce((t, d) => t + (minutes[d] ?? 0), 0)),
      invites_pending: invites.data!.filter((i) => !i.accepted_at && new Date(i.expires_at).getTime() > Date.now()).length,
      weekly_reports_on: fams.data!.filter((f) => f.report_auto).length,
    },
    plans,
    emails_7d: mails.data!.reduce((o: Record<string, number>, m) => { const k = `${m.kind}:${m.status}`; o[k] = (o[k] ?? 0) + 1; return o; }, {}),
    daily: days.map((d) => ({ day: d, signups: signups[d], active_children: activeKids[d].size, minutes: Math.round(minutes[d]) })),
    families: fams.data!
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 200)
      .map((f) => ({
        id: f.id, name: f.name, email: emailOf[f.owner_id] ?? "", created_at: f.created_at, children: kidsPer[f.id] ?? 0,
        plan: effectivePlan(f), last_active: famLast[f.id] ?? null, minutes_7d: Math.round(fam7[f.id] ?? 0),
      })),
  });
});

