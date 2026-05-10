const { DateTime } = require('luxon');
const { decryptToken } = require('./tokenVault');
const { fetchClubActivities, joinClubActivity } = require('./clubApi');

function parseJsonKeywordArray(raw) {
  try {
    const j = JSON.parse(String(raw || '[]'));
    return Array.isArray(j) ? j.map((x) => String(x || '').trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function isJoinableOption6(activity) {
  const o = activity?.optionStatus;
  return String(o ?? '').trim() === '6' || Number(o) === 6;
}

function hasCapacity(activity) {
  const joined = Number(activity.joinStudentNum ?? activity.signInStudent ?? 0);
  const total = Number(activity.maxStudent ?? activity.studentNum ?? 0);
  if (!Number.isFinite(joined) || !Number.isFinite(total) || total <= 0) return true;
  return joined < total;
}

function activityTextBlob(activity) {
  return [activity.activityName, activity.address, activity.addressDetail].filter(Boolean).join(' ');
}

function hasAreaMatch(activity, keywords) {
  if (!keywords.length) return false;
  const blob = activityTextBlob(activity);
  return keywords.some((kw) => kw && blob.includes(kw));
}

function hasExclude(activity, excludes) {
  const blob = activityTextBlob(activity);
  return excludes.some((ex) => ex && blob.includes(ex));
}

function parseActivityStart(activity, zone) {
  const s = String(activity.startTime || activity.activityStartTime || '').trim();
  const slice = s.slice(0, 19);
  let dt = DateTime.fromFormat(slice, 'yyyy-MM-dd HH:mm:ss', { zone: zone || 'Asia/Shanghai' });
  if (!dt.isValid) {
    dt = DateTime.fromISO(s, { zone: zone || 'Asia/Shanghai' });
  }
  return dt.isValid ? dt : null;
}

function classifyJoinError(err) {
  const msg = String(err?.message || err || '');
  if (/已报名|重复|请勿重复|already|duplicate/i.test(msg)) return 'external';
  return 'error';
}

/**
 * 从 club_sign_runs 取当日最近一次已完成签到/签退（ok / external）
 */
function findCompletedSignRun(db, studentId, runDate, action) {
  const row = db
    .prepare(
      `SELECT r.created_at, r.status
       FROM club_sign_runs r
       INNER JOIN club_sign_schedules s ON s.id = r.schedule_id AND s.student_id = ?
       WHERE r.run_date = ? AND r.action = ? AND r.status IN ('ok', 'external')
       ORDER BY r.id DESC LIMIT 1`,
    )
    .get(studentId, runDate, action);
  return row || null;
}

function getExistingAutoJoinRun(db, ruleId, runDate) {
  return db
    .prepare(`SELECT id, status FROM club_auto_join_runs WHERE rule_id = ? AND run_date = ?`)
    .get(ruleId, runDate);
}

async function findNextJoinableActivity(token, rule) {
  const areaKeywords = parseJsonKeywordArray(rule.area_keywords);
  const excludeKeywords = parseJsonKeywordArray(rule.exclude_keywords);
  if (areaKeywords.length === 0) return null;

  const tz = rule.timezone || 'Asia/Shanghai';
  const now = DateTime.now().setZone(tz);
  const maxDays = Math.min(30, Math.max(1, Number(rule.max_days_ahead) || 7));

  const candidates = [];
  for (let d = 0; d < maxDays; d += 1) {
    const queryTime = now.plus({ days: d }).toFormat('yyyy-MM-dd');
    let list;
    try {
      list = await fetchClubActivities(token, {
        queryTime,
        schoolId: rule.school_id,
        studentId: rule.student_id,
        pageNo: 1,
        pageSize: 50,
      });
    } catch {
      break;
    }
    for (const act of list) {
      if (!isJoinableOption6(act)) continue;
      if (!hasCapacity(act)) continue;
      if (hasExclude(act, excludeKeywords)) continue;
      if (!hasAreaMatch(act, areaKeywords)) continue;
      const st = parseActivityStart(act, tz);
      if (!st || st < now) continue;
      candidates.push({ act, st });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.st.toMillis() - b.st.toMillis());
  const preferEarliest = Number(rule.prefer_earliest) !== 0;
  const pick = preferEarliest ? candidates[0] : candidates[candidates.length - 1];
  return pick.act;
}

function parseSignRunTime(createdAt, zone) {
  const z = zone || 'Asia/Shanghai';
  const s = String(createdAt || '').trim();
  let dt = DateTime.fromSQL(s, { zone: z });
  if (!dt.isValid) {
    dt = DateTime.fromFormat(s.slice(0, 19), 'yyyy-MM-dd HH:mm:ss', { zone: z });
  }
  if (!dt.isValid) {
    dt = DateTime.fromISO(s, { zone: z });
  }
  return dt.isValid ? dt : null;
}

async function maybeRunAutoJoin(db, logger, rule) {
  const log = logger?.info?.bind(logger) || console.log;
  const tz = rule.timezone || 'Asia/Shanghai';
  const now = DateTime.now().setZone(tz);
  const today = now.toFormat('yyyy-MM-dd');

  const signInRun = findCompletedSignRun(db, rule.student_id, today, 'sign_in');
  const signOutRun = findCompletedSignRun(db, rule.student_id, today, 'sign_out');
  if (!signInRun || !signOutRun) return;

  const signOutAt = parseSignRunTime(signOutRun.created_at, tz);
  if (!signOutAt) return;

  const delayMin = Math.max(0, Number(rule.delay_minutes) || 60);
  const dueAt = signOutAt.plus({ minutes: delayMin });
  if (now < dueAt) return;

  const existing = getExistingAutoJoinRun(db, rule.id, today);
  if (existing && ['ok', 'external', 'no_target'].includes(existing.status)) return;
  if (existing && existing.status === 'running') return;
  if (existing && existing.status === 'error') {
    db.prepare('DELETE FROM club_auto_join_runs WHERE rule_id = ? AND run_date = ?').run(rule.id, today);
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO club_auto_join_runs
      (rule_id, student_id, school_id, run_date, status, message, selected_activity_id, selected_activity_name, selected_activity_time, selected_activity_area)
     VALUES (?, ?, ?, ?, 'running', '', NULL, NULL, NULL, NULL)`,
  );
  const ins = insert.run(rule.id, rule.student_id, rule.school_id, today);
  if (!ins.changes) return;

  const update = db.prepare(
    `UPDATE club_auto_join_runs SET status = ?, message = ?, selected_activity_id = ?, selected_activity_name = ?, selected_activity_time = ?, selected_activity_area = ?
     WHERE rule_id = ? AND run_date = ?`,
  );

  let token;
  try {
    token = decryptToken(rule.token_enc);
  } catch (e) {
    update.run('error', `解密 token 失败: ${e.message}`.slice(0, 500), null, null, null, null, rule.id, today);
    log(`[auto-join] decrypt fail rule=${rule.id}`);
    return;
  }

  try {
    const target = await findNextJoinableActivity(token, rule);
    if (!target) {
      update.run(
        'no_target',
        '没有找到符合区域和名额条件的活动',
        null,
        null,
        null,
        null,
        rule.id,
        today,
      );
      log(`[auto-join] no_target student=${rule.student_id}`);
      return;
    }

    const aid = Number(target.activityId ?? target.activity_id);
    const data = await joinClubActivity(token, aid, rule.student_id);
    const msg =
      String(data?.response?.message || data?.msg || data?.message || '报名成功').slice(0, 500);
    update.run(
      'ok',
      msg,
      aid,
      String(target.activityName || '').slice(0, 500),
      String(target.startTime || '').slice(0, 200),
      String(target.addressDetail || target.address || '').slice(0, 500),
      rule.id,
      today,
    );
    log(`[auto-join] ok student=${rule.student_id} activity=${aid}`);
  } catch (e) {
    const status = classifyJoinError(e);
    const msg = String(e.message || e).slice(0, 500);
    update.run(status, msg, null, null, null, null, rule.id, today);
    log(`[auto-join] ${status} student=${rule.student_id} ${msg}`);
  }
}

module.exports = {
  maybeRunAutoJoin,
  parseJsonKeywordArray,
  findNextJoinableActivity,
};
