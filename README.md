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

**สร้าง QR จาก `https://<host>`:** (1) เปิด `https://<host>/poster` แล้วบันทึกภาพ QR / พิมพ์หน้า (2) ใช้ [QR Server](https://goqr.me/) หรือ Canva ใส่ URL `https://<host>/checkin` (3) Google Sheet / LINE OA Manager ก็มีเครื่องมือสร้าง QR จากลิงก์ได้

## 4) Important

- OAuth `state` is **signed** (not stored in memory), so `node --watch` restarts do not break LINE/Google login mid-flow.
- For LINE route, OAuth URL uses `bot_prompt=normal`
- For Google route, user taps Add OA button after login (no second QR)
- Keep all secrets in `.env`; never commit tokens/keys

## 5) Deploy ให้ลูกค้าเทส (เช่น Render)

1. **Push โปรเจคขึ้น GitHub/GitLab/Bitbucket** (Render ดึงจาก Git)
2. ใน [Render](https://dashboard.render.com/) → **New** → **Blueprint** → เลือก repo ที่มี [`render.yaml`](render.yaml) หรือสร้าง **Web Service** เอง: Runtime Node, Build `npm install`, Start `npm start`, Health check path `/health`
3. หลังได้ URL เช่น `https://mali-checkin.onrender.com` ให้ตั้ง **Environment** ใน Render (อย่า commit `.env`):

| Key                                                   | ค่า                                                                                                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `BASE_URL`                                            | URL จริงของ service (ไม่มี `/` ท้าย) — **ต้องตรงกับ Callback ใน LINE ทุกตัวอักษร**; ถ้าไม่ใส่ โค้ดจะ fallback `RENDER_EXTERNAL_URL` ของ Render |
| `PORT`                                                | ไม่ต้องใส่ — Render กำหนดให้                                                                                                                   |
| `LINE_LOGIN_CHANNEL_ID` / `LINE_LOGIN_CHANNEL_SECRET` | จาก LINE Login channel                                                                                                                         |
| `LINE_OA_ADD_FRIEND_URL` / `LINE_OA_BASIC_ID`         | ตามเดิม                                                                                                                                        |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`           | จาก Google Cloud                                                                                                                               |
| `GOOGLE_REDIRECT_URI`                                 | `https://<host>/auth/google/callback`                                                                                                          |
| `GOOGLE_SERVICE_ACCOUNT_JSON`                         | วาง **เนื้อหาไฟล์ JSON ทั้งก้อน** (บรรทัดเดียวหรือ escape ตามที่ Render รับ)                                                                   |
| `GOOGLE_SHEET_ID` / `GOOGLE_SHEET_TAB`                | ตามชีตจริง                                                                                                                                     |
| ค่าอื่นใน `.env` ที่ใช้ local                         | คัดลอกมาใส่ให้ครบ                                                                                                                              |

4. **LINE Developers** → LINE Login channel → Callback URL เพิ่ม  
   `https://<host>/auth/line/callback`
5. **Google Cloud** → OAuth client → Authorized redirect URIs เพิ่ม  
   `https://<host>/auth/google/callback` และเพิ่ม **Test users** ถ้าแอปยังอยู่โหมด Testing
6. รีดีพลอย / Redeploy หลังแก้ env
7. ลูกค้าเทส: เปิด `https://<host>/poster` พิมพ์ QR หรือสแกนจากมือถือ → `/checkin` → LINE / Google

**หมายเหตุ:** แพลน `free` อาจหลับหลังไม่มี traffic — เทสเฟสแรกได้ ถ้าต้องการไม่หลับใช้แพลนมีค่า  
**Webhook:** ไม่จำเป็นสำหรับเฟส “สแกน + ล็อกอิน + เขียน Sheet”

### Render — ข้อผิดพลาดที่พบบ่อย

- **Service account:** ใช้ตัวแปร **`GOOGLE_SERVICE_ACCOUNT_JSON`** วาง JSON ทั้งก้อน — **อย่า**ใส่ JSON ในชื่อ `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` (ชื่อนั้นสำหรับ path ไฟล์บนเครื่อง dev เท่านั้น)
- **อย่าใส่ `PORT` บน Render** — ให้แพลตฟอร์มกำหนด `PORT` เอง
- **`LINE_OA_BASIC_ID`:** ต้องเป็น `@057xhooz` (มี @) — ถ้าพิมพ์ `a057...` โค้ดจะพยายามแก้เป็น `@057...` อัตโนมัติ
- **Google Client ID / Sheet ID:** คัดลอกจาก Console ใหม่ทั้งดุ้น ตัวเลขผิดหนึ่งตัวจะล็อกอิน/เขียน Sheet ไม่ได้

## 6) Keep Alive for Render Free

- มี endpoint เบาๆ ที่ `GET /warmup` (หรือใช้ `GET /health` ก็ได้)
- มี GitHub Actions workflow ที่ `.github/workflows/keep-render-awake.yml`
- workflow จะ ping `https://mali-2upq.onrender.com/warmup` ทุก 5 นาที และกดรันเองได้จากแท็บ Actions
- หลัง push ขึ้น GitHub ให้เข้า repo -> `Actions` -> เปิดใช้งาน workflow ถ้าระบบถาม
- วิธีนี้ช่วยลดโอกาส cold start แต่ไม่ได้การันตี 100% เท่ากับอัปเกรดเป็น Starter plan

### UptimeRobot (ทางเลือก — ไม่ต้องพึ่ง GitHub Actions)

1. สมัคร/ล็อกอินที่ [UptimeRobot](https://uptimerobot.com/)
2. **Add New Monitor**
3. **Monitor Type:** `HTTP(s)`
4. **Friendly Name:** ตั้งชื่ออะไรก็ได้ (เช่น `MALI Render warmup`)
5. **URL:** `https://<ชื่อ-service-ของคุณ>.onrender.com/warmup`  
   แทน `<ชื่อ-service-ของคุณ>` ด้วยโดเมนจริงจาก Render (เช่น `https://mali-2upq.onrender.com/warmup`)
6. **Monitoring Interval:** ตั้ง **5 นาที** (หรือถี่กว่านั้นถ้าแพลนรองรับ) — Render Free หลับหลังไม่มี traffic ~15 นาที การ ping ทุก 5 นาทีจะช่วยให้ instance ตื่นอยู่บ่อยครั้ง
7. บันทึก — รอ request แรกผ่าน (ครั้งแรกอาจยังเห็นหน้า spin-up ของ Render จนกว่า service จะตื่น)

**หมายเหตุ:** ถ้าไม่อยากได้อีเมลแจ้งเตือนตอน service หลับชั่วคราว ให้ปรับ **Alert contacts** หรือ threshold ใน UptimeRobot ตามต้องการ
