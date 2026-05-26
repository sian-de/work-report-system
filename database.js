const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'reports.db'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    display_name TEXT,
    group_id TEXT,
    is_supervisor INTEGER DEFAULT 0,
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

  CREATE INDEX IF NOT EXISTS idx_reports_date ON reports(created_at);
  CREATE INDEX IF NOT EXISTS idx_reports_user ON reports(user_id);
  CREATE INDEX IF NOT EXISTS idx_reports_report_date ON reports(report_date);
`);

// 如果舊資料庫缺少新欄位，嘗試加入
try { db.exec('ALTER TABLE reports ADD COLUMN task_type TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN is_supervisor INTEGER DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN role TEXT DEFAULT "user"'); } catch (e) {}

module.exports = db;
