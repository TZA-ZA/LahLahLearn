// Weekly report, built on the server from the same progress data the app saves.
// Mirrors reportWeek() in index.html so parents see the same numbers in the app and in email.
import { esc } from "./http.ts";

export const SKN: Record<string, string> = {
  read: "Early reading", num: "Number sense", pat: "Patterns", feel: "Feelings",
  know: "World knowledge", att: "Attention", talk: "Communication",
};
const LVNAME = ["Seed", "Sprout", "Bloom", "Canopy"];
const GOALS: [string, string, number, number][] = [
  ["Counts a group of objects up to 10", "num", 70, 45],
  ["Matches a pictured word to its written form", "read", 70, 45],
  ["Continues a simple repeating pattern", "pat", 70, 45],
  ["Names common feelings and calm-down ideas", "feel", 70, 45],
  ["Talks about caring for the planet and for others", "know", 70, 45],
  ["Stays with a short task for five minutes", "att", 65, 40],
  ["Uses picture cards to make a request", "talk", 60, 40],
];

export const TZ = () => Deno.env.get("APP_TIMEZONE") || "Asia/Kuala_Lumpur";

/** YYYY-MM-DD for a moment in the app's time zone (the app keys minutes by local date). */
export function dayStr(d: Date, tz = TZ()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
/** 0 = Monday ... 6 = Sunday, in the app's time zone. */
export function weekday(d: Date, tz = TZ()): number {
  const w = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(w);
}
export function weekStart(d: Date, tz = TZ()): string {
  return dayStr(new Date(d.getTime() - weekday(d, tz) * 864e5), tz);
}

type G = Record<string, any>;
const lastDays = (now: Date, n = 7) => Array.from({ length: n }, (_, i) => dayStr(new Date(now.getTime() - i * 864e5)));

export interface ChildReport { name: string; minutes: number; days: number; lessons: number; level: string; strengths: string[]; support: string[]; calm: number; upsets: number; goals: { goal: string; status: string }[]; interests: string[]; notes: string; }

export function summarise(profile: G, g: G, now = new Date()): ChildReport {
  const days = lastDays(now);
  const mins = g.mins ?? {}, mastery = g.mastery ?? {}, st = g.st ?? {};
  const seconds = days.reduce((t, d) => t + (Number(mins[d]) || 0), 0);
  const learned = days.filter((d) => (g.days ?? []).includes(d) || (Number(mins[d]) || 0) > 0).length;
  const evidence = (k: string) => (k === "talk" ? Number(g.speaks) || 0 : (st[k]?.[0] ?? 0));
  const ranked = Object.keys(SKN).filter((k) => evidence(k) >= 5).map((k) => [k, Math.round(Number(mastery[k]) || 0)] as [string, number]).sort((a, b) => b[1] - a[1]);
  const avg = ((Number(mastery.read) || 25) + (Number(mastery.num) || 25)) / 2;
  const level = LVNAME[Math.min(4, Math.max(1, 1 + Math.floor(avg / 26))) - 1];
  return {
    name: String(profile.name || "your child"),
    minutes: Math.round(seconds / 60),
    days: learned,
    lessons: Number(g.lessons) || 0,
    level,
    strengths: ranked.slice(0, 3).map(([k, v]) => `${SKN[k]} (${v}%)`),
    support: ranked.slice(-3).reverse().map(([k, v]) => `${SKN[k]} (${v}%)`),
    calm: Number(g.calm) || 0,
    upsets: days.reduce((t, d) => t + (Number(g.upsetN?.[d]) || 0), 0),
    goals: GOALS.map(([goal, k, hi, mid]) => {
      const v = Number(mastery[k]) || 0;
      return { goal, status: evidence(k) < 5 ? "Getting started" : v >= hi ? "Secure" : v >= mid ? "Working on it" : "Needs support" };
    }),
    interests: Array.isArray(profile.interests) ? profile.interests.map(String) : [],
    notes: "",
  };
}

export function reportEmail(children: ChildReport[], weekEnding: string, upcoming: { when: string; who: string }[] = []) {
  const names = children.map((c) => c.name).join(" and ");
  const subject = `${names}'s week on LahLahLearn`;
  const list = (xs: string[]) => xs.length ? xs.map((x) => `<li>${esc(x)}</li>`).join("") : "<li>Still collecting activity</li>";
  const block = (c: ChildReport) => `
    <h2 style="font-size:18px;font-weight:500;margin:26px 0 8px">${esc(c.name)}</h2>
    <p style="margin:0 0 6px"><b>${c.minutes}</b> minutes over <b>${c.days}</b> day${c.days === 1 ? "" : "s"} · Level: ${esc(c.level)} · ${c.lessons} lessons so far</p>
    <p style="margin:12px 0 4px;color:#6c746d">Strengths</p><ul style="margin:0;padding-left:18px">${list(c.strengths)}</ul>
    <p style="margin:12px 0 4px;color:#6c746d">Needs support</p><ul style="margin:0;padding-left:18px">${list(c.support)}</ul>
    <p style="margin:12px 0 0">Calm breaks used: ${c.calm} · Upset moments this week: ${c.upsets}</p>
    ${c.notes ? `<p style="margin:12px 0 0;color:#6c746d">Shared notes</p><p style="margin:2px 0 0;white-space:pre-wrap">${esc(c.notes)}</p>` : ""}`;
  const next = upcoming.length ? `<p style="margin:22px 0 0">Next check-up: ${esc(upcoming[0].when)} with ${esc(upcoming[0].who)}</p>` : "";
  const stop = "You get this email because the weekly report is switched on for your family. To stop it, open the Care Circle, go to Report and untick \"Email the report automatically\", or reply to this email and we will stop it for you.";
  const html = `<p style="margin:0">Here is the week ending ${esc(weekEnding)}.</p>${children.map(block).join("")}${next}<p style="margin:26px 0 0;font-size:12px;color:#6c746d">${stop}</p>`;
  const text = [`LahLahLearn weekly report — week ending ${weekEnding}`, ""].concat(children.flatMap((c) => [
    c.name, `- Learning time: ${c.minutes} minutes over ${c.days} day(s)`, `- Lessons so far: ${c.lessons}`, `- Level: ${c.level}`,
    `- Strengths: ${c.strengths.join(", ") || "Still collecting activity"}`, `- Needs support: ${c.support.join(", ") || "Still collecting activity"}`,
    `- Calm breaks: ${c.calm}; upset moments this week: ${c.upsets}`, ...(c.notes ? [`- Notes: ${c.notes}`] : []), "",
  ])).concat(upcoming.length ? [`Next check-up: ${upcoming[0].when} with ${upcoming[0].who}`] : []).concat(["", stop]).join("\n");
  return { subject, html, text };
}
