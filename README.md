# CaseStudyBot (x-case-study-bot)

Slack port of the Grok web project **"Creative Strategy Case Study Matchmaker"**.
Reps tag `@CaseStudyBot` in a channel (or DM it) with a brand, vertical,
product/strategy, or cultural moment, and it returns 3–5 case study decks —
exact title + exact Google Drive link — from the master Creative Strategy folder.

> @CaseStudyBot I want a Trend Genius case study for the CPG vertical

Runs on **Vercel** (serverless function) with **keyless** Google Drive access via
Workload Identity Federation. No service account key anywhere.

## How it works

```
Rep @mentions CaseStudyBot (channel, thread, or DM)
        |
        v
Slack POSTs the event to  https://<app>.vercel.app/api/slack/events
  -> signature verified, 200 returned in milliseconds (Slack needs <3s)
  -> the real work continues in the background (waitUntil)
        |
        v
Live Google Drive listing of the master folder
  15I3CdBcBvQ9kUO_b7-mpausV3VzgWjQO -> vertical subfolders -> one Slides deck per case study
  (auth: Vercel OIDC token -> GCP STS -> short-lived token for the service account)
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
Reply posted in-thread under the rep's message (":mag: Searching..." is edited into the answer)
```

The Grok web project relied on Grok's built-in `google_drive_*` tools. Here the bot
calls the Drive API itself and feeds the results to Grok as a **LIVE FOLDER SNAPSHOT**
and **CANDIDATE DETAILS**, so the "live source only" constraint is enforced in code,
not just in the prompt: Grok never writes titles or URLs, only file ids.

Follow-ups work in-thread: mention the bot again under its reply ("give me 2 more",
"any in Travel instead?") and it loads the thread as context.

## Setup

### 1. Slack app

1. https://api.slack.com/apps → **Create New App** → **From a manifest** → pick the
   workspace → paste `slack-manifest.json`. (At X this install needs IT approval — open
   a `#it-help` ticket referencing the manifest.)
2. **Install App** → `SLACK_BOT_TOKEN` (`xoxb-...`).
3. **Basic Information → Signing Secret** → `SLACK_SIGNING_SECRET`.
4. For local dev only: **Basic Information → App-Level Tokens** → generate with
   `connections:write` → `SLACK_APP_TOKEN` (`xapp-...`).
5. After the Vercel deploy (step 3): **Socket Mode → off**, **Event Subscriptions →
   Request URL** = `https://<app>.vercel.app/api/slack/events` (should show "Verified"),
   confirm bot events `app_mention` + `message.im`, Save, reinstall if prompted.
6. Invite the bot: `/invite @CaseStudyBot`.

### 2. Google Cloud (keyless via Workload Identity Federation)

Done once in the GCP project (`xai-dev-casestudybot`). Needs Editor on the project
(or Security does it). Replace `TEAM_SLUG` with the Vercel team slug (Vercel →
Settings → General).

```bash
PROJECT=xai-dev-casestudybot
TEAM_SLUG=<vercel-team-slug>
gcloud config set project $PROJECT
PROJECT_NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')

# APIs
gcloud services enable drive.googleapis.com iamcredentials.googleapis.com sts.googleapis.com

# Service account (no project roles needed)
gcloud iam service-accounts create casestudybot --display-name="CaseStudyBot (Slack)"
SA=casestudybot@$PROJECT.iam.gserviceaccount.com

# Workload identity pool + Vercel OIDC provider
gcloud iam workload-identity-pools create vercel --location=global --display-name="Vercel"
gcloud iam workload-identity-pools providers create-oidc vercel \
  --location=global --workload-identity-pool=vercel \
  --issuer-uri="https://oidc.vercel.com/$TEAM_SLUG" \
  --allowed-audiences="https://vercel.com/$TEAM_SLUG" \
  --attribute-mapping="google.subject=assertion.sub,attribute.project=assertion.project,attribute.environment=assertion.environment" \
  --attribute-condition="assertion.project == 'x-case-study-bot'"   # Vercel project name

# Let tokens from that pool impersonate the SA
gcloud iam service-accounts add-iam-policy-binding $SA \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/vercel/attribute.project/x-case-study-bot"

echo "GCP_WORKLOAD_IDENTITY_AUDIENCE=//iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/vercel/providers/vercel"
echo "GCP_SERVICE_ACCOUNT_EMAIL=$SA"
```

Then share the case study folder
(https://drive.google.com/drive/folders/15I3CdBcBvQ9kUO_b7-mpausV3VzgWjQO) with
`casestudybot@xai-dev-casestudybot.iam.gserviceaccount.com` as **Viewer**. If the
folder lives in a Shared Drive, add the SA as a Shared Drive member instead.

Vercel side: the project needs **Settings → Security → Secure Backend Access with OIDC
Federation** set to *Team* (issuer `https://oidc.vercel.com/<team>`). That matches the
provider above.

### 3. Vercel

1. Vercel → **Add New → Project** → import `nextgabby/CaseStudyBot`. Framework preset:
   *Other*. No build command. Node 20+. Leave **Fluid compute** on (needed for
   background work after the ack).
2. **Environment Variables** (Production):

   | Key | Value |
   |---|---|
   | `SLACK_BOT_TOKEN` | `xoxb-...` |
   | `SLACK_SIGNING_SECRET` | from Slack app |
   | `XAI_API_KEY` | `xai-...` |
   | `GCP_WORKLOAD_IDENTITY_AUDIENCE` | printed by the script above |
   | `GCP_SERVICE_ACCOUNT_EMAIL` | `casestudybot@xai-dev-casestudybot.iam.gserviceaccount.com` |
   | `DRIVE_ROOT_FOLDER_ID` | optional, defaults to the master folder |

3. Deploy. `GET https://<app>.vercel.app/api/slack/events` should return `CaseStudyBot ok`.
4. Finish Slack step 1.5 (Request URL) and test:
   `@CaseStudyBot Trend Genius case study for the CPG vertical`.

`vercel.json` sets `maxDuration: 300` for the function (Grok two-pass takes ~20–40s;
Enterprise allows up to 800).

### 4. Local development

```bash
cp .env.example .env     # fill SLACK_BOT_TOKEN, SLACK_APP_TOKEN, XAI_API_KEY
npm install
# Drive access locally = your own Google login (ADC), no key:
gcloud auth application-default login \
  --scopes=https://www.googleapis.com/auth/drive.readonly,https://www.googleapis.com/auth/cloud-platform
npm run check-drive      # prints verticals + every deck + link
npm run ask -- "Trend Genius case study for the CPG vertical"   # pipeline, no Slack
npm run dev              # Socket Mode — same handler as production, no public URL needed
```

(`vercel dev` also works for exercising `api/slack/events.mjs` locally; `vercel env pull`
gives you `VERCEL_OIDC_TOKEN` so WIF works from your laptop too.)

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `SLACK_BOT_TOKEN` | yes | `xoxb-...` |
| `SLACK_SIGNING_SECRET` | Vercel | verifies Slack requests |
| `SLACK_APP_TOKEN` | local dev | `xapp-...`, Socket Mode only |
| `XAI_API_KEY` | yes | |
| `GCP_WORKLOAD_IDENTITY_AUDIENCE` + `GCP_SERVICE_ACCOUNT_EMAIL` | Vercel | keyless Drive auth |
| `GOOGLE_SERVICE_ACCOUNT_JSON_B64` / `GOOGLE_APPLICATION_CREDENTIALS` | alt | SA key — only with an org-policy exemption |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` / `_REFRESH_TOKEN` | alt | OAuth user creds |
| *(none of the Google vars)* | local | Application Default Credentials (`gcloud auth application-default login`) |
| `GROK_MODEL` | no | default `grok-4.3-latest` |
| `DRIVE_ROOT_FOLDER_ID` | no | defaults to the master folder |
| `DRIVE_CACHE_TTL_MIN` | no | folder listing cache per warm instance, default 10 |
| `DRIVE_MAX_CONTENT_CHARS` | no | deck text per candidate, default 4000 |
| `MAX_CANDIDATES` | no | decks opened per request, default 10 |

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
response contract is appended by `matchmaker.js`. Edit, commit, push — Vercel redeploys.

## Files

- `api/slack/events.mjs` — Vercel function: Slack signature check, URL challenge, instant ack, background dispatch
- `slack-handler.js` — transport-agnostic handling: thread context, posting, chunking, dedup
- `matchmaker.js` — the pipeline: catalog → shortlist → deck text → final pick → render
- `drive.js` — Google Drive listing/export + caching; auth via WIF / ADC / key / OAuth
- `grok.js` — x.ai Responses API client + JSON parsing
- `index.js` — local Socket Mode dev runner (same handler)
- `files/system-prompt.txt` — the matchmaker prompt
- `scripts/check-drive.js`, `scripts/ask.js` — setup/debug helpers
- `slack-manifest.json`, `vercel.json` — app + deploy config

## Notes

- Dedup is per warm instance; Slack retries are rejected at the HTTP layer
  (`x-slack-retry-num`), so a slow response never produces a duplicate answer.
- The Drive index cache lives in the warm instance. A cold instance re-lists the
  folder (a few seconds) on its first request.
