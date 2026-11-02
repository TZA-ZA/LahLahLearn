// POST { family_id, email, name, role } — a parent invites a teacher, therapist or co-parent to the Care Circle.
import { esc, HttpError, isEmail, json, readJson, serveJson } from "../_shared/http.ts";
import { adminClient, requireParent, requireUser } from "../_shared/clients.ts";
import { layout, sendMail, siteUrl } from "../_shared/email.ts";

const ROLE_WORD: Record<string, string> = { teacher: "a teacher", therapist: "a therapist", parent: "a parent or carer" };

export const handler = serveJson(async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "Use POST.");
  const { user, db } = await requireUser(req);
  const b = await readJson<{ family_id?: string; email?: string; name?: string; role?: string }>(req);
  const fid = await requireParent(db, b.family_id);
  const email = String(b.email ?? "").trim().toLowerCase();
  if (!isEmail(email)) throw new HttpError(400, "Please check the email address.");
  const role = String(b.role ?? "");
  if (!ROLE_WORD[role]) throw new HttpError(400, "Choose teacher, therapist or parent.");
  const name = String(b.name ?? "").trim().slice(0, 80);
  if (email === (user.email ?? "").toLowerCase()) throw new HttpError(400, "That is your own email address.");

  const admin = adminClient();
  const { data: members } = await admin.from("family_members").select("email, display_name, user_id").eq("family_id", fid);
  if ((members ?? []).some((m) => (m.email ?? "").toLowerCase() === email)) throw new HttpError(409, "This person is already in the Care Circle.");

  // one open invite per email: replace an older one
  await db.from("invites").delete().eq("family_id", fid).eq("email", email).is("accepted_at", null);
  const { data: inv, error } = await db.from("invites").insert({ family_id: fid, email, name, role }).select("id, token, expires_at").single();
  if (error || !inv) throw new HttpError(400, "Could not create the invite.");

  const { data: kids } = await admin.from("children").select("display_name").eq("family_id", fid).order("created_at");
  const childNames = (kids ?? []).map((k) => k.display_name).filter(Boolean).join(" and ") || "a child";
  const me = (members ?? []).find((m) => m.user_id === user.id);
  const inviter = me?.display_name || user.email || "A parent";
  const link = `${siteUrl()}#join-${inv.token}`;
  const title = `Join ${childNames}'s Care Circle`;
  const html = layout(title,
    `<p style="margin:0 0 12px">${esc(inviter)} invited you to LahLahLearn as ${ROLE_WORD[role]}${name ? `, ${esc(name)}` : ""}.</p>
     <p style="margin:0 0 12px">You'll see ${esc(childNames)}'s progress, add shared notes${role === "therapist" ? " and offer check-up times" : ""}.</p>
     <p style="margin:0;color:#6c746d">Sign in with ${esc(email)} to accept. This invite works for 14 days.</p>`,
    { label: "Accept invite", url: link });
  const text = `${inviter} invited you to ${childNames}'s Care Circle on LahLahLearn as ${ROLE_WORD[role]}.\nSign in with ${email} to accept (valid for 14 days):\n${link}`;
  const mail = await sendMail(admin, { to: email, subject: title, html, text, kind: "invite", familyId: fid });
  return json({ ok: true, invite_id: inv.id, emailed: mail.sent, link, expires_at: inv.expires_at });
});

