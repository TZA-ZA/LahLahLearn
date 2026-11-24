// Stripe has been removed while LahLahLearn is in its demo phase. Any webhook call is refused.
Deno.serve(() => new Response(JSON.stringify({ error: "Payments are switched off." }), { status: 410, headers: { "Content-Type": "application/json" } }));
