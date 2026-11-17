// Sous assistant — multi-turn AI for the Today tab.
// Accepts { message, board, history } and returns { say, actions, drafts }.
// The board is a plain-text snapshot of active leads, built client-side.
// History is kept client-side (last 10 turns) so the function stays stateless.
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const BUYER_STAGES  = "New Lead, Contacted, Consultation, Active Search, Agreement Signed, Offer Submitted, Subjects, Closed";
const SELLER_STAGES = "New Lead, Contacted, Listing Appointment, Listed, Offer Received, Subjects, Completed";

function systemPrompt(board: string): string {
  return `You are Sous, the assistant inside Realtor OS, Chris's personal CRM for his real estate business in Vancouver, BC.

YOUR VOICE (the "say" field): short, direct, plain English, 1–3 sentences. No cheerleading, no emojis. Never claim anything is saved — you only propose and he taps Apply.

WHAT YOU DO: Turn what Chris tells you into proposed card updates (actions), draft client messages when asked, or answer questions about his leads.

RULES FOR ACTIONS
- lead_id must be a numeric id from the LEADS list. Never invent a lead.
- If a name is ambiguous (matches more than one lead), propose nothing and ask in "say".
- Propose only what Chris said or clearly implied.
- Dates: use the DATES table. "Friday" = next Friday. "next week" with no day = next Monday. Never before today.
- Action types:
  {"type":"log_activity","lead_id":123,"kind":"called|texted|emailed|voicemail|no_answer|met|showing|sent_listings|sent_comps|note","note":"short factual line"}
  {"type":"set_followup","lead_id":123,"date":"YYYY-MM-DD"}
  {"type":"set_stage","lead_id":123,"stage":"exact stage name"}
  {"type":"add_appointment","lead_id":123,"appt_type":"showing|appointment","date":"YYYY-MM-DD","time":"HH:MM 24h, only if stated","address":"as stated"}
  {"type":"add_note","lead_id":123,"note":"a lasting fact about this person"}
  {"type":"snooze","lead_id":123,"days":14}
  {"type":"set_priority","lead_id":123,"priority":"hot|warm|cold"}
- Buyer stages: ${BUYER_STAGES}
- Seller stages: ${SELLER_STAGES}

RULES FOR DRAFTS (real clients will read these; write as Chris, friendly, casual, short)
- {"lead_id":123,"channel":"text|email","subject":"email only","body":"..."}
- Text: 2 sentences max, under 30 words, first name only, no sign-off.
- Never: "touching base", "checking in", "hope you're well", "excited", "amazing". No em dashes.
- Missing detail: use a [bracketed placeholder].

Respond with ONLY a single JSON object, no markdown fences: {"say":"...","actions":[...],"drafts":[...]}

${board}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user) return json({ error: { message: "Not signed in" } }, 401);

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return json({ error: { message: "ANTHROPIC_API_KEY secret is not set" } }, 500);

  try {
    const { message, board = "", history = [] } = await req.json();
    if (typeof message !== "string" || !message.trim()) {
      return json({ error: { message: "message is required" } }, 400);
    }

    // history is [{role:"user"|"assistant", content:string}], capped by caller to last 10 turns
    const messages = [
      ...(Array.isArray(history) ? history : []).slice(-18),
      { role: "user", content: message },
    ];

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: systemPrompt(typeof board === "string" ? board : ""),
        messages,
      }),
    });

    const raw = await res.json();
    if (!res.ok) {
      const msg = raw?.error?.message || `API error ${res.status}`;
      return json({ say: msg, actions: [], drafts: [] }, 200);
    }

    const text = raw?.content?.[0]?.text ?? "";
    const cleaned = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
    try {
      return json(JSON.parse(cleaned));
    } catch {
      return json({ say: "Couldn't parse that response. Try again.", actions: [], drafts: [] });
    }
  } catch (e) {
    console.error("assistant error:", e);
    return json({ say: "Something went wrong. Try again.", actions: [], drafts: [] }, 500);
  }
});
