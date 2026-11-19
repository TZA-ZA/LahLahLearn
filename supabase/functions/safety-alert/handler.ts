// POST { family_id, child_id, kind: "fall" | "still" | "help" | "okay", answered?: boolean } -> { sent, to }
// Safety watch on a child's device asks for help: email the family's grown-ups and the emergency contacts saved in
// that child's profile. Only addresses the family saved are used (never ones sent in the request), a few alerts in 10 minutes at most.
import { HttpError, isEmail, json, readJson, serveJson } from "../_shared/http.ts";
import { adminClient, requireUser, roleIn } from "../_shared/clients.ts";
import { layout, sendMail } from "../_shared/email.ts";
import { esc } from "../_shared/http.ts";

const WHAT: Record<string, string> = {
  fall: "may have fallen",
  still: "has been lying very still on the floor",
  help: "pressed the Help button",
};

export const handler = serveJson(async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "Use POST.");
  const { db } = await requireUser(req);
  const b = await readJson<{ family_id?: string; child_id?: string; kind?: string; answered?: boolean }>(req);
  if (typeof b.family_id !== "string" || !(await roleIn(db, b.family_id))) throw new HttpError(403, "You are not in this family.");
  if (typeof b.child_id !== "string" || !/^[A-Za-z0-9_-]{3,40}$/.test(b.child_id)) throw new HttpError(400, "Missing child.");
  const kind = b.kind === "okay" ? "okay" : WHAT[String(b.kind)] ? String(b.kind) : "fall";
  const admin = adminClient();

  const { data: child } = await admin.from("children").select("profile, display_name").eq("id", b.child_id).eq("family_id", b.family_id).maybeSingle();
  if (!child) throw new HttpError(404, "Child not found.");
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { count } = await admin.from("email_log").select("id", { count: "exact", head: true }).eq("family_id", b.family_id).eq("kind", "safety").gte("created_at", since);
  if ((count ?? 0) >= 20) return json({ sent: false, limited: true });

  // the family's grown-ups (parents) plus the child's emergency contacts with an email
  const { data: members } = await admin.from("family_members").select("user_id").eq("family_id", b.family_id).eq("role", "parent");
  const ids = (members ?? []).map((m) => m.user_id);
  const { data: profs } = ids.length ? await admin.from("profiles").select("email").in("id", ids) : { data: [] };
  const contacts = Array.isArray(child.profile?.safety?.contacts) ? child.profile.safety.contacts : [];
  const to = [...new Set([...(profs ?? []).map((p) => p.email), ...contacts.map((c: { e?: string }) => c?.e)].filter(isEmail).map((e) => e.toLowerCase()))].slice(0, 8);
  if (!to.length) return json({ sent: false, to: 0 });

  const name = String(child.profile?.name || child.display_name || "Your child").slice(0, 60);
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: Deno.env.get("APP_TIMEZONE") || "Asia/Kuala_Lumpur", dateStyle: "medium", timeStyle: "short" }).format(new Date());
  const okay = kind === "okay";
  const subject = okay ? `${name} says they are okay now` : `⚠ Please check on ${name} now`;
  const line = okay
    ? `${name} tapped "I'm okay" after the Safety watch alert.`
    : `LahLahLearn's Safety watch thinks ${name} ${WHAT[kind]}${b.answered === false ? " and did not answer \"Are you okay?\"" : ""}.`;
  const phones = contacts.filter((c: { p?: string }) => c?.p).map((c: { n?: string; p?: string }) => `${esc(c.n || "Contact")}: <a href="tel:${esc(String(c.p).replace(/[^\d+]/g, ""))}">${esc(c.p)}</a>`).join("<br>");
  const html = layout(subject, `<p style="font-size:17px;margin:0 0 12px"><b>${esc(line)}</b></p><p style="margin:0 0 12px">Time: ${esc(when)}</p>` +
    (okay ? "" : `<p style="margin:0 0 12px">Please check on ${esc(name)} now. If anyone is hurt, call 999 (Malaysia) or your local emergency number.</p>${phones ? `<p style="margin:0 0 12px">Emergency contacts:<br>${phones}</p>` : ""}`) +
    `<p style="margin:16px 0 0;font-size:12px;color:#6c746d">Safety watch runs on the child's device. No video or pictures are recorded or sent; only this alert. It can miss a fall or raise a false alarm, so it does not replace a grown-up nearby.</p>`);
  const text = `${line}\nTime: ${when}\n${okay ? "" : `Please check on ${name} now. If anyone is hurt, call 999 (Malaysia) or your local emergency number.\n`}`;
  const r = await sendMail(admin, { to, subject, html, text, kind: "safety", familyId: b.family_id });
  return json({ sent: r.sent, to: to.length });
});
