/**
 * 将社团定时配置同步到自建后端（server + SQLite + cron，见 backend-club-sign-scheduler.md）。
 *
 * 方式一：`VITE_CLUB_SCHEDULER_BASE=http://127.0.0.1:8787`（需后端 CORS 已开；端口以 server 为准）
 * 方式二：开发时代理——`.env` 设 `VITE_CLUB_SCHEDULER_USE_DEV_PROXY=true`，并在 vite 中已配置 `/api/club-schedules` → 本机 server
 */
const trimBase = (base) => String(base || '').replace(/\/$/, '');

export function isClubSchedulerConfigured() {
  const base = trimBase(import.meta.env.VITE_CLUB_SCHEDULER_BASE);
  if (base) return true;
  return import.meta.env.VITE_CLUB_SCHEDULER_USE_DEV_PROXY === 'true';
}

export function resolveSchedulerBaseUrl() {
  const base = trimBase(import.meta.env.VITE_CLUB_SCHEDULER_BASE);
  if (base) return base;
  if (import.meta.env.VITE_CLUB_SCHEDULER_USE_DEV_PROXY === 'true') return '';
  return null;
}

/** @param {string} path 必须以 / 开头，如 /api/club-schedules */
export function schedulerUrl(path) {
  const base = resolveSchedulerBaseUrl();
  if (base === null) return '';
  const p = path.startsWith('/') ? path : `/${path}`;
  if (base === '') return p;
  return `${base}${p}`;
}

/**
 * @param {string} token - 与校园跑 API 相同的请求头 token
 * @param {{ enabled: boolean, autoExecute: boolean, signInTime: string, signBackTime: string }} schedule
 */
export async function syncClubScheduleToBackend(token, schedule) {
  if (!isClubSchedulerConfigured() || !token) return { skipped: true };

  const headers = {
    token: String(token),
    'Content-Type': 'application/json',
  };

  const cloudEnabled = !!(schedule.enabled && schedule.autoExecute);

  if (!cloudEnabled) {
    const res = await fetch(schedulerUrl('/api/club-schedules/me'), { method: 'DELETE', headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, message: data.message || res.statusText };
    return { ok: true, removed: true };
  }

  const tz =
    typeof Intl !== 'undefined' && Intl.DateTimeFormat
      ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
      : 'Asia/Shanghai';

  const res = await fetch(schedulerUrl('/api/club-schedules'), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      signInTime: schedule.signInTime,
      signOutTime: schedule.signBackTime,
      enabled: true,
      timezone: tz,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    return { ok: false, message: data.message || res.statusText };
  }
  return { ok: true, data };
}
