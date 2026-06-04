# 工作動態回報系統 — 專案說明

## 專案位置
- **本機**：`C:\Users\User\Desktop\Documents\Claude作業區域\work-report-system\`
- **GitHub**：https://github.com/sian-de/work-report-system（私有）
- **線上服務**：https://work-report-system-bmnq.onrender.com
- **資料庫**：Turso 雲端 libSQL — `libsql://work-reports-sian-de.aws-ap-northeast-1.turso.io`
- **Node.js**：`C:\Program Files\nodejs\node.exe`

## 技術堆疊
| 元件 | 技術 |
|------|------|
| 後端 | Node.js + Express 4.x |
| 資料庫 | Turso (libSQL / SQLite 相容) |
| 密碼 | bcryptjs（cost 12） |
| 安全 | helmet（CSP 含 unsafe-inline）、express-rate-limit |
| 壓縮 | compression |
| 前端地圖 | Leaflet.js（CDN unpkg.com） |
| PWA | manifest.json + sw.js（network-first） |
| 部署 | Render（push main 自動部署）|

## 目錄結構
```
work-report-system/
├── server.js          # 主伺服器 + 所有 API
├── database.js        # 資料庫連線與資料表初始化
├── package.json
├── .env               # 環境變數（不在 Git）
├── .env.example
├── Dockerfile
├── docker-compose.yml
├── public/
│   ├── report.html    # 職員前台
│   ├── index.html     # 管理後台
│   ├── track.html
│   ├── manifest.json
│   └── sw.js
└── docs/
    ├── technical-guide.md
    └── 技術文件-工作動態回報系統.html
```

## 角色權限（公司資料隔離）
| 角色 | 前台 | 後台 | 資料範圍 |
|------|------|------|----------|
| admin | ✅ | ✅ 全功能 | 所有公司 |
| is_supervisor=1（主管）| ✅ | ✅（限本公司）| 其管轄公司（`supervisor_companies` 多對多，可跨多間）|
| 一般職員（稽查員）| ✅ | ❌（導向前台）| 僅自己 |

- 主管「可檢視」的公司來自 `supervisor_companies`（一位主管可管多間公司）。
- 人員「所屬」公司為 `users.company_id`（決定其回報歸屬哪間公司）。
- 隔離一律於後端強制：reports / summary / status-board / users / trajectory / gps-users / last-locations / export 皆依範圍過濾；快取 key 含範圍避免跨公司外洩。
- 同事位置地圖：稽查員看「所屬公司」同事；主管看「管轄公司」；點位最後回報超過 2 小時顯示灰色。

## 回報類型（4 種）
| 類型 | 圖示 | 顏色 | 需填地點+內容 |
|------|------|------|:---:|
| 到達 | 📍 | 綠 | ✅ |
| 離開 | 🚗 | 橘 | ❌（僅記 GPS）|
| 隨車(上車) | 🚌 | 藍 | ✅ |
| 隨車(下車) | 🚏 | 紫 | ✅ |

## 資料庫結構
- **users**：user_id, display_name, group_id, is_supervisor, company_id, password_hash, role, created_at
- **reports**：id, user_id, display_name, group_id, report_date, report_time, task_type, location, task_description, gps_latitude, gps_longitude, created_at
- **task_types**：id, name, emoji, sort_order, is_active（後台類型管理已移除，前台類型固定）
- **groups**：id, name, company_id, created_at（群組歸屬一間公司）
- **companies**：id, name(UNIQUE), created_at
- **supervisor_companies**：user_id, company_id（主管↔公司 多對多，PK 複合）

> 階層：公司(companies) > 群組(groups) > 人員(users)。`users.company_id` 用 ALTER 補欄位（啟動時自動，相容既有資料）。

## 主要 API 端點
- `POST /api/login` / `register` / `logout` / `forgot-password` / `change-password`
- `POST /api/submit-report` — 離開類型不需要 location/task
- `GET /api/my-reports` — 支援 startDate/endDate/limit 參數
- `GET /api/last-locations` — 同事最新位置（含 created_at；依公司範圍）
- `GET /api/status-board` — 今日狀態板（依公司範圍）
- `GET /api/export` — CSV 匯出（admin 全部 / 主管限管轄公司）
- `GET/POST/PUT/DELETE /api/companies[/:id]` — 公司管理（GET 需登入；增改刪需 admin）
- `PUT /api/users/:userId/group` — 設定分組/所屬公司/角色/主管管轄公司（groupId + companyId + isSupervisor + supervisorCompanyIds[]）

## 前台 report.html 功能
- 到達/離開/隨車上下車 4 種回報類型（2×2 按鈕）
- GPS 定位（maximumAge: 0 強制即時，不用快取）
- 頁首顯示今日回報筆數
- 底部導航：回報 / 同事位置 / 我的紀錄
- 同事位置地圖（Leaflet，golden-angle 偏移防重疊，顯示姓名+類型+時間）
- 我的紀錄 → 兩個 Tab：紀錄查詢 / 日報表
- 日報表：日期區間選擇、統計摘要、明細表格、列印（直式 A4，僅抬頭+明細）、Excel 匯出（詳見下方正式樣板）
- 修改密碼彈窗
- 深色模式（prefers-color-scheme: dark）
- PWA（加到主畫面）

## 後台 index.html 功能
- 回報查詢（日期/分組/關鍵字篩選）
- 人員管理（卡片式，inline 設定分組 + 主管/一般）
- 分組管理
- 狀態板（今日已回報/未回報）
- 日報表（全體/多人）：與稽查員前台同款正式樣板（見下方）

## 日報表正式樣板（前台稽查員 + 後台共用同一套版型）
兩處版型一致：正式抬頭 + 摘要卡片 + 「工作明細」綠色左邊框小標 + 綠色表頭表格 + 頁尾。
- **正式抬頭**：公司名稱 ＋ 報表標題 ＋ 製表人/期間/製表日期（**無編號**）；深色分隔線。
- **摘要卡片**：螢幕顯示、**列印隱藏**（含前台各類型統計長條）。
- **明細表格**：去 emoji；日期分組列為淡綠文字；GPS 經緯度上下換行、保留（螢幕＋列印）。
- **頁尾**：製表系統＋製表時間；頁碼用 `@page` margin box（Chrome 不支援則略過）。
- **列印**：A4 直式，只輸出「抬頭 + 工作明細」（**無摘要、無簽核欄**）。

差異：
- **前台 report.html**（稽查員單人，`我的紀錄 → 日報表`）：標題「稽查員工作日報表」；公司來自登入回傳 `companyName`；製表人＝本人；欄位 `# | 日期時間(MM/DD＋時間換行) | 類型 | 地點 | 處理內容 | GPS`。
- **後台 index.html**（管理員/主管，多人）：標題「工作日報表」；公司依「公司」篩選顯示（未選＝留白）；製表人＝登入者；欄位多 `姓名 | 公司 | 組別`（時間 | 姓名 | 公司 | 組別 | 類型 | 地點 | 處理內容 | GPS）。

## 待處理事項
- （無）

## 安全設定重點
- helmet CSP 需包含 `scriptSrcAttr: ["'unsafe-inline'"]`（否則 onclick 無法作用）
- CSP scriptSrc 需包含 `https://unpkg.com`（Leaflet CDN）
- 登入/註冊/忘記密碼端點有 rate-limit（每 IP 每 15 分鐘 10 次）

## Git 設定
```
user.name = sian-de
user.email = sian-de@users.noreply.github.com
```

## 常用指令
```bash
# 啟動本機伺服器
node server.js

# 推送
git add -A && git commit -m "..." && git push
```
