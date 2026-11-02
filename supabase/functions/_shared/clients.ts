import { createClient, type SupabaseClient, type User } from "npm:@supabase/supabase-js@2.117.3";
import { env, HttpError } from "./http.ts";

/** Service-role client: bypasses row level security. Only use after checking who is asking. */
export function adminClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Client acting as the signed-in caller, so row level security applies. */
export function userClient(req: Request): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
}

export async function requireUser(req: Request): Promise<{ user: User; db: SupabaseClient }> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) throw new HttpError(401, "Please sign in again.");
  const db = userClient(req);
  const { data, error } = await db.auth.getUser(auth.slice(7));
  if (error || !data.user) throw new HttpError(401, "Please sign in again.");
  return { user: data.user, db };
}

/** The caller's role in a family, or null. Uses the caller's own permissions. */
export async function roleIn(db: SupabaseClient, familyId: string): Promise<string | null> {
  const { data, error } = await db.rpc("member_role", { fid: familyId });
  if (error) throw new HttpError(400, "Could not check your access to this family.");
  return (data as string | null) ?? null;
}

export async function requireParent(db: SupabaseClient, familyId: unknown): Promise<string> {
  if (typeof familyId !== "string" || !/^[0-9a-f-]{36}$/i.test(familyId)) throw new HttpError(400, "Missing family.");
  if ((await roleIn(db, familyId)) !== "parent") throw new HttpError(403, "Only a parent on this account can do that.");
  return familyId;
}
