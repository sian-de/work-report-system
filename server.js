require('dotenv').config();
const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
const { db, initDB } = require('./database');

const app = express();

// 安全標頭（CSP、X-Frame-Options 等）
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      imgSrc: ["'self'", "data:", "https://*.tile.openstreetmap.org", "https://unpkg.com"],
      connectSrc: ["'self'"],
    },
  },
}));

// Gzip 壓縮（減少 60-70% 傳輸量）
app.use(compression());

// JSON body parser
app.use(express.json());

// 登入/註冊/忘記密碼速率限制（每 IP 15 分鐘內最多 15 次）
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: '嘗試次數過多，請 15 分鐘後再試' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ====== 工具函式 ======
function getTaiwanTime() {
  const now = new Date();
  const tw = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const y = tw.getFullYear();
  const m = String(tw.getMonth() + 1).padStart(2, '0');
  const d = String(tw.getDate()).padStart(2, '0');
  const hh = String(tw.getHours()).padStart(2, '0');
  const mm = String(tw.getMinutes()).padStart(2, '0');
  return { date: `${y}-${m}-${d}`, time: `${hh}:${mm}` };
}

// 密碼雜湊（bcrypt，cost factor 12）
async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

// 驗證密碼（支援 bcrypt 和舊版 SHA-256 自動遷移）
function sha256(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

async function verifyPassword(password, hash) {
  // 新格式：bcrypt hash 以 $2 開頭
  if (hash.startsWith('$2')) {
    return bcrypt.compare(password, hash);
  }
  // 舊格式：SHA-256（64 字元 hex）— 驗證後自動升級
  return sha256(password) === hash;
}

async function upgradePasswordIfNeeded(userId, password, currentHash) {
  // 如果還是舊的 SHA-256 格式，升級為 bcrypt
  if (!currentHash.startsWith('$2')) {
    const newHash = await hashPassword(password);
    await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE user_id = ?', args: [newHash, userId] });
  }
}

// ====== Session 管理 ======
const sessions = new Map();

function createSession(userId, displayName, role) {
  const token = crypto.randomUUID();
  sessions.set(token, { userId, displayName, role, createdAt: Date.now() });
  return token;
}

function getSession(req) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token || !sessions.has(token)) return null;
  const session = sessions.get(token);
  // 24 小時過期
  if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
    sessions.delete(token);
    return null;
  }
  return session;
}

// 定期清理過期 session
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of sessions) {
    if (now - val.createdAt > 24 * 60 * 60 * 1000) sessions.delete(key);
  }
}, 10 * 60 * 1000);

// 驗證中間件
function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: '請先登入' });
  req.session = session;
  next();
}

function requireAdmin(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: '請先登入' });
  if (session.role !== 'admin') return res.status(403).json({ error: '需要管理員權限' });
  req.session = session;
  next();
}

// ====== 公司資料隔離工具 ======
// 取得請求者的權限範圍：
//   isAdmin       管理員 → 看全部
//   isSupervisor  主管   → 看其管轄公司（supervisor_companies）的聯集
//   一般使用者(稽查員)    → 只看自己
async function getScope(session) {
  const { role, userId } = session;
  if (role === 'admin') return { isAdmin: true, isSupervisor: false, userId, companyIds: [] };
  const info = await db.execute({ sql: 'SELECT is_supervisor FROM users WHERE user_id = ?', args: [userId] });
  const isSupervisor = info.rows[0]?.is_supervisor ? true : false;
  let companyIds = [];
  if (isSupervisor) {
    const r = await db.execute({ sql: 'SELECT company_id FROM supervisor_companies WHERE user_id = ?', args: [userId] });
    companyIds = r.rows.map(x => Number(x.company_id));
  }
  return { isAdmin: false, isSupervisor, userId, companyIds };
}

// 針對「reports 表」的範圍條件（依回報者所屬公司過濾）
//  - 管理員：無條件
//  - 主管（有管轄公司）：回報者 company_id ∈ 管轄公司
//  - 其餘（含未指派公司的主管）：只看自己
function reportScopeClause(scope, userCol = 'user_id') {
  if (scope.isAdmin) return { clause: '', params: [] };
  if (scope.isSupervisor && scope.companyIds.length > 0) {
    const ph = scope.companyIds.map(() => '?').join(',');
    return { clause: ` AND ${userCol} IN (SELECT user_id FROM users WHERE company_id IN (${ph}))`, params: [...scope.companyIds] };
  }
  return { clause: ` AND ${userCol} = ?`, params: [scope.userId] };
}

// 針對「users 表」的範圍條件（依人員所屬公司過濾）
function userScopeClause(scope, companyCol = 'company_id', idCol = 'user_id') {
  if (scope.isAdmin) return { clause: '', params: [] };
  if (scope.isSupervisor && scope.companyIds.length > 0) {
    const ph = scope.companyIds.map(() => '?').join(',');
    return { clause: ` AND ${companyCol} IN (${ph})`, params: [...scope.companyIds] };
  }
  return { clause: ` AND ${idCol} = ?`, params: [scope.userId] };
}

// 快取範圍鍵：避免不同公司/使用者透過共用快取互相外洩
function scopeCacheKey(scope) {
  if (scope.isAdmin) return 'all';
  if (scope.isSupervisor && scope.companyIds.length > 0) return 'company:' + scope.companyIds.slice().sort((a, b) => a - b).join('-');
  return 'self:' + scope.userId;
}

// ====== 記憶體快取工具 ======
const apiCache = new Map();

function cached(key, ttlSeconds, fetchFn) {
  return async (req, res, next) => {
    const cacheKey = typeof key === 'function' ? key(req) : key;
    const now = Date.now();
    const entry = apiCache.get(cacheKey);
    if (entry && now - entry.time < ttlSeconds * 1000) {
      return res.json(entry.data);
    }
    // 把原始 res.json 包裝起來，攔截結果存入快取
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      apiCache.set(cacheKey, { data, time: now });
      return originalJson(data);
    };
    next();
  };
}

// 定期清理過期快取
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of apiCache) {
    if (now - val.time > 300000) apiCache.delete(key); // 5 分鐘最大存活
  }
}, 60000);

// ====== 靜態檔案（含快取標頭）======
app.use('/admin', express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));
app.use('/report.html', express.static(path.join(__dirname, 'public', 'report.html'), { maxAge: '10m', etag: true }));

// ====== 健康檢查（供 UptimeRobot 保活）======
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// ====== 帳號 API ======

// 註冊
app.post('/api/register', authLimiter, async (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password || !displayName) {
    return res.status(400).json({ error: '請填寫所有欄位' });
  }
  if (username.trim().length < 2) {
    return res.status(400).json({ error: '帳號至少 2 個字元' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: '密碼至少 4 個字元' });
  }

  const userId = username.trim();
  const name = displayName.trim();

  try {
    const existing = await db.execute({ sql: 'SELECT user_id FROM users WHERE user_id = ?', args: [userId] });
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: '此帳號已被使用' });
    }

    const pwHash = await hashPassword(password);
    await db.execute({
      sql: 'INSERT INTO users (user_id, display_name, group_id, password_hash, role) VALUES (?, ?, ?, ?, ?)',
      args: [userId, name, 'web', pwHash, 'user'],
    });

    const token = createSession(userId, name, 'user');
    res.json({ success: true, token, displayName: name, role: 'user' });
  } catch (err) {
    console.error('註冊失敗:', err);
    res.status(500).json({ error: '註冊失敗' });
  }
});

// 登入
app.post('/api/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '請輸入帳號和密碼' });
  }

  try {
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE user_id = ?', args: [username.trim()] });
    const user = result.rows[0];
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: '帳號或密碼錯誤' });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: '帳號或密碼錯誤' });
    }

    // 自動將舊 SHA-256 密碼升級為 bcrypt
    await upgradePasswordIfNeeded(user.user_id, password, user.password_hash);

    const token = createSession(user.user_id, user.display_name, user.role || 'user');
    res.json({ success: true, token, displayName: user.display_name, role: user.role || 'user' });
  } catch (err) {
    console.error('登入失敗:', err);
    res.status(500).json({ error: '登入失敗' });
  }
});

// 驗證 session
app.get('/api/me', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: '未登入' });
  try {
    const result = await db.execute({ sql: 'SELECT is_supervisor FROM users WHERE user_id = ?', args: [session.userId] });
    const isSupervisor = result.rows[0]?.is_supervisor ? true : false;
    res.json({ userId: session.userId, displayName: session.displayName, role: session.role, isSupervisor });
  } catch (e) {
    res.json({ userId: session.userId, displayName: session.displayName, role: session.role, isSupervisor: false });
  }
});

// 登出
app.post('/api/logout', (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (token) sessions.delete(token);
  res.json({ success: true });
});

// 管理員重設密碼
app.post('/api/users/:userId/reset-password', requireAdmin, async (req, res) => {
  const { userId } = req.params;
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: '新密碼至少 4 個字元' });
  }
  try {
    const user = await db.execute({ sql: 'SELECT user_id FROM users WHERE user_id = ?', args: [userId] });
    if (user.rows.length === 0) return res.status(404).json({ error: '找不到此使用者' });

    const pwHash = await hashPassword(newPassword);
    await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE user_id = ?', args: [pwHash, userId] });
    res.json({ success: true });
  } catch (err) {
    console.error('重設密碼失敗:', err);
    res.status(500).json({ error: '重設失敗' });
  }
});

// 使用者自助重設密碼（帳號 + 姓名驗證）
app.post('/api/forgot-password', authLimiter, async (req, res) => {
  const { username, displayName, newPassword } = req.body;
  if (!username || !displayName || !newPassword) {
    return res.status(400).json({ error: '請填寫所有欄位' });
  }
  if (newPassword.length < 4) {
    return res.status(400).json({ error: '新密碼至少 4 個字元' });
  }

  try {
    const result = await db.execute({
      sql: 'SELECT user_id, display_name FROM users WHERE user_id = ?',
      args: [username.trim()],
    });
    const user = result.rows[0];

    // 驗證帳號 + 姓名是否匹配
    if (!user || user.display_name !== displayName.trim()) {
      return res.status(400).json({ error: '帳號或姓名不正確' });
    }

    const pwHash = await hashPassword(newPassword);
    await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE user_id = ?', args: [pwHash, username.trim()] });
    res.json({ success: true, message: '密碼已重設，請用新密碼登入' });
  } catch (err) {
    console.error('自助重設密碼失敗:', err);
    res.status(500).json({ error: '重設失敗，請稍後再試' });
  }
});

// ====== 群組 API ======

// 取得所有群組（含成員統計與所屬公司）
app.get('/api/groups', requireAuth, async (req, res) => {
  try {
    const groups = await db.execute({
      sql: `SELECT g.*, c.name as company_name,
              (SELECT COUNT(*) FROM users u WHERE u.group_id = CAST(g.id AS TEXT)) as member_count,
              (SELECT u.display_name FROM users u WHERE u.group_id = CAST(g.id AS TEXT) AND u.is_supervisor = 1 LIMIT 1) as supervisor_name
            FROM groups g
            LEFT JOIN companies c ON g.company_id = c.id
            ORDER BY c.name, g.name`,
      args: [],
    });
    res.json(groups.rows);
  } catch (err) {
    console.error('查詢群組失敗:', err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

// 取得群組成員
app.get('/api/groups/:id/members', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const members = await db.execute({
      sql: 'SELECT user_id, display_name, is_supervisor, role, created_at FROM users WHERE group_id = ? ORDER BY is_supervisor DESC, display_name',
      args: [String(id)],
    });
    res.json(members.rows);
  } catch (err) {
    console.error('查詢群組成員失敗:', err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

// 建立群組（須歸屬一間公司）
app.post('/api/groups', requireAdmin, async (req, res) => {
  const { name, companyId } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '群組名稱不能為空' });
  if (!companyId) return res.status(400).json({ error: '請選擇所屬公司' });

  try {
    const comp = await db.execute({ sql: 'SELECT id FROM companies WHERE id = ?', args: [Number(companyId)] });
    if (comp.rows.length === 0) return res.status(400).json({ error: '找不到此公司' });

    await db.execute({ sql: 'INSERT INTO groups (name, company_id) VALUES (?, ?)', args: [name.trim(), Number(companyId)] });
    apiCache.clear();
    res.json({ success: true });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(400).json({ error: '此群組名稱已存在' });
    console.error('建立群組失敗:', err);
    res.status(500).json({ error: '建立失敗' });
  }
});

// 修改群組（名稱／所屬公司）
app.put('/api/groups/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, companyId } = req.body;

  try {
    const existing = await db.execute({ sql: 'SELECT * FROM groups WHERE id = ?', args: [Number(id)] });
    if (existing.rows.length === 0) return res.status(404).json({ error: '找不到此群組' });

    const updates = [];
    const args = [];
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: '群組名稱不能為空' });
      updates.push('name = ?'); args.push(name.trim());
    }
    if (companyId !== undefined) {
      updates.push('company_id = ?'); args.push(companyId ? Number(companyId) : null);
    }
    if (updates.length === 0) return res.status(400).json({ error: '沒有要修改的欄位' });

    args.push(Number(id));
    await db.execute({ sql: `UPDATE groups SET ${updates.join(', ')} WHERE id = ?`, args });

    // 指定公司時，將該群組現有成員的所屬公司一併對齊（維持公司>群組>人員一致）
    if (companyId !== undefined && companyId) {
      await db.execute({ sql: 'UPDATE users SET company_id = ? WHERE group_id = ?', args: [Number(companyId), String(id)] });
    }

    apiCache.clear();
    res.json({ success: true });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(400).json({ error: '此群組名稱已存在' });
    console.error('修改群組失敗:', err);
    res.status(500).json({ error: '修改失敗' });
  }
});

// 刪除群組
app.delete('/api/groups/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const members = await db.execute({
      sql: 'SELECT COUNT(*) as c FROM users WHERE group_id = ?',
      args: [String(id)],
    });
    if (members.rows[0].c > 0) {
      return res.status(400).json({ error: `此群組還有 ${members.rows[0].c} 位成員，請先移除所有成員` });
    }

    await db.execute({ sql: 'DELETE FROM groups WHERE id = ?', args: [Number(id)] });
    res.json({ success: true });
  } catch (err) {
    console.error('刪除群組失敗:', err);
    res.status(500).json({ error: '刪除失敗' });
  }
});

// 指派使用者到群組/公司（或移除）+ 設定權限與主管管轄公司
app.put('/api/users/:userId/group', requireAdmin, async (req, res) => {
  const { userId } = req.params;
  const { groupId, isSupervisor, companyId, supervisorCompanyIds } = req.body;

  try {
    const user = await db.execute({ sql: 'SELECT * FROM users WHERE user_id = ?', args: [userId] });
    if (user.rows.length === 0) return res.status(404).json({ error: '找不到此使用者' });

    const currentUser = user.rows[0];
    // groupId 為 null 或空字串表示移除群組
    const newGroupId = groupId !== undefined ? (groupId ? String(groupId) : null) : currentUser.group_id;
    // isSupervisor 為 null/undefined 表示不變更
    const newSupervisor = isSupervisor !== null && isSupervisor !== undefined ? (isSupervisor ? 1 : 0) : currentUser.is_supervisor;
    // companyId（所屬公司）：undefined 不變更；空值表示移除
    let newCompanyId = companyId !== undefined ? (companyId ? Number(companyId) : null) : currentUser.company_id;

    // 階層強制：若指派到某群組，所屬公司一律對齊該群組的公司
    if (newGroupId && newGroupId !== 'web') {
      const grp = await db.execute({ sql: 'SELECT company_id FROM groups WHERE id = ?', args: [Number(newGroupId)] });
      if (grp.rows.length > 0 && grp.rows[0].company_id != null) {
        newCompanyId = Number(grp.rows[0].company_id);
      }
    }

    await db.execute({
      sql: 'UPDATE users SET group_id = ?, is_supervisor = ?, company_id = ? WHERE user_id = ?',
      args: [newGroupId, newSupervisor, newCompanyId, userId],
    });

    // 主管管轄公司（多對多）
    if (Array.isArray(supervisorCompanyIds)) {
      await db.execute({ sql: 'DELETE FROM supervisor_companies WHERE user_id = ?', args: [userId] });
      if (newSupervisor) {
        const ids = [...new Set(supervisorCompanyIds.map(Number).filter(n => Number.isInteger(n)))];
        for (const cid of ids) {
          await db.execute({ sql: 'INSERT OR IGNORE INTO supervisor_companies (user_id, company_id) VALUES (?, ?)', args: [userId, cid] });
        }
      }
    } else if (newSupervisor === 0) {
      // 取消主管身分 → 清空管轄公司
      await db.execute({ sql: 'DELETE FROM supervisor_companies WHERE user_id = ?', args: [userId] });
    }

    apiCache.clear(); // 權限/公司異動 → 清空快取避免範圍快取陳舊
    res.json({ success: true });
  } catch (err) {
    console.error('指派群組失敗:', err);
    res.status(500).json({ error: '指派失敗' });
  }
});

// ====== 公司 API ======

// 取得所有公司
app.get('/api/companies', requireAuth, async (req, res) => {
  try {
    const companies = await db.execute({
      sql: `SELECT c.*,
              (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id) as member_count
            FROM companies c ORDER BY c.name`,
      args: [],
    });
    res.json(companies.rows);
  } catch (err) {
    console.error('查詢公司失敗:', err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

// 建立公司
app.post('/api/companies', requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '公司名稱不能為空' });
  try {
    await db.execute({ sql: 'INSERT INTO companies (name) VALUES (?)', args: [name.trim()] });
    apiCache.clear();
    res.json({ success: true });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(400).json({ error: '此公司名稱已存在' });
    console.error('建立公司失敗:', err);
    res.status(500).json({ error: '建立失敗' });
  }
});

// 修改公司名稱
app.put('/api/companies/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '公司名稱不能為空' });
  try {
    const existing = await db.execute({ sql: 'SELECT id FROM companies WHERE id = ?', args: [Number(id)] });
    if (existing.rows.length === 0) return res.status(404).json({ error: '找不到此公司' });
    await db.execute({ sql: 'UPDATE companies SET name = ? WHERE id = ?', args: [name.trim(), Number(id)] });
    apiCache.clear();
    res.json({ success: true });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(400).json({ error: '此公司名稱已存在' });
    console.error('修改公司失敗:', err);
    res.status(500).json({ error: '修改失敗' });
  }
});

// 刪除公司（仍有人員歸屬時不可刪）
app.delete('/api/companies/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await db.execute({ sql: 'SELECT id FROM companies WHERE id = ?', args: [Number(id)] });
    if (existing.rows.length === 0) return res.status(404).json({ error: '找不到此公司' });

    const used = await db.execute({ sql: 'SELECT COUNT(*) as c FROM users WHERE company_id = ?', args: [Number(id)] });
    if (used.rows[0].c > 0) {
      return res.status(400).json({ error: `此公司仍有 ${used.rows[0].c} 位人員，請先將其改至其他公司或移除` });
    }

    await db.execute({ sql: 'DELETE FROM companies WHERE id = ?', args: [Number(id)] });
    await db.execute({ sql: 'DELETE FROM supervisor_companies WHERE company_id = ?', args: [Number(id)] });
    apiCache.clear();
    res.json({ success: true });
  } catch (err) {
    console.error('刪除公司失敗:', err);
    res.status(500).json({ error: '刪除失敗' });
  }
});

// 取得未分組的使用者
app.get('/api/users/unassigned', requireAuth, async (req, res) => {
  const { companyId } = req.query;
  try {
    let sql = `SELECT user_id, display_name FROM users
               WHERE (group_id IS NULL OR group_id = '' OR group_id = 'web') AND role != 'admin'`;
    const params = [];
    // 分組管理加成員時，只列同公司或尚未指定公司的人（指派後會對齊該群組公司）
    if (companyId) {
      sql += ' AND (company_id = ? OR company_id IS NULL)';
      params.push(Number(companyId));
    }
    sql += ' ORDER BY display_name';
    const result = await db.execute({ sql, args: params });
    res.json(result.rows);
  } catch (err) {
    console.error('查詢未分組使用者失敗:', err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

// 在某公司設定/取消主管（分組管理用，公司感知；可累加多間公司）
app.put('/api/users/:userId/supervisor-company', requireAdmin, async (req, res) => {
  const { userId } = req.params;
  const { companyId, enabled } = req.body;
  if (!companyId) return res.status(400).json({ error: '缺少公司' });
  try {
    const user = await db.execute({ sql: 'SELECT user_id FROM users WHERE user_id = ?', args: [userId] });
    if (user.rows.length === 0) return res.status(404).json({ error: '找不到此使用者' });

    if (enabled) {
      await db.execute({ sql: 'INSERT OR IGNORE INTO supervisor_companies (user_id, company_id) VALUES (?, ?)', args: [userId, Number(companyId)] });
      await db.execute({ sql: 'UPDATE users SET is_supervisor = 1 WHERE user_id = ?', args: [userId] });
    } else {
      await db.execute({ sql: 'DELETE FROM supervisor_companies WHERE user_id = ? AND company_id = ?', args: [userId, Number(companyId)] });
      const left = await db.execute({ sql: 'SELECT COUNT(*) as c FROM supervisor_companies WHERE user_id = ?', args: [userId] });
      if (left.rows[0].c === 0) {
        await db.execute({ sql: 'UPDATE users SET is_supervisor = 0 WHERE user_id = ?', args: [userId] });
      }
    }
    apiCache.clear();
    res.json({ success: true });
  } catch (err) {
    console.error('設定主管(公司)失敗:', err);
    res.status(500).json({ error: '設定失敗' });
  }
});

// ====== 回報 API ======

// 提交回報
app.post('/api/submit-report', requireAuth, async (req, res) => {
  const { taskType, location, task, latitude, longitude } = req.body;
  const { userId, displayName } = req.session;

  // 「到達」需要地點和處理內容；「離開」不需要
  if (taskType !== '離開' && (!location || !task)) {
    return res.status(400).json({ error: '請填寫地點和處理內容' });
  }

  const tw = getTaiwanTime();

  try {
    await db.execute({
      sql: `INSERT INTO reports (user_id, display_name, group_id, report_date, report_time, task_type, location, task_description, gps_latitude, gps_longitude)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [userId, displayName, 'web', tw.date, tw.time, taskType || '到達', location || '', task || '', latitude || null, longitude || null],
    });

    res.json({ success: true, message: '回報成功！' });
  } catch (err) {
    console.error('儲存回報失敗:', err);
    res.status(500).json({ error: '儲存失敗，請稍後再試。' });
  }
});

// 查詢某人今日回報次數
app.get('/api/user-today', requireAuth, async (req, res) => {
  const { userId } = req.session;
  const tw = getTaiwanTime();
  try {
    const result = await db.execute({
      sql: 'SELECT COUNT(*) as c FROM reports WHERE user_id = ? AND report_date = ?',
      args: [userId, tw.date],
    });
    res.json({ count: result.rows[0].c });
  } catch (err) {
    res.json({ count: 0 });
  }
});

// ====== 後台 API（需要登入）======

// 組合回報查詢條件（供 /api/reports 與 /api/export 共用）
async function buildReportFilter(req) {
  const { date, startDate, endDate, user, keyword, companyId, groupId, taskType } = req.query;
  const scope = await getScope(req.session);
  const sc = reportScopeClause(scope, 'r.user_id');
  let where = ' WHERE 1=1' + sc.clause;
  const params = [...sc.params];
  if (date) { where += ' AND r.report_date = ?'; params.push(date); }
  if (startDate) { where += ' AND r.report_date >= ?'; params.push(startDate); }
  if (endDate) { where += ' AND r.report_date <= ?'; params.push(endDate); }
  if (user) { where += ' AND (r.display_name LIKE ? OR r.user_id = ?)'; params.push(`%${user}%`, user); }
  if (keyword) { where += ' AND (r.location LIKE ? OR r.task_description LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }
  if (companyId) { where += ' AND r.user_id IN (SELECT user_id FROM users WHERE company_id = ?)'; params.push(Number(companyId)); }
  if (groupId) { where += ' AND r.user_id IN (SELECT user_id FROM users WHERE group_id = ?)'; params.push(String(groupId)); }
  if (taskType) { where += ' AND r.task_type = ?'; params.push(taskType); }
  return { where, params };
}

const REPORT_JOINS = ` FROM reports r
  LEFT JOIN users u ON r.user_id = u.user_id
  LEFT JOIN companies c ON u.company_id = c.id
  LEFT JOIN groups g ON u.group_id = CAST(g.id AS TEXT)`;

// 取得回報紀錄（支援日期區間、公司/群組/類型篩選；含公司/群組標籤與小計）
app.get('/api/reports', requireAuth, async (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  // limit=0 表示不分頁，回傳符合篩選的全部資料（避免同一人的回報被頁面邊界切斷）
  const noLimit = String(limit) === '0';
  const offset = (page - 1) * limit;

  try {
    const { where, params } = await buildReportFilter(req);

    const countResult = await db.execute({ sql: `SELECT COUNT(*) as total${REPORT_JOINS}${where}`, args: params });
    const total = countResult.rows[0].total;

    const reports = await db.execute({
      sql: `SELECT r.*, c.name as company_name, g.name as group_name${REPORT_JOINS}${where} ORDER BY r.created_at DESC`
        + (noLimit ? '' : ' LIMIT ? OFFSET ?'),
      args: noLimit ? params : [...params, Number(limit), Number(offset)],
    });

    // 小計（整個篩選結果，非僅當頁）
    const typeAgg = await db.execute({ sql: `SELECT r.task_type as k, COUNT(*) as c${REPORT_JOINS}${where} GROUP BY r.task_type`, args: params });
    const compAgg = await db.execute({ sql: `SELECT COALESCE(c.name, '未指定公司') as k, COUNT(*) as c${REPORT_JOINS}${where} GROUP BY c.name ORDER BY c DESC`, args: params });

    res.json({
      data: reports.rows, total, page: Number(page), totalPages: noLimit ? 1 : Math.ceil(total / limit),
      typeCounts: typeAgg.rows, companyCounts: compAgg.rows,
    });
  } catch (err) {
    console.error('查詢回報失敗:', err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

// 取得自己的回報紀錄
app.get('/api/my-reports', requireAuth, async (req, res) => {
  const { date, startDate, endDate, page = 1, limit = 50 } = req.query;
  const { userId } = req.session;
  const offset = (page - 1) * limit;

  let sql = 'SELECT * FROM reports WHERE user_id = ?';
  let countSql = 'SELECT COUNT(*) as total FROM reports WHERE user_id = ?';
  const params = [userId];

  if (date) { sql += ' AND report_date = ?'; countSql += ' AND report_date = ?'; params.push(date); }
  if (startDate) { sql += ' AND report_date >= ?'; countSql += ' AND report_date >= ?'; params.push(startDate); }
  if (endDate) { sql += ' AND report_date <= ?'; countSql += ' AND report_date <= ?'; params.push(endDate); }

  try {
    const countResult = await db.execute({ sql: countSql, args: params });
    const total = countResult.rows[0].total;

    // 報表模式：不分頁，全部回傳（limit=0）
    if (Number(limit) === 0) {
      sql += ' ORDER BY report_date ASC, report_time ASC';
      const reports = await db.execute({ sql, args: params });
      return res.json({ data: reports.rows, total });
    }

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    const reports = await db.execute({ sql, args: [...params, Number(limit), Number(offset)] });

    res.json({ data: reports.rows, total, page: Number(page), totalPages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('查詢我的回報失敗:', err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

// 取得軌跡資料
app.get('/api/trajectory', requireAuth, async (req, res) => {
  const { userId, date, startDate, endDate } = req.query;

  let sql = 'SELECT * FROM reports WHERE gps_latitude IS NOT NULL';
  const params = [];

  // 範圍隔離：主管限管轄公司、稽查員只看自己（即使指定他人 user_id 也查不到）
  const scope = await getScope(req.session);
  const sc = reportScopeClause(scope);
  sql += sc.clause; params.push(...sc.params);

  if (userId) { sql += ' AND user_id = ?'; params.push(userId); }
  if (date) {
    sql += ' AND report_date = ?'; params.push(date);
  } else {
    if (startDate) { sql += ' AND report_date >= ?'; params.push(startDate); }
    if (endDate) { sql += ' AND report_date <= ?'; params.push(endDate); }
  }

  sql += ' ORDER BY report_date ASC, report_time ASC';

  try {
    const result = await db.execute({ sql, args: params });
    const reports = result.rows;

    const withDuration = reports.map((r, i) => {
      let stayMinutes = null;
      if (i < reports.length - 1) {
        const curr = new Date(`${r.report_date}T${r.report_time}:00`);
        const next = new Date(`${reports[i + 1].report_date}T${reports[i + 1].report_time}:00`);
        stayMinutes = Math.round((next - curr) / 60000);
      }
      return { ...r, stay_minutes: stayMinutes };
    });

    res.json(withDuration);
  } catch (err) {
    console.error('查詢軌跡失敗:', err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

// 取得有 GPS 資料的使用者列表（快取 120 秒）
app.get('/api/gps-users', requireAuth, async (req, res) => {
  try {
    const scope = await getScope(req.session);
    const sc = reportScopeClause(scope, 'r.user_id');
    const result = await db.execute({
      sql: `SELECT r.user_id, r.display_name, COUNT(*) as report_count,
             MIN(r.report_date) as first_date, MAX(r.report_date) as last_date
           FROM reports r WHERE r.gps_latitude IS NOT NULL${sc.clause}
           GROUP BY r.user_id ORDER BY r.display_name`,
      args: [...sc.params],
    });
    res.json(result.rows);
  } catch (err) {
    console.error('查詢 GPS 使用者失敗:', err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

// 取得今日摘要（快取依角色分開）
app.get('/api/summary', requireAuth, async (req, res) => {
  const tw = getTaiwanTime();
  const today = tw.date;
  const scope = await getScope(req.session);

  // 快取依範圍分開，避免跨公司外洩
  const cacheKey = 'summary-' + scopeCacheKey(scope);
  const now = Date.now();
  const entry = apiCache.get(cacheKey);
  if (entry && now - entry.time < 60000) {
    return res.json(entry.data);
  }

  try {
    let data;
    if (scope.isAdmin || (scope.isSupervisor && scope.companyIds.length > 0)) {
      // 管理員：全部；主管：限管轄公司
      const rsc = reportScopeClause(scope);
      const usc = userScopeClause(scope);
      const results = await db.batch([
        { sql: `SELECT COUNT(*) as count FROM reports WHERE report_date = ?${rsc.clause}`, args: [today, ...rsc.params] },
        { sql: `SELECT COUNT(DISTINCT user_id) as count FROM reports WHERE report_date = ?${rsc.clause}`, args: [today, ...rsc.params] },
        { sql: `SELECT COUNT(*) as count FROM users WHERE 1=1${usc.clause}`, args: [...usc.params] },
      ]);
      const totalReports = results[0].rows[0].count;
      const totalUsers = results[1].rows[0].count;
      const allUsers = results[2].rows[0].count;
      data = { today, totalReports, totalUsers, allUsers, reportRate: allUsers > 0 ? Math.round((totalUsers / allUsers) * 100) : 0 };
    } else {
      // 稽查員（或未指派公司的主管）：只看自己
      const result = await db.execute({
        sql: 'SELECT COUNT(*) as count FROM reports WHERE report_date = ? AND user_id = ?',
        args: [today, scope.userId],
      });
      data = { today, totalReports: result.rows[0].count, totalUsers: result.rows[0].count > 0 ? 1 : 0, allUsers: 1, reportRate: result.rows[0].count > 0 ? 100 : 0 };
    }

    apiCache.set(cacheKey, { data, time: now });
    res.json(data);
  } catch (err) {
    console.error('查詢摘要失敗:', err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

// 取得使用者（依公司範圍隔離；含所屬公司與主管管轄公司）
app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const scope = await getScope(req.session);
    const usc = userScopeClause(scope, 'u.company_id', 'u.user_id');
    const result = await db.execute({
      sql: `SELECT u.user_id, u.display_name, u.role, u.group_id, u.is_supervisor, u.company_id, u.created_at,
              g.name as group_name, c.name as company_name
            FROM users u
            LEFT JOIN groups g ON u.group_id = CAST(g.id AS TEXT)
            LEFT JOIN companies c ON u.company_id = c.id
            WHERE 1=1${usc.clause}
            ORDER BY u.display_name`,
      args: [...usc.params],
    });
    // 補上每位主管的管轄公司清單
    const supRows = await db.execute({ sql: 'SELECT user_id, company_id FROM supervisor_companies', args: [] });
    const supMap = {};
    for (const s of supRows.rows) { (supMap[s.user_id] = supMap[s.user_id] || []).push(Number(s.company_id)); }
    const out = result.rows.map(u => ({ ...u, supervisor_company_ids: supMap[u.user_id] || [] }));
    res.json(out);
  } catch (err) {
    console.error('查詢使用者失敗:', err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

// 修改回報紀錄
app.put('/api/reports/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { taskType, location, task } = req.body;

  // 「到達」需要地點和處理內容；「離開」不需要
  if (taskType !== '離開' && (!location || !task)) {
    return res.status(400).json({ error: '地點和處理內容不能為空' });
  }

  try {
    const result = await db.execute({ sql: 'SELECT * FROM reports WHERE id = ?', args: [Number(id)] });
    const report = result.rows[0];
    if (!report) return res.status(404).json({ error: '找不到此回報' });

    // 一般人員只能改自己的，管理員可以改所有人的
    if (req.session.role !== 'admin' && report.user_id !== req.session.userId) {
      return res.status(403).json({ error: '只能修改自己的回報' });
    }

    await db.execute({
      sql: 'UPDATE reports SET task_type = ?, location = ?, task_description = ? WHERE id = ?',
      args: [taskType || '到達', location || '', task || '', Number(id)],
    });

    res.json({ success: true });
  } catch (err) {
    console.error('修改回報失敗:', err);
    res.status(500).json({ error: '修改失敗' });
  }
});

// 刪除回報紀錄（自己的或管理員可刪除所有）
app.delete('/api/reports/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.execute({ sql: 'SELECT * FROM reports WHERE id = ?', args: [Number(id)] });
    const report = result.rows[0];
    if (!report) return res.status(404).json({ error: '找不到此回報' });

    // 一般人員只能刪自己的，管理員可以刪所有人的
    if (req.session.role !== 'admin' && report.user_id !== req.session.userId) {
      return res.status(403).json({ error: '只能刪除自己的回報' });
    }

    await db.execute({ sql: 'DELETE FROM reports WHERE id = ?', args: [Number(id)] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '刪除失敗' });
  }
});

// 刪除人員（管理員限定）
app.delete('/api/users/:userId', requireAdmin, async (req, res) => {
  const { userId } = req.params;
  if (userId === 'admin') {
    return res.status(400).json({ error: '不能刪除管理員帳號' });
  }
  try {
    await db.execute({ sql: 'DELETE FROM reports WHERE user_id = ?', args: [userId] });
    await db.execute({ sql: 'DELETE FROM supervisor_companies WHERE user_id = ?', args: [userId] });
    await db.execute({ sql: 'DELETE FROM users WHERE user_id = ?', args: [userId] });
    apiCache.clear();
    res.json({ success: true });
  } catch (err) {
    console.error('刪除人員失敗:', err);
    res.status(500).json({ error: '刪除失敗' });
  }
});

// 使用者修改自己的密碼
app.post('/api/change-password', requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return res.status(400).json({ error: '請填寫所有欄位' });
  if (newPassword.length < 4) return res.status(400).json({ error: '新密碼至少 4 個字元' });

  try {
    const result = await db.execute({ sql: 'SELECT password_hash FROM users WHERE user_id = ?', args: [req.session.userId] });
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: '使用者不存在' });

    const valid = await verifyPassword(oldPassword, user.password_hash);
    if (!valid) return res.status(400).json({ error: '目前密碼不正確' });

    const pwHash = await hashPassword(newPassword);
    await db.execute({ sql: 'UPDATE users SET password_hash = ? WHERE user_id = ?', args: [pwHash, req.session.userId] });
    res.json({ success: true, message: '密碼已修改' });
  } catch (err) {
    console.error('修改密碼失敗:', err);
    res.status(500).json({ error: '修改失敗' });
  }
});

// 全員最後位置（所有登入使用者可看）
app.get('/api/last-locations', requireAuth, async (req, res) => {
  try {
    const scope = await getScope(req.session);
    // 地圖範圍：管理員全部；主管→管轄公司；稽查員→自己所屬公司同事
    let clause = '';
    const params = [];
    if (!scope.isAdmin) {
      let companyIds = null;
      if (scope.isSupervisor && scope.companyIds.length > 0) {
        companyIds = scope.companyIds;
      } else {
        const me = await db.execute({ sql: 'SELECT company_id FROM users WHERE user_id = ?', args: [scope.userId] });
        const cid = me.rows[0]?.company_id;
        companyIds = cid ? [Number(cid)] : null;
      }
      if (companyIds && companyIds.length > 0) {
        const ph = companyIds.map(() => '?').join(',');
        clause = ` AND r.user_id IN (SELECT user_id FROM users WHERE company_id IN (${ph}))`;
        params.push(...companyIds);
      } else {
        clause = ' AND r.user_id = ?';
        params.push(scope.userId);
      }
    }
    const result = await db.execute({
      sql: `SELECT r.user_id, r.display_name, r.report_date, r.report_time,
              r.location, r.task_type, r.gps_latitude, r.gps_longitude, r.created_at
            FROM reports r
            INNER JOIN (
              SELECT user_id, MAX(created_at) as max_created
              FROM reports
              WHERE gps_latitude IS NOT NULL
              GROUP BY user_id
            ) latest ON r.user_id = latest.user_id AND r.created_at = latest.max_created
            WHERE r.gps_latitude IS NOT NULL${clause}
            ORDER BY r.display_name`,
      args: [...params],
    });
    res.json(result.rows);
  } catch (err) {
    console.error('查詢最後位置失敗:', err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

// 人員回報狀態面板（主管/管理員用）
app.get('/api/status-board', requireAuth, async (req, res) => {
  const tw = getTaiwanTime();
  const today = tw.date;

  const scope = await getScope(req.session);
  if (!scope.isAdmin && !scope.isSupervisor) {
    return res.status(403).json({ error: '需要主管或管理員權限' });
  }

  try {
    // 取得使用者清單（管理員全部 / 主管限管轄公司）
    const usc = userScopeClause(scope, 'company_id', 'user_id');
    const userSql = `SELECT user_id, display_name, group_id, is_supervisor, role FROM users WHERE 1=1${usc.clause} ORDER BY display_name`;
    const users = await db.execute({ sql: userSql, args: [...usc.params] });

    // 取得每人最後一筆回報
    const statusList = [];
    for (const u of users.rows) {
      const lastReport = await db.execute({
        sql: `SELECT report_date, report_time, task_type, location, task_description,
                gps_latitude, gps_longitude
              FROM reports WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
        args: [u.user_id],
      });

      const todayCount = await db.execute({
        sql: 'SELECT COUNT(*) as c FROM reports WHERE user_id = ? AND report_date = ?',
        args: [u.user_id, today],
      });

      const lr = lastReport.rows[0] || null;
      statusList.push({
        user_id: u.user_id,
        display_name: u.display_name,
        is_supervisor: u.is_supervisor,
        role: u.role,
        today_count: todayCount.rows[0].c,
        reported_today: todayCount.rows[0].c > 0,
        last_report: lr ? {
          date: lr.report_date,
          time: lr.report_time,
          type: lr.task_type,
          location: lr.location,
          task: lr.task_description,
          lat: lr.gps_latitude,
          lng: lr.gps_longitude,
        } : null,
      });
    }

    res.json({ today, users: statusList });
  } catch (err) {
    console.error('查詢狀態面板失敗:', err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

// 匯出 CSV（沿用回報查詢的所有篩選條件；範圍隔離同 /api/reports）
app.get('/api/export', requireAuth, async (req, res) => {
  const { startDate, endDate } = req.query;
  try {
    const { where, params } = await buildReportFilter(req);
    const result = await db.execute({
      sql: `SELECT r.*${REPORT_JOINS}${where} ORDER BY r.created_at DESC`,
      args: params,
    });
    const reports = result.rows;

    const BOM = '﻿';
    let csv = BOM + '日期,時間,姓名,事項類型,地點,處理事項,GPS緯度,GPS經度,Google地圖連結\n';
    for (const r of reports) {
      const gpsLink = r.gps_latitude ? `https://maps.google.com/?q=${r.gps_latitude},${r.gps_longitude}` : '';
      csv += `"${r.report_date}","${r.report_time}","${r.display_name}","${r.task_type || ''}","${(r.location || '').replace(/"/g, '""')}","${(r.task_description || '').replace(/"/g, '""')}","${r.gps_latitude || ''}","${r.gps_longitude || ''}","${gpsLink}"\n`;
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=reports_${startDate || 'all'}_${endDate || 'all'}.csv`);
    res.send(csv);
  } catch (err) {
    console.error('匯出失敗:', err);
    res.status(500).json({ error: '匯出失敗' });
  }
});

// 首頁導向回報頁
app.get('/', (req, res) => {
  res.redirect('/report.html');
});

// ====== 全域錯誤處理 ======
app.use((err, req, res, next) => {
  console.error('未捕獲的錯誤:', err);
  res.status(500).json({ error: '伺服器內部錯誤，請稍後再試' });
});

// ====== 啟動伺服器 ======
let server;

async function startServer() {
  await initDB();

  // 自動建立預設管理員帳號（如果不存在）
  const adminResult = await db.execute({ sql: 'SELECT user_id FROM users WHERE role = ?', args: ['admin'] });
  if (adminResult.rows.length === 0) {
    const pwHash = await hashPassword('admin123');
    await db.execute({
      sql: 'INSERT OR IGNORE INTO users (user_id, display_name, group_id, password_hash, role) VALUES (?, ?, ?, ?, ?)',
      args: ['admin', '管理員', 'web', pwHash, 'admin'],
    });
    console.log('已建立預設管理員帳號: admin / admin123');
  }

  const PORT = process.env.PORT || 3000;
  server = app.listen(PORT, () => {
    console.log(`伺服器啟動於 http://localhost:${PORT}`);
    console.log(`回報頁面: http://localhost:${PORT}/report.html`);
    console.log(`管理後台: http://localhost:${PORT}/admin`);
  });
}

// ====== Graceful Shutdown ======
function gracefulShutdown(signal) {
  console.log(`收到 ${signal}，正在優雅關閉...`);
  if (server) {
    server.close(() => {
      console.log('伺服器已關閉');
      process.exit(0);
    });
    // 強制 10 秒後關閉
    setTimeout(() => { process.exit(1); }, 10000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

startServer().catch(err => {
  console.error('啟動失敗:', err);
  process.exit(1);
});
