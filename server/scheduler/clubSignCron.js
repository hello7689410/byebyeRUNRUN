const cron = require('node-cron');
const { DateTime } = require('luxon');
const { decryptToken } = require('../lib/tokenVault');
const { signInOrSignBack } = require('../lib/clubApi');

const DEFAULT_SIGN_OUT_GRACE_MINUTES = 60;

function normalizeHHMM(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const min = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function readGraceMinutes() {
  const n = Number(process.env.SCHEDULER_SIGN_OUT_GRACE_MINUTES);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SIGN_OUT_GRACE_MINUTES;
  return Math.floor(n);
}

function buildTodayTime(now, hhmm) {
  const normalized = normalizeHHMM(hhmm);
  if (!normalized) return null;
  const [hour, minute] = normalized.split(':').map(Number);
  return now.set({ hour, minute, second: 0, millisecond: 0 });
}

function isDueBetween(now, start, end) {
  if (!start || !end) return false;
  return now >= start && now <= end;
}

function isExternalCompletionMessage(message) {
  return /已签|重复|请勿重复|already|duplicate/i.test(String(message || ''));
}

function resolveDueActions(now, signInHm, signOutHm) {
  const signInAt = buildTodayTime(now, signInHm);
  const signOutAt = buildTodayTime(now, signOutHm);
  if (!signInAt || !signOutAt) return [];

  const actions = [];
  if (isDueBetween(now, signInAt, signOutAt)) {
    actions.push({ action: 'sign_in', signType: '1' });
  }

  const signOutDeadline = signOutAt.plus({ minutes: readGraceMinutes() });
  if (isDueBetween(now, signOutAt, signOutDeadline)) {
    actions.push({ action: 'sign_out', signType: '2' });
  }

  return actions;
}

function startClubSignCron(db, logger) {
  const log = logger?.info?.bind(logger) || console.log;

  const job = cron.schedule('* * * * *', () => {
    void (async () => {
      const schedules = db.prepare('SELECT * FROM club_sign_schedules WHERE enabled = 1').all();

      for (const row of schedules) {
        const tz = row.timezone || 'Asia/Shanghai';
        const now = DateTime.now().setZone(tz);
        const hm = now.toFormat('HH:mm');
        const today = now.toFormat('yyyy-MM-dd');

        const signInHm = normalizeHHMM(row.sign_in_time);
        const signOutHm = normalizeHHMM(row.sign_out_time);
        if (!signInHm || !signOutHm) continue;

        let token;
        try {
          token = decryptToken(row.token_enc);
        } catch (e) {
          log(`[cron] decrypt failed schedule_id=${row.id}: ${e.message}`);
          continue;
        }

        const dueActions = resolveDueActions(now, signInHm, signOutHm);
        for (const item of dueActions) {
          await runOnce(db, logger, row, today, item.action, item.signType, token);
        }
      }
    })();
  });

  log('[cron] club sign scheduler started (every minute UTC machine clock; per-row timezone for due window match)');
  return job;
}

async function runOnce(db, logger, scheduleRow, runDate, action, signType, token) {
  const log = logger?.info?.bind(logger) || console.log;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO club_sign_runs (schedule_id, run_date, action, status, message, api_code)
     VALUES (?, ?, ?, 'running', '', NULL)`,
  );
  const info = insert.run(scheduleRow.id, runDate, action);
  if (!info.changes) {
    return;
  }

  const update = db.prepare(
    `UPDATE club_sign_runs SET status = ?, message = ?, api_code = ? WHERE schedule_id = ? AND run_date = ? AND action = ?`,
  );

  try {
    const data = await signInOrSignBack(token, scheduleRow.student_id, signType);
    const msg =
      (data && (data.response?.message || data.msg || data.message)) || 'ok';
    update.run('ok', String(msg).slice(0, 500), Number(data?.code) || 10000, scheduleRow.id, runDate, action);
    log(`[cron] OK student=${scheduleRow.student_id} action=${action} ${msg}`);
  } catch (e) {
    const msg = e.message || String(e);
    const status = isExternalCompletionMessage(msg) ? 'external' : 'error';
    update.run(status, msg.slice(0, 500), null, scheduleRow.id, runDate, action);
    log(`[cron] ${status === 'external' ? 'EXTERNAL' : 'FAIL'} student=${scheduleRow.student_id} action=${action} ${msg}`);
  }
}

module.exports = { startClubSignCron };
