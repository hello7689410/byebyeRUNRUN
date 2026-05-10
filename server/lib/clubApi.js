/**
 * 调用校园跑社团签到接口（与 app/src/utils/sign.js、scripts/club-auto-sign.mjs 规则一致）
 */
const crypto = require('crypto');

const APP_VERSION = '1.8.3';
const DEFAULT_APP_KEY = process.env.BYERUN_APP_KEY || '389885588s0648fa';
const DEFAULT_APP_SECRET = process.env.BYERUN_APP_SECRET || '56E39A1658455588885690425C0FD16055A21676';

function md5HexLower(s) {
  return crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
}

function md5SignUpper(signStr) {
  return crypto.createHash('md5').update(signStr, 'utf8').digest('hex').toUpperCase();
}

function genSign(query, body) {
  const appKey = DEFAULT_APP_KEY;
  const appSecret = DEFAULT_APP_SECRET;
  let signStr = '';

  if (query !== null && query !== undefined) {
    const normalizedQuery = Object.entries(query).reduce((acc, [key, value]) => {
      acc[key] = value === null ? '' : String(value);
      return acc;
    }, {});
    const sortedKeys = Object.keys(normalizedQuery).sort();
    for (const key of sortedKeys) {
      const value = normalizedQuery[key];
      if (value !== '') signStr += key + value;
    }
  }

  signStr += appKey;
  signStr += appSecret;

  if (body !== null && body !== undefined) {
    signStr += JSON.stringify(body);
  }

  let replaced = false;
  const specialChars = [' ', '~', '!', '(', ')', "'"];
  for (const ch of specialChars) {
    if (signStr.includes(ch)) {
      signStr = signStr.split(ch).join('');
      replaced = true;
    }
  }
  if (replaced) {
    signStr = encodeURIComponent(signStr);
  }

  let sign = md5SignUpper(signStr);
  if (replaced) sign += 'encodeutf8';
  return sign;
}

function getApiBase() {
  return (process.env.BYERUN_API_BASE || 'https://run-lb.tanmasports.com/v1').replace(/\/$/, '');
}

function buildHeaders({ token, params, body }) {
  return {
    appKey: DEFAULT_APP_KEY,
    'Content-Type': 'application/json',
    token: token || '',
    sign: genSign(params ?? null, body ?? null),
  };
}

async function apiRequest(method, path, { token, params, body } = {}) {
  const base = getApiBase();
  const url = new URL(path.startsWith('/') ? path.slice(1) : path, `${base}/`);

  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && `${v}` !== '') url.searchParams.set(k, String(v));
    }
  }

  const headers = buildHeaders({
    token,
    params: method === 'GET' ? params : null,
    body: method !== 'GET' ? body : null,
  });

  const init = { method, headers };
  if (method !== 'GET' && body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text, parseError: true };
  }
  return { ok: res.ok, status: res.status, data };
}

function isApiSuccess(data) {
  const code = Number(data?.code);
  return code === 10000 || code === 1000;
}

async function fetchStudentIdFromToken(token) {
  const { data } = await apiRequest('GET', '/auth/query/token', { token });
  if (!isApiSuccess(data)) {
    throw new Error(data?.msg || data?.message || 'token 无效或已过期');
  }
  const sid = data.response?.studentId ?? data.response?.student_id;
  const n = Number(sid);
  if (!Number.isFinite(n) || n <= 0) throw new Error('query/token 未返回 studentId');
  return n;
}

async function fetchTokenProfile(token) {
  const { data } = await apiRequest('GET', '/auth/query/token', { token });
  if (!isApiSuccess(data)) {
    throw new Error(data?.msg || data?.message || 'token 无效或已过期');
  }
  const r = data.response || {};
  const studentId = Number(r.studentId ?? r.student_id);
  const userId = Number(r.userId ?? r.user_id);
  const schoolId = Number(r.schoolId ?? r.school_id);
  if (!Number.isFinite(studentId) || studentId <= 0) throw new Error('query/token 未返回 studentId');
  if (!Number.isFinite(userId) || userId <= 0) throw new Error('query/token 未返回 userId');
  if (!Number.isFinite(schoolId) || schoolId <= 0) throw new Error('query/token 未返回 schoolId');
  return { studentId, userId, schoolId };
}

async function fetchSignTask(token, studentId) {
  const params = { studentId };
  const { data } = await apiRequest('GET', '/clubactivity/getSignInTf', { token, params });
  if (!isApiSuccess(data)) {
    throw new Error(data?.msg || data?.message || '获取签到任务失败');
  }
  const r = data.response;
  if (!r || typeof r !== 'object') return null;

  const activityId = Number(r.activityId);
  if (!Number.isFinite(activityId) || activityId <= 0) return null;

  return {
    activityId,
    latitude: String(r.latitude || ''),
    longitude: String(r.longitude || ''),
    signInStatus: r.signInStatus ?? null,
    signBackStatus: r.signBackStatus ?? null,
  };
}

function isSignedStatus(status) {
  return Number(status) === 1;
}

async function signInOrSignBack(token, studentId, signType) {
  const task = await fetchSignTask(token, studentId);
  if (!task) {
    throw new Error('当前没有可用的签到任务');
  }
  if (!task.latitude || !task.longitude) {
    throw new Error('任务缺少经纬度，无法签到/签退');
  }

  if (signType === '1') {
    if (isSignedStatus(task.signInStatus) && isSignedStatus(task.signBackStatus)) {
      throw new Error('已完成签到与签退，跳过');
    }
    if (isSignedStatus(task.signInStatus)) {
      throw new Error('已签到，跳过重复签到');
    }
  }
  if (signType === '2') {
    if (!isSignedStatus(task.signInStatus)) {
      throw new Error('尚未签到，无法签退');
    }
    if (isSignedStatus(task.signBackStatus)) {
      throw new Error('已签退，跳过重复签退');
    }
  }

  const body = {
    activityId: task.activityId,
    latitude: task.latitude,
    longitude: task.longitude,
    signType: String(signType),
    studentId: Number(studentId),
  };

  const { data } = await apiRequest('POST', '/clubactivity/signInOrSignBack', { token, body });
  if (!isApiSuccess(data)) {
    throw new Error(data?.msg || data?.message || `接口返回失败 code=${data?.code}`);
  }
  return data;
}

function extractList(response) {
  if (Array.isArray(response)) return response;
  if (!response || typeof response !== 'object') return [];
  const keys = ['records', 'list', 'rows', 'items', 'activityList'];
  for (const key of keys) {
    if (Array.isArray(response[key])) return response[key];
  }
  return [];
}

async function fetchClubActivities(token, { queryTime, schoolId, studentId, pageNo = 1, pageSize = 50 }) {
  const params = {
    pageNo: Number(pageNo) || 1,
    pageSize: Number(pageSize) || 50,
    queryTime: String(queryTime),
    schoolId: Number(schoolId),
    studentId: Number(studentId),
  };
  const { data } = await apiRequest('GET', '/clubactivity/queryActivityList', { token, params });
  if (!isApiSuccess(data)) {
    throw new Error(data?.msg || data?.message || '查询活动列表失败');
  }
  return extractList(data.response);
}

async function joinClubActivity(token, activityId, studentId) {
  const params = {
    activityId: Number(activityId),
    studentId: Number(studentId),
  };
  const { data } = await apiRequest('GET', '/clubactivity/joinClubActivity', { token, params });
  if (!isApiSuccess(data)) {
    throw new Error(data?.msg || data?.message || '报名失败');
  }
  return data;
}

async function loginByPhone(phone, passwordPlain) {
  const body = {
    appVersion: APP_VERSION,
    password: md5HexLower(passwordPlain),
    userPhone: phone,
    brand: 'Apple',
    deviceToken: '',
    deviceType: '2',
    mobileType: 'iPhone',
    sysVersion: '18.6',
  };
  const { data } = await apiRequest('POST', '/auth/login/password', { body, token: '' });
  if (!isApiSuccess(data)) {
    throw new Error(data?.msg || data?.message || '登录失败');
  }
  const u = data.response || {};
  const token = u.oauthToken?.token || u.token || '';
  const studentId = u.studentId ?? u.student_id;
  if (!token) throw new Error('登录返回中未找到 token');
  if (studentId == null || studentId === '') throw new Error('登录返回中未找到 studentId');
  return { token: String(token), studentId: Number(studentId) };
}

async function fetchRunStandard(token, schoolId) {
  const params = { schoolId: Number(schoolId) };
  const { data } = await apiRequest('GET', '/unirun/query/runStandard', { token, params });
  if (!isApiSuccess(data)) {
    throw new Error(data?.msg || data?.message || '获取跑步标准失败');
  }
  return data.response || {};
}

async function saveRunRecord(
  token,
  { trackPoints, runDistance, runTime, userId, recordDate, yearSemester, brand, mobileType, sysVersion },
) {
  const body = {
    againRunStatus: '0',
    againRunTime: 0,
    appVersions: APP_VERSION,
    brand: String(brand || 'Apple'),
    mobileType: String(mobileType || 'iPhone'),
    sysVersions: String(sysVersion || '18.6'),
    trackPoints: String(trackPoints || ''),
    distanceTimeStatus: '1',
    innerSchool: '1',
    runDistance: Math.round(Number(runDistance)),
    runTime: Math.round(Number(runTime)),
    userId: Number(userId),
    vocalStatus: '1',
    yearSemester: String(yearSemester),
    recordDate: String(recordDate),
  };
  const { data } = await apiRequest('POST', '/unirun/save/run/record/new', { token, body });
  if (!isApiSuccess(data)) {
    throw new Error(data?.msg || data?.message || `提交失败 code=${data?.code}`);
  }
  return data;
}

module.exports = {
  apiRequest,
  isApiSuccess,
  extractList,
  fetchStudentIdFromToken,
  fetchTokenProfile,
  fetchSignTask,
  signInOrSignBack,
  fetchClubActivities,
  joinClubActivity,
  fetchRunStandard,
  saveRunRecord,
  loginByPhone,
  getApiBase,
};
