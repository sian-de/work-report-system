require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./database');

const app = express();

// JSON body parser
app.use(express.json());

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

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
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

// ====== 靜態檔案 ======
app.use('/admin', express.static(path.join(__dirname, 'public')));
app.use('/report.html', express.static(path.join(__dirname, 'public', 'report.html')));

// ====== 帳號 API ======

// 註冊
app.post('/api/register', (req, res) => {
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

  // 檢查帳號是否已存在
  const existing = db.prepare('SELECT user_id FROM users WHERE user_id = ?').get(username.trim());
  if (existing) {
    return res.status(400).json({ error: '此帳號已被使用' });
  }

  const userId = username.trim();
  const name = displayName.trim();
  const pwHash = hashPassword(password);

  try {
    db.prepare('INSERT INTO users (user_id, display_name, group_id, password_hash, role) VALUES (?, ?, ?, ?, ?)')
      .run(userId, name, 'web', pwHash, 'user');

    const token = createSession(userId, name, 'user');
    res.json({ success: true, token, displayName: name, role: 'user' });
  } catch (err) {
    console.error('註冊失敗:', err);
    res.status(500).json({ error: '註冊失敗' });
  }
});

// 登入
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '請輸入帳號和密碼' });
  }

  const user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(username.trim());
  if (!user || !user.password_hash) {
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }

  if (user.password_hash !== hashPassword(password)) {
    return res.status(401).json({ error: '帳號或密碼錯誤' });
  }

  const token = createSession(user.user_id, user.display_name, user.role || 'user');
  res.json({ success: true, token, displayName: user.display_name, role: user.role || 'user' });
});

// 驗證 session
app.get('/api/me', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: '未登入' });
  res.json({ userId: session.userId, displayName: session.displayName, role: session.role });
});

// 登出
app.post('/api/logout', (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (token) sessions.delete(token);
  res.json({ success: true });
});

// ====== 回報 API ======

// 提交回報
app.post('/api/submit-report', requireAuth, (req, res) => {
  const { taskType, location, task, latitude, longitude } = req.body;
  const { userId, displayName } = req.session;

  if (!location || !task) {
    return res.status(400).json({ error: '請填寫地點和處理內容' });
  }

  const tw = getTaiwanTime();

  try {
    db.prepare(`
      INSERT INTO reports (user_id, display_name, group_id, report_date, report_time, task_type, location, task_description, gps_latitude, gps_longitude)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, displayName, 'web',
      tw.date, tw.time, taskType || '其他',
      location, task,
      latitude || null, longitude || null);

    res.json({ success: true, message: '回報成功！' });
  } catch (err) {
    console.error('儲存回報失敗:', err);
    res.status(500).json({ error: '儲存失敗，請稍後再試。' });
  }
});

// 查詢某人今日回報次數
app.get('/api/user-today', requireAuth, (req, res) => {
  const { userId } = req.session;
  const tw = getTaiwanTime();
  const count = db.prepare(
    'SELECT COUNT(*) as c FROM reports WHERE user_id = ? AND report_date = ?'
  ).get(userId, tw.date).c;
  res.json({ count });
});

// ====== 後台 API（需要登入）======

// 取得回報紀錄
app.get('/api/reports', requireAuth, (req, res) => {
  const { date, user, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  let sql = 'SELECT * FROM reports WHERE 1=1';
  const params = [];

  if (date) { sql += ' AND report_date = ?'; params.push(date); }
  if (user) { sql += ' AND (display_name LIKE ? OR user_id = ?)'; params.push(`%${user}%`, user); }

  const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
  const total = db.prepare(countSql).get(...params).total;

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const reports = db.prepare(sql).all(...params);
  res.json({ data: reports, total, page: Number(page), totalPages: Math.ceil(total / limit) });
});

// 取得軌跡資料
app.get('/api/trajectory', requireAuth, (req, res) => {
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
  const reports = db.prepare(sql).all(...params);

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
});

// 取得有 GPS 資料的使用者列表
app.get('/api/gps-users', requireAuth, (req, res) => {
  const users = db.prepare(`
    SELECT DISTINCT r.user_id, r.display_name, COUNT(*) as report_count,
           MIN(r.report_date) as first_date, MAX(r.report_date) as last_date
    FROM reports r WHERE r.gps_latitude IS NOT NULL
    GROUP BY r.user_id ORDER BY r.display_name
  `).all();
  res.json(users);
});

// 取得今日摘要
app.get('/api/summary', requireAuth, (req, res) => {
  const tw = getTaiwanTime();
  const today = tw.date;

  const totalReports = db.prepare('SELECT COUNT(*) as count FROM reports WHERE report_date = ?').get(today).count;
  const totalUsers = db.prepare('SELECT COUNT(DISTINCT user_id) as count FROM reports WHERE report_date = ?').get(today).count;
  const allUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;

  res.json({
    today, totalReports, totalUsers, allUsers,
    reportRate: allUsers > 0 ? Math.round((totalUsers / allUsers) * 100) : 0,
  });
});

// 取得所有使用者
app.get('/api/users', requireAuth, (req, res) => {
  const users = db.prepare('SELECT user_id, display_name, role, created_at FROM users ORDER BY display_name').all();
  res.json(users);
});

// 修改回報紀錄
app.put('/api/reports/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  const { taskType, location, task } = req.body;

  if (!location || !task) {
    return res.status(400).json({ error: '地點和處理內容不能為空' });
  }

  try {
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
    if (!report) return res.status(404).json({ error: '找不到此回報' });

    // 一般人員只能改自己的，管理員可以改所有人的
    if (req.session.role !== 'admin' && report.user_id !== req.session.userId) {
      return res.status(403).json({ error: '只能修改自己的回報' });
    }

    db.prepare('UPDATE reports SET task_type = ?, location = ?, task_description = ? WHERE id = ?')
      .run(taskType || '其他', location, task, id);

    res.json({ success: true });
  } catch (err) {
    console.error('修改回報失敗:', err);
    res.status(500).json({ error: '修改失敗' });
  }
});

// 取得自己的回報紀錄
app.get('/api/my-reports', requireAuth, (req, res) => {
  const { date, page = 1, limit = 50 } = req.query;
  const { userId } = req.session;
  const offset = (page - 1) * limit;

  let sql = 'SELECT * FROM reports WHERE user_id = ?';
  const params = [userId];

  if (date) { sql += ' AND report_date = ?'; params.push(date); }

  const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total');
  const total = db.prepare(countSql).get(...params).total;

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const reports = db.prepare(sql).all(...params);
  res.json({ data: reports, total, page: Number(page), totalPages: Math.ceil(total / limit) });
});

// 刪除回報紀錄（自己的或管理員可刪除所有）
app.delete('/api/reports/:id', requireAuth, (req, res) => {
  const { id } = req.params;
  try {
    const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
    if (!report) return res.status(404).json({ error: '找不到此回報' });

    // 一般人員只能刪自己的，管理員可以刪所有人的
    if (req.session.role !== 'admin' && report.user_id !== req.session.userId) {
      return res.status(403).json({ error: '只能刪除自己的回報' });
    }

    db.prepare('DELETE FROM reports WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '刪除失敗' });
  }
});

// 刪除人員（管理員限定）
app.delete('/api/users/:userId', requireAdmin, (req, res) => {
  const { userId } = req.params;
  if (userId === 'admin') {
    return res.status(400).json({ error: '不能刪除管理員帳號' });
  }
  try {
    db.prepare('DELETE FROM reports WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM users WHERE user_id = ?').run(userId);
    res.json({ success: true });
  } catch (err) {
    console.error('刪除人員失敗:', err);
    res.status(500).json({ error: '刪除失敗' });
  }
});

// 匯出 CSV
app.get('/api/export', (req, res) => {
  const { startDate, endDate } = req.query;

  let sql = 'SELECT * FROM reports WHERE 1=1';
  const params = [];

  if (startDate) { sql += ' AND report_date >= ?'; params.push(startDate); }
  if (endDate) { sql += ' AND report_date <= ?'; params.push(endDate); }

  sql += ' ORDER BY created_at DESC';
  const reports = db.prepare(sql).all(...params);

  const BOM = '﻿';
  let csv = BOM + '日期,時間,姓名,事項類型,地點,處理事項,GPS緯度,GPS經度,Google地圖連結\n';
  for (const r of reports) {
    const gpsLink = r.gps_latitude ? `https://maps.google.com/?q=${r.gps_latitude},${r.gps_longitude}` : '';
    csv += `"${r.report_date}","${r.report_time}","${r.display_name}","${r.task_type || ''}","${(r.location || '').replace(/"/g, '""')}","${(r.task_description || '').replace(/"/g, '""')}","${r.gps_latitude || ''}","${r.gps_longitude || ''}","${gpsLink}"\n`;
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=reports_${startDate || 'all'}_${endDate || 'all'}.csv`);
  res.send(csv);
});

// 首頁導向回報頁
app.get('/', (req, res) => {
  res.redirect('/report.html');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  // 自動建立預設管理員帳號（如果不存在）
  const admin = db.prepare('SELECT user_id FROM users WHERE role = ?').get('admin');
  if (!admin) {
    const pwHash = hashPassword('admin123');
    db.prepare('INSERT OR IGNORE INTO users (user_id, display_name, group_id, password_hash, role) VALUES (?, ?, ?, ?, ?)')
      .run('admin', '管理員', 'web', pwHash, 'admin');
    console.log('已建立預設管理員帳號: admin / admin123');
  }

  console.log(`伺服器啟動於 http://localhost:${PORT}`);
  console.log(`回報頁面: http://localhost:${PORT}/report.html`);
  console.log(`管理後台: http://localhost:${PORT}/admin`);
});
