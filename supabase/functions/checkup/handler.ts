// POST { appointment_id, action: "booked" | "canceled" } — emails the therapist and the family about a check-up.
import { esc, HttpError, json, readJson, serveJson } from "../_shared/http.ts";
import { adminClient, requireUser, roleIn } from "../_shared/clients.ts";
import { layout, sendMail, siteUrl } from "../_shared/email.ts";
import { TZ } from "../_shared/report.ts";

const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");

export function buildIcs(id: string, start: Date, minutes: number, summary: string, description: string, cancel = false): string {
  const end = new Date(start.getTime() + minutes * 60000);
  const clean = (s: string) => s.replace(/[\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//LahLahLearn//Check-ups//EN", `METHOD:${cancel ? "CANCEL" : "PUBLISH"}`,
    "BEGIN:VEVENT", `UID:${id}@lahlahlearn`, `DTSTAMP:${icsDate(new Date())}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
    `SUMMARY:${clean(summary)}`, `DESCRIPTION:${clean(description)}`, `STATUS:${cancel ? "CANCELLED" : "CONFIRMED"}`, "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
}

export const handler = serveJson(async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "Use POST.");
  const { db } = await requireUser(req);
  const b = await readJson<{ appointment_id?: string; action?: string }>(req);
  const admin = adminClient();
  const { data: a } = await admin.from("appointments").select("*").eq("id", b.appointment_id ?? "").maybeSingle();
  if (!a) throw new HttpError(404, "Check-up not found.");
  if (!(await roleIn(db, a.family_id))) throw new HttpError(403, "You are not in this Care Circle.");
  const cancel = b.action === "canceled" || a.status === "canceled";

  const [{ data: child }, { data: fam }, { data: members }] = await Promise.all([
    admin.from("children").select("display_name").eq("id", a.child_id).single(),
    admin.from("families").select("report_email").eq("id", a.family_id).single(),
    admin.from("family_members").select("user_id, role, email").eq("family_id", a.family_id),
  ]);
  const to = new Set<string>();
  if (fam?.report_email) to.add(fam.report_email.toLowerCase());
  for (const m of members ?? []) {
    if (m.email && (m.role === "parent" || m.user_id === a.therapist_user_id)) to.add(m.email.toLowerCase());
  }
  if (!to.size) return json({ ok: true, emailed: false });

  const name = child?.display_name || "your child";
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: TZ(), dateStyle: "full", timeStyle: "short" }).format(new Date(a.starts_at));
  const how = a.mode === "online" ? "Online" : "In person";
  const title = cancel ? `Check-up cancelled: ${name}` : `Check-up booked: ${name}`;
  const html = layout(title,
    `<p style="margin:0 0 6px"><b>${esc(when)}</b></p><p style="margin:0 0 6px">With ${esc(a.therapist_name)} · ${how}</p>
     ${a.note ? `<p style="margin:12px 0 0;color:#6c746d">Note: ${esc(a.note)}</p>` : ""}
     ${a.booked_by_name ? `<p style="margin:12px 0 0;color:#6c746d">${cancel ? "Cancelled" : "Booked"} in LahLahLearn by ${esc(a.booked_by_name)}.</p>` : ""}`,
    { label: "Open the Care Circle", url: `${siteUrl()}#care` });
  const text = `${title}\n${when}\nWith ${a.therapist_name} (${how})${a.note ? `\nNote: ${a.note}` : ""}`;
  const ics = buildIcs(a.id, new Date(a.starts_at), 45, `LahLahLearn check-up: ${name}`, `With ${a.therapist_name} (${how})`, cancel);
  const mail = await sendMail(admin, {
    to: [...to], subject: title, html, text, kind: cancel ? "checkup_canceled" : "checkup_booked", familyId: a.family_id,
    attachments: [{ filename: "check-up.ics", content: btoa(ics), content_type: "text/calendar" }],
  });
  return json({ ok: true, emailed: mail.sent });
});

