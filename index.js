require("dotenv").config();
const { App, ExpressReceiver } = require("@slack/bolt");
const drive = require("./drive");
const grok = require("./grok");
const { answerRequest } = require("./matchmaker");

/* ───────────────────────────────────────────
   ENV
   ─────────────────────────────────────────── */
const {
  SLACK_BOT_TOKEN,
  SLACK_APP_TOKEN,
  SLACK_SIGNING_SECRET,
  PORT = "3000",
} = process.env;

const SOCKET_MODE = process.env.SLACK_SOCKET_MODE !== "false"; // default true

for (const [name, value] of Object.entries({ SLACK_BOT_TOKEN, XAI_API_KEY: process.env.XAI_API_KEY })) {
  if (!value) {
    console.error(`Missing required env var ${name} (see .env.example)`);
    process.exit(1);
  }
}
if (SOCKET_MODE && !SLACK_APP_TOKEN) {
  console.error("SLACK_APP_TOKEN is required in Socket Mode (or set SLACK_SOCKET_MODE=false)");
  process.exit(1);
}
if (!SOCKET_MODE && !SLACK_SIGNING_SECRET) {
  console.error("SLACK_SIGNING_SECRET is required in HTTP mode");
  process.exit(1);
}

/* ───────────────────────────────────────────
   SLACK APP INIT
   ─────────────────────────────────────────── */
let appOptions;
let receiver = null;

if (SOCKET_MODE) {
  appOptions = { token: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN, socketMode: true };
} else {
  receiver = new ExpressReceiver({
    signingSecret: SLACK_SIGNING_SECRET,
    endpoints: "/slack/events",
  });
  // Health check for Render
  receiver.router.get(["/", "/healthz"], (_req, res) => res.status(200).send("CaseStudyBot ok"));
  appOptions = { token: SLACK_BOT_TOKEN, receiver };
}

const app = new App(appOptions);

// Resolved at startup via auth.test
let SELF_USER_ID = process.env.BOT_USER_ID || null;
let SELF_BOT_ID = null;

/* ───────────────────────────────────────────
   UI COPY
   ─────────────────────────────────────────── */
const UI = {
  searching: ":mag: Searching the case study folder...",
  empty:
    "Tell me what you need — e.g. `@CaseStudyBot Trend Genius case study for the CPG vertical`, " +
    "`@CaseStudyBot something for Starlink`, or `@CaseStudyBot Super Bowl examples`.",
  error: (msg) => `:warning: CaseStudyBot hit an error and could not finish. ${msg}`,
};
const TRANSIENT_BOT_MSG = /^:mag:|^:warning:/;

/* ───────────────────────────────────────────
   HELPERS
   ─────────────────────────────────────────── */
const processed = new Set(); // dedup by ts
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

function isFromSelf(msg) {
  if (SELF_BOT_ID && msg.bot_id === SELF_BOT_ID) return true;
  if (SELF_USER_ID && msg.user === SELF_USER_ID) return true;
  return false;
}

/**
 * For follow-ups inside a thread, load the prior exchange so Grok knows what
 * has already been shown. Returns [{ role: "bot"|"user", text }].
 */
async function loadThreadContext(client, channel, threadTs, currentTs) {
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
      const self = isFromSelf(m);
      if (self && TRANSIENT_BOT_MSG.test(m.text)) continue;
      if (!self && m.bot_id) continue; // other bots / workflow posts
      const text = cleanText(m.text).slice(0, 1500);
      if (!text) continue;
      turns.push({ role: self ? "bot" : "user", text });
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

/* ───────────────────────────────────────────
   REQUEST HANDLER (mentions + DMs)
   ─────────────────────────────────────────── */
async function handleRequest(event, client) {
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
        ? await loadThreadContext(client, event.channel, event.thread_ts, event.ts)
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

/* ───────────────────────────────────────────
   EVENTS
   ─────────────────────────────────────────── */
// @CaseStudyBot in any channel the bot has been invited to (top level or in a thread)
app.event("app_mention", async ({ event, client }) => {
  if (isFromSelf(event)) return;
  await handleRequest(event, client);
});

// Direct messages to the bot (no @mention needed)
app.event("message", async ({ event, client }) => {
  if (event.channel_type !== "im") return;
  if (event.subtype || event.bot_id || isFromSelf(event)) return;
  await handleRequest(event, client);
});

/* ───────────────────────────────────────────
   START
   ─────────────────────────────────────────── */
(async () => {
  try {
    const auth = await app.client.auth.test({ token: SLACK_BOT_TOKEN });
    SELF_BOT_ID = auth.bot_id;
    SELF_USER_ID = auth.user_id;
    console.log(`[startup] Slack identity: user_id=${SELF_USER_ID} bot_id=${SELF_BOT_ID} team=${auth.team}`);
  } catch (err) {
    console.error("[startup] auth.test failed:", err.message);
  }

  const port = SOCKET_MODE ? undefined : parseInt(PORT, 10);
  await app.start(port);
  console.log(
    `CaseStudyBot is running (${SOCKET_MODE ? "Socket Mode" : `HTTP :${PORT}`}) | model=${grok.GROK_MODEL} | folder=${drive.ROOT_FOLDER_ID}`
  );

  // Warm the Drive index so the first request is fast; failures are logged, not fatal.
  drive
    .getIndex()
    .then((idx) =>
      console.log(
        `[startup] Drive auth: ${drive.describeAuth()} | verticals: ${idx.verticals.join(", ") || "(none)"}`
      )
    )
    .catch((err) => console.error(`[startup] Drive index warm-up failed: ${err.message}`));
})();
