const express = require("express");
const path = require("path");
const dotenv = require("dotenv");
const crypto = require("crypto");
const axios = require("axios");
const { google } = require("googleapis");
const { getGoogleSheetsAuth } = require("./googleSheetsAuth");

dotenv.config();

const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const EVENT_ID = process.env.EVENT_ID || "MALI_EVENT";

/** URL สาธารณะของเว็บ — ต้องตรงกับ Callback ใน LINE / Google ทุกตัวอักษร */
function getPublicBaseUrl() {
  const explicit = (process.env.BASE_URL || "").trim().replace(/\/+$/, "");
  const renderUrl = (process.env.RENDER_EXTERNAL_URL || "")
    .trim()
    .replace(/\/+$/, "");
  const base = explicit || renderUrl;
  if (explicit && renderUrl && explicit !== renderUrl) {
    console.warn(
      `[mali-checkin] BASE_URL (${explicit}) ≠ RENDER_EXTERNAL_URL (${renderUrl}); using BASE_URL — fix mismatch if LINE OAuth fails.`,
    );
  }
  return base;
}

function getLineRedirectUri() {
  const base = getPublicBaseUrl();
  if (!base) {
    throw new Error(
      "Set BASE_URL (e.g. https://your-host.onrender.com) or rely on RENDER_EXTERNAL_URL on Render.",
    );
  }
  return `${base}/auth/line/callback`;
}

/** ภาพด้านล่างหน้าสำเร็จ — ตั้ง URL เต็มได้ถ้าโฮสต์ที่อื่น */
function getCheckinSuccessArtworkUrl() {
  const custom = (process.env.CHECKIN_SUCCESS_ARTWORK_URL || "").trim();
  if (custom) {
    return custom;
  }
  const base = getPublicBaseUrl();
  if (!base) {
    return "/checkin-success-artwork.png";
  }
  return `${base.replace(/\/+$/, "")}/checkin-success-artwork.png`;
}

const LINE_LOGIN_CHANNEL_ID = process.env.LINE_LOGIN_CHANNEL_ID;
const LINE_LOGIN_CHANNEL_SECRET = process.env.LINE_LOGIN_CHANNEL_SECRET;
const LINE_OA_ADD_FRIEND_URL = process.env.LINE_OA_ADD_FRIEND_URL;
/** Basic ID เช่น @057xhooz — ใช้สร้างลิงก์ line:// เปิดแอป LINE โดยตรงบนมือถือ */
const LINE_OA_BASIC_ID_RAW = (process.env.LINE_OA_BASIC_ID || "").trim();
/** Messaging API — optional repeat push of the OA card image after LINE check-in */
const LINE_MESSAGING_CHANNEL_ACCESS_TOKEN = (
  process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN ||
  process.env.LINE_CHANNEL_ACCESS_TOKEN ||
  ""
).trim();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SHEET_TAB = process.env.GOOGLE_SHEET_TAB || "Sheet1";

/** ค่า `oa_added_status` ตาม CRM — แถวใหม่หลัง check-in เริ่มที่ ST_NEWLEAD; ขั้นถัดไปอัปเดตด้วยมือหรือ automation */
const OA_STATUS = {
  NEWLEAD: "ST_NEWLEAD",
  ENGAGED: "ST_ENGAGED",
  REDEEMED: "ST_REDEEMED",
  VISITED: "ST_VISITED",
  INACTIVE: "ST_INACTIVE",
};

/** Stable secret so OAuth state survives server restarts (e.g. node --watch). */
function getOauthStateSecret() {
  if (process.env.OAUTH_STATE_SECRET) {
    return process.env.OAUTH_STATE_SECRET;
  }
  if (LINE_LOGIN_CHANNEL_SECRET && GOOGLE_CLIENT_SECRET) {
    return crypto
      .createHash("sha256")
      .update(`${LINE_LOGIN_CHANNEL_SECRET}:${GOOGLE_CLIENT_SECRET}`)
      .digest("hex");
  }
  return null;
}

const STATE_MAX_AGE_MS = 15 * 60 * 1000;

function createSignedState(provider) {
  const secret = getOauthStateSecret();
  if (!secret) {
    throw new Error(
      "Set OAUTH_STATE_SECRET in .env or ensure LINE_LOGIN_CHANNEL_SECRET and GOOGLE_CLIENT_SECRET are set",
    );
  }
  const nonce = crypto.randomBytes(16).toString("hex");
  const ts = Date.now();
  const payload = `${provider}:${nonce}:${ts}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
}

/** Old in-memory state was a 32-char hex nonce; reject with a clear hint. */
function isLegacyRandomState(state) {
  return typeof state === "string" && /^[a-f0-9]{32}$/i.test(state);
}

function verifySignedState(state, expectedProvider) {
  const secret = getOauthStateSecret();
  if (!secret || typeof state !== "string" || !state) {
    return false;
  }
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const dot = decoded.lastIndexOf(".");
    if (dot === -1) {
      return false;
    }
    const payload = decoded.slice(0, dot);
    const sig = decoded.slice(dot + 1);
    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest("hex");
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expectedSig, "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return false;
    }
    const parts = payload.split(":");
    if (parts.length !== 3) {
      return false;
    }
    const [prov, , tsStr] = parts;
    if (prov !== expectedProvider) {
      return false;
    }
    const ts = Number(tsStr);
    if (!Number.isFinite(ts) || Date.now() - ts > STATE_MAX_AGE_MS) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function normalizeProviderUserId(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function normalizeLineBasicId(id) {
  if (!id) {
    return "";
  }
  let s = String(id).trim();
  // พิมพ์ "a" แทน "@" บนมือถือ เช่น a057xhooz → @057xhooz
  if (/^a(?=[0-9])/i.test(s)) {
    s = `@${s.slice(1)}`;
  }
  if (!s.startsWith("@")) {
    s = `@${s}`;
  }
  return s;
}

function htmlAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

/** OA add-friend buttons (pairs with success artwork on the web page). */
function addOaButtonsHtml() {
  const webUrl = LINE_OA_ADD_FRIEND_URL || "";
  const basicId = normalizeLineBasicId(LINE_OA_BASIC_ID_RAW);
  const lineAppUrl = basicId ? `line://ti/p/${basicId}` : "";
  if (lineAppUrl && webUrl) {
    return `
      <div class="actions">
        <a class="btn btn-line" href="${htmlAttr(lineAppUrl)}">Open LINE to add friend (recommended)</a>
        <a class="btn btn-secondary" href="${htmlAttr(webUrl)}">Open web link</a>
      </div>`;
  }
  if (webUrl) {
    return `<div class="actions"><a class="btn btn-line" href="${htmlAttr(webUrl)}">Add LINE Official Account</a></div>`;
  }
  return "";
}

function checkinSuccessArtworkHtml() {
  const url = htmlAttr(getCheckinSuccessArtworkUrl());
  return `<div class="success-artwork-panel">
    <img src="${url}" alt="CLAIM YOUR PRIVILEGE — MALI" width="800" height="1200" loading="lazy" decoding="async" />
  </div>`;
}

/**
 * Same HTTPS image as your LINE OA Manager greeting/card hero — no fallback to web artwork.
 * Set LINE_OA_CARD_IMAGE_URL (or legacy LINE_PUSH_CARD_IMAGE_URL).
 */
function getLineOaCardImageUrlForPush() {
  return (
    process.env.LINE_OA_CARD_IMAGE_URL ||
    process.env.LINE_PUSH_CARD_IMAGE_URL ||
    ""
  ).trim();
}

async function pushLineOaCardImageAfterCheckin(lineUserId) {
  if (!LINE_MESSAGING_CHANNEL_ACCESS_TOKEN || !lineUserId) {
    return;
  }
  const imgUrl = getLineOaCardImageUrlForPush();
  if (!imgUrl) {
    console.warn(
      "[mali-checkin] LINE image push skipped: set LINE_OA_CARD_IMAGE_URL to the same public HTTPS image URL used in LINE OA Manager (card/greeting).",
    );
    return;
  }
  const messages = [];
  const extraText = (process.env.LINE_PUSH_WELCOME_TEXT || "").trim();
  if (extraText) {
    messages.push({ type: "text", text: extraText.replace(/\\n/g, "\n") });
  }
  messages.push({
    type: "image",
    originalContentUrl: imgUrl,
    previewImageUrl: imgUrl,
  });
  const payload = { to: lineUserId, messages };
  try {
    await axios.post("https://api.line.me/v2/bot/message/push", payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LINE_MESSAGING_CHANNEL_ACCESS_TOKEN}`,
      },
      timeout: 15000,
    });
  } catch (err) {
    const status = err.response?.status;
    const data =
      err.response?.data != null ? JSON.stringify(err.response.data) : "";
    console.warn(
      "[mali-checkin] LINE push message:",
      status || err.message,
      data || "",
    );
  }
}

/**
 * Human-readable wall time for column A (not UTC `...Z` strings).
 * `SHEET_TIMEZONE`: IANA, e.g. Asia/Bangkok. `SHEET_TIMESTAMP_LOCALE`: BCP 47, e.g. en-GB, th-TH.
 */
function formatTimestampForSheet(d = new Date()) {
  const tz =
    (process.env.SHEET_TIMEZONE || "Asia/Bangkok").trim() || "Asia/Bangkok";
  const locale =
    (process.env.SHEET_TIMESTAMP_LOCALE || "en-GB").trim() || "en-GB";
  try {
    const wall = new Intl.DateTimeFormat(locale, {
      timeZone: tz,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(d);
    return `${wall} (${tz})`;
  } catch {
    return d.toISOString();
  }
}

async function appendToSheet(row) {
  const auth = getGoogleSheetsAuth();
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: `${GOOGLE_SHEET_TAB}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });
}

function htmlPage(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="theme-color" content="#0f2d24" />
  <title>${htmlAttr(title)}</title>
  <style>
    :root {
      --bg: #e8eeeb;
      --surface: #ffffff;
      --ink: #14221e;
      --muted: #5a6d66;
      --line: #06c755;
      --line-dark: #059648;
      --google-blue: #1a73e8;
      --border: rgba(15, 45, 36, 0.12);
      --shadow: 0 12px 40px rgba(15, 45, 36, 0.08);
      --radius: 16px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
      background: linear-gradient(165deg, var(--bg) 0%, #dce6e1 48%, #cfd9d3 100%);
      color: var(--ink);
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }
    .shell {
      max-width: 420px;
      margin: 0 auto;
      padding: 20px 18px 32px;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
    .shell:has(.success-page) {
      justify-content: flex-start;
      padding-top: max(16px, env(safe-area-inset-top, 0px));
      padding-bottom: max(20px, env(safe-area-inset-bottom, 0px));
    }
    .brand {
      text-align: center;
      margin-bottom: 18px;
      letter-spacing: 0.28em;
      font-size: 11px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
    }
    .brand span { color: var(--line-dark); letter-spacing: 0.15em; }
    .card {
      background: var(--surface);
      border-radius: var(--radius);
      padding: 28px 22px;
      box-shadow: var(--shadow);
      border: 1px solid var(--border);
      overflow: hidden;
    }
    .eyebrow {
      font-size: 12px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin: 0 0 8px;
    }
    h1 {
      font-size: 1.45rem;
      font-weight: 700;
      margin: 0 0 10px;
      line-height: 1.25;
      color: var(--ink);
    }
    .lead { margin: 0 0 22px; color: var(--muted); font-size: 15px; }
    .actions { display: flex; flex-direction: column; gap: 12px; }
    .btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      padding: 14px 18px;
      border-radius: 12px;
      text-decoration: none;
      font-weight: 600;
      font-size: 15px;
      border: none;
      cursor: pointer;
      transition: transform 0.12s ease, box-shadow 0.12s ease;
    }
    .btn:active { transform: scale(0.98); }
    .btn-line {
      background: var(--line);
      color: #fff;
      box-shadow: 0 4px 14px rgba(6, 199, 85, 0.35);
    }
    .btn-line:hover { background: var(--line-dark); color: #fff; }
    .btn-google {
      background: var(--surface);
      color: var(--google-blue);
      border: 1.5px solid rgba(26, 115, 232, 0.35);
    }
    .btn-google:hover { background: #f8fbff; }
    .btn-secondary {
      background: var(--surface);
      color: var(--ink);
      border: 1.5px solid var(--border);
    }
    .btn-secondary:hover { background: #f6f8f7; }
    .fineprint {
      margin: 18px 0 0;
      font-size: 12px;
      color: var(--muted);
      text-align: center;
    }
    .muted { color: var(--muted); font-size: 13px; margin: 12px 0 0; }
    .note-box {
      margin-top: 18px;
      padding: 12px 14px;
      background: #f4f8f6;
      border-radius: 10px;
      border: 1px solid var(--border);
      font-size: 13px;
      color: var(--muted);
    }
    .note-box strong { color: var(--ink); }
    .success-icon {
      width: 52px;
      height: 52px;
      margin: 0 auto 16px;
      background: linear-gradient(135deg, #0a5c3f, var(--line));
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-size: 28px;
      line-height: 1;
      box-shadow: 0 8px 24px rgba(6, 199, 85, 0.3);
    }
    .success-title { text-align: center; }
    .success-title h1 { margin-bottom: 6px; }
    .divider { height: 1px; background: var(--border); margin: 20px 0; }
    code {
      font-size: 12px;
      background: #eef3f0;
      padding: 2px 6px;
      border-radius: 4px;
      word-break: break-all;
    }
    .qr-wrap {
      text-align: center;
      margin: 16px 0;
    }
    .qr-wrap img {
      max-width: 100%;
      height: auto;
      border-radius: 12px;
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
    }
    .success-page .success-icon {
      width: 46px;
      height: 46px;
      font-size: 22px;
      margin-bottom: 12px;
      box-shadow: 0 6px 18px rgba(6, 199, 85, 0.28);
    }
    .success-page .success-title h1 {
      font-size: 1.22rem;
      margin-bottom: 4px;
    }
    .success-page .success-title .lead {
      font-size: 14px;
      margin-bottom: 0;
    }
    .success-page .divider {
      margin: 14px 0 12px;
    }
    .success-page .eyebrow {
      margin-bottom: 6px;
      font-size: 11px;
    }
    .success-page .actions {
      gap: 10px;
    }
    .success-page .btn {
      padding: 12px 16px;
      font-size: 14px;
      border-radius: 11px;
    }
    /* Success artwork: full card width, no dark letterbox */
    .success-artwork-panel {
      margin: 18px -22px -28px;
      padding: 0;
      text-align: center;
      background: transparent;
      border: none;
      border-radius: 0;
      box-shadow: none;
      width: calc(100% + 44px);
      max-width: none;
    }
    .success-artwork-panel img {
      display: block;
      width: 100%;
      height: auto;
      margin: 0;
      border-radius: 0 0 var(--radius) var(--radius);
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="brand">House of <span>MALI</span></div>
    <div class="card">
      ${body}
    </div>
  </div>
</body>
</html>`;
}

app.get("/", (req, res) => {
  res.redirect("/checkin");
});

/** หน้าพิมพ์/ยื่นหน้างาน: QR ชี้ไปที่ /checkin (สแกน = เปิด URL เดียวกับกดลิงก์) */
app.get("/poster", (req, res) => {
  const base = (getPublicBaseUrl() || `http://localhost:${PORT}`).replace(
    /\/$/,
    "",
  );
  const checkinUrl = `${base}/checkin`;
  const qrImgSrc = `https://api.qrserver.com/v1/create-qr-code/?size=420x420&data=${encodeURIComponent(checkinUrl)}`;
  const body = `
    <p class="eyebrow">Event check-in</p>
    <h1>Staff poster QR</h1>
    <p class="lead">Guests scan this QR <strong>once</strong> to open sign-in and complete event registration.</p>
    <div class="qr-wrap"><img src="${htmlAttr(qrImgSrc)}" width="420" height="420" alt="Check-in QR code" /></div>
    <p class="muted" style="text-align:center;margin-top:8px"><strong>URL in QR</strong><br /><code>${htmlAttr(checkinUrl)}</code></p>
    <div class="divider"></div>
    <div class="actions">
      <a class="btn btn-secondary" href="/checkin">Open check-in page (test)</a>
    </div>
    <p class="fineprint">Print this page or save the QR for your poster. Production should use HTTPS.</p>
  `;
  res.send(htmlPage("MALI — Check-in QR", body));
});

app.get("/checkin", (req, res) => {
  let lineRedirectUriRaw;
  try {
    lineRedirectUriRaw = getLineRedirectUri();
  } catch (e) {
    return res.status(500).send(String(e.message || e));
  }

  let lineState;
  let googleState;
  try {
    lineState = createSignedState("line");
    googleState = createSignedState("google");
  } catch (e) {
    return res.status(500).send(String(e.message || e));
  }

  const lineRedirectUri = encodeURIComponent(lineRedirectUriRaw);
  const lineAuthUrl =
    `https://access.line.me/oauth2/v2.1/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(LINE_LOGIN_CHANNEL_ID)}` +
    `&redirect_uri=${lineRedirectUri}` +
    `&state=${encodeURIComponent(lineState)}` +
    `&scope=profile%20openid` +
    `&bot_prompt=normal`;

  const googleAuth = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
  );
  const googleAuthUrl = googleAuth.generateAuthUrl({
    access_type: "offline",
    scope: ["openid", "email", "profile"],
    state: googleState,
    prompt: "consent",
  });

  const body = `
    <p class="eyebrow">Event registration</p>
    <h1>Check in</h1>
    <p class="lead">After scanning the event QR, sign in once with LINE or Google so we can record your visit.</p>
    <div class="actions">
      <a class="btn btn-line" href="${htmlAttr(lineAuthUrl)}">Continue with LINE</a>
      <a class="btn btn-google" href="${htmlAttr(googleAuthUrl)}">Continue with Google</a>
    </div>
  `;
  res.send(htmlPage("MALI — Event check-in", body));
});

app.get("/auth/line/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).send("Missing LINE code or state.");
    }
    if (isLegacyRandomState(state)) {
      return res.status(400).send(
        htmlPage(
          "Sign-in link expired",
          `<p>This link is from an old session or an outdated LINE in-app tab.</p>
             <p><strong>What to do:</strong> Close the LINE tab or in-app browser, then start again from the check-in page.</p>
             <a class="btn btn-line" href="/checkin">Go to check-in and tap LINE again</a>
             <p class="muted">Do not refresh a URL that contains <code>callback</code>.</p>`,
        ),
      );
    }
    if (!verifySignedState(state, "line")) {
      return res.status(400).send(
        htmlPage(
          "Invalid LINE state",
          `<p>Open <code>/checkin</code> and tap the LINE button again (do not bookmark the callback URL).</p>
           <a class="btn btn-line" href="/checkin">Back to check-in</a>`,
        ),
      );
    }

    const lineRedirectUriRaw = getLineRedirectUri();
    const tokenResp = await axios.post(
      "https://api.line.me/oauth2/v2.1/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: lineRedirectUriRaw,
        client_id: LINE_LOGIN_CHANNEL_ID,
        client_secret: LINE_LOGIN_CHANNEL_SECRET,
      }).toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
    );

    const accessToken = tokenResp.data.access_token;
    const profileResp = await axios.get("https://api.line.me/v2/profile", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const lineUserId = profileResp.data.userId || "";
    const displayName = profileResp.data.displayName || "";

    const row = [
      formatTimestampForSheet(),
      EVENT_ID,
      "LINE",
      normalizeProviderUserId(lineUserId),
      displayName,
      "",
      lineUserId,
      OA_STATUS.NEWLEAD,
      "qr_poster",
      "line_oauth_callback",
    ];
    await appendToSheet(row);

    const body = `
      <div class="success-page">
        <div class="success-icon" aria-hidden="true">✓</div>
        <div class="success-title">
          <h1>Registration complete</h1>
          <p class="lead">You are checked in for this event.</p>
        </div>
        <div class="divider"></div>
        <p class="eyebrow">Next step</p>
        ${addOaButtonsHtml()}
        ${checkinSuccessArtworkHtml()}
      </div>
    `;
    res.send(htmlPage("MALI — Registration complete", body));
    pushLineOaCardImageAfterCheckin(lineUserId);
  } catch (error) {
    const lineBody =
      error.response?.data != null ? JSON.stringify(error.response.data) : "";
    let lineRedirectHint = "";
    try {
      lineRedirectHint = getLineRedirectUri();
    } catch {
      lineRedirectHint = "(set BASE_URL)";
    }
    const hint =
      error.response?.status === 400
        ? ` Common causes: (1) redirect_uri mismatch — register exactly ${lineRedirectHint} in LINE Developers (2) refreshed callback or reused code — start again from /checkin (3) wrong channel secret (must be LINE Login channel secret)`
        : "";
    res
      .status(500)
      .send(
        `LINE callback error: ${error.message}${lineBody ? ` | LINE: ${lineBody}` : ""}${hint}`,
      );
  }
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).send("Missing Google code or state.");
    }
    if (isLegacyRandomState(state)) {
      return res.status(400).send(
        htmlPage(
          "Sign-in link expired",
          `<p>This link is from an old session.</p>
           <a class="btn btn-line" href="/checkin">Go to check-in and use Google again</a>`,
        ),
      );
    }
    if (!verifySignedState(state, "google")) {
      return res.status(400).send(
        htmlPage(
          "Invalid Google state",
          `<p>Open <code>/checkin</code> and tap the Google button again.</p>
           <a class="btn btn-line" href="/checkin">Back to check-in</a>`,
        ),
      );
    }

    const googleAuth = new google.auth.OAuth2(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI,
    );
    const { tokens } = await googleAuth.getToken(code);
    googleAuth.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: "v2", auth: googleAuth });
    const me = await oauth2.userinfo.get();

    const providerId = me.data.id || me.data.email || "google-unknown";
    const row = [
      formatTimestampForSheet(),
      EVENT_ID,
      "GOOGLE",
      normalizeProviderUserId(providerId),
      me.data.name || "",
      me.data.email || "",
      "",
      OA_STATUS.NEWLEAD,
      "qr_poster",
      "google_oauth_callback",
    ];
    await appendToSheet(row);

    const body = `
      <div class="success-page">
        <div class="success-icon" aria-hidden="true">✓</div>
        <div class="success-title">
          <h1>Registration complete</h1>
          <p class="lead">You are checked in for this event.</p>
        </div>
        <div class="divider"></div>
        <p class="eyebrow">Next step</p>
        ${addOaButtonsHtml()}
        ${checkinSuccessArtworkHtml()}
      </div>
    `;
    res.send(htmlPage("MALI — Registration complete", body));
  } catch (error) {
    res.status(500).send(`Google callback error: ${error.message}`);
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "mali-checkin",
    timestamp: new Date().toISOString(),
  });
});

/** Lightweight endpoint for uptime pings to reduce Render cold starts. */
app.get("/warmup", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "mali-checkin",
    warmed: true,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(
    `MALI Check-in server running at ${getPublicBaseUrl() || `http://localhost:${PORT}`}`,
  );
  try {
    console.log(
      `LINE OAuth redirect_uri (register this URL in LINE Developers): ${getLineRedirectUri()}`,
    );
  } catch (e) {
    console.warn(String(e.message || e));
  }
});
