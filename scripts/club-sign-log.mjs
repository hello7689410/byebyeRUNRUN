#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const serverRoot = path.join(repoRoot, 'server');
const require = createRequire(import.meta.url);

function parseDotenv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const env = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) env[key] = value;
  }
  return env;
}

function parseArgs(argv) {
  const args = {
    date: '',
    studentId: '',
    dbPath: '',
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--json') {
      args.json = true;
      continue;
    }
    if (item === '--date' && argv[i + 1]) {
      args.date = argv[++i];
      continue;
    }
    if (item === '--student-id' && argv[i + 1]) {
      args.studentId = argv[++i];
      continue;
    }
    if (item === '--db' && argv[i + 1]) {
      args.dbPath = argv[++i];
    }
  }

  return args;
}

function todayInChina() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

function openDb(dbPath) {
  const initSqlJs = require(path.join(serverRoot, 'node_modules', 'sql.js'));
  return initSqlJs({
    locateFile: (file) => path.join(serverRoot, 'node_modules', 'sql.js', 'dist', file),
  }).then((SQL) => {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`数据库不存在: ${dbPath}`);
    }
    return new SQL.Database(fs.readFileSync(dbPath));
  });
}

function all(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function tableExists(db, tableName) {
  const rows = all(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [
    tableName,
  ]);
  return rows.length > 0;
}

function normalizeActionText(action) {
  if (action === 'sign_in') return '签到';
  if (action === 'sign_out') return '签退';
  return action || '-';
}

function isAlreadyDoneMessage(message) {
  const text = String(message || '');
  return /已签|重复|请勿重复|already|duplicate/i.test(text);
}

function classifyRun(run) {
  if (!run) {
    return {
      source: '未记录',
      note: '后端日志表没有这次动作的记录',
    };
  }

  if (run.status === 'ok') {
    return {
      source: '后端自动完成',
      note: run.message || '后端调用接口成功',
    };
  }

  if (run.status === 'external' || isAlreadyDoneMessage(run.message)) {
    return {
      source: '可能手动/外部已完成',
      note: run.message || '后端执行时发现该动作已经完成',
    };
  }

  return {
    source: '后端执行失败',
    note: run.message || run.status || '未知错误',
  };
}

function buildReport(schedules, runs, date) {
  const byScheduleAction = new Map();
  for (const run of runs) {
    byScheduleAction.set(`${run.schedule_id}:${run.action}`, run);
  }

  return schedules.map((schedule) => {
    const signInRun = byScheduleAction.get(`${schedule.id}:sign_in`);
    const signOutRun = byScheduleAction.get(`${schedule.id}:sign_out`);
    const signIn = classifyRun(signInRun);
    const signOut = classifyRun(signOutRun);

    let daySummary = '未完成';
    if (signIn.source === '后端自动完成' && signOut.source === '后端自动完成') {
      daySummary = '签到和签退均由后端自动完成';
    } else if (signIn.source !== '后端自动完成' && signOut.source === '后端自动完成') {
      daySummary = '签退由后端完成，签到不是后端成功记录';
    } else if (signIn.source === '后端自动完成' && signOut.source !== '后端自动完成') {
      daySummary = '签到由后端完成，签退不是后端成功记录';
    } else if (
      signIn.source === '可能手动/外部已完成' ||
      signOut.source === '可能手动/外部已完成'
    ) {
      daySummary = '存在手动或外部完成痕迹';
    }

    return {
      date,
      studentId: schedule.student_id,
      schedule: {
        id: schedule.id,
        signInTime: schedule.sign_in_time,
        signOutTime: schedule.sign_out_time,
        timezone: schedule.timezone,
        enabled: schedule.enabled === 1,
        updatedAt: schedule.updated_at,
      },
      summary: daySummary,
      actions: [
        {
          action: 'sign_in',
          label: '签到',
          plannedTime: schedule.sign_in_time,
          source: signIn.source,
          status: signInRun?.status || '',
          runAt: signInRun?.created_at || '',
          message: signIn.note,
        },
        {
          action: 'sign_out',
          label: '签退',
          plannedTime: schedule.sign_out_time,
          source: signOut.source,
          status: signOutRun?.status || '',
          runAt: signOutRun?.created_at || '',
          message: signOut.note,
        },
      ],
    };
  });
}

function buildAuditSummary(audits) {
  const counts = {};
  for (const row of audits) {
    const key = `${row.event_type}:${row.status}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function printReport(report, dbPath) {
  console.log(`数据库: ${dbPath}`);
  if (report.length === 0) {
    console.log('没有找到匹配的定时配置。');
    return;
  }

  for (const item of report) {
    console.log('');
    console.log(`日期: ${item.date}`);
    console.log(`学生ID: ${item.studentId}`);
    console.log(
      `定时: 签到 ${item.schedule.signInTime} / 签退 ${item.schedule.signOutTime} / ${item.schedule.timezone} / ${
        item.schedule.enabled ? '启用' : '停用'
      }`,
    );
    console.log(`结论: ${item.summary}`);
    console.log('动作      计划时间  来源                 状态    后端记录时间           说明');
    console.log('--------  --------  -------------------  ------  -------------------  ----------------');
    for (const action of item.actions) {
      console.log(
        [
          normalizeActionText(action.action).padEnd(8, ' '),
          String(action.plannedTime || '-').padEnd(8, ' '),
          String(action.source || '-').padEnd(19, ' '),
          String(action.status || '-').padEnd(6, ' '),
          String(action.runAt || '-').padEnd(19, ' '),
          action.message || '-',
        ].join('  '),
      );
    }
  }
}

function printAudits(audits) {
  if (!audits.length) {
    console.log('');
    console.log('审计日志: 暂无。若后端刚升级，请等待下一次 cron 扫描。');
    return;
  }

  console.log('');
  console.log('审计日志汇总:');
  const summary = buildAuditSummary(audits);
  for (const [key, count] of Object.entries(summary)) {
    console.log(`- ${key}: ${count}`);
  }

  console.log('');
  console.log('最近审计日志:');
  console.log('时间                 学生ID      动作      事件              状态      说明');
  console.log('-------------------  ----------  --------  ----------------  --------  ----------------');
  for (const row of audits.slice(-20).reverse()) {
    console.log(
      [
        String(row.created_at || '-').padEnd(19, ' '),
        String(row.student_id || '-').padEnd(10, ' '),
        normalizeActionText(row.action).padEnd(8, ' '),
        String(row.event_type || '-').padEnd(16, ' '),
        String(row.status || '-').padEnd(8, ' '),
        String(row.message || '-'),
      ].join('  '),
    );
  }
}

const args = parseArgs(process.argv.slice(2));
const env = { ...parseDotenv(path.join(serverRoot, '.env')), ...process.env };
const dbPath = path.resolve(
  repoRoot,
  args.dbPath || env.SCHEDULER_DB_PATH || path.join(serverRoot, 'data', 'club_scheduler.sqlite'),
);
const date = args.date || todayInChina();
const studentId = args.studentId ? Number(args.studentId) : null;

try {
  const db = await openDb(dbPath);
  const schedules = studentId
    ? all(db, 'SELECT * FROM club_sign_schedules WHERE student_id = ? ORDER BY student_id', [
        studentId,
      ])
    : all(db, 'SELECT * FROM club_sign_schedules ORDER BY student_id');
  const runs = studentId
    ? all(
        db,
        `SELECT r.* FROM club_sign_runs r
         JOIN club_sign_schedules s ON s.id = r.schedule_id
         WHERE r.run_date = ? AND s.student_id = ?
         ORDER BY r.created_at`,
        [date, studentId],
      )
    : all(db, 'SELECT * FROM club_sign_runs WHERE run_date = ? ORDER BY created_at', [date]);
  const audits = tableExists(db, 'club_sign_audit_logs')
    ? studentId
      ? all(
          db,
          'SELECT * FROM club_sign_audit_logs WHERE run_date = ? AND student_id = ? ORDER BY created_at, id',
          [date, studentId],
        )
      : all(
          db,
          'SELECT * FROM club_sign_audit_logs WHERE run_date = ? ORDER BY created_at, id',
          [date],
        )
    : [];
  const report = buildReport(schedules, runs, date);

  if (args.json) {
    console.log(JSON.stringify({ ok: true, dbPath, date, report, audits }, null, 2));
  } else {
    printReport(report, dbPath);
    printAudits(audits);
  }
  db.close();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
