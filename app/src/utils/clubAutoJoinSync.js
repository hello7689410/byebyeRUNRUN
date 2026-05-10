/**
 * 云端自动报名规则同步（见 自动报名技术方案.md），与社团定时共用 VITE_CLUB_SCHEDULER_BASE / USE_DEV_PROXY。
 */
import { isClubSchedulerConfigured, schedulerUrl } from './clubSchedulerSync';

function splitKeywords(text) {
  return String(text || '')
    .split(/[\n,，;；]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {string} token
 * @param {{
 *   enabled: boolean,
 *   areaKeywordsText: string,
 *   excludeKeywordsText: string,
 *   delayMinutes: number,
 *   maxDaysAhead: number,
 *   preferEarliest: boolean,
 * }} cfg
 * @param {number|null} schoolId
 */
export async function syncClubAutoJoinToBackend(token, cfg, schoolId) {
  if (!isClubSchedulerConfigured() || !token) return { skipped: true };

  if (!schoolId) {
    return { ok: false, message: '缺少 schoolId，无法同步自动报名' };
  }

  const headers = {
    token: String(token),
    'Content-Type': 'application/json',
  };

  if (!cfg.enabled) {
    const res = await fetch(schedulerUrl('/api/club-auto-join/me'), { method: 'DELETE', headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, message: data.message || res.statusText };
    return { ok: true, removed: true };
  }

  const areaKeywords = splitKeywords(cfg.areaKeywordsText);
  if (areaKeywords.length === 0) {
    return { ok: false, message: '请至少填写一个区域关键词后再开启自动报名' };
  }

  const tz =
    typeof Intl !== 'undefined' && Intl.DateTimeFormat
      ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
      : 'Asia/Shanghai';

  const res = await fetch(schedulerUrl('/api/club-auto-join'), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      schoolId,
      enabled: true,
      areaKeywords,
      excludeKeywords: splitKeywords(cfg.excludeKeywordsText),
      delayMinutes: Number(cfg.delayMinutes) || 60,
      maxDaysAhead: Number(cfg.maxDaysAhead) || 7,
      preferEarliest: cfg.preferEarliest !== false,
      timezone: tz,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    return { ok: false, message: data.message || res.statusText };
  }
  return { ok: true, data };
}
