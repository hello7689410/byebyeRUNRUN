#!/usr/bin/env node
/**
 * 社团活动自动签到 / 签退（服务端定时，无需人工确认）
 *
 * 与前端 useApi.signInOrSignBack 一致：POST /clubactivity/signInOrSignBack
 * 需携带 token、appKey、sign（MD5 签名规则与 app/src/utils/sign.js 相同）
 *
 * 用法 A — 常驻进程（按本地时钟等到指定时刻执行）：
 *   BYERUN_PHONE=... BYERUN_PASSWORD=... BYERUN_SIGN_IN=07:58 BYERUN_SIGN_OUT=08:26 node scripts/club-auto-sign.mjs
 *
 * 用法 B — 单次执行（适合 Linux cron / Windows 任务计划程序分别约在签到、签退时刻各跑一次）：
 *   BYERUN_TOKEN=... node scripts/club-auto-sign.mjs --once 1   # 签到
 *   BYERUN_TOKEN=... node scripts/club-auto-sign.mjs --once 2   # 签退
 *
 * 环境变量：
 *   BYERUN_API_BASE   默认 https://run-lb.tanmasports.com/v1
 *   BYERUN_APP_KEY    默认与 app 内一致
 *   BYERUN_APP_SECRET 默认与 app 内一致
 *   BYERUN_TOKEN      登录后的 token（与浏览器请求头 token 一致）；若不填则用手机号密码登录
 *   BYERUN_PHONE / BYERUN_PASSWORD  登录用（密码为明文，脚本内会做 MD5）
 *   BYERUN_STUDENT_ID 可选；不填则从登录接口返回里取
 *   BYERUN_SIGN_IN / BYERUN_SIGN_OUT  HH:mm，常驻模式必填
 *
 * 安全：不要把密码写进仓库；可用 export / 系统环境变量 / systemd EnvironmentFile。
 */

import crypto from 'node:crypto';

const APP_VERSION = '1.8.3';
const DEFAULT_APP_KEY = '389885588s0648fa';
const DEFAULT_APP_SECRET = '56E39A1658455588885690425C0FD16055A21676';

function md5HexLower(s) {
  return crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
}

function md5SignUpper(signStr) {
  return crypto.createHash('md5').update(signStr, 'utf8').digest('hex').toUpperCase();
}

/** 与 app/src/utils/sign.js 一致 */
function genSign(query, body) {
  const appKey = process.env.BYERUN_APP_KEY || DEFAULT_APP_KEY;
  const appSecret = process.env.BYERUN_APP_SECRET || DEFAULT_APP_SECRET;
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
  const appKey = process.env.BYERUN_APP_KEY || DEFAULT_APP_KEY;
  return {
    appKey,
    'Content-Type': 'application/json',
    token: token || '',
    sign: genSign(params ?? null, body ?? null),
  };
}

async function apiRequest(method, path, { token, params, body } = {}) {
  const base = getApiBase();
  const url = new URL(path.startsWith('/') ? path.slice(1) : path, base + '/');

  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && `${v}` !== '') url.searchParams.set(k, String(v));
    }
  }

  const headers = buildHeaders({ token, params: method === 'GET' ? params : null, body: method !== 'GET' ? body : null });

  const init = {
    method,
    headers,
  };
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

async function login(phone, passwordPlain) {
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

function parseHHMM(s) {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const min = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return { h, min };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sleepUntil(targetDate) {
  const ms = targetDate.getTime() - Date.now();
  if (ms > 0) await sleep(ms);
}

function todayAt(hhmm, baseDate = new Date()) {
  const p = parseHHMM(hhmm);
  if (!p) return null;
  const d = new Date(baseDate);
  d.setHours(p.h, p.min, 0, 0);
  return d;
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function resolveAuth() {
  let token = process.env.BYERUN_TOKEN?.trim();
  let studentId = process.env.BYERUN_STUDENT_ID ? Number(process.env.BYERUN_STUDENT_ID) : null;

  if (token) {
    if (!studentId || !Number.isFinite(studentId) || studentId <= 0) {
      log('仅有 BYERUN_TOKEN，正在请求 /auth/query/token 获取 studentId…');
      studentId = await fetchStudentIdFromToken(token);
    }
    return { token, studentId };
  }

  const phone = process.env.BYERUN_PHONE?.trim();
  const password = process.env.BYERUN_PASSWORD;
  if (!phone || password == null || password === '') {
    throw new Error('请设置 BYERUN_TOKEN（可选 BYERUN_STUDENT_ID），或 BYERUN_PHONE + BYERUN_PASSWORD');
  }

  log('使用手机号登录…');
  const logged = await login(phone, password);
  token = logged.token;
  studentId = logged.studentId;

  if (process.env.BYERUN_STUDENT_ID) {
    const override = Number(process.env.BYERUN_STUDENT_ID);
    if (Number.isFinite(override) && override > 0) studentId = override;
  }

  return { token, studentId };
}

async function runOnce(signType) {
  const { token, studentId } = await resolveAuth();
  log(`执行 signType=${signType} studentId=${studentId}`);
  const data = await signInOrSignBack(token, studentId, signType);
  log('成功:', JSON.stringify(data?.response ?? data?.msg ?? data));
}

async function trySign(token, studentId, signType, label) {
  try {
    await signInOrSignBack(token, studentId, signType);
    log(`${label}成功`);
  } catch (e) {
    log(`${label}失败:`, e.message);
  }
}

async function runDaemon(signInHHMM, signOutHHMM) {
  if (!parseHHMM(signInHHMM) || !parseHHMM(signOutHHMM)) {
    throw new Error('BYERUN_SIGN_IN / BYERUN_SIGN_OUT 须为 HH:mm，例如 07:58');
  }

  const { token, studentId } = await resolveAuth();
  log(`常驻模式 studentId=${studentId} 签到=${signInHHMM} 签退=${signOutHHMM}`);

  const dummy = new Date();
  const a = todayAt(signInHHMM, dummy);
  const b = todayAt(signOutHHMM, dummy);
  if (b.getTime() <= a.getTime()) {
    throw new Error('签退时间必须晚于签到时间（同一天内）');
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const now = Date.now();
    const cal = new Date();
    const signInToday = todayAt(signInHHMM, cal);
    const signOutToday = todayAt(signOutHHMM, cal);

    if (now >= signOutToday.getTime()) {
      const nextDay = new Date(cal.getFullYear(), cal.getMonth(), cal.getDate() + 1);
      const nextSignIn = todayAt(signInHHMM, nextDay);
      await sleepUntil(nextSignIn);
      await trySign(token, studentId, '1', '签到');
      const signOutSameDay = todayAt(signOutHHMM, nextSignIn);
      await sleepUntil(signOutSameDay);
      await trySign(token, studentId, '2', '签退');
      continue;
    }

    if (now < signInToday.getTime()) {
      await sleepUntil(signInToday);
      await trySign(token, studentId, '1', '签到');
      await sleepUntil(signOutToday);
      await trySign(token, studentId, '2', '签退');
      continue;
    }

    await trySign(token, studentId, '1', '签到(已过签到点，立即尝试)');
    await sleepUntil(signOutToday);
    await trySign(token, studentId, '2', '签退');
  }
}

function parseArgs(argv) {
  const idx = argv.indexOf('--once');
  if (idx >= 0 && argv[idx + 1]) {
    const t = String(argv[idx + 1]).trim();
    if (t === '1' || t === '2') return { mode: 'once', signType: t };
    throw new Error('--once 参数须为 1（签到）或 2（签退）');
  }
  return { mode: 'daemon' };
}

const { mode, signType } = parseArgs(process.argv.slice(2));

try {
  if (mode === 'once') {
    await runOnce(signType);
    process.exit(0);
  }

  const signIn = process.env.BYERUN_SIGN_IN;
  const signOut = process.env.BYERUN_SIGN_OUT;
  if (!signIn || !signOut) {
    console.error('常驻模式需要 BYERUN_SIGN_IN 与 BYERUN_SIGN_OUT（HH:mm）');
    process.exit(1);
  }
  await runDaemon(signIn, signOut);
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
