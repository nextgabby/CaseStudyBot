/* ───────────────────────────────────────────
   GROK (x.ai Responses API)
   Same transport as creative-botline-connector.
   ─────────────────────────────────────────── */
const XAI_BASE = "https://api.x.ai/v1";
const GROK_MODEL = process.env.GROK_MODEL || "grok-4.3-latest";

function apiKey() {
  const key = process.env.XAI_API_KEY;
  if (!key) throw new Error("XAI_API_KEY is not set");
  return key;
}

/**
 * Send a system + user turn to Grok and return the output text.
 * @param {string} system
 * @param {string|Array} user  plain text or Responses API content array
 */
async function ask(system, user, { max_output_tokens = 4000, temperature = 0.3 } = {}) {
  const content = typeof user === "string" ? [{ type: "input_text", text: user }] : user;
  const resp = await fetch(`${XAI_BASE}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROK_MODEL,
      input: [
        { role: "system", content: system },
        { role: "user", content },
      ],
      max_output_tokens,
      temperature,
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`Grok API ${resp.status}: ${errBody}`);
  }

  const data = await resp.json();
  const outputMsg = (data.output || []).find((o) => o.type === "message");
  if (!outputMsg) throw new Error("No message in Grok response");
  const textBlock = (outputMsg.content || []).find((c) => c.type === "output_text");
  if (!textBlock) throw new Error("No output_text in Grok response");
  return textBlock.text;
}

/**
 * Pull the first JSON object out of a model reply (tolerates ```json fences
 * and leading/trailing prose).
 */
function parseJson(text) {
  if (!text) throw new Error("Empty model output");
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error(`Model did not return JSON: ${t.slice(0, 200)}`);
    }
    return JSON.parse(t.slice(start, end + 1));
  }
}

module.exports = { ask, parseJson, GROK_MODEL };
