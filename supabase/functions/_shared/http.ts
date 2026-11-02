// Small HTTP helpers shared by every function.
export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

/** Wraps a handler with CORS, OPTIONS handling and friendly error responses. */
export function serveJson(handler: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    try {
      return await handler(req);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Something went wrong. Please try again." }, 500);
    }
  };
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  try { return (await req.json()) as T; } catch { throw new HttpError(400, "Expected a JSON body."); }
}

export function env(name: string, fallback?: string): string {
  const v = Deno.env.get(name);
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new HttpError(500, `Server is missing the ${name} setting.`);
  }
  return v;
}

export const optionalEnv = (name: string): string | undefined => {
  const v = Deno.env.get(name);
  return v === undefined || v === "" ? undefined : v;
};

export const isEmail = (s: unknown): s is string =>
  typeof s === "string" && s.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
