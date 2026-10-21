# CaseStudyBot (x-case-study-bot)

Slack port of the Grok web project **"Creative Strategy Case Study Matchmaker"**.
Reps tag `@CaseStudyBot` in a channel (or DM it) with a brand, vertical,
product/strategy, or cultural moment, and it returns 3–5 case study decks —
exact title + exact Google Drive link — from the master Creative Strategy folder.

> @CaseStudyBot I want a Trend Genius case study for the CPG vertical

## How it works

```
Rep @mentions CaseStudyBot (channel, thread, or DM)
        |
        v
Live Google Drive listing of the master folder
  15I3CdBcBvQ9kUO_b7-mpausV3VzgWjQO -> vertical subfolders -> one Slides deck per case study
  (cached DRIVE_CACHE_TTL_MIN minutes, re-read on every request after that)
        |
        v
Grok pass 1 (shortlist): full live catalog (id + exact title, grouped by vertical)
  + the request -> up to 10 candidate file ids
        |
        v
Deck text exported for the candidates (Slides/Docs -> text/plain, truncated)
        |
        v
Grok pass 2 (matchmaker): files/system-prompt.txt + catalog + candidate text
  -> JSON { title, assumption, results[{file_id, summary, fit}], note, follow_ups }
        |
        v
Bot renders Slack mrkdwn using the exact name + webViewLink from the live index.
Any file_id Grok returns that is not in the live listing is dropped.
If Drive is unreachable/empty: "Case study folder unavailable or unreadable right now. Cannot surface case studies."
        |
        v
Reply posted in-thread under the rep's message
```

The Grok web project relied on Grok's built-in `google_drive_*` tools. Here the bot
calls the Drive API itself and feeds the results to Grok as a **LIVE FOLDER SNAPSHOT**
and **CANDIDATE DETAILS**, so the "live source only" constraint is enforced in code,
not just in the prompt: Grok never writes titles or URLs, only file ids.

Follow-ups work in-thread: mention the bot again under its reply ("give me 2 more",
"any in Travel instead?") and it loads the thread as context.

## Setup

### 1. Slack app

1. Go to https://api.slack.com/apps → **Create New App** → **From a manifest** → pick
   the workspace → paste `slack-manifest.json`.
2. **Basic Information → App-Level Tokens** → generate a token with `connections:write`
   → `SLACK_APP_TOKEN` (`xapp-...`). Needed for Socket Mode / local dev.
3. **Install App** → `SLACK_BOT_TOKEN` (`xoxb-...`).
4. **Basic Information → Signing Secret** → `SLACK_SIGNING_SECRET` (HTTP mode only).
5. Invite the bot to the channel(s): `/invite @CaseStudyBot`.

Manifest scopes: `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`
(thread context for follow-ups), `im:history`, `mpim:history`. Events: `app_mention`, `message.im`.

### 2. Google Drive access

The bot needs read access to the master folder. Two options:

**Option A — service account (recommended for a bot)**

1. In Google Cloud, create (or reuse) a project, enable the **Google Drive API**.
2. **IAM & Admin → Service Accounts → Create**, then **Keys → Add key → JSON**.
3. Share the case study folder
   (https://drive.google.com/drive/folders/15I3CdBcBvQ9kUO_b7-mpausV3VzgWjQO)
   with the service account's email as **Viewer**. (If the folder lives in a
   Shared Drive, add the service account as a member of that Shared Drive.)
4. Put the key in `.env`:

   ```bash
   # easiest for Render / single-line env vars
   GOOGLE_SERVICE_ACCOUNT_JSON_B64=$(base64 -i service-account.json | tr -d '\n')
   # or a path (local only)
   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
   ```

**Option B — OAuth refresh token for a human account**

Use when a service account can't be shared into the folder. Create an OAuth client
(Desktop) in Google Cloud, get a refresh token with scope
`https://www.googleapis.com/auth/drive.readonly` (e.g. via the OAuth Playground with
your own client credentials), then set `GOOGLE_OAUTH_CLIENT_ID`,
`GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`.

Verify access before touching Slack:

```bash
npm run check-drive            # prints verticals + every deck + link
npm run check-drive -- --sample  # also exports text from one deck
```

### 3. Environment variables

```bash
cp .env.example .env
```

| Variable | Required | Notes |
|---|---|---|
| `SLACK_BOT_TOKEN` | yes | `xoxb-...` |
| `SLACK_APP_TOKEN` | Socket Mode | `xapp-...` |
| `SLACK_SIGNING_SECRET` | HTTP mode | |
| `XAI_API_KEY` | yes | |
| `GROK_MODEL` | no | default `grok-4.3-latest` |
| `DRIVE_ROOT_FOLDER_ID` | no | defaults to the master folder |
| `GOOGLE_SERVICE_ACCOUNT_JSON_B64` / `GOOGLE_SERVICE_ACCOUNT_JSON` / `GOOGLE_APPLICATION_CREDENTIALS` | one of | service account key |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` / `_REFRESH_TOKEN` | alt | OAuth user creds |
| `DRIVE_CACHE_TTL_MIN` | no | folder listing cache, default 10 |
| `DRIVE_MAX_CONTENT_CHARS` | no | deck text per candidate, default 4000 |
| `MAX_CANDIDATES` | no | decks opened per request, default 10 |
| `SLACK_SOCKET_MODE` | no | `true` locally, `false` on Render |
| `PORT` | HTTP mode | set by Render |

### 4. Install & run

```bash
npm install
npm start
```

Try the pipeline without Slack:

```bash
npm run ask -- "Trend Genius case study for the CPG vertical"
```

## Request types (from the prompt)

| Ask | Behaviour |
|---|---|
| Brand (`something for Lays`) | Same vertical first, then adjacent, then strategic analogues — connection labelled |
| Strategy/product (`Trend Genius examples`, `notification case studies`) | Hard filter on that type; never mixes categories |
| Combined (`Trend Genius for CPG`) | Strategy is the hard filter, vertical ranks within it |
| Event/moment (`Super Bowl`) | Matches on the event context |
| Vertical (`travel case studies`) | Hard filter on the vertical folder, never padded |

Vertical folders: `CPG | Dining | FinServ | Gambling | Gaming | Luxury | M&E | Retail | Tech | Telco | Travel`
(the bot passes whatever folders actually exist in Drive at request time).

## Output

```
*Recommended Case Studies for Trend Genius – CPG*
_Assumption: ..._            (only when the ask was ambiguous)

1. *"Exact deck title"* — one-line summary (what the brand did + result)
    https://docs.google.com/presentation/d/...
2. ...

Only N exist in this category.   (only when fewer than asked / zero)
• targeted follow-up question
```

## Editing the prompt

`files/system-prompt.txt` is the original Grok prompt with the tool-usage section
rewritten for this pipeline. It is sent verbatim as the system message; the JSON
response contract is appended by `matchmaker.js`. Edit the file and restart.

## Local vs production

| Setting | Local | Render |
|---|---|---|
| `SLACK_SOCKET_MODE` | `true` | `false` |
| `SLACK_APP_TOKEN` | required | not needed |
| `SLACK_SIGNING_SECRET` | not needed | required |
| `PORT` | — | set by Render |

### Deploy to Render

1. Push to GitHub; create a **Web Service** from the repo (Render picks up `render.yaml`).
2. Add the secret env vars (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `XAI_API_KEY`,
   `GOOGLE_SERVICE_ACCOUNT_JSON_B64`).
3. In the Slack app: **Socket Mode → off**, **Event Subscriptions → Request URL**
   `https://<service>.onrender.com/slack/events`, re-subscribe to `app_mention` + `message.im`.

## Files

- `index.js` — Slack (Bolt) wiring: mentions, DMs, thread context, posting
- `matchmaker.js` — the pipeline: catalog → shortlist → deck text → final pick → render
- `drive.js` — Google Drive listing/export + caching
- `grok.js` — x.ai Responses API client + JSON parsing
- `files/system-prompt.txt` — the matchmaker prompt
- `scripts/check-drive.js`, `scripts/ask.js` — setup/debug helpers
- `slack-manifest.json`, `render.yaml` — app + deploy config
