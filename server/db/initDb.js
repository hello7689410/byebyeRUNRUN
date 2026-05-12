const fs = require('fs');
const path = require('path');

/**
 * 将 sql.js 包装为与 better-sqlite3 子集兼容的同步 API（prepare().get / .all / .run）
 * 便于 routes、scheduler 与 backend-club-sign-scheduler.md 描述一致。
 */
function wrapSqlJsDatabase(sqlDb, persist) {
  return {
    prepare(sql) {
      return {
        get(...params) {
          const stmt = sqlDb.prepare(sql);
          stmt.bind(params);
          if (!stmt.step()) {
            stmt.free();
            return undefined;
          }
          const row = stmt.getAsObject();
          stmt.free();
          return row;
        },
        all(...params) {
          const stmt = sqlDb.prepare(sql);
          stmt.bind(params);
          const rows = [];
          while (stmt.step()) {
            rows.push(stmt.getAsObject());
          }
          stmt.free();
          return rows;
        },
        run(...params) {
          sqlDb.run(sql, params);
          const changes = sqlDb.getRowsModified();
          persist();
          return { changes };
        },
      };
    },
  };
}

async function initDb(logger) {
  let initSqlJs;
  try {
    initSqlJs = require('sql.js');
  } catch (e) {
    throw new Error('缺少 sql.js，请在 server 目录执行 npm install');
  }

  const dataDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = process.env.SCHEDULER_DB_PATH || path.join(dataDir, 'club_scheduler.sqlite');

  const wasmDir = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist');
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(wasmDir, file),
  });

  let sqlDb;
  if (fs.existsSync(dbPath)) {
    const filebuffer = fs.readFileSync(dbPath);
    sqlDb = new SQL.Database(filebuffer);
  } else {
    sqlDb = new SQL.Database();
  }

  const persist = () => {
    const data = sqlDb.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  };

  sqlDb.exec(`
    CREATE TABLE IF NOT EXISTS club_sign_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL UNIQUE,
      token_enc TEXT NOT NULL,
      sign_in_time TEXT NOT NULL,
      sign_out_time TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS club_sign_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id INTEGER NOT NULL,
      run_date TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      api_code INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (schedule_id) REFERENCES club_sign_schedules(id) ON DELETE CASCADE,
      UNIQUE (schedule_id, run_date, action)
    );

    CREATE INDEX IF NOT EXISTS idx_club_sign_runs_schedule ON club_sign_runs(schedule_id);
    CREATE INDEX IF NOT EXISTS idx_club_sign_runs_created ON club_sign_runs(created_at);

    CREATE TABLE IF NOT EXISTS club_sign_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id INTEGER,
      student_id INTEGER,
      run_date TEXT NOT NULL,
      action TEXT,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      metadata TEXT,
      unique_key TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (unique_key)
    );

    CREATE INDEX IF NOT EXISTS idx_club_sign_audit_date ON club_sign_audit_logs(run_date);
    CREATE INDEX IF NOT EXISTS idx_club_sign_audit_schedule ON club_sign_audit_logs(schedule_id);

    CREATE TABLE IF NOT EXISTS club_auto_join_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL UNIQUE,
      school_id INTEGER NOT NULL,
      token_enc TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      area_keywords TEXT NOT NULL DEFAULT '',
      exclude_keywords TEXT NOT NULL DEFAULT '',
      delay_minutes INTEGER NOT NULL DEFAULT 60,
      max_days_ahead INTEGER NOT NULL DEFAULT 7,
      prefer_earliest INTEGER NOT NULL DEFAULT 1,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS club_auto_join_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      school_id INTEGER NOT NULL,
      run_date TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      selected_activity_id INTEGER,
      selected_activity_name TEXT,
      selected_activity_time TEXT,
      selected_activity_area TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (rule_id) REFERENCES club_auto_join_rules(id) ON DELETE CASCADE,
      UNIQUE (rule_id, run_date)
    );

    CREATE INDEX IF NOT EXISTS idx_club_auto_join_runs_rule ON club_auto_join_runs(rule_id);
    CREATE INDEX IF NOT EXISTS idx_club_auto_join_runs_date ON club_auto_join_runs(run_date);

    CREATE TABLE IF NOT EXISTS daily_run_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL UNIQUE,
      token_enc TEXT NOT NULL,
      school_id INTEGER,
      map_id TEXT NOT NULL,
      distance_m INTEGER NOT NULL,
      cron_expr TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS daily_run_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER NOT NULL,
      run_date TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      response_code INTEGER,
      response_brief TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (rule_id) REFERENCES daily_run_rules(id) ON DELETE CASCADE,
      UNIQUE (rule_id, run_date)
    );

    CREATE INDEX IF NOT EXISTS idx_daily_run_runs_rule ON daily_run_runs(rule_id);
    CREATE INDEX IF NOT EXISTS idx_daily_run_runs_date ON daily_run_runs(run_date);
  `);

  persist();

  const db = wrapSqlJsDatabase(sqlDb, persist);
  if (logger) logger.info(`Club scheduler DB ready (sql.js): ${dbPath}`);
  return db;
}

module.exports = { initDb };
