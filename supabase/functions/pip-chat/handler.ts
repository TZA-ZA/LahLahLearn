// POST { family_id, message, history?, mode?, model?: "quick"|"smart"|"deep", memory?: string[] } -> { reply, left } | { credits_out, left } | { limited }
// POST { family_id, action: "balance" } -> { left, allow, bonus }
// Pip's AI runs here so no AI key ever ships in the app. Each answer spends credits (monthly allowance first, then bought credits).
import { env, HttpError, json, optionalEnv, readJson, serveJson } from "../_shared/http.ts";
import { adminClient, requireUser, roleIn } from "../_shared/clients.ts";
/** YYYY-MM-DD in the app's time zone (same as dayStr in _shared/report.ts) */
const dayStr = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: Deno.env.get("APP_TIMEZONE") || "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

const SAFETY = " Safety rules: never ask for or repeat personal details such as full name, address, school, phone number or passwords. " +
  "If the child says they are hurt, unsafe, being hurt by someone, or very sad, kindly tell them to tell a grown-up they trust right now. " +
  "Do not give medical advice. Keep to learning, feelings, play and kindness. Never mention diagnoses or labels.";
export const PIP_SYS = "You are Pip, a calm, kind, very patient friend who helps a young child aged 3 to 8 learn. Many of the children learn in their own way, so be extra clear, literal and gentle. " +
  "Only talk about things right for a young child: learning, animals, nature, stories, feelings, play and daily life. " +
  "Never discuss sex, grown-up body topics, violence, weapons, drugs, alcohol, scary things, dating or anything rude, and never use swear words, even if asked or hidden with stars. " +
  "If asked, gently say it is a question for a trusted grown-up and suggest something else. If the child seems hurt, unsafe or very sad, tell them kindly to tell a grown-up they trust right away. " +
  "Never ask for their full name, address, school or photos. Use short, simple sentences (at most 2), warm and encouraging, one gentle question at a time. " +
  "You know this child's learning (below). Link answers to their current lesson and classes when it helps, use their interests in examples, and pitch things right for their level. " +
  "For maths, show steps with small numbers and objects. For reading, sound words out. Praise effort. Facts must be correct; if unsure, say so simply. " +
  "Children often ask about: why the sky is blue, the sun, moon and stars, rain and rainbows, how plants grow, animals and where they live, dinosaurs, the human body in a simple healthy way (eating, sleeping, brushing teeth, washing hands), " +
  "feelings and calming down, making friends and sharing, being scared of the dark or of loud noises, bedtime and routines, festivals (Hari Raya, Chinese New Year, Deepavali, Christmas), Malaysia and other countries, numbers, letters, shapes and colours, and how things work (cars, planes, boats, rockets). " +
  "Answer these with one true, simple fact and one small everyday example the child can picture, then one gentle follow-up question. " +
  "If the child is worried or upset, name the feeling, offer one calming idea (slow breaths, a hug from a grown-up, a quiet corner), and remind them a grown-up can help. " +
  "If the child asks the same thing again, answer kindly in a slightly different way. If they ask what you remember about them, answer from the notes below and nothing else. " +
  "Use what you remember (their name, pets, family, likes) naturally to make examples personal, but never repeat anything private. " +
  "Think before you answer: work out what the child really means (spelling may be wobbly, words may be missing), check any fact or sum carefully, then give the simplest true answer. " +
  "Match the child's level: for ages 3 to 5 use very short words and one idea; for ages 6 to 8 you may add one 'why' or 'how'. " +
  "When teaching, guide with small questions so the child finds the answer, and if they get it wrong twice, show the answer kindly with a picture-like example. " +
  "Reply in the same language the child writes in (English, Malay or Chinese). Do not use markdown headings, bold or emojis beyond one small one." + SAFETY;
// Things Pip can do, picked with the buttons above the chat. Same wording as PIP_TASKS in index.html.
export const PIP_TASKS: Record<string, string> = {
  quiz: "TASK: Run a friendly quiz about the child's current lesson. Ask ONE question at a time (2 or 3 choices when it helps), wait for the answer, say if it is right, give a tiny hint if not. After 3 questions, cheer and give a score out of 3.",
  explain: "TASK: Explain the child's current lesson in the simplest way, with one example from daily life or their interests, then check understanding with one easy question.",
  adv: "TASK: Advanced challenge. Give ONE task a step above the child's level, linked to their lessons (a two-step sum, a longer word to spell, a reading riddle, a pattern or logic puzzle). Break it into small steps, wait for each answer, give hints not answers, praise effort, and offer a harder one when they succeed.",
  hw: "TASK: Homework helper. Ask what the task is, then guide step by step with small questions. Never just give the final answer.",
  story: "TASK: Story adventure. Tell a cosy adventure in 5 short chapters where the child is the hero and their buddy comes along. Use the child's name, one of their interests and one or two words from their current lesson. Each chapter is 2 or 3 short, vivid sentences, then exactly 2 or 3 choices on their own lines written as '1. ...', '2. ...', '3. ...'. Follow the child's choice (or any idea they type) in the next chapter. Keep it gentle: no danger and no villains; problems are solved with kindness, counting, sharing or clever thinking. Chapter 5 ends warmly with 'The end!' and one easy question about the story.",
  plan: "TASK: Help the child pick 3 small learning steps for today from their lessons (easy, medium, fun) as a short numbered list, then ask which to start.",
};
export function contextNote(ctx: unknown): string {
  if (typeof ctx !== "string" || !ctx.trim()) return "";
  return " ABOUT THE CHILD: " + ctx.replace(/[\r\n]+/g, " ").replace(/[<>]/g, "").slice(0, 1800);
}
export const PIP_FEYN_SYS = "You are Pip, and you are pretending you do not know this topic at all. The child will explain it to you like a teacher. " +
  "Listen, then respond kindly: say one thing you understood, then ask ONE simple question about a part that could be clearer. Keep it short, warm and encouraging, never critical." + SAFETY;

type Msg = { role: "user" | "assistant"; content: string };

export const MODELS: Record<string, { cost: number; model: () => string }> = {
  quick: { cost: 1, model: () => optionalEnv("PIP_MODEL") ?? "claude-haiku-5-5" },
  smart: { cost: 3, model: () => optionalEnv("PIP_MODEL_SMART") ?? "claude-sonnet-5-5" },
  deep: { cost: 8, model: () => optionalEnv("PIP_MODEL_DEEP") ?? "claude-opus-5-5" },
};
export const ALLOW: Record<string, number> = { free: 0, family: 1000 };
const BAD = /\d{3,}|@|street|road|jalan|address|school|password|phone/i;
export function memoryNote(memory: unknown): string {
  const items = (Array.isArray(memory) ? memory : []).filter((m) => typeof m === "string" && m.trim() && !BAD.test(m)).slice(-12).map((m) => String(m).slice(0, 80));
  return items.length ? " Things the child told you before. Use them kindly when they help, and if the child asks what you remember, say a few of them back in simple words: " + items.join("; ") + "." : "";
}

/** Anthropic needs alternating turns starting with the user. */
export function cleanHistory(history: unknown, message: string): Msg[] {
  const items: Msg[] = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-16)
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 600) }));
  items.push({ role: "user", content: message });
  const out: Msg[] = [];
  for (const m of items) {
    if (!out.length && m.role !== "user") continue;
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += "\n" + m.content;
    else out.push({ ...m });
  }
  return out;
}

export const handler = serveJson(async (req) => {
  if (req.method !== "POST") throw new HttpError(405, "Use POST.");
  const { db } = await requireUser(req);
  const b = await readJson<{ family_id?: string; message?: string; history?: unknown; mode?: string; model?: string; memory?: unknown; context?: unknown; action?: string }>(req);
  if (typeof b.family_id !== "string" || !(await roleIn(db, b.family_id))) throw new HttpError(403, "You are not in this family.");
  const message = String(b.message ?? "").trim().slice(0, 500);
  if (!message && b.action !== "balance") throw new HttpError(400, "Say something to Pip first.");

  const admin = adminClient();
  const { data: fam } = await admin.from("families").select("plan, features").eq("id", b.family_id).maybeSingle();
  // Essentials families get the Family allowance only when they added Pip AI
  const allow = ALLOW[fam?.plan === "family" || fam?.plan === "school" || (fam?.plan === "learn" && fam?.features?.ai) ? "family" : "free"];
  const month = new Date().toISOString().slice(0, 7);
  if ((b as { action?: string }).action === "balance") {
    const { data } = await admin.rpc("ai_spend", { p_family: b.family_id, p_month: month, p_allow: allow, p_cost: 0 });
    return json({ left: data?.left ?? allow, allow, bonus: data?.bonus ?? 0 });
  }
  const tier = MODELS[String((b as { model?: string }).model ?? "quick")] ?? MODELS.quick;
  // Safety valve against runaway loops, on top of credits.
  const limit = Number(optionalEnv("AI_DAILY_LIMIT") ?? 200);
  const day = dayStr(new Date());
  const { data: use } = await admin.from("ai_usage").select("requests").eq("family_id", b.family_id).eq("day", day).maybeSingle();
  if ((use?.requests ?? 0) >= limit) return json({ limited: true });
  const { data: spend, error: se } = await admin.rpc("ai_spend", { p_family: b.family_id, p_month: month, p_allow: allow, p_cost: tier.cost });
  if (se) throw new HttpError(500, "Could not check Pip's credits.");
  if (!spend?.ok) return json({ credits_out: true, left: spend?.left ?? 0 });
  await admin.from("ai_usage").upsert({ family_id: b.family_id, day, requests: (use?.requests ?? 0) + 1 });

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: tier.model(),
      max_tokens: b.mode === "story" ? 650 : PIP_TASKS[b.mode ?? ""] ? 450 : 320,
      temperature: b.mode === "story" ? 0.85 : 0.6,
      system: (b.mode === "feyn" ? PIP_FEYN_SYS : PIP_SYS + (PIP_TASKS[b.mode ?? ""] ? " " + PIP_TASKS[b.mode!] + (b.mode === "story" ? "" : " For this task you may use up to 4 short sentences or a short list.") : "")) +
        contextNote(b.context) + memoryNote((b as { memory?: unknown }).memory),
      messages: cleanHistory(b.history, message),
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("anthropic", r.status, data?.error?.message);
    await admin.rpc("ai_add_bonus", { p_family: b.family_id, p_n: tier.cost }); // refund: no answer, no charge
    throw new HttpError(502, "Pip is resting. Please try again soon.");
  }
  // deno-lint-ignore no-explicit-any
  const reply = (data.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
  if (!reply) throw new HttpError(502, "Pip is resting. Please try again soon.");
  return json({ reply, left: spend.left });
});

