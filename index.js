/* ───────────────────────────────────────────
   LOCAL DEV RUNNER (Socket Mode)
   Production runs on Vercel via api/slack/events.mjs.
   This file lets you run the same handler from your
   laptop without a public URL: `npm run dev`.
   ─────────────────────────────────────────── */
require("dotenv").config();
const { App } = require("@slack/bolt");
const drive = require("./drive");
const grok = require("./grok");
const { handleRequest, isFromSelf } = require("./slack-handler");

const { SLACK_BOT_TOKEN, SLACK_APP_TOKEN } = process.env;

for (const [name, value] of Object.entries({
  SLACK_BOT_TOKEN,
  SLACK_APP_TOKEN,
  XAI_API_KEY: process.env.XAI_API_KEY,
})) {
  if (!value) {
    console.error(`Missing required env var ${name} for local Socket Mode (see .env.example)`);
    process.exit(1);
  }
}

const app = new App({ token: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN, socketMode: true });
const self = { userId: null, botId: null };

app.event("app_mention", async ({ event, client }) => {
  if (isFromSelf(event, self)) return;
  await handleRequest(event, client, self);
});

app.event("message", async ({ event, client }) => {
  if (event.channel_type !== "im") return;
  if (event.subtype || event.bot_id || isFromSelf(event, self)) return;
  await handleRequest(event, client, self);
});

(async () => {
  try {
    const auth = await app.client.auth.test({ token: SLACK_BOT_TOKEN });
    self.userId = auth.user_id;
    self.botId = auth.bot_id;
    console.log(`[startup] Slack identity: user_id=${self.userId} bot_id=${self.botId} team=${auth.team}`);
  } catch (err) {
    console.error("[startup] auth.test failed:", err.message);
  }

  await app.start();
  console.log(`CaseStudyBot (local Socket Mode) | model=${grok.GROK_MODEL} | folder=${drive.ROOT_FOLDER_ID}`);

  drive
    .getIndex()
    .then((idx) =>
      console.log(`[startup] Drive auth: ${drive.describeAuth()} | verticals: ${idx.verticals.join(", ") || "(none)"}`)
    )
    .catch((err) => console.error(`[startup] Drive index warm-up failed: ${err.message}`));
})();
