/* ───────────────────────────────────────────
   MATCHMAKER PIPELINE
   request → live Drive index → Grok shortlist →
   deck text for shortlist → Grok final pick (JSON)
   → Slack mrkdwn rendered from the live index.

   Grok never writes titles or links. It returns
   file ids; we attach the exact name + webViewLink
   from this turn's Drive listing. Anything it
   returns that is not in the listing is dropped.
   ─────────────────────────────────────────── */
const { readFileSync } = require("fs");
const { join } = require("path");
const drive = require("./drive");
const grok = require("./grok");

const UNAVAILABLE_MSG =
  "Case study folder unavailable or unreadable right now. Cannot surface case studies.";

const MAX_CANDIDATES = parseInt(process.env.MAX_CANDIDATES || "10", 10);
const MAX_RESULTS = 5;

const PROMPT_PATH = join(__dirname, "files", "system-prompt.txt");
let SYSTEM_PROMPT;
try {
  SYSTEM_PROMPT = readFileSync(PROMPT_PATH, "utf-8").trim();
} catch (err) {
  console.error(`Failed to load system prompt from ${PROMPT_PATH}:`, err.message);
  process.exit(1);
}

/* ───────────────────────────────────────────
   PROMPT BUILDING BLOCKS
   ─────────────────────────────────────────── */
function formatCatalog(index) {
  const byVertical = new Map();
  for (const f of index.files) {
    if (!byVertical.has(f.vertical)) byVertical.set(f.vertical, []);
    byVertical.get(f.vertical).push(f);
  }
  const lines = [
    `LIVE FOLDER SNAPSHOT — "${index.rootName}" (read from Google Drive just now)`,
    `Vertical folders present: ${index.verticals.join(" | ") || "(none)"}`,
    `Total case study files: ${index.files.length}`,
    "",
  ];
  for (const [vertical, files] of byVertical) {
    lines.push(`## ${vertical} (${files.length})`);
    for (const f of files) {
      const sub = f.path && f.path !== f.vertical ? ` [${f.path}]` : "";
      const kind = f.mimeType === drive.MIME.SLIDES ? "" : ` (${shortMime(f.mimeType)})`;
      lines.push(`- id=${f.id} | "${f.name}"${sub}${kind}`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function shortMime(m) {
  if (m === drive.MIME.PDF) return "PDF";
  if (m === drive.MIME.DOC) return "Google Doc";
  if (m === drive.MIME.PPTX || m === drive.MIME.PPT) return "PowerPoint";
  if (m === drive.MIME.KEY) return "Keynote";
  return m;
}

function formatConversation(conversation) {
  if (!conversation || !conversation.length) return "";
  const lines = ["CONVERSATION SO FAR (this Slack thread, oldest first):"];
  for (const turn of conversation) {
    const who = turn.role === "bot" ? "CaseStudyBot" : "Rep";
    lines.push(`[${who}] ${turn.text}`);
  }
  return lines.join("\n");
}

function formatCandidates(candidates) {
  if (!candidates.length) return "CANDIDATE DETAILS: (none shortlisted — rely on titles in the snapshot)";
  const lines = ["CANDIDATE DETAILS (text exported from the shortlisted decks this turn):"];
  for (const c of candidates) {
    lines.push("");
    lines.push(`### id=${c.id} | "${c.name}" | vertical: ${c.vertical}`);
    lines.push(c.excerpt ? c.excerpt : "(no text available — summarize from the exact title only)");
  }
  return lines.join("\n");
}

const SHORTLIST_SYSTEM = `You are the retrieval stage for CaseStudyBot, which matches X sales reps to case study decks.
You receive a rep's request and a LIVE FOLDER SNAPSHOT: every case study file in the master Google Drive folder, grouped by vertical folder, each with an id and exact title.

Pick the files worth opening to answer the request. Think about the request type:
- Brand request → same vertical first, then adjacent verticals, then strategic analogues.
- Strategy/product request (Trend Genius, Notification/Arrow/push/alert/Scheduled Notifs, Amplify, Takeover, etc.) → ONLY files whose title signals that product/strategy. Do not pad with other types.
- Combined (strategy + brand/vertical) → strategy is a hard filter; brand/vertical ranks within it.
- Event/moment → match the event/moment in the title.
- Vertical request → ONLY files in that vertical folder. Never pad with adjacent verticals.
Titles are the only signal at this stage — be generous with plausible matches (up to the limit) because the next stage reads the decks and makes the final call.

Return ONLY valid JSON, no markdown, no commentary:
{"candidate_ids": ["<id>", ...], "reading": "<one clause: how you interpreted the request>"}
candidate_ids must be ids copied exactly from the snapshot, best first, max LIMIT entries. Return an empty array if nothing in the snapshot plausibly fits.`;

const RESPONSE_CONTRACT = `RESPONSE CONTRACT (the bot renders your JSON into Slack — follow it exactly)
Return ONLY valid JSON, no markdown fences, no commentary:
{
  "status": "ok" | "no_match" | "unavailable",
  "title": "Recommended Case Studies for <the request, as understood>",
  "assumption": "<one clause stating how you read an ambiguous request, or null>",
  "results": [
    {"file_id": "<exact id from LIVE FOLDER SNAPSHOT>", "summary": "<one line, <25 words: what the brand did + key result or mechanic>", "fit": "<short connection label for adjacent/analogue picks in brand requests, e.g. 'also CPG snacking'; null for direct matches>"}
  ],
  "note": "<plain statement when fewer than requested or zero exist in the category, naming the nearest category if relevant; null otherwise>",
  "follow_ups": ["<targeted follow-up question>", "<optional second>"]
}
Rules: 3–5 results max, best first, fewer if fewer truly fit. file_id values must be copied exactly from the snapshot. "no_match" when the hard filter yields zero files (explain in note and offer the nearest category). "unavailable" only if the snapshot itself is empty or unreadable. follow_ups only when fewer exist than asked for or when the hard filter yields zero; otherwise an empty array.`;

/* ───────────────────────────────────────────
   STAGES
   ─────────────────────────────────────────── */
async function shortlist({ request, conversation, catalog }) {
  const user = [
    formatConversation(conversation),
    `REQUEST: ${request}`,
    "",
    catalog,
  ]
    .filter(Boolean)
    .join("\n\n");
  const raw = await grok.ask(
    SHORTLIST_SYSTEM.replace("LIMIT", String(MAX_CANDIDATES)),
    user,
    { max_output_tokens: 1200, temperature: 0.1 }
  );
  const parsed = grok.parseJson(raw);
  const ids = Array.isArray(parsed.candidate_ids)
    ? parsed.candidate_ids.map(String)
    : [];
  return { ids, reading: parsed.reading || null };
}

async function finalPick({ request, conversation, catalog, candidates }) {
  const user = [
    formatConversation(conversation),
    `REQUEST: ${request}`,
    "",
    catalog,
    "",
    formatCandidates(candidates),
    "",
    RESPONSE_CONTRACT,
  ]
    .filter((s) => s !== null && s !== undefined)
    .join("\n");
  const raw = await grok.ask(SYSTEM_PROMPT, user, {
    max_output_tokens: 2000,
    temperature: 0.3,
  });
  return grok.parseJson(raw);
}

/* ───────────────────────────────────────────
   RENDER (Slack mrkdwn)
   ─────────────────────────────────────────── */
function escapeMrkdwn(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function render(result, byId) {
  if (!result || result.status === "unavailable") {
    return { text: UNAVAILABLE_MSG, ok: false, results: [] };
  }

  // Validate: keep only file ids that exist in this turn's live index, dedup, cap.
  const seen = new Set();
  const results = [];
  for (const r of Array.isArray(result.results) ? result.results : []) {
    const file = byId.get(String(r.file_id || ""));
    if (!file || seen.has(file.id)) continue;
    seen.add(file.id);
    results.push({ file, summary: r.summary || "", fit: r.fit || null });
    if (results.length >= MAX_RESULTS) break;
  }

  const lines = [];
  const title = result.title && /^Recommended Case Studies/i.test(result.title)
    ? result.title
    : `Recommended Case Studies for ${result.title || "your request"}`;
  lines.push(`*${escapeMrkdwn(title)}*`);
  if (result.assumption) lines.push(`_Assumption: ${escapeMrkdwn(result.assumption)}_`);
  lines.push("");

  if (results.length) {
    results.forEach(({ file, summary, fit }, i) => {
      const fitLabel = fit ? ` _(${escapeMrkdwn(fit)})_` : "";
      lines.push(
        `${i + 1}. *"${escapeMrkdwn(file.name)}"* — ${escapeMrkdwn(summary)}${fitLabel}`
      );
      lines.push(`    ${file.webViewLink}`);
    });
    lines.push("");
  } else {
    lines.push(
      result.note
        ? ""
        : "_No case studies in the folder match that request._"
    );
  }

  if (result.note) lines.push(escapeMrkdwn(result.note));
  const followUps = Array.isArray(result.follow_ups)
    ? result.follow_ups.filter(Boolean).slice(0, 2)
    : [];
  if (followUps.length) {
    lines.push("");
    for (const q of followUps) lines.push(`• ${escapeMrkdwn(q)}`);
  }

  return {
    text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    ok: results.length > 0,
    results,
  };
}

/* ───────────────────────────────────────────
   ENTRY POINT
   ─────────────────────────────────────────── */
async function answerRequest({ request, conversation = [], log = console }) {
  // 1. Live folder listing (mandatory on every message)
  let index;
  try {
    index = await drive.getIndex();
  } catch (err) {
    log.error(`[matchmaker] Drive unavailable: ${err.message}`);
    return { text: UNAVAILABLE_MSG, ok: false, results: [], error: err.message };
  }
  if (!index.files.length) {
    log.warn("[matchmaker] Drive index is empty");
    return { text: UNAVAILABLE_MSG, ok: false, results: [] };
  }

  const byId = new Map(index.files.map((f) => [f.id, f]));
  const catalog = formatCatalog(index);

  // 2. Shortlist by title
  let ids = [];
  let reading = null;
  try {
    ({ ids, reading } = await shortlist({ request, conversation, catalog }));
  } catch (err) {
    log.warn(`[matchmaker] Shortlist failed (${err.message}) — continuing with titles only`);
  }
  const candidateFiles = ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .slice(0, MAX_CANDIDATES);
  log.log(
    `[matchmaker] "${request}" → reading: ${reading || "(n/a)"} | ${candidateFiles.length} candidate(s) of ${index.files.length}`
  );

  // 3. Pull deck text for the shortlist (read_file equivalent)
  const candidates = await Promise.all(
    candidateFiles.map(async (f) => ({ ...f, excerpt: await drive.getFileExcerpt(f) }))
  );

  // 4. Final pick, then render from the live index
  const result = await finalPick({ request, conversation, catalog, candidates });
  const rendered = render(result, byId);
  log.log(
    `[matchmaker] status=${result && result.status} rendered=${rendered.results.length} result(s)`
  );
  return rendered;
}

module.exports = { answerRequest, UNAVAILABLE_MSG, formatCatalog, render };
