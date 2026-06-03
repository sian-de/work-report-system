const { createClient } = require('@libsql/client');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:reports.db',
  authToken: process.env.TURSO_AUTH_TOKEN || undefined,
});

async function initDB() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      display_name TEXT,
      group_id TEXT,
      is_supervisor INTEGER DEFAULT 0,
      password_hash TEXT,
      role TEXT DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      display_name TEXT,
      group_id TEXT,
      report_date TEXT,
      report_time TEXT,
      task_type TEXT,
      location TEXT,
      task_description TEXT,
      gps_latitude REAL,
      gps_longitude REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(user_id)
    );

    CREATE TABLE IF NOT EXISTS task_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      emoji TEXT DEFAULT '📌',
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 主管 ↔ 公司 多對多：一位主管可管轄多間公司
    CREATE TABLE IF NOT EXISTS supervisor_companies (
      user_id TEXT NOT NULL,
      company_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, company_id)
    );

    CREATE INDEX IF NOT EXISTS idx_reports_date ON reports(created_at);
    CREATE INDEX IF NOT EXISTS idx_reports_user ON reports(user_id);
    CREATE INDEX IF NOT EXISTS idx_reports_report_date ON reports(report_date);
    CREATE INDEX IF NOT EXISTS idx_supcomp_user ON supervisor_companies(user_id);
  `);

  // 以 ALTER 補欄位（相容既有資料表）；欄位已存在則忽略錯誤。
  const addColumn = async (sql, label) => {
    try {
      await db.execute(sql);
    } catch (e) {
      if (!/duplicate column/i.test(e.message || '')) {
        console.error(`新增 ${label} 欄位時發生非預期錯誤:`, e.message);
      }
    }
  };
  // users.company_id：人員所屬公司（回報歸屬）
  await addColumn('ALTER TABLE users ADD COLUMN company_id INTEGER', 'users.company_id');
  // groups.company_id：群組歸屬的公司（公司 > 群組 > 人員 階層）
  await addColumn('ALTER TABLE groups ADD COLUMN company_id INTEGER', 'groups.company_id');

  // 預設事項類型種子資料
  const typeCount = await db.execute({ sql: 'SELECT COUNT(*) as c FROM task_types', args: [] });
  if (typeCount.rows[0].c === 0) {
    const defaultTypes = [
      { name: '跑法院', emoji: '⚖️', sort_order: 1 },
      { name: '拜訪對照', emoji: '🤝', sort_order: 2 },
      { name: '對照和解', emoji: '📝', sort_order: 3 },
      { name: '跑警察局', emoji: '🏛️', sort_order: 4 },
      { name: '到站找駕駛', emoji: '🚌', sort_order: 5 },
      { name: '其他', emoji: '📌', sort_order: 6 },
    ];
    for (const t of defaultTypes) {
      await db.execute({
        sql: 'INSERT INTO task_types (name, emoji, sort_order) VALUES (?, ?, ?)',
        args: [t.name, t.emoji, t.sort_order],
      });
    }
    console.log('已建立預設事項類型（6 種）');
  }
}

module.exports = { db, initDB };
