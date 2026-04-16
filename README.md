# MALI Event Check-in (Package B)

One-scan event check-in flow with:

- LINE Login
- Google Login
- Save records to Google Sheet
- Add LINE OA without scanning second QR

## 1) Setup

```bash
npm install
```

Copy `.env.example` to `.env` and fill values:

- `BASE_URL` should be your running URL (local or deployed)
- `LINE_LOGIN_CHANNEL_ID`, `LINE_LOGIN_CHANNEL_SECRET` — ต้องเป็นของ **LINE Login channel** ชุดเดียวกัน (ไม่ใช่ Channel secret ของ Messaging API)
- `LINE_OA_ADD_FRIEND_URL` (e.g. `https://line.me/R/ti/p/@xxxxxx` or `https://lin.ee/...`)
- `LINE_OA_BASIC_ID` (e.g. `@057xhooz`) — ใช้สร้างปุ่ม `line://ti/p/@...` ให้มือถือเปิดแอป LINE โดยตรง แทนหน้า QR บน PC
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`
- `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` (path to JSON — ใช้ตอน dev บนเครื่อง) **หรือ** `GOOGLE_SERVICE_ACCOUNT_JSON` (ข้อความ JSON ทั้งก้อน — ใช้บน Render / cloud)
- `GOOGLE_SHEET_ID`, `GOOGLE_SHEET_TAB` (ชื่อแท็บจริง เช่น `ชีต1` หรือ `Sheet1`)

## 2) Google Sheet columns

Create these headers in row 1:

1. `timestamp`
2. `event_id`
3. `auth_provider`
4. `provider_user_id_hash`
5. `display_name`
6. `email`
7. `line_user_id`
8. `oa_added_status` — ค่าที่ระบบรองรับ: `ST_NEWLEAD` (ค่าเริ่มตอนลงทะเบียน), `ST_ENGAGED`, `ST_REDEEMED`, `ST_VISITED`, `ST_INACTIVE` (เช่น ไม่มีปฏิสัมพันธ์ 14 วัน — อัปเดตภายหลังด้วยมือหรือบอท)
9. `checkin_source`
10. `raw_payload_ref`

Also share the sheet with service account email as Editor.

## 3) Run

```bash
npm run dev
```

Open:

- `http://localhost:3000/checkin` — หน้าเลือก LINE / Google Login
- `http://localhost:3000/poster` — **QR สำหรับหน้างาน** (สแกนแล้วเข้า `/checkin` เหมือนกดลิงก์; วันงานตั้ง `BASE_URL` เป็น HTTPS จริง)

**เรื่อง QR vs ลิงก์:** QR หนึ่งรูป = เก็บ URL หนึ่งเส้น — ผู้ใช้สแกนด้วยกล้องแล้วเบราว์เซอร์เปิด URL นั้น ไม่ใช่คนละช่องทางกับลิงก์

## 4) Important

- OAuth `state` is **signed** (not stored in memory), so `node --watch` restarts do not break LINE/Google login mid-flow.
- For LINE route, OAuth URL uses `bot_prompt=normal`
- For Google route, user taps Add OA button after login (no second QR)
- Keep all secrets in `.env`; never commit tokens/keys

## 5) Deploy ให้ลูกค้าเทส (เช่น Render)

1. **Push โปรเจคขึ้น GitHub/GitLab/Bitbucket** (Render ดึงจาก Git)
2. ใน [Render](https://dashboard.render.com/) → **New** → **Blueprint** → เลือก repo ที่มี [`render.yaml`](render.yaml) หรือสร้าง **Web Service** เอง: Runtime Node, Build `npm install`, Start `npm start`, Health check path `/health`
3. หลังได้ URL เช่น `https://mali-checkin.onrender.com` ให้ตั้ง **Environment** ใน Render (อย่า commit `.env`):

| Key                                                   | ค่า                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `BASE_URL`                                            | URL จริงของ service (ไม่มี `/` ท้าย) — **ต้องตรงกับ Callback ใน LINE ทุกตัวอักษร**; ถ้าไม่ใส่ โค้ดจะ fallback `RENDER_EXTERNAL_URL` ของ Render |
| `PORT`                                                | ไม่ต้องใส่ — Render กำหนดให้                                                 |
| `LINE_LOGIN_CHANNEL_ID` / `LINE_LOGIN_CHANNEL_SECRET` | จาก LINE Login channel                                                       |
| `LINE_OA_ADD_FRIEND_URL` / `LINE_OA_BASIC_ID`         | ตามเดิม                                                                      |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`           | จาก Google Cloud                                                             |
| `GOOGLE_REDIRECT_URI`                                 | `https://<host>/auth/google/callback`                                        |
| `GOOGLE_SERVICE_ACCOUNT_JSON`                         | วาง **เนื้อหาไฟล์ JSON ทั้งก้อน** (บรรทัดเดียวหรือ escape ตามที่ Render รับ) |
| `GOOGLE_SHEET_ID` / `GOOGLE_SHEET_TAB`                | ตามชีตจริง                                                                   |
| ค่าอื่นใน `.env` ที่ใช้ local                         | คัดลอกมาใส่ให้ครบ                                                            |

4. **LINE Developers** → LINE Login channel → Callback URL เพิ่ม  
   `https://<host>/auth/line/callback`
5. **Google Cloud** → OAuth client → Authorized redirect URIs เพิ่ม  
   `https://<host>/auth/google/callback` และเพิ่ม **Test users** ถ้าแอปยังอยู่โหมด Testing
6. รีดีพลอย / Redeploy หลังแก้ env
7. ลูกค้าเทส: เปิด `https://<host>/poster` พิมพ์ QR หรือสแกนจากมือถือ → `/checkin` → LINE / Google

**หมายเหตุ:** แพลน `free` อาจหลับหลังไม่มี traffic — เทสเฟสแรกได้ ถ้าต้องการไม่หลับใช้แพลนมีค่า  
**Webhook:** ไม่จำเป็นสำหรับเฟส “สแกน + ล็อกอิน + เขียน Sheet”
