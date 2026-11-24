// Payments are switched off while LahLahLearn is in its demo phase. Stripe has been removed.
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
Deno.serve((req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  return new Response(JSON.stringify({ error: "LahLahLearn is in its demo phase. Nothing can be bought yet." }), { status: 410, headers: { ...cors, "Content-Type": "application/json" } });
});
