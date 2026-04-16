const { google } = require("googleapis");

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

/**
 * GoogleAuth for Sheets: ใช้ GOOGLE_SERVICE_ACCOUNT_JSON (ข้อความ JSON เต็ม) บน cloud
 * หรือ GOOGLE_SERVICE_ACCOUNT_KEY_PATH (ไฟล์บนเครื่อง) ตอน dev
 */
function getGoogleSheetsAuth() {
  const jsonRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (jsonRaw && String(jsonRaw).trim()) {
    let credentials;
    try {
      credentials = JSON.parse(jsonRaw);
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
    }
    return new google.auth.GoogleAuth({
      credentials,
      scopes: [SHEETS_SCOPE],
    });
  }
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  if (keyPath && String(keyPath).trim()) {
    return new google.auth.GoogleAuth({
      keyFile: keyPath,
      scopes: [SHEETS_SCOPE],
    });
  }
  throw new Error(
    "Set GOOGLE_SERVICE_ACCOUNT_JSON (Render) or GOOGLE_SERVICE_ACCOUNT_KEY_PATH (local)",
  );
}

module.exports = { getGoogleSheetsAuth };
