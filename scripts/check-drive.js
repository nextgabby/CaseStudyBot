#!/usr/bin/env node
/**
 * Verifies Google Drive access and prints what the bot can see.
 *
 *   npm run check-drive              # list verticals + decks
 *   npm run check-drive -- --sample  # also export text from the first Slides deck
 */
require("dotenv").config();
const drive = require("../drive");

(async () => {
  const sample = process.argv.includes("--sample");
  try {
    const index = await drive.getIndex({ force: true });
    console.log(`\nAuth: ${drive.describeAuth()}`);
    console.log(`Root folder: "${index.rootName}" (${drive.ROOT_FOLDER_ID})`);
    console.log(`Vertical folders: ${index.verticals.join(" | ") || "(none)"}`);
    console.log(`Case study files: ${index.files.length}\n`);

    const byVertical = new Map();
    for (const f of index.files) {
      if (!byVertical.has(f.vertical)) byVertical.set(f.vertical, []);
      byVertical.get(f.vertical).push(f);
    }
    for (const [vertical, files] of byVertical) {
      console.log(`${vertical} (${files.length})`);
      for (const f of files) {
        const sub = f.path && f.path !== f.vertical ? `  [${f.path}]` : "";
        console.log(`  - ${f.name}${sub}\n      ${f.webViewLink}`);
      }
    }

    if (sample) {
      const first = index.files.find((f) => f.mimeType === drive.MIME.SLIDES) || index.files[0];
      if (first) {
        console.log(`\n--- Sample export: "${first.name}" ---`);
        const text = await drive.getFileExcerpt(first);
        console.log(text || "(no text could be exported for this file type)");
      }
    }
  } catch (err) {
    console.error("\nDrive check FAILED:", err.message);
    console.error(
      "\nChecklist:\n" +
        "  1. Google Drive API is enabled in the service account's GCP project\n" +
        "  2. The case study folder is shared (Viewer) with the service account email\n" +
        "  3. GOOGLE_SERVICE_ACCOUNT_JSON_B64 / GOOGLE_SERVICE_ACCOUNT_JSON / GOOGLE_APPLICATION_CREDENTIALS is set\n" +
        "  4. DRIVE_ROOT_FOLDER_ID is the folder id (not the URL)"
    );
    process.exit(1);
  }
})();
