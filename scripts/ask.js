#!/usr/bin/env node
/**
 * Run the full matchmaker pipeline from the terminal (no Slack needed).
 *
 *   npm run ask -- "Trend Genius case study for the CPG vertical"
 */
require("dotenv").config();
const { answerRequest } = require("../matchmaker");

(async () => {
  const request = process.argv.slice(2).join(" ").trim();
  if (!request) {
    console.error('Usage: npm run ask -- "your request"');
    process.exit(1);
  }
  const started = Date.now();
  const { text, ok, results } = await answerRequest({ request });
  console.log("\n" + text + "\n");
  console.log(`(${ok ? results.length : 0} result(s) in ${Date.now() - started}ms)`);
})().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
