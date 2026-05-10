const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');
const { decryptToken } = require('./tokenVault');
const { fetchRunStandard, fetchTokenProfile, saveRunRecord } = require('./clubApi');

const DEFAULT_DISTANCE_MIN = 1001;
const DEFAULT_DISTANCE_MAX = 9000;
const MIN_PACE_MINUTES_PER_KM = 6;
const MAX_PACE_MINUTES_PER_KM = 10;

let mapCache = null;

function clampValue(v, a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Math.max(lo, Math.min(v, hi));
}

function normalizeGender(raw) {
  const gender = String(raw ?? '').trim().toLowerCase();
  if (['1', 'male', 'man', 'm', 'boy', 'nan'].includes(gender)) return 'male';
  if (['2', 'female', 'woman', 'f', 'girl', 'nv'].includes(gender)) return 'female';
  return '';
}

function getDistance(start, end) {
  const toRad = (d) => (d * Math.PI) / 180;
  const [lng1, lat1] = start;
  const [lng2, lat2] = end;
  const R = 6378137;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function loadMaps() {
  if (mapCache) return mapCache;
  const mapsDir = path.join(__dirname, '..', '..', 'app', 'src', 'assets', 'maps');
  const files = fs.readdirSync(mapsDir).filter((f) => f.endsWith('.json'));
  const mapById = {};
  for (const file of files) {
    const fullPath = path.join(mapsDir, file);
    const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    if (!data?.mapId || !Array.isArray(data?.mapData)) continue;
    mapById[String(data.mapId)] = data.mapData;
  }
  mapCache = mapById;
  return mapById;
}

function buildYearSemester(now) {
  const year = now.getFullYear();
  const semester = now.getMonth() + 1 < 8 ? '1' : '2';
  return `${year}${semester}`;
}

function toPositive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function resolveRunBounds(profile, runStandard) {
  const gender = normalizeGender(profile?.gender ?? profile?.sex);
  const boyMin = toPositive(runStandard?.boyOnceDistanceMin);
  const boyMax = toPositive(runStandard?.boyOnceDistanceMax);
  const girlMin = toPositive(runStandard?.girlOnceDistanceMin);
  const girlMax = toPositive(runStandard?.girlOnceDistanceMax);

  let distanceMin = DEFAULT_DISTANCE_MIN;
  let distanceMax = DEFAULT_DISTANCE_MAX;
  if (gender === 'male') {
    if (boyMin > 0) distanceMin = Math.max(1, Math.trunc(boyMin) + 1);
    if (boyMax > 0) distanceMax = Math.max(distanceMin, Math.trunc(boyMax) + 1001);
  } else if (gender === 'female') {
    if (girlMin > 0) distanceMin = Math.max(1, Math.trunc(girlMin) + 1);
    if (girlMax > 0) distanceMax = Math.max(distanceMin, Math.trunc(girlMax) + 1001);
  }

  const boyTimeMin = toPositive(runStandard?.boyOnceTimeMin);
  const boyTimeMax = toPositive(runStandard?.boyOnceTimeMax);
  const girlTimeMin = toPositive(runStandard?.girlOnceTimeMin);
  const girlTimeMax = toPositive(runStandard?.girlOnceTimeMax);
  let timeMin = 0;
  let timeMax = 0;
  if (gender === 'male') {
    timeMin = boyTimeMin;
    timeMax = boyTimeMax;
  } else if (gender === 'female') {
    timeMin = girlTimeMin;
    timeMax = girlTimeMax;
  }
  return { distanceMin, distanceMax, timeMin, timeMax };
}

function computeDurationFromDistance(distanceMeters, timeMin, timeMax) {
  const dist = Number(distanceMeters);
  if (!Number.isFinite(dist) || dist <= 0) return 0;
  const km = dist / 1000;
  let minPace = MIN_PACE_MINUTES_PER_KM;
  let maxPace = MAX_PACE_MINUTES_PER_KM;
  if (timeMin > 0) minPace = Math.max(minPace, timeMin / km);
  if (timeMax > 0) maxPace = Math.min(maxPace, timeMax / km);
  const pace =
    minPace <= maxPace
      ? minPace + (maxPace - minPace) * Math.random()
      : MIN_PACE_MINUTES_PER_KM + (MAX_PACE_MINUTES_PER_KM - MIN_PACE_MINUTES_PER_KM) * Math.random();
  return Math.max(1, Math.round(km * pace));
}

function genTrackPoints(distance, mapChoice, durationMinutes) {
  const targetDistance = Number(distance);
  if (!Number.isFinite(targetDistance) || targetDistance <= 0) return '[]';

  const maps = loadMaps();
  const locations = maps[String(mapChoice)] || maps.default || [];
  if (!locations || locations.length === 0) return '[]';

  const coords = locations
    .map((point) => String(point).split(',').map(Number))
    .filter((pair) => pair.length === 2 && pair.every((num) => !Number.isNaN(num)));
  if (coords.length < 2) return '[]';

  const segments = [];
  for (let i = 0; i < coords.length; i += 1) {
    const from = coords[i];
    const to = coords[(i + 1) % coords.length];
    const len = getDistance(from, to);
    if (len >= 0.5) segments.push({ from, to, length: len });
  }
  if (!segments.length) return '[]';

  const pace = clampValue(
    Number(durationMinutes) > 0 ? durationMinutes / (targetDistance / 1000) : 8,
    MIN_PACE_MINUTES_PER_KM,
    MAX_PACE_MINUTES_PER_KM,
  );
  const durationMs = Math.round((targetDistance / 1000) * pace * 60 * 1000);
  const baseSpeed = 1000 / (pace * 60);
  const baseSpacing = clampValue(targetDistance / 1200, 4, 8);
  const maxTotalPoints = 4000;

  const projectOnSegment = (seg, offsetMeters) => {
    const t = clampValue(offsetMeters / seg.length, 0, 1);
    const lng = seg.from[0] + (seg.to[0] - seg.from[0]) * t;
    const lat = seg.from[1] + (seg.to[1] - seg.from[1]) * t;
    return [lng, lat];
  };

  let segIndex = Math.floor(Math.random() * segments.length);
  let segOffset = Math.random() * Math.max(1, segments[segIndex].length * 0.6);
  let lastPoint = projectOnSegment(segments[segIndex], segOffset);

  let elapsedMs = 0;
  let generatedDistance = 0;
  const result = [`${lastPoint[0]}-${lastPoint[1]}`];
  while (generatedDistance < targetDistance && result.length < maxTotalPoints) {
    const remainingDistance = targetDistance - generatedDistance;
    const stepTarget = Math.min(remainingDistance, baseSpacing * (0.9 + Math.random() * 0.35));
    let advance = stepTarget;
    while (advance > 0) {
      const seg = segments[segIndex];
      const remainingOnSeg = seg.length - segOffset;
      const stepThisSeg = Math.min(advance, remainingOnSeg);
      segOffset += stepThisSeg;
      advance -= stepThisSeg;
      if (segOffset >= seg.length - 1e-6) {
        segIndex = (segIndex + 1) % segments.length;
        segOffset = 0;
      }
    }
    const point = projectOnSegment(segments[segIndex], segOffset);
    const traveled = getDistance(lastPoint, point);
    generatedDistance += traveled;
    const stepTime = (traveled / Math.max(0.5, baseSpeed)) * 1000;
    elapsedMs += stepTime;
    if (elapsedMs > durationMs * 1.2 && generatedDistance > targetDistance * 0.7) break;
    result.push(`${point[0]}-${point[1]}`);
    lastPoint = point;
  }
  return JSON.stringify(result);
}

function parseCronMinuteHour(cronExpr) {
  const parts = String(cronExpr || '').trim().split(/\s+/);
  if (parts.length < 2) return null;
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  if (!Number.isInteger(minute) || !Number.isInteger(hour)) return null;
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  return { minute, hour };
}

function getTodayRun(db, ruleId, runDate) {
  return db.prepare('SELECT * FROM daily_run_runs WHERE rule_id = ? AND run_date = ?').get(ruleId, runDate);
}

async function maybeRunDailySubmit(db, logger, rule) {
  const log = logger?.info?.bind(logger) || console.log;
  const tz = String(rule.timezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai';
  const now = DateTime.now().setZone(tz);
  const runDate = now.toFormat('yyyy-MM-dd');
  const cron = parseCronMinuteHour(rule.cron_expr);
  if (!cron) return;
  if (now.hour !== cron.hour || now.minute !== cron.minute) return;

  const existing = getTodayRun(db, rule.id, runDate);
  if (existing && ['running', 'ok', 'external'].includes(String(existing.status))) return;
  if (existing && String(existing.status) === 'error') {
    db.prepare('DELETE FROM daily_run_runs WHERE rule_id = ? AND run_date = ?').run(rule.id, runDate);
  }

  const ins = db
    .prepare(
      `INSERT OR IGNORE INTO daily_run_runs
      (rule_id, run_date, status, message, response_code, response_brief)
      VALUES (?, ?, 'running', '', NULL, NULL)`,
    )
    .run(rule.id, runDate);
  if (!ins.changes) return;

  const update = db.prepare(
    `UPDATE daily_run_runs SET status = ?, message = ?, response_code = ?, response_brief = ? WHERE rule_id = ? AND run_date = ?`,
  );

  let token;
  try {
    token = decryptToken(rule.token_enc);
  } catch (e) {
    update.run('error', `解密 token 失败: ${e.message}`.slice(0, 500), null, null, rule.id, runDate);
    return;
  }

  try {
    const profile = await fetchTokenProfile(token);
    const standard = await fetchRunStandard(token, profile.schoolId);
    const bounds = resolveRunBounds(profile, standard);
    let runDistance = Math.round(Number(rule.distance_m) || 0);
    runDistance = clampValue(runDistance, bounds.distanceMin || DEFAULT_DISTANCE_MIN, bounds.distanceMax || DEFAULT_DISTANCE_MAX);
    const runTime = computeDurationFromDistance(runDistance, bounds.timeMin, bounds.timeMax);
    const trackPoints = genTrackPoints(runDistance, rule.map_id, runTime);
    if (!trackPoints || trackPoints === '[]') {
      update.run('error', '轨迹生成失败', null, null, rule.id, runDate);
      return;
    }

    const nowJs = new Date();
    const recordDate = nowJs.toISOString().split('T')[0];
    const yearSemester = buildYearSemester(nowJs);
    const data = await saveRunRecord(token, {
      trackPoints,
      runDistance,
      runTime,
      userId: profile.userId,
      recordDate,
      yearSemester,
    });
    const brief = String(data?.response?.resultDesc || data?.msg || data?.message || '提交成功').slice(0, 500);
    update.run('ok', brief, Number(data?.code || 10000), brief, rule.id, runDate);
    log(`[daily-run] ok student=${profile.studentId} distance=${runDistance} map=${rule.map_id}`);
  } catch (e) {
    const msg = String(e?.message || e || '执行失败').slice(0, 500);
    const status = /已完成|重复|already|duplicate/i.test(msg) ? 'external' : 'error';
    update.run(status, msg, null, msg, rule.id, runDate);
    log(`[daily-run] ${status} rule=${rule.id} ${msg}`);
  }
}

module.exports = {
  parseCronMinuteHour,
  maybeRunDailySubmit,
};

