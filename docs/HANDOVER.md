# 工作動態回報系統 — 交接文件（給資訊人員）

> 本文件提供將本系統移交公司資訊單位自行架設、維運所需的全部資訊。
> 適合具備 Node.js / Docker / 反向代理基本知識的人員依此重現整套服務。

---

## 1. 系統概述

純 **Node.js + Express** 的單體應用，前端為靜態 HTML（無前端框架、無建置步驟），
資料庫使用 **libSQL（SQLite 相容）**，可選雲端（Turso）或本地檔案。

| 元件 | 技術 | 說明 |
|------|------|------|
| 後端 | Node.js (>=18) + Express 4 | 全部 API 集中在 `server.js` |
| 資料庫 | libSQL / SQLite（`@libsql/client`） | Turso 雲端 **或** 本地 `.db` 檔皆可 |
| 密碼雜湊 | bcryptjs（cost 12） | |
| 安全 | helmet（CSP）、express-rate-limit | |
| 前端 | 靜態 HTML + Leaflet 地圖（CDN）+ PWA | `public/` 目錄 |
| 容器化 | Dockerfile + docker-compose.yml | 已備妥，可直接用 |

### 目錄結構
```
work-report-system/
├── server.js            # 主程式（所有 API、靜態檔服務）
├── database.js          # 資料庫連線 + 資料表自動建立
├── package.json
├── Dockerfile           # 生產用多階段映像
├── docker-compose.yml   # 一鍵部署
├── .env.example         # 環境變數範本
└── public/              # 前端靜態檔（report.html / index.html / track.html / PWA）
```

---

## 2. 交付清單（移交時要交給 IT 的東西）

1. **原始碼**：GitHub repo 轉移或授權（見第 3 節）
2. **環境變數值**：目前線上使用的 `.env` 內容（**含資料庫憑證，請以安全管道交付**，勿放進 Git）
3. **資料庫資料**：現有資料的匯出檔（見第 5 節）
4. **本文件**：架設與維運說明
5. （選用）現有 Render / Turso 帳號的存取權，若要先沿用再逐步搬遷

---

## 3. 原始碼移交（GitHub）

目前 repo：`https://github.com/sian-de/work-report-system`（私有）

擇一：
- **轉移擁有權**：GitHub repo → Settings → 最下方 **Transfer ownership** → 輸入公司帳號 / 組織。
- **加入協作者**：Settings → Collaborators → 邀請 IT 帳號（保留你的擁有權）。
- **匯出一份乾淨副本**：
  ```bash
  git clone --bare https://github.com/sian-de/work-report-system.git
  # 交付此資料夾，或由 IT push 到公司自有 Git 伺服器（GitLab / Gitea 等）
  ```

> ⚠️ Git 歷史中**不應**含 `.env`（已被 `.gitignore` 排除）。憑證請另以安全方式（密碼管理工具 / 加密郵件）交付，不要寫進 repo。

---

## 4. 環境變數（`.env`）

複製範本後填值：`cp .env.example .env`

| 變數 | 必填 | 說明 |
|------|:---:|------|
| `PORT` | 否 | 服務埠，預設 `3000` |
| `TURSO_DATABASE_URL` | 視情況 | 雲端：`libsql://xxx.turso.io`；本地檔案：`file:/app/data/reports.db` |
| `TURSO_AUTH_TOKEN` | 雲端才需 | Turso 存取權杖；本地模式留空 |

- 若 **不填** `TURSO_*`，系統會自動使用程式目錄下的本地檔案 `reports.db`。
- 資料表會在啟動時**自動建立**（`database.js` 的 `initDB()`），IT 無需手動跑 SQL。

---

## 5. 資料庫處理

### 5-1. 結構
共 4 張表：`users`、`reports`、`task_types`、`groups`（定義見 `database.js`）。
首次啟動自動建表，並植入預設事項類型。

### 5-2. 三種資料庫選擇（IT 擇一）

**A. 繼續用 Turso 雲端**（最省事）
轉移 Turso 帳號或建立公司自己的 Turso DB，填入新的 `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` 即可。

**B. 改用公司自架的 libSQL / 本地 SQLite 檔**（資料留在公司內網）
- 設定 `TURSO_DATABASE_URL=file:/app/data/reports.db`、`TURSO_AUTH_TOKEN` 留空。
- 用 Docker 時務必掛載 volume 讓資料持久化（見第 6 節的注意事項）。

**C. 自架 sqld（libSQL server）**：適合要多台、要備援者，填入 sqld 的連線 URL。

### 5-3. 既有資料搬遷
若要把現有資料帶到新環境：
```bash
# 從現有 Turso 匯出（需安裝 turso CLI 並登入）
turso db shell <你的資料庫名稱> ".dump" > backup.sql

# 匯入新環境（本地 SQLite 為例）
sqlite3 reports.db < backup.sql
```
> 若資料量不大，也可由舊系統的「CSV 匯出」功能（後台 → 匯出 CSV）備份回報資料。

---

## 6. 部署方式

### 方式一：Docker Compose（建議，最簡單）
```bash
cp .env.example .env      # 填入實際值
docker compose up -d      # 背景啟動
# 服務在 http://伺服器IP:3000
```

### 方式二：純 Node.js
```bash
npm ci --omit=dev
node server.js            # 或 npm start
```
建議用 `pm2` 或 systemd 顧進程，確保當機 / 重開機後自動拉起。

### 方式三：任何支援 Node 的 PaaS
Render / Railway / Fly.io / Azure App Service 等皆可，啟動指令 `node server.js`，設好環境變數即可。

### 反向代理 + HTTPS（正式環境務必做）
本系統**不自行處理 TLS**，請用 Nginx / Caddy / 公司既有負載平衡器在前面終結 HTTPS。
- GPS 定位（前台核心功能）在多數瀏覽器**只有 HTTPS 才會放行**，內網用自簽憑證或內部 CA 亦可。
- Nginx 範例：
  ```nginx
  server {
    listen 443 ssl;
    server_name reports.公司網域;
    ssl_certificate     /path/fullchain.pem;
    ssl_certificate_key /path/privkey.pem;
    location / {
      proxy_pass http://127.0.0.1:3000;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
    }
  }
  ```

---

## 7. 首次上線必做

1. **修改預設管理員密碼**
   系統啟動時若無管理員，會自動建立 `admin / admin123`（見 `server.js`）。
   **上線後請立即用 admin 登入 → 後台改密碼**，否則是重大資安風險。
2. 確認服務在 HTTPS 下可正常定位 GPS。
3. 建立公司實際的群組、人員、主管權限。
4. 設定資料庫定期備份（Turso 有快照；本地檔請排程備份 `.db`）。

---

## 8. 已知限制 / 維運注意（⚠️ 請務必告知 IT）

1. **登入 session 存在「記憶體」中（非資料庫 / 非 Redis）**
   - `server.js` 用 `const sessions = new Map()` 保存 token。
   - **影響一**：每次重啟 / 重新部署，所有人會被登出（需重新登入）。屬正常、可接受。
   - **影響二（重要）**：**不支援多執行個體 / 水平擴展**。若放在負載平衡器後跑多個副本，A 副本發的 token 到 B 副本會失效，導致登入隨機失敗。
     - 解法：① 只跑**單一執行個體**（本系統流量需求通常足夠）；或 ② 在 LB 開啟 **sticky session（依來源綁定）**；或 ③ 改寫為共享 session 儲存（Redis），此為程式調整，需開發資源。

2. **本地 SQLite 的持久化路徑**
   - `database.js` 預設檔名是 `reports.db`（位於程式目錄 `/app`），但 `docker-compose.yml` 掛載的 volume 是 `/app/data`。
   - 若選「本地檔案模式」，請把 `TURSO_DATABASE_URL` 設為 **`file:/app/data/reports.db`**，否則資料會寫到沒被掛載的位置，**容器重建即遺失**。

3. **rate limit**：登入 / 註冊 / 忘記密碼端點每 IP 每 15 分鐘 10 次。若全公司經由單一 NAT/Proxy 出口，可能誤觸；必要時調整 `server.js` 的 `authLimiter` 或設定 `app.set('trust proxy', ...)` 取得真實來源 IP。

4. **CSP / CDN 依賴**：前端地圖用 unpkg.com 的 Leaflet（CDN）。若公司內網無法連外，需改為本地託管 Leaflet，並同步調整 `server.js` 的 helmet CSP 白名單。

5. **無自動化測試**：變更後請以手動冒煙測試為主（登入、回報、地圖、後台各分頁）。

---

## 9. 交接檢查清單

- [ ] repo 已轉移 / 授權給 IT，且確認可 clone
- [ ] `.env` 實際值已以安全管道交付（資料庫 URL / token）
- [ ] 既有資料已匯出並交付（`.dump` 或 CSV）
- [ ] IT 已能在測試環境啟動並登入
- [ ] 已決定資料庫方案（Turso / 本地檔 / 自架 sqld）
- [ ] 已配置 HTTPS（反向代理）且 GPS 定位正常
- [ ] **已修改預設 admin 密碼**
- [ ] 已設定進程守護（pm2 / systemd / compose restart）
- [ ] 已設定資料庫備份排程
- [ ] 已告知第 8 節的 session 與多副本限制

---

## 10. 聯絡 / 後續

- 技術細節另見 `docs/technical-guide.md`。
- 原部署平台：Render（自動部署自 `main`）；原資料庫：Turso。移交後可逐步停用。
