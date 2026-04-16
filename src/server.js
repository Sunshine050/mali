const express = require("express");
const dotenv = require("dotenv");
const crypto = require("crypto");
const axios = require("axios");
const { google } = require("googleapis");
const { getGoogleSheetsAuth } = require("./googleSheetsAuth");

dotenv.config();

const app = express();
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

/** ปุ่มเพิ่มเพื่อน: มือถือใช้ line:// เปิดแอปได้โดยไม่ต้องสแกน QR หน้าเว็บบน PC */
function addOaSectionHtml() {
  const webUrl = LINE_OA_ADD_FRIEND_URL || "";
  const basicId = normalizeLineBasicId(LINE_OA_BASIC_ID_RAW);
  const lineAppUrl = basicId ? `line://ti/p/${basicId}` : "";
  let buttons = "";
  if (lineAppUrl && webUrl) {
    buttons = `
      <a class="btn primary" href="${htmlAttr(lineAppUrl)}">เปิด LINE เพื่อเพิ่มเพื่อน (แนะนำ · มือถือ)</a>
      <a class="btn" href="${htmlAttr(webUrl)}">เปิดแบบลิงก์เว็บ</a>`;
  } else if (webUrl) {
    buttons = `<a class="btn primary" href="${htmlAttr(webUrl)}">Add LINE OA</a>`;
  }
  return `${buttons}
      <p class="muted">บนคอมพิวเตอร์ LINE มักแสดงหน้าให้สแกน QR ในมือถือ — ลูกค้าที่ใช้มือถือกดปุ่ม &quot;เปิด LINE&quot; ด้านบนเพื่อเข้าแอปโดยตรง (ไม่ต้องสแกนรอบสอง)</p>
      <p class="muted">ถ้าล็อกอินด้วย LINE แล้วระบบให้ Add OA ในขั้นตอน OAuth อยู่แล้ว อาจไม่ต้องกดซ้ำ</p>`;
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
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 560px; margin: 24px auto; line-height: 1.5; padding: 0 16px; }
    .card { border: 1px solid #ddd; border-radius: 10px; padding: 18px; }
    .btn { display: inline-block; margin: 8px 8px 0 0; padding: 10px 14px; border-radius: 8px; text-decoration: none; border: 1px solid #222; }
    .primary { background: #111; color: #fff; }
    .muted { color: #666; font-size: 14px; }
    code { background: #f7f7f7; padding: 2px 4px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="card">
    ${body}
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
    <h2>QR ลงทะเบียนเข้างาน</h2>
    <p>ผู้เข้างาน<strong>สแกน QR นี้ครั้งเดียว</strong>เพื่อเข้าหน้า Login ลงทะเบียน — QR คือรูปที่เก็บ URL เดียวกับการเปิดลิงก์จากกล้อง</p>
    <p><img src="${htmlAttr(qrImgSrc)}" width="420" height="420" alt="Check-in QR" style="max-width:100%;height:auto;border:1px solid #ddd" /></p>
    <p class="muted"><strong>URL ใน QR:</strong> <code>${htmlAttr(checkinUrl)}</code></p>
    <p class="muted">วันงานจริง: ตั้ง <code>BASE_URL</code> เป็น HTTPS โดเมนจริง แล้วพิมพ์หน้านี้หรือส่งออก PNG จากเครื่องมือสร้าง QR จาก URL เดียวกัน</p>
    <a class="btn" href="/checkin">เปิดหน้า Check-in (ทดสอบ)</a>
  `;
  res.send(htmlPage("MALI — QR Check-in", body));
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
    <h2>MALI Event Check-in</h2>
    <p>สแกนครั้งเดียวและเลือกวิธีล็อกอินเพื่อลงทะเบียนเข้างาน</p>
    <a class="btn primary" href="${lineAuthUrl}">Continue with LINE</a>
    <a class="btn" href="${googleAuthUrl}">Continue with Google</a>
    <p class="muted">Flow นี้รองรับแพ็กเกจ B (LINE + Google)</p>
  `;
  res.send(htmlPage("MALI Check-in", body));
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
             <a class="btn primary" href="/checkin">ไปหน้า Check-in แล้วกด LINE ใหม่</a>
             <p class="muted">อย่ารีเฟรช URL ที่มี <code>callback</code> โดยตรง</p>`,
        ),
      );
    }
    if (!verifySignedState(state, "line")) {
      return res.status(400).send(
        htmlPage(
          "LINE state ไม่ถูกต้อง",
          `<p>เปิดจาก <code>/checkin</code> แล้วกดปุ่ม LINE ใหม่เท่านั้น (อย่า bookmark URL callback)</p>
           <a class="btn primary" href="/checkin">กลับไป Check-in</a>`,
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
      <h2>ลงทะเบียนสำเร็จ</h2>
      <p>เข้าสู่งานเรียบร้อยแล้ว</p>
      ${addOaSectionHtml()}
      <p class="muted">สำหรับเส้นทาง LINE อาจถูกขอให้ยืนยัน Add OA ในขั้นตอน OAuth แล้ว</p>
      <p class="muted">เจ้าหน้าที่: กรุณาตรวจหน้าจอนี้ยืนยันการลงทะเบียน</p>
    `;
    res.send(htmlPage("Check-in success", body));
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
           <a class="btn primary" href="/checkin">ไปหน้า Check-in แล้วกด Google ใหม่</a>`,
        ),
      );
    }
    if (!verifySignedState(state, "google")) {
      return res.status(400).send(
        htmlPage(
          "Google state ไม่ถูกต้อง",
          `<p>เปิดจาก <code>/checkin</code> แล้วกดปุ่ม Google ใหม่</p>
           <a class="btn primary" href="/checkin">กลับไป Check-in</a>`,
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
      <h2>ลงทะเบียนสำเร็จ</h2>
      <p>เข้าสู่งานเรียบร้อยแล้ว</p>
      ${addOaSectionHtml()}
      <p class="muted">เส้นทาง Google ต้องกดเพิ่มเพื่อนอย่างน้อย 1 ครั้ง — ใช้ปุ่ม &quot;เปิด LINE&quot; บนมือถือเพื่อไม่ต้องสแกน QR หน้าเว็บ</p>
      <p class="muted">เจ้าหน้าที่: กรุณาตรวจหน้าจอนี้ยืนยันการลงทะเบียน</p>
    `;
    res.send(htmlPage("Check-in success", body));
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
