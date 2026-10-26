/* ───────────────────────────────────────────
   GOOGLE DRIVE LAYER
   Replaces Grok's built-in google_drive_* tools.
   Walks the master case study folder (root →
   vertical subfolders → decks), caches the index,
   and exports deck text on demand for summaries.
   ─────────────────────────────────────────── */
const { google } = require("googleapis");

const ROOT_FOLDER_ID =
  process.env.DRIVE_ROOT_FOLDER_ID || "15I3CdBcBvQ9kUO_b7-mpausV3VzgWjQO";
const CACHE_TTL_MS =
  parseInt(process.env.DRIVE_CACHE_TTL_MIN || "10", 10) * 60 * 1000;
const MAX_CONTENT_CHARS = parseInt(
  process.env.DRIVE_MAX_CONTENT_CHARS || "4000",
  10
);
const MAX_DEPTH = 4; // root → vertical → (up to 3 nested levels)
const LIST_CONCURRENCY = 4;

const MIME = {
  FOLDER: "application/vnd.google-apps.folder",
  SHORTCUT: "application/vnd.google-apps.shortcut",
  SLIDES: "application/vnd.google-apps.presentation",
  DOC: "application/vnd.google-apps.document",
  PDF: "application/pdf",
  PPTX: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  PPT: "application/vnd.ms-powerpoint",
  KEY: "application/x-iwork-keynote-sffkey",
};

// Files that count as a "case study deck". Everything else in the tree is ignored.
const DECK_MIMES = new Set([
  MIME.SLIDES,
  MIME.DOC,
  MIME.PDF,
  MIME.PPTX,
  MIME.PPT,
  MIME.KEY,
]);

const FILE_FIELDS =
  "id,name,mimeType,webViewLink,modifiedTime,shortcutDetails(targetId,targetMimeType)";

/* ───────────────────────────────────────────
   AUTH
   Service account (recommended) or OAuth
   refresh token for a user that can see the folder.
   ─────────────────────────────────────────── */
function buildAuth() {
  const scopes = ["https://www.googleapis.com/auth/drive.readonly"];
  const {
    GOOGLE_SERVICE_ACCOUNT_JSON,
    GOOGLE_SERVICE_ACCOUNT_JSON_B64,
    GOOGLE_APPLICATION_CREDENTIALS,
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_REFRESH_TOKEN,
  } = process.env;

  if (GOOGLE_OAUTH_REFRESH_TOKEN) {
    if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
      throw new Error(
        "GOOGLE_OAUTH_REFRESH_TOKEN is set but GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are missing"
      );
    }
    const oauth2 = new google.auth.OAuth2(
      GOOGLE_OAUTH_CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET
    );
    oauth2.setCredentials({ refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN });
    return { auth: oauth2, mode: "oauth" };
  }

  let credentials = null;
  if (GOOGLE_SERVICE_ACCOUNT_JSON_B64) {
    credentials = JSON.parse(
      Buffer.from(GOOGLE_SERVICE_ACCOUNT_JSON_B64, "base64").toString("utf8")
    );
  } else if (GOOGLE_SERVICE_ACCOUNT_JSON) {
    credentials = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  }

  if (credentials) {
    return {
      auth: new google.auth.GoogleAuth({ credentials, scopes }),
      mode: `service-account (${credentials.client_email || "unknown"})`,
    };
  }
  if (GOOGLE_APPLICATION_CREDENTIALS) {
    // GoogleAuth reads the key file path from the env var itself.
    return {
      auth: new google.auth.GoogleAuth({ scopes }),
      mode: `service-account file (${GOOGLE_APPLICATION_CREDENTIALS})`,
    };
  }
  // Keyless: Application Default Credentials. On Cloud Run / GCE this is the
  // service account attached to the service; locally it is whatever
  // `gcloud auth application-default login` set up. Also covers Workload
  // Identity Federation credential files via GOOGLE_APPLICATION_CREDENTIALS.
  return {
    auth: new google.auth.GoogleAuth({ scopes }),
    mode: "application-default-credentials (attached identity / WIF)",
  };
}

let _drive = null;
let AUTH_MODE = "unconfigured";
function client() {
  if (!_drive) {
    const { auth, mode } = buildAuth();
    AUTH_MODE = mode;
    _drive = google.drive({ version: "v3", auth });
  }
  return _drive;
}

/* ───────────────────────────────────────────
   LOW-LEVEL HELPERS
   ─────────────────────────────────────────── */
async function listChildren(folderId) {
  const files = [];
  let pageToken;
  do {
    const res = await client().files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: `nextPageToken, files(${FILE_FIELDS})`,
      pageSize: 1000,
      orderBy: "name",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageToken,
    });
    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

async function getMeta(fileId) {
  const res = await client().files.get({
    fileId,
    fields: FILE_FIELDS,
    supportsAllDrives: true,
  });
  return res.data;
}

// Shortcuts point at a real file elsewhere — surface the real file (and its real link).
async function resolveShortcut(file) {
  if (file.mimeType !== MIME.SHORTCUT) return file;
  const targetId = file.shortcutDetails && file.shortcutDetails.targetId;
  if (!targetId) return null;
  try {
    const target = await getMeta(targetId);
    return { ...target, name: target.name || file.name };
  } catch (err) {
    console.warn(`[drive] Could not resolve shortcut "${file.name}": ${err.message}`);
    return null;
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

/* ───────────────────────────────────────────
   INDEX
   { builtAt, rootName, verticals: [..], files: [{ id, name, mimeType,
     webViewLink, modifiedTime, vertical, path }] }
   ─────────────────────────────────────────── */
let indexCache = null;
let indexInFlight = null;

async function walkFolder(folderId, vertical, pathParts, depth, out) {
  const children = await listChildren(folderId);
  const subfolders = [];
  for (const child of children) {
    if (child.mimeType === MIME.FOLDER) {
      subfolders.push(child);
      continue;
    }
    const file = await resolveShortcut(child);
    if (!file || !DECK_MIMES.has(file.mimeType)) continue;
    out.push({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      webViewLink: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
      modifiedTime: file.modifiedTime,
      vertical,
      path: pathParts.join("/"),
    });
  }
  if (depth < MAX_DEPTH) {
    await mapLimit(subfolders, LIST_CONCURRENCY, (sub) =>
      walkFolder(sub.id, vertical, [...pathParts, sub.name], depth + 1, out)
    );
  }
}

async function buildIndex() {
  const started = Date.now();
  const root = await getMeta(ROOT_FOLDER_ID);
  const rootChildren = await listChildren(ROOT_FOLDER_ID);

  const verticalFolders = rootChildren.filter((f) => f.mimeType === MIME.FOLDER);
  const files = [];

  // Loose decks sitting directly in the root (no vertical folder)
  for (const child of rootChildren) {
    if (child.mimeType === MIME.FOLDER) continue;
    const file = await resolveShortcut(child);
    if (!file || !DECK_MIMES.has(file.mimeType)) continue;
    files.push({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      webViewLink: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
      modifiedTime: file.modifiedTime,
      vertical: "(root)",
      path: "",
    });
  }

  await mapLimit(verticalFolders, LIST_CONCURRENCY, (folder) =>
    walkFolder(folder.id, folder.name, [folder.name], 1, files)
  );

  // Dedup (a deck can be reachable via a shortcut and directly)
  const seen = new Set();
  const unique = files.filter((f) => (seen.has(f.id) ? false : seen.add(f.id)));
  unique.sort((a, b) =>
    a.vertical === b.vertical
      ? a.name.localeCompare(b.name)
      : a.vertical.localeCompare(b.vertical)
  );

  const index = {
    builtAt: Date.now(),
    rootName: root.name,
    verticals: verticalFolders.map((f) => f.name).sort(),
    files: unique,
  };
  console.log(
    `[drive] Indexed "${root.name}": ${unique.length} deck(s) across ${index.verticals.length} vertical folder(s) in ${Date.now() - started}ms`
  );
  return index;
}

/**
 * Returns the cached folder index, rebuilding when stale.
 * Throws if Drive is unreachable AND there is no cached copy.
 */
async function getIndex({ force = false } = {}) {
  const fresh = indexCache && Date.now() - indexCache.builtAt < CACHE_TTL_MS;
  if (fresh && !force) return indexCache;
  if (!indexInFlight) {
    indexInFlight = buildIndex()
      .then((idx) => {
        indexCache = idx;
        return idx;
      })
      .finally(() => {
        indexInFlight = null;
      });
  }
  try {
    return await indexInFlight;
  } catch (err) {
    if (indexCache) {
      console.warn(`[drive] Refresh failed (${err.message}) — serving stale index`);
      return indexCache;
    }
    throw err;
  }
}

/* ───────────────────────────────────────────
   CONTENT
   Export Slides / Docs as plain text for summaries.
   Cached per file id + modifiedTime.
   ─────────────────────────────────────────── */
const contentCache = new Map(); // key → text|null
const CONTENT_CACHE_MAX = 400;

async function getFileExcerpt(file) {
  const key = `${file.id}:${file.modifiedTime}`;
  if (contentCache.has(key)) return contentCache.get(key);

  let text = null;
  try {
    if (file.mimeType === MIME.SLIDES || file.mimeType === MIME.DOC) {
      const res = await client().files.export(
        { fileId: file.id, mimeType: "text/plain" },
        { responseType: "text" }
      );
      text = typeof res.data === "string" ? res.data : String(res.data || "");
    }
    // PDFs / PPTX: no text extraction dependency — summaries fall back to the title.
  } catch (err) {
    console.warn(`[drive] Export failed for "${file.name}": ${err.message}`);
  }

  if (text) {
    text = text
      .replace(/\r/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (text.length > MAX_CONTENT_CHARS) {
      text = text.slice(0, MAX_CONTENT_CHARS) + "\n[...truncated]";
    }
    if (!text.length) text = null;
  }

  if (contentCache.size >= CONTENT_CACHE_MAX) {
    contentCache.delete(contentCache.keys().next().value);
  }
  contentCache.set(key, text);
  return text;
}

function describeAuth() {
  return AUTH_MODE;
}

module.exports = {
  ROOT_FOLDER_ID,
  getIndex,
  getFileExcerpt,
  describeAuth,
  MIME,
};
