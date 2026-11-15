// Edge Function: CoChatAI (Google AI Studio / Gemini)
// Secrets: GEMINI_API_KEY (Pflicht), GEMINI_MODEL (optional, Standard gemini-2.5-flash)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url = Deno.env.get("SUPABASE_URL")!;
  const authHeader = req.headers.get("Authorization") ?? "";

  // Nutzer anhand des JWT bestimmen
  const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "Nicht angemeldet" }, 401);

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Die letzte Nutzer-Nachricht liegt bereits in ai_messages; Verlauf laden
  const { data: rows, error } = await admin
    .from("ai_messages").select("role, content")
    .eq("user_id", user.id).order("created_at", { ascending: false }).limit(20);
  if (error) return json({ error: error.message }, 500);
  const history = (rows ?? []).reverse();
  if (!history.length || history[history.length - 1].role !== "user") {
    return json({ error: "Keine Nutzer-Nachricht vorhanden" }, 400);
  }

  const model = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.5-flash";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": Deno.env.get("GEMINI_API_KEY")! },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: "Du bist CoChatAI, der freundliche Assistent in der Messenger-App CoChat. Antworte knapp, hilfreich und in der Sprache des Nutzers." }],
        },
        contents: history.map((m) => ({ role: m.role, parts: [{ text: m.content }] })),
      }),
    },
  );
  if (!res.ok) {
    const t = await res.text();
    console.error("Gemini-Fehler", res.status, t);
    await admin.from("ai_messages").insert({
      user_id: user.id, role: "model",
      content: "⚠️ CoChatAI ist gerade nicht erreichbar. Bitte versuche es später erneut.",
    });
    return json({ error: "Gemini-Fehler" }, 502);
  }
  const out = await res.json();
  const text = out?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("")
    || "Dazu habe ich leider keine Antwort.";

  await admin.from("ai_messages").insert({ user_id: user.id, role: "model", content: text });
  return json({ ok: true });
});
