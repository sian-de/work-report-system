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

// ====== 事項類型 API ======

// 取得啟用的類型（前端用，快取 60 秒）
app.get('/api/task-types', requireAuth, cached('task-types', 60, null), async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT id, name, emoji, sort_order FROM task_types WHERE is_active = 1 ORDER BY sort_order ASC, id ASC',
      args: [],
    });
    res.json(result.rows);
  } catch (err) {
    console.error('查詢類型失敗:', err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

// 取得所有類型（管理用）
app.get('/api/task-types/all', requireAdmin, async (req, res) => {
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM task_types ORDER BY sort_order ASC, id ASC',
      args: [],
    });
    res.json(result.rows);
  } catch (err) {
    console.error('查詢所有類型失敗:', err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

// 新增類型
app.post('/api/task-types', requireAdmin, async (req, res) => {
  const { name, emoji } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '名稱不能為空' });

  try {
    // 取得最大排序值
    const maxOrder = await db.execute({ sql: 'SELECT MAX(sort_order) as m FROM task_types', args: [] });
    const nextOrder = (maxOrder.rows[0].m || 0) + 1;

    await db.execute({
      sql: 'INSERT INTO task_types (name, emoji, sort_order) VALUES (?, ?, ?)',
      args: [name.trim(), emoji || '📌', nextOrder],
    });
    apiCache.delete('task-types');
    res.json({ success: true });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(400).json({ error: '此類型名稱已存在' });
    console.error('新增類型失敗:', err);
    res.status(500).json({ error: '新增失敗' });
  }
});

// 修改類型
app.put('/api/task-types/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, emoji, sort_order, is_active } = req.body;

  try {
    const existing = await db.execute({ sql: 'SELECT * FROM task_types WHERE id = ?', args: [Number(id)] });
    if (existing.rows.length === 0) return res.status(404).json({ error: '找不到此類型' });

    const updates = [];
    const args = [];
    if (name !== undefined) { updates.push('name = ?'); args.push(name.trim()); }
    if (emoji !== undefined) { updates.push('emoji = ?'); args.push(emoji); }
    if (sort_order !== undefined) { updates.push('sort_order = ?'); args.push(Number(sort_order)); }
    if (is_active !== undefined) { updates.push('is_active = ?'); args.push(is_active ? 1 : 0); }

    if (updates.length === 0) return res.status(400).json({ error: '沒有要修改的欄位' });

    args.push(Number(id));
    await db.execute({ sql: `UPDATE task_types SET ${updates.join(', ')} WHERE id = ?`, args });
    apiCache.delete('task-types');
    res.json({ success: true });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(400).json({ error: '此類型名稱已存在' });
    console.error('修改類型失敗:', err);
    res.status(500).json({ error: '修改失敗' });
  }
});

// 刪除類型
app.delete('/api/task-types/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await db.execute({ sql: 'SELECT name FROM task_types WHERE id = ?', args: [Number(id)] });
    if (existing.rows.length === 0) return res.status(404).json({ error: '找不到此類型' });

    // 檢查是否有回報使用此類型
    const used = await db.execute({
      sql: 'SELECT COUNT(*) as c FROM reports WHERE task_type = ?',
      args: [existing.rows[0].name],
    });
    if (used.rows[0].c > 0) {
      return res.status(400).json({ error: `此類型已有 ${used.rows[0].c} 筆回報使用，建議停用而非刪除` });
    }

    await db.execute({ sql: 'DELETE FROM task_types WHERE id = ?', args: [Number(id)] });
    apiCache.delete('task-types');
    res.json({ success: true });
  } catch (err) {
    console.error('刪除類型失敗:', err);
    res.status(500).json({ error: '刪除失敗' });
  }
});

// ====== 群組 API ======

// 取得所有群組（含成員統計）
app.get('/api/groups', requireAuth, async (req, res) => {
  try {
    const groups = await db.execute({
      sql: `SELECT g.*,
              (SELECT COUNT(*) FROM users u WHERE u.group_id = CAST(g.id AS TEXT)) as member_count,
              (SELECT u.display_name FROM users u WHERE u.group_id = CAST(g.id AS TEXT) AND u.is_supervisor = 1 LIMIT 1) as supervisor_name
            FROM groups g ORDER BY g.name`,
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

// 建立群組
app.post('/api/groups', requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '群組名稱不能為空' });

  try {
    await db.execute({ sql: 'INSERT INTO groups (name) VALUES (?)', args: [name.trim()] });
    res.json({ success: true });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(400).json({ error: '此群組名稱已存在' });
    console.error('建立群組失敗:', err);
    res.status(500).json({ error: '建立失敗' });
  }
});

// 修改群組名稱
app.put('/api/groups/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '群組名稱不能為空' });

  try {
    const existing = await db.execute({ sql: 'SELECT * FROM groups WHERE id = ?', args: [Number(id)] });
    if (existing.rows.length === 0) return res.status(404).json({ error: '找不到此群組' });

    await db.execute({ sql: 'UPDATE groups SET name = ? WHERE id = ?', args: [name.trim(), Number(id)] });
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

// 指派使用者到群組（或移除）+ 設定權限
app.put('/api/users/:userId/group', requireAdmin, async (req, res) => {
  const { userId } = req.params;
  const { groupId, isSupervisor } = req.body;

  try {
    const user = await db.execute({ sql: 'SELECT * FROM users WHERE user_id = ?', args: [userId] });
    if (user.rows.length === 0) return res.status(404).json({ error: '找不到此使用者' });

    const currentUser = user.rows[0];
    // groupId 為 null 或空字串表示移除群組
    const newGroupId = groupId !== undefined ? (groupId ? String(groupId) : null) : currentUser.group_id;
    // isSupervisor 為 null 表示不變更
    const newSupervisor = isSupervisor !== null && isSupervisor !== undefined ? (isSupervisor ? 1 : 0) : currentUser.is_supervisor;

    await db.execute({
      sql: 'UPDATE users SET group_id = ?, is_supervisor = ? WHERE user_id = ?',
      args: [newGroupId, newSupervisor, userId],
    });
    apiCache.delete('users');
    res.json({ success: true });
  } catch (err) {
    console.error('指派群組失敗:', err);
    res.status(500).json({ error: '指派失敗' });
  }
});

// 取得未分組的使用者
app.get('/api/users/unassigned', requireAuth, async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT user_id, display_name FROM users
            WHERE (group_id IS NULL OR group_id = '' OR group_id = 'web') AND role != 'admin'
            ORDER BY display_name`,
      args: [],
    });
    res.json(result.rows);
  } catch (err) {
    console.error('查詢未分組使用者失敗:', err);
    res.status(500).json({ error: '查詢失敗' });
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

// 取得回報紀錄
app.get('/api/reports', requireAuth, async (req, res) => {
  const { date, user, keyword, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  let sql = 'SELECT * FROM reports WHERE 1=1';
  let countSql = 'SELECT COUNT(*) as total FROM reports WHERE 1=1';
  const params = [];

  // 主管和管理員可看全部回報，一般使用者只看自己
  const { role, userId } = req.session;
  if (role !== 'admin') {
    const userInfo = await db.execute({ sql: 'SELECT is_supervisor FROM users WHERE user_id = ?', args: [userId] });
    const u = userInfo.rows[0];
    if (u && u.is_supervisor) {
      // 主管：看全部（與管理員相同）
    } else {
      // 一般使用者：只看自己的
      sql += ' AND user_id = ?';
      countSql += ' AND user_id = ?';
      params.push(userId);
    }
  }

  if (date) { sql += ' AND report_date = ?'; countSql += ' AND report_date = ?'; params.push(date); }
  if (user) { sql += ' AND (display_name LIKE ? OR user_id = ?)'; countSql += ' AND (display_name LIKE ? OR user_id = ?)'; params.push(`%${user}%`, user); }
  if (keyword) { sql += ' AND (location LIKE ? OR task_description LIKE ?)'; countSql += ' AND (location LIKE ? OR task_description LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`); }

  try {
    const countResult = await db.execute({ sql: countSql, args: params });
    const total = countResult.rows[0].total;

    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    const reports = await db.execute({ sql, args: [...params, Number(limit), Number(offset)] });

    res.json({ data: reports.rows, total, page: Number(page), totalPages: Math.ceil(total / limit) });
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
app.get('/api/gps-users', requireAuth, cached('gps-users', 120, null), async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT DISTINCT r.user_id, r.display_name, COUNT(*) as report_count,
             MIN(r.report_date) as first_date, MAX(r.report_date) as last_date
           FROM reports r WHERE r.gps_latitude IS NOT NULL
           GROUP BY r.user_id ORDER BY r.display_name`,
      args: [],
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
  const { role, userId } = req.session;

  // 主管和管理員看全部統計，一般使用者看自己
  let isSupervisor = false;
  let cacheKey = `summary-user-${userId}`;

  if (role !== 'admin') {
    const userInfo = await db.execute({ sql: 'SELECT is_supervisor FROM users WHERE user_id = ?', args: [userId] });
    const u = userInfo.rows[0];
    if (u && u.is_supervisor) {
      isSupervisor = true;
      cacheKey = 'summary';
    }
  } else {
    cacheKey = 'summary';
  }

  // 檢查快取
  const now = Date.now();
  const entry = apiCache.get(cacheKey);
  if (entry && now - entry.time < 60000) {
    return res.json(entry.data);
  }

  try {
    let data;
    if (role === 'admin' || isSupervisor) {
      // 管理員和主管：看全部
      const results = await db.batch([
        { sql: 'SELECT COUNT(*) as count FROM reports WHERE report_date = ?', args: [today] },
        { sql: 'SELECT COUNT(DISTINCT user_id) as count FROM reports WHERE report_date = ?', args: [today] },
        { sql: 'SELECT COUNT(*) as count FROM users', args: [] },
      ]);
      const totalReports = results[0].rows[0].count;
      const totalUsers = results[1].rows[0].count;
      const allUsers = results[2].rows[0].count;
      data = { today, totalReports, totalUsers, allUsers, reportRate: allUsers > 0 ? Math.round((totalUsers / allUsers) * 100) : 0 };
    } else {
      // 一般使用者
      const result = await db.execute({
        sql: 'SELECT COUNT(*) as count FROM reports WHERE report_date = ? AND user_id = ?',
        args: [today, userId],
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

// 取得所有使用者（快取 60 秒）
app.get('/api/users', requireAuth, cached('users', 60, null), async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT u.user_id, u.display_name, u.role, u.group_id, u.is_supervisor, u.created_at,
              g.name as group_name
            FROM users u
            LEFT JOIN groups g ON u.group_id = CAST(g.id AS TEXT)
            ORDER BY u.display_name`,
      args: [],
    });
    res.json(result.rows);
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
    await db.execute({ sql: 'DELETE FROM users WHERE user_id = ?', args: [userId] });
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
            WHERE r.gps_latitude IS NOT NULL
            ORDER BY r.display_name`,
      args: [],
    });
    res.json(result.rows);
  } catch (err) {
    console.error('查詢最後位置失敗:', err);
    res.status(500).json({ error: '查詢失敗' });
  }
});

// 人員回報狀態面板（主管/管理員用）
app.get('/api/status-board', requireAuth, async (req, res) => {
  const { role, userId } = req.session;
  const tw = getTaiwanTime();
  const today = tw.date;

  try {
    // 取得使用者清單（依權限篩選）
    let userSql = 'SELECT user_id, display_name, group_id, is_supervisor, role FROM users WHERE 1=1';
    const userParams = [];

    if (role !== 'admin') {
      const userInfo = await db.execute({ sql: 'SELECT is_supervisor FROM users WHERE user_id = ?', args: [userId] });
      const u = userInfo.rows[0];
      if (u && u.is_supervisor) {
        // 主管：看全部人員（與管理員相同）
      } else {
        return res.status(403).json({ error: '需要主管或管理員權限' });
      }
    }

    userSql += ' ORDER BY display_name';
    const users = await db.execute({ sql: userSql, args: userParams });

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

// 匯出 CSV
app.get('/api/export', requireAdmin, async (req, res) => {
  const { startDate, endDate } = req.query;

  let sql = 'SELECT * FROM reports WHERE 1=1';
  const params = [];

  if (startDate) { sql += ' AND report_date >= ?'; params.push(startDate); }
  if (endDate) { sql += ' AND report_date <= ?'; params.push(endDate); }

  sql += ' ORDER BY created_at DESC';

  try {
    const result = await db.execute({ sql, args: params });
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
