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
      `[mali-checkin] BASE_URL (${explicit}) ≠ RENDER_EXTERNAL_URL (${renderUrl}); ใช้ BASE_URL — ถ้า LINE error ให้แก้ให้ตรงกัน`,
    );
  }
  return base;
}

function getLineRedirectUri() {
  const base = getPublicBaseUrl();
  if (!base) {
    throw new Error(
      "ตั้งค่า BASE_URL (https://your-host.onrender.com) หรือให้ Render ตั้ง RENDER_EXTERNAL_URL",
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

/** ปุ่มเพิ่มเพื่อน OA เท่านั้น (ไม่มีกล่องคำแนะ — ใช้คู่กับภาพด้านล่างหน้าสำเร็จ) */
function addOaButtonsHtml() {
  const webUrl = LINE_OA_ADD_FRIEND_URL || "";
  const basicId = normalizeLineBasicId(LINE_OA_BASIC_ID_RAW);
  const lineAppUrl = basicId ? `line://ti/p/${basicId}` : "";
  if (lineAppUrl && webUrl) {
    return `
      <div class="actions">
        <a class="btn btn-line" href="${htmlAttr(lineAppUrl)}">เปิด LINE เพื่อเพิ่มเพื่อน (แนะนำ · มือถือ)</a>
        <a class="btn btn-secondary" href="${htmlAttr(webUrl)}">เปิดแบบลิงก์เว็บ</a>
      </div>`;
  }
  if (webUrl) {
    return `<div class="actions"><a class="btn btn-line" href="${htmlAttr(webUrl)}">เพิ่มเพื่อน LINE Official</a></div>`;
  }
  return "";
}

function checkinSuccessArtworkHtml() {
  const url = htmlAttr(getCheckinSuccessArtworkUrl());
  return `<div class="success-artwork-wrap">
    <img class="success-artwork" src="${url}" alt="CLAIM YOUR PRIVILEGE — MALI" loading="lazy" decoding="async" />
  </div>`;
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
<html lang="th">
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
    .success-artwork-wrap {
      margin: 20px -22px 0;
      text-align: center;
    }
    .success-artwork {
      display: block;
      width: 100%;
      max-width: 100%;
      height: auto;
      border-radius: 12px;
      box-shadow: var(--shadow);
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
    <h1>QR ลงทะเบียนหน้างาน</h1>
    <p class="lead">ผู้เข้างานสแกน QR นี้ <strong>ครั้งเดียว</strong> เพื่อเข้าหน้ายืนยันตัวตนและลงทะเบียนเข้างาน</p>
    <div class="qr-wrap"><img src="${htmlAttr(qrImgSrc)}" width="420" height="420" alt="QR ลงทะเบียน" /></div>
    <p class="muted" style="text-align:center;margin-top:8px"><strong>ลิงก์ใน QR</strong><br /><code>${htmlAttr(checkinUrl)}</code></p>
    <div class="divider"></div>
    <div class="actions">
      <a class="btn btn-secondary" href="/checkin">เปิดหน้าลงทะเบียน (ทดสอบ)</a>
    </div>
    <p class="fineprint">พิมพ์หน้านี้หรือบันทึกภาพ QR ไปใส่โปสเตอร์ · โดเมนจริงควรเป็น HTTPS ตามที่ตั้งบนเซิร์ฟเวอร์</p>
  `;
  res.send(htmlPage("MALI — QR ลงทะเบียน", body));
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
    <h1>ลงทะเบียนเข้างาน</h1>
    <p class="lead">สแกน QR จากหน้างานแล้วเลือกช่องทางยืนยันตัวตนเพื่อบันทึกการเข้าร่วม</p>
    <div class="actions">
      <a class="btn btn-line" href="${htmlAttr(lineAuthUrl)}">เข้าสู่ระบบด้วย LINE</a>
      <a class="btn btn-google" href="${htmlAttr(googleAuthUrl)}">เข้าสู่ระบบด้วย Google</a>
    </div>
    
  `;
  res.send(htmlPage("MALI — ลงทะเบียนเข้างาน", body));
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
          "ลิงก์ล็อกอินเก่า",
          `<p>ลิงก์นี้มาจากเซสชันเก่าก่อนอัปเดตระบบ หรือแท็บ LINE ยังเปิดลิงก์เดิมอยู่</p>
             <p><strong>ทำแบบนี้:</strong> ปิดแท็บ LINE / ปิด in-app browser แล้วเปิดใหม่</p>
             <a class="btn btn-line" href="/checkin">ไปหน้า Check-in แล้วกด LINE ใหม่</a>
             <p class="muted">อย่ารีเฟรช URL ที่มี <code>callback</code> โดยตรง</p>`,
        ),
      );
    }
    if (!verifySignedState(state, "line")) {
      return res.status(400).send(
        htmlPage(
          "LINE state ไม่ถูกต้อง",
          `<p>เปิดจาก <code>/checkin</code> แล้วกดปุ่ม LINE ใหม่เท่านั้น (อย่า bookmark URL callback)</p>
           <a class="btn btn-line" href="/checkin">กลับไป Check-in</a>`,
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
      new Date().toISOString(),
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
      <div class="success-icon" aria-hidden="true">✓</div>
      <div class="success-title">
        <h1>ลงทะเบียนสำเร็จ</h1>
        <p class="lead" style="margin-bottom:0">เข้าสู่งานเรียบร้อยแล้ว</p>
      </div>
      <div class="divider"></div>
      <p class="eyebrow" style="margin-bottom:10px">ขั้นตอนถัดไป</p>
      ${addOaButtonsHtml()}
      ${checkinSuccessArtworkHtml()}
    `;
    res.send(htmlPage("MALI — ลงทะเบียนสำเร็จ", body));
  } catch (error) {
    const lineBody =
      error.response?.data != null ? JSON.stringify(error.response.data) : "";
    let lineRedirectHint = "";
    try {
      lineRedirectHint = getLineRedirectUri();
    } catch {
      lineRedirectHint = "(ตั้ง BASE_URL)";
    }
    const hint =
      error.response?.status === 400
        ? ` มักเกิดจาก: (1) redirect_uri ไม่ตรง — ใน LINE Developers ต้องมี URL เดียวกับ ${lineRedirectHint} (2) รีเฟรชหน้า callback / โค้ดใช้ซ้ำ — เริ่มใหม่จาก /checkin (3) Channel secret ไม่ใช่ของ LINE Login channel`
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
          "ลิงก์ล็อกอินเก่า",
          `<p>ลิงก์นี้มาจากเซสชันเก่า</p>
           <a class="btn btn-line" href="/checkin">ไปหน้า Check-in แล้วกด Google ใหม่</a>`,
        ),
      );
    }
    if (!verifySignedState(state, "google")) {
      return res.status(400).send(
        htmlPage(
          "Google state ไม่ถูกต้อง",
          `<p>เปิดจาก <code>/checkin</code> แล้วกดปุ่ม Google ใหม่</p>
           <a class="btn btn-line" href="/checkin">กลับไป Check-in</a>`,
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
      new Date().toISOString(),
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
      <div class="success-icon" aria-hidden="true">✓</div>
      <div class="success-title">
        <h1>ลงทะเบียนสำเร็จ</h1>
        <p class="lead" style="margin-bottom:0">เข้าสู่งานเรียบร้อยแล้ว</p>
      </div>
      <div class="divider"></div>
      <p class="eyebrow" style="margin-bottom:10px">ขั้นตอนถัดไป</p>
      ${addOaButtonsHtml()}
      ${checkinSuccessArtworkHtml()}
    `;
    res.send(htmlPage("MALI — ลงทะเบียนสำเร็จ", body));
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
      `LINE OAuth redirect_uri (ลงทะเบียนใน LINE Developers ให้ตรง): ${getLineRedirectUri()}`,
    );
  } catch (e) {
    console.warn(String(e.message || e));
  }
});
