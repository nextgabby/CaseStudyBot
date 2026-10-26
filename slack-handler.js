/* ───────────────────────────────────────────
   SLACK HANDLER (transport-agnostic)
   Used by api/slack/events.mjs (Vercel) and
   index.js (local Socket Mode dev runner).
   `client` is any @slack/web-api WebClient.
   ─────────────────────────────────────────── */
const { answerRequest } = require("./matchmaker");

const UI = {
  searching: ":mag: Searching the case study folder...",
  empty:
    "Tell me what you need — e.g. `@CaseStudyBot Trend Genius case study for the CPG vertical`, " +
    "`@CaseStudyBot something for Starlink`, or `@CaseStudyBot Super Bowl examples`.",
  error: (msg) => `:warning: CaseStudyBot hit an error and could not finish. ${msg}`,
};
const TRANSIENT_BOT_MSG = /^:mag:|^:warning:/;

// Dedup by event ts. Per-process only (each warm serverless instance has its
// own); Slack retries are additionally rejected at the HTTP layer.
const processed = new Set();
function markProcessed(ts) {
  processed.add(ts);
  if (processed.size > 500) processed.delete(processed.values().next().value);
}

function cleanText(text) {
  return (text || "")
    .replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isFromSelf(msg, self) {
  if (self.botId && msg.bot_id === self.botId) return true;
  if (self.userId && msg.user === self.userId) return true;
  return false;
}

/**
 * For follow-ups inside a thread, load the prior exchange so Grok knows what
 * has already been shown. Returns [{ role: "bot"|"user", text }].
 */
async function loadThreadContext(client, channel, threadTs, currentTs, self) {
  try {
    const res = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 40,
      inclusive: true,
    });
    const turns = [];
    for (const m of res.messages || []) {
      if (m.ts === currentTs) continue;
      if (!m.text) continue;
      const mine = isFromSelf(m, self);
      if (mine && TRANSIENT_BOT_MSG.test(m.text)) continue;
      if (!mine && m.bot_id) continue; // other bots / workflow posts
      const text = cleanText(m.text).slice(0, 1500);
      if (!text) continue;
      turns.push({ role: mine ? "bot" : "user", text });
    }
    return turns.slice(-12);
  } catch (err) {
    console.warn(`[slack] Could not load thread context: ${err.message}`);
    return [];
  }
}

// chat.update rejects payloads over ~4000 bytes — split on result boundaries if needed.
const SLACK_MAX_BYTES = 3500;
function chunkText(text) {
  if (Buffer.byteLength(text, "utf8") <= SLACK_MAX_BYTES) return [text];
  const chunks = [];
  let current = "";
  for (const para of text.split(/\n(?=\d+\. \*)/)) {
    const candidate = current ? `${current}\n${para}` : para;
    if (Buffer.byteLength(candidate, "utf8") > SLACK_MAX_BYTES && current) {
      chunks.push(current);
      current = para;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function postResult(client, channel, threadTs, thinkingTs, text) {
  const chunks = chunkText(text);
  await client.chat.update({
    channel,
    ts: thinkingTs,
    text: chunks[0],
    unfurl_links: false,
    unfurl_media: false,
  });
  for (let i = 1; i < chunks.length; i++) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: chunks[i],
      unfurl_links: false,
      unfurl_media: false,
    });
  }
}

/**
 * Handle one Slack event (app_mention or DM message).
 * @param {object} event   Slack event payload
 * @param {object} client  WebClient
 * @param {{userId?: string, botId?: string}} self  the bot's own identity
 */
async function handleRequest(event, client, self = {}) {
  if (processed.has(event.ts)) return;
  markProcessed(event.ts);

  const request = cleanText(event.text);
  const threadTs = event.thread_ts || event.ts;

  if (!request) {
    await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: UI.empty });
    return;
  }

  console.log(`[request] <@${event.user}> in ${event.channel}: "${request}"`);
  const started = Date.now();

  let thinking;
  try {
    thinking = await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: UI.searching,
    });

    const conversation =
      event.thread_ts && event.thread_ts !== event.ts
        ? await loadThreadContext(client, event.channel, event.thread_ts, event.ts, self)
        : [];

    const { text, ok, results } = await answerRequest({ request, conversation });
    await postResult(client, event.channel, threadTs, thinking.ts, text);
    console.log(
      `[request] done in ${Date.now() - started}ms — ${ok ? `${results.length} result(s)` : "no results"}`
    );
  } catch (err) {
    console.error("[request] error:", err);
    const text = UI.error(`Error: ${err.message}`);
    if (thinking) {
      await client.chat.update({ channel: event.channel, ts: thinking.ts, text }).catch(() => {});
    } else {
      await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text }).catch(() => {});
    }
  }
}

/**
 * Route a Slack Events API payload to the handler. Returns true if handled.
 */
async function dispatchEvent(body, client) {
  const event = body.event || {};
  const self = {
    userId: (body.authorizations && body.authorizations[0] && body.authorizations[0].user_id) || null,
    botId: null,
  };

  if (event.type === "app_mention") {
    if (isFromSelf(event, self)) return false;
    await handleRequest(event, client, self);
    return true;
  }
  if (event.type === "message" && event.channel_type === "im") {
    if (event.subtype || event.bot_id || isFromSelf(event, self)) return false;
    await handleRequest(event, client, self);
    return true;
  }
  return false;
}

module.exports = { handleRequest, dispatchEvent, isFromSelf, UI };
