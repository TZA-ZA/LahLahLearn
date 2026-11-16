// Admin page: see and change the AI settings without opening the Supabase dashboard.
//   GET                         -> which settings are set (secrets are never sent back, only their last 4 characters)
//   POST { name, value }        -> saves the setting in Supabase Vault (empty value removes it)
// Only profiles.is_admin or emails in ADMIN_EMAILS may call it. A function secret with the same name wins over Vault.
import { HttpError, json, optionalEnv, readJson, serveJson } from "../_shared/http.ts";
import { adminClient, requireUser } from "../_shared/clients.ts";

export const AI_SETTINGS: { name: string; label: string; secret: boolean; hint: string }[] = [
  { name: "ANTHROPIC_API_KEY", label: "Anthropic API key", secret: true, hint: "Starts with sk-ant-. Used by Pip AI." },
  { name: "PIP_MODEL", label: "Model for Pip Quick", secret: false, hint: "Leave empty for the default." },
  { name: "PIP_MODEL_SMART", label: "Model for Pip Smart", secret: false, hint: "Leave empty for the default." },
  { name: "PIP_MODEL_DEEP", label: "Model for Pip Deep", secret: false, hint: "Leave empty for the default." },
  { name: "AI_DAILY_LIMIT", label: "Answers per child per day", secret: false, hint: "A number. Leave empty for the default." },
];

export const handler = serveJson(async (req) => {
  const { user } = await requireUser(req);
  const admin = adminClient();
  const allow = (optionalEnv("ADMIN_EMAILS") ?? "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const { data: me } = await admin.from("profiles").select("is_admin").eq("id", user.id).maybeSingle();
  if (!me?.is_admin && !allow.includes((user.email ?? "").toLowerCase())) throw new HttpError(403, "This page is for the LahLahLearn team.");

  if (req.method === "POST") {
    const b = await readJson<{ name?: string; value?: string }>(req);
    const s = AI_SETTINGS.find((x) => x.name === b.name);
    if (!s) throw new HttpError(400, "That setting cannot be changed here.");
    const value = String(b.value ?? "").trim();
    if (value.length > 400) throw new HttpError(400, "That value is too long.");
    if (s.name === "ANTHROPIC_API_KEY" && value && !/^sk-ant-[A-Za-z0-9_\-]{20,}$/.test(value)) throw new HttpError(400, "That does not look like an Anthropic API key (it starts with sk-ant-).");
    if (s.name === "AI_DAILY_LIMIT" && value && !/^\d{1,4}$/.test(value)) throw new HttpError(400, "Please type a whole number.");
    const { error } = await admin.rpc("set_app_setting", { p_name: s.name, p_value: value });
    if (error) { console.error(error); throw new HttpError(500, "Could not save the setting."); }
  }

  const { data: vault } = await admin.rpc("get_app_settings");
  const v = (vault ?? {}) as Record<string, string>;
  return json({
    settings: AI_SETTINGS.map((s) => {
      const fromEnv = !!Deno.env.get(s.name), val = Deno.env.get(s.name) || v[s.name] || "";
      return { ...s, set: !!val, source: fromEnv ? "function secret" : val ? "admin page" : null, preview: !val ? "" : s.secret ? "••••" + val.slice(-4) : val };
    }),
  });
});
