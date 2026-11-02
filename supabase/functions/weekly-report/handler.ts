// Weekly progress emails.
//  - Scheduled: POST with header x-cron-secret = CRON_SECRET. Sends to every family whose report day is today.
//  - On demand: POST { family_id } with a parent's session. Sends now.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.117.3";
import { env, HttpError, json, readJson, serveJson } from "../_shared/http.ts";
import { adminClient, requireParent, requireUser } from "../_shared/clients.ts";
import { layout, sendMail, siteUrl } from "../_shared/email.ts";
import { dayStr, reportEmail, summarise, TZ, weekday, weekStart } from "../_shared/report.ts";

export async function sendFamilyReport(admin: SupabaseClient, fid: string, to: string, now = new Date()) {
  const [{ data: kids }, { data: prog }, { data: notes }, { data: appts }] = await Promise.all([
    admin.from("children").select("id, profile").eq("family_id", fid).order("created_at"),
    admin.from("progress").select("child_id, data").eq("family_id", fid),
    admin.from("shared_notes").select("child_id, body").eq("family_id", fid),
    admin.from("appointments").select("starts_at, therapist_name").eq("family_id", fid).eq("status", "booked").gte("starts_at", now.toISOString()).order("starts_at").limit(1),
  ]);
  if (!kids?.length) return { sent: false, error: "No children yet" };
  const reports = kids.map((k) => {
    const s = summarise(k.profile ?? {}, prog?.find((p) => p.child_id === k.id)?.data ?? {}, now);
    s.notes = notes?.find((n) => n.child_id === k.id)?.body ?? "";
    return s;
  });
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ(), dateStyle: "medium", timeStyle: "short" });
  const upcoming = (appts ?? []).map((a) => ({ when: fmt.format(new Date(a.starts_at)), who: a.therapist_name }));
  const r = reportEmail(reports, new Intl.DateTimeFormat("en-GB", { timeZone: TZ(), dateStyle: "long" }).format(now), upcoming);
  return await sendMail(admin, { to, subject: r.subject, html: layout(r.subject, r.html, { label: "Open the Care Circle", url: `${siteUrl()}#care` }), text: r.text, kind: "weekly_report", familyId: fid });
}

export async function sendDueReports(admin: SupabaseClient, now = new Date()) {
  const wd = weekday(now), ws = weekStart(now), today = dayStr(now);
  const { data: fams, error } = await admin.from("families").select("id, report_email, report_last_sent")
    .eq("report_auto", true).eq("report_day", wd).not("report_email", "is", null);
  if (error) throw error;
  const due = (fams ?? []).filter((f) => !f.report_last_sent || f.report_last_sent < ws);
  let sent = 0, failed = 0;
  for (const f of due) {
    const r = await sendFamilyReport(admin, f.id, f.report_email!, now);
    if (r.sent) { sent++; await admin.from("families").update({ report_last_sent: today }).eq("id", f.id); } else failed++;
  }
  return { due: due.length, sent, failed };
}

export const handler = serveJson(async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "Use POST.");
  const admin = adminClient();
  const cron = req.headers.get("x-cron-secret");
  if (cron !== null) {
    if (cron !== env("CRON_SECRET")) throw new HttpError(401, "Bad cron secret.");
    return json(await sendDueReports(admin));
  }
  const { user, db } = await requireUser(req);
  const b = await readJson<{ family_id?: string }>(req);
  const fid = await requireParent(db, b.family_id);
  const { data: fam } = await admin.from("families").select("report_email").eq("id", fid).single();
  const to = fam?.report_email || user.email;
  if (!to) throw new HttpError(400, "Add an email address for reports first.");
  const r = await sendFamilyReport(admin, fid, to);
  if (!r.sent) throw new HttpError(502, r.error === "No children yet" ? "Add a child first." : "The email could not be sent. Please try again later.");
  return json({ ok: true, to });
});

