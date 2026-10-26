/* ───────────────────────────────────────────
   VERCEL FUNCTION — Slack Events API endpoint
   POST /api/slack/events

   Slack requires a 200 within 3 seconds; the
   matchmaker takes ~20-40s. We verify the
   signature, ack immediately, and finish the
   work with waitUntil() (Fluid compute keeps
   the instance alive after the response).
   ─────────────────────────────────────────── */
import { createHmac, timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { WebClient } from "@slack/web-api";
import { dispatchEvent } from "../../slack-handler.js";

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const MAX_SKEW_SECONDS = 60 * 5;

let _client = null;
function slack() {
  if (!_client) _client = new WebClient(BOT_TOKEN);
  return _client;
}
/** Test seam: swap the Slack client (not used in production). */
export function __setSlackClient(client) {
  _client = client;
}

function verifySignature(rawBody, headers) {
  if (!SIGNING_SECRET) return { ok: false, reason: "SLACK_SIGNING_SECRET not set" };
  const ts = headers.get("x-slack-request-timestamp");
  const sig = headers.get("x-slack-signature");
  if (!ts || !sig) return { ok: false, reason: "missing signature headers" };
  if (Math.abs(Date.now() / 1000 - Number(ts)) > MAX_SKEW_SECONDS) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }
  const expected =
    "v0=" + createHmac("sha256", SIGNING_SECRET).update(`v0:${ts}:${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}

export async function GET() {
  return new Response("CaseStudyBot ok", { status: 200 });
}

export async function POST(request) {
  const rawBody = await request.text();

  const verified = verifySignature(rawBody, request.headers);
  if (!verified.ok) {
    console.warn(`[slack] rejected request: ${verified.reason}`);
    return new Response("invalid signature", { status: 401 });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // One-time URL verification when the Request URL is set in the Slack app config
  if (body.type === "url_verification") {
    return new Response(body.challenge, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  // Slack retries if it doesn't get a 200 within 3s. We always ack fast, so a
  // retry means the original is already being processed — never process twice.
  if (request.headers.get("x-slack-retry-num")) {
    return new Response("", { status: 200, headers: { "x-slack-no-retry": "1" } });
  }

  if (body.type === "event_callback") {
    waitUntil(
      dispatchEvent(body, slack()).catch((err) =>
        console.error("[slack] unhandled error:", err)
      )
    );
  }

  return new Response("", { status: 200 });
}
