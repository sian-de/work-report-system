# 工作動態回報系統 — 技術文件

> 版本：1.0.0 ｜ 最後更新：2026-05-28

---

## 1. 系統概述

工作動態回報系統是一套為稽查/調查人員設計的外勤工作回報平台。人員透過手機瀏覽器即時回報工作動態（含 GPS 定位），主管與管理員可在後台即時監控人員位置、查看統計報表。

### 核心功能

| 功能 | 說明 |
|------|------|
| 即時回報 | 職員透過手機填寫工作事項，自動記錄 GPS 座標 |
| 同事位置 | 地圖即時顯示全組同事最新位置與停留時間 |
| 日報表 | 職員可自選日期區間，產生統計報表並列印/匯出 Excel |
| 後台管理 | 管理員/主管可查看所有回報、篩選匯出、管理人員分組 |
| 即時狀態板 | 儀表板顯示今日回報狀態，區分已回報/未回報人員 |
| PWA 支援 | 手機可「加到主畫面」，像 App 一樣使用 |

### 角色權限

| 角色 | 前台（report.html） | 後台（index.html） | 資料範圍 |
|------|---------------------|---------------------|----------|
| 管理員 (admin) | ✅ | ✅ | 所有人 |
| 主管 (supervisor) | ✅ | ✅ | 所有人 |
| 一般職員 (user) | ✅ | ❌（自動導向前台） | 僅自己 |

---

## 2. 技術架構

```
┌─────────────────────────────────────────────┐
│                  使用者裝置                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ 手機瀏覽器 │  │ 桌機瀏覽器 │  │  PWA App  │   │
│  └─────┬────┘  └─────┬────┘  └─────┬────┘   │
└────────┼─────────────┼─────────────┼────────┘
         │             │             │
         ▼             ▼             ▼
┌─────────────────────────────────────────────┐
│              Express.js 伺服器               │
│  ┌─────────┐ ┌────────┐ ┌───────────────┐  │
│  │ helmet   │ │ gzip   │ │ rate-limiter  │  │
│  │ (安全)   │ │ (壓縮)  │ │ (防暴力破解)   │  │
│  └─────────┘ └────────┘ └───────────────┘  │
│  ┌──────────────────────────────────────┐   │
│  │           REST API 層                 │   │
│  │  認證 / 回報 / 查詢 / 管理 / 匯出     │   │
│  └──────────────┬───────────────────────┘   │
│                 │                            │
│  ┌──────────────▼───────────────────────┐   │
│  │      @libsql/client 資料庫驅動        │   │
│  └──────────────┬───────────────────────┘   │
└─────────────────┼───────────────────────────┘
                  │
         ┌────────┴────────┐
         ▼                 ▼
┌────────────────┐ ┌────────────────┐
│  Turso 雲端 DB  │ │  本地 SQLite   │
│  (推薦/生產)    │ │  (開發/備用)    │
└────────────────┘ └────────────────┘
```

### 技術堆疊

| 元件 | 技術 | 說明 |
|------|------|------|
| 後端框架 | Express.js 4.x | Node.js HTTP 伺服器 |
| 資料庫 | Turso (libSQL) | 相容 SQLite 的雲端資料庫 |
| 密碼加密 | bcryptjs | 自帶鹽值，cost factor 12 |
| 安全標頭 | helmet | CSP、X-Frame-Options 等 15+ 安全標頭 |
| 速率限制 | express-rate-limit | 防暴力登入，每 IP 每 15 分鐘 10 次 |
| 壓縮 | compression | gzip 壓縮，減少 60-70% 傳輸量 |
| 地圖 | Leaflet.js（CDN） | 前端 GPS 定位視覺化 |
| PWA | Service Worker | 網路優先策略，支援離線快取 |

---

## 3. 專案目錄結構

```
work-report-system/
├── server.js          # 主伺服器程式（所有 API）
├── database.js        # 資料庫連線與初始化
├── package.json       # Node.js 專案設定
├── .env               # 環境變數（勿加入 Git）
├── .env.example       # 環境變數範本
├── .gitignore
├── Dockerfile         # Docker 映像構建
├── docker-compose.yml # Docker Compose 部署
├── .dockerignore
├── public/
│   ├── report.html    # 職員前台（回報/紀錄/地圖/日報表）
│   ├── index.html     # 管理後台（報表/管理/狀態板）
│   ├── track.html     # GPS 追蹤頁面
│   ├── manifest.json  # PWA 設定檔
│   └── sw.js          # Service Worker
└── docs/
    └── technical-guide.md  # 本文件
```

---

## 4. 資料庫結構

### users 表

| 欄位 | 型別 | 說明 |
|------|------|------|
| user_id | TEXT PK | 帳號（唯一識別） |
| display_name | TEXT | 顯示名稱 |
| group_id | TEXT | 所屬分組 |
| is_supervisor | INTEGER | 是否為主管（0/1） |
| password_hash | TEXT | bcrypt 密碼雜湊 |
| role | TEXT | 角色（admin/user） |
| created_at | DATETIME | 建立時間 |

### reports 表

| 欄位 | 型別 | 說明 |
|------|------|------|
| id | INTEGER PK | 自動編號 |
| user_id | TEXT FK | 回報人帳號 |
| display_name | TEXT | 回報人姓名 |
| group_id | TEXT | 回報人分組 |
| report_date | TEXT | 回報日期（YYYY-MM-DD） |
| report_time | TEXT | 回報時間（HH:MM） |
| task_type | TEXT | 事項類型 |
| location | TEXT | 地點 |
| task_description | TEXT | 工作內容 |
| gps_latitude | REAL | GPS 緯度 |
| gps_longitude | REAL | GPS 經度 |
| created_at | DATETIME | 建立時間 |

### task_types 表

| 欄位 | 型別 | 說明 |
|------|------|------|
| id | INTEGER PK | 自動編號 |
| name | TEXT UNIQUE | 類型名稱 |
| emoji | TEXT | 圖示 |
| sort_order | INTEGER | 排序順序 |
| is_active | INTEGER | 是否啟用（0/1） |

### groups 表

| 欄位 | 型別 | 說明 |
|------|------|------|
| id | INTEGER PK | 自動編號 |
| name | TEXT UNIQUE | 分組名稱 |

### 索引

- `idx_reports_date` — reports(created_at)
- `idx_reports_user` — reports(user_id)
- `idx_reports_report_date` — reports(report_date)

---

## 5. API 參考

### 認證相關

| 方法 | 路徑 | 權限 | 說明 |
|------|------|------|------|
| POST | `/api/register` | 公開（限速） | 註冊新帳號 |
| POST | `/api/login` | 公開（限速） | 登入取得 token |
| POST | `/api/logout` | 登入 | 登出 |
| GET | `/api/me` | 登入 | 取得目前使用者資訊 |
| POST | `/api/forgot-password` | 公開（限速） | 忘記密碼重設 |
| POST | `/api/change-password` | 登入 | 修改密碼 |

### 回報相關

| 方法 | 路徑 | 權限 | 說明 |
|------|------|------|------|
| POST | `/api/submit-report` | 登入 | 提交工作回報 |
| GET | `/api/reports` | 登入 | 查詢回報列表（支援篩選） |
| GET | `/api/my-reports` | 登入 | 查詢自己的回報（支援日期區間） |
| PUT | `/api/reports/:id` | 登入 | 修改回報 |
| DELETE | `/api/reports/:id` | 登入 | 刪除回報 |
| GET | `/api/user-today` | 登入 | 取得今日回報數 |
| GET | `/api/summary` | 登入 | 取得統計摘要 |
| GET | `/api/export` | 管理員 | CSV 匯出 |

### GPS 相關

| 方法 | 路徑 | 權限 | 說明 |
|------|------|------|------|
| GET | `/api/trajectory` | 登入 | 查詢軌跡 |
| GET | `/api/gps-users` | 登入 | 有 GPS 資料的使用者列表 |
| GET | `/api/last-locations` | 登入 | 所有同事最新位置 |

### 管理相關

| 方法 | 路徑 | 權限 | 說明 |
|------|------|------|------|
| GET | `/api/users` | 登入 | 使用者列表 |
| DELETE | `/api/users/:userId` | 管理員 | 刪除使用者 |
| PUT | `/api/users/:userId/group` | 管理員 | 設定使用者分組/角色 |
| POST | `/api/users/:userId/reset-password` | 管理員 | 重設使用者密碼 |
| GET | `/api/users/unassigned` | 登入 | 未分組使用者列表 |

### 事項類型 / 分組

| 方法 | 路徑 | 權限 | 說明 |
|------|------|------|------|
| GET | `/api/task-types` | 登入 | 取得啟用中的事項類型 |
| GET | `/api/task-types/all` | 管理員 | 取得所有事項類型 |
| POST | `/api/task-types` | 管理員 | 新增事項類型 |
| PUT | `/api/task-types/:id` | 管理員 | 修改事項類型 |
| DELETE | `/api/task-types/:id` | 管理員 | 刪除事項類型 |
| GET | `/api/groups` | 登入 | 分組列表 |
| POST | `/api/groups` | 管理員 | 新增分組 |
| PUT | `/api/groups/:id` | 管理員 | 修改分組 |
| DELETE | `/api/groups/:id` | 管理員 | 刪除分組 |

### 狀態板

| 方法 | 路徑 | 權限 | 說明 |
|------|------|------|------|
| GET | `/api/status-board` | 登入 | 今日回報狀態板 |
| GET | `/api/health` | 公開 | 健康檢查 |

---

## 6. 認證機制

- 使用 **Token-based Session** 認證（非 JWT）
- 登入成功後，伺服器產生隨機 token 存入記憶體 Map
- Token 有效期 **24 小時**，過期自動清除
- 前端存放於 `localStorage`，每次 API 請求帶在 `Authorization: Bearer <token>` 標頭

### 密碼安全

- 使用 **bcryptjs** 加密（cost factor 12）
- 舊 SHA-256 密碼在登入時自動升級為 bcrypt 格式
- 登入端點受 **rate limiting** 保護（每 IP 每 15 分鐘最多 10 次）

---

## 7. 部署指南

### 方式一：Docker Compose（推薦）

```bash
# 1. 複製專案
git clone https://github.com/your-org/work-report-system.git
cd work-report-system

# 2. 設定環境變數
cp .env.example .env
# 編輯 .env，填入 Turso 資料庫連線資訊

# 3. 啟動
docker compose up -d

# 4. 確認運行中
docker compose ps
docker compose logs -f app

# 5. 開啟瀏覽器
# http://localhost:3000
```

#### 常用指令

```bash
# 停止
docker compose down

# 更新（拉取新版程式碼後）
git pull
docker compose up -d --build

# 查看日誌
docker compose logs -f app

# 進入容器除錯
docker exec -it work-report-system sh
```

### 方式二：直接執行 Node.js

```bash
# 前置需求：Node.js >= 18

# 1. 安裝依賴
npm ci --omit=dev

# 2. 設定環境變數
cp .env.example .env
# 編輯 .env

# 3. 啟動
node server.js
# 或用 PM2 管理程序
npm install -g pm2
pm2 start server.js --name work-report
pm2 save
pm2 startup
```

### 方式三：Render 雲端（目前使用）

1. 將 GitHub repo 連結至 [Render](https://render.com)
2. 建立 Web Service → 選擇 repo
3. Build Command：`npm install`
4. Start Command：`node server.js`
5. 在 Environment 設定環境變數
6. 每次 push 到 main 分支自動部署

---

## 8. 環境變數說明

| 變數名稱 | 必要 | 預設值 | 說明 |
|----------|------|--------|------|
| `PORT` | 否 | 3000 | 伺服器監聽埠號 |
| `TURSO_DATABASE_URL` | 是* | `file:reports.db` | Turso 資料庫 URL |
| `TURSO_AUTH_TOKEN` | 是* | — | Turso 認證 Token |

> *若不設定 Turso，系統自動使用本地 SQLite 檔案

---

## 9. 安全機制

| 機制 | 實作方式 |
|------|----------|
| 安全標頭 | helmet.js — CSP、X-Frame-Options、HSTS 等 |
| 密碼加密 | bcryptjs（cost 12，自帶鹽值） |
| 暴力破解防護 | express-rate-limit（登入/註冊/忘記密碼） |
| CSV 匯出保護 | 需管理員權限 |
| HTTPS | 由部署平台（Render/Nginx）處理 |
| 輸入驗證 | 後端參數化查詢，防 SQL Injection |

---

## 10. 初始設定

### 建立管理員帳號

1. 第一位註冊的使用者預設為一般職員
2. 需手動將第一位使用者升級為管理員：

```bash
# 使用 Turso CLI
turso db shell your-database
> UPDATE users SET role = 'admin' WHERE user_id = 'your_account';
```

3. 之後管理員可在後台管理其他使用者的角色與分組

### 預設事項類型

系統啟動時會自動建立 6 種預設事項類型，管理員可在後台新增/修改/刪除。

---

## 11. 維運注意事項

- **Session 儲存在記憶體**：伺服器重啟後所有使用者需重新登入
- **Turso 免費額度**：每月 9GB 儲存、500M 讀取列，一般使用足夠
- **Render 免費額度**：閒置 15 分鐘後休眠，首次訪問需 30-60 秒喚醒
- **備份**：Turso 自動備份；若使用本地 SQLite，建議定期備份 `reports.db`
- **監控**：`GET /api/health` 回傳 `{ status: 'ok' }`，可接入監控系統

---

## 12. 故障排除

| 問題 | 可能原因 | 解決方式 |
|------|----------|----------|
| 無法登入 | 密碼錯誤或帳號不存在 | 管理員重設密碼 |
| GPS 不定位 | 瀏覽器未授權位置權限 | 手機設定 → 允許位置存取 |
| 頁面空白 | CSP 阻擋腳本 | 檢查 helmet CSP 設定 |
| API 回 429 | 觸發速率限制 | 等待 15 分鐘後重試 |
| Docker 啟動失敗 | .env 未設定 | 確認 .env 檔案存在且正確 |
