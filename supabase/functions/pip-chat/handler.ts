// POST { family_id, message, history?: {role, content}[], mode?: "teach" | "feyn" } -> { reply } or { limited: true }
// Pip's AI runs here so no AI key ever ships in the app. Per-family daily limit keeps costs predictable.
import { env, HttpError, json, optionalEnv, readJson, serveJson } from "../_shared/http.ts";
import { adminClient, requireUser, roleIn } from "../_shared/clients.ts";
import { dayStr } from "../_shared/report.ts";

const SAFETY = " Safety rules: never ask for or repeat personal details such as full name, address, school, phone number or passwords. " +
  "If the child says they are hurt, unsafe, being hurt by someone, or very sad, kindly tell them to tell a grown-up they trust right now. " +
  "Do not give medical advice. Keep to learning, feelings, play and kindness. Never mention diagnoses or labels.";
export const PIP_SYS = "You are Pip, a calm, kind, very patient friend who helps a young child learn. Use short, simple sentences (at most 2). " +
  "Warm, slow, encouraging tone. No sarcasm, no slang, nothing scary or loud. If you ask a question, ask only one, gently." + SAFETY;
export const PIP_FEYN_SYS = "You are Pip, and you are pretending you do not know this topic at all. The child will explain it to you like a teacher. " +
  "Listen, then respond kindly: say one thing you understood, then ask ONE simple question about a part that could be clearer. Keep it short, warm and encouraging, never critical." + SAFETY;

type Msg = { role: "user" | "assistant"; content: string };

/** Anthropic needs alternating turns starting with the user. */
export function cleanHistory(history: unknown, message: string): Msg[] {
  const items: Msg[] = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-8)
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
  const b = await readJson<{ family_id?: string; message?: string; history?: unknown; mode?: string }>(req);
  if (typeof b.family_id !== "string" || !(await roleIn(db, b.family_id))) throw new HttpError(403, "You are not in this family.");
  const message = String(b.message ?? "").trim().slice(0, 500);
  if (!message) throw new HttpError(400, "Say something to Pip first.");

  const admin = adminClient();
  const limit = Number(optionalEnv("AI_DAILY_LIMIT") ?? 80);
  const day = dayStr(new Date());
  const { data: use } = await admin.from("ai_usage").select("requests").eq("family_id", b.family_id).eq("day", day).maybeSingle();
  if ((use?.requests ?? 0) >= limit) return json({ limited: true });
  await admin.from("ai_usage").upsert({ family_id: b.family_id, day, requests: (use?.requests ?? 0) + 1 });

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env("ANTHROPIC_API_KEY"), "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: optionalEnv("PIP_MODEL") ?? "claude-haiku-5-5",
      max_tokens: 220,
      temperature: 0.6,
      system: b.mode === "feyn" ? PIP_FEYN_SYS : PIP_SYS,
      messages: cleanHistory(b.history, message),
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("anthropic", r.status, data?.error?.message);
    throw new HttpError(502, "Pip is resting. Please try again soon.");
  }
  // deno-lint-ignore no-explicit-any
  const reply = (data.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
  if (!reply) throw new HttpError(502, "Pip is resting. Please try again soon.");
  return json({ reply });
});

