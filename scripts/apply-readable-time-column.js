/**
 * Inserts a helper column with ARRAYFORMULA: ISO UTC in column A → readable GMT+7.
 * Uses column K (does not overwrite B = event_id).
 *
 * From repo root: npm run sheet:readable
 */
const path = require("path");
const dotenv = require("dotenv");
const { google } = require("googleapis");
const { getGoogleSheetsAuth } = require("../src/googleSheetsAuth");

dotenv.config({ path: path.join(__dirname, "..", ".env") });

const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;
const TAB = process.env.GOOGLE_SHEET_TAB || "Sheet1";

/** Quote sheet tab for A1 notation if needed */
function tabRange(tab, a1) {
  const t = String(tab);
  const quoted = `'${t.replace(/'/g, "''")}'`;
  return `${quoted}!${a1}`;
}

const FORMULA =
  '=ARRAYFORMULA(IF(A2:A="","",IF(REGEXMATCH(A2:A,"^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}"),TEXT(DATEVALUE(LEFT(A2:A,10))+TIMEVALUE(REGEXEXTRACT(A2:A,"T(\\d{2}:\\d{2}:\\d{2})"))+7/24,"dd/mm/yyyy HH:mm:ss") & " (GMT+7)",A2:A)))';

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
  const range = tabRange(TAB, "K1:K2");

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [["readable_bkk (GMT+7)"], [FORMULA]],
    },
  });

  console.log("OK: Wrote header + formula to", range);
  console.log(
    "Column K: old ISO rows in A show as dd/mm/yyyy; new readable A rows pass through.",
  );
}

main().catch((err) => {
  const msg = err.message || String(err);
  console.error("Failed:", msg);
  if (msg.includes("403") || msg.includes("PERMISSION")) {
    console.error(
      "\nShare the spreadsheet with the service account email from your JSON (client_email) as Editor.",
    );
  }
  process.exit(1);
});
