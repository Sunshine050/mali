/**
 * Writes row 1 headers to Google Sheet using service account from .env
 * Run from repo root: node scripts/setup-google-sheet.js
 */
const path = require("path");
const dotenv = require("dotenv");
const { google } = require("googleapis");
const { getGoogleSheetsAuth } = require("../src/googleSheetsAuth");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const TAB = process.env.GOOGLE_SHEET_TAB || "Sheet1";

const HEADERS = [
  "timestamp",
  "event_id",
  "auth_provider",
  "provider_user_id_hash",
  "display_name",
  "email",
  "line_user_id",
  "oa_added_status",
  "checkin_source",
  "raw_payload_ref",
];

async function main() {
  if (!SPREADSHEET_ID) {
    console.error("Missing GOOGLE_SHEET_ID in .env");
    process.exit(1);
  }

  let auth;
  try {
    auth = getGoogleSheetsAuth();
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
  const sheets = google.sheets({ version: "v4", auth });

  const range = `${TAB}!A1:J1`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [HEADERS] },
  });

  console.log("OK: Wrote headers to", range);
}

main().catch((err) => {
  const msg = err.message || String(err);
  console.error("Failed:", msg);
  if (msg.includes("403") || msg.includes("PERMISSION")) {
    console.error(
      "\nShare this spreadsheet with the service account as Editor:\n" +
        "  mali-756@mali-493503.iam.gserviceaccount.com\n" +
        "Then run this script again.",
    );
  }
  process.exit(1);
});
