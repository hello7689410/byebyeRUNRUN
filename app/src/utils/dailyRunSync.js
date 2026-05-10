import { isClubSchedulerConfigured, schedulerUrl } from './clubSchedulerSync';

function parseJsonSafe(res) {
  return res.json().catch(() => ({}));
}

export async function getDailyRunRule(token) {
  if (!isClubSchedulerConfigured() || !token) return { skipped: true };
  const res = await fetch(schedulerUrl('/api/daily-run/me'), {
    method: 'GET',
    headers: { token: String(token) },
  });
  const data = await parseJsonSafe(res);
  if (!res.ok || data?.ok === false) {
    return { ok: false, message: data.message || res.statusText };
  }
  return data;
}

export async function saveDailyRunRule(token, payload) {
  if (!isClubSchedulerConfigured() || !token) return { skipped: true };
  const res = await fetch(schedulerUrl('/api/daily-run'), {
    method: 'POST',
    headers: {
      token: String(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await parseJsonSafe(res);
  if (!res.ok || data?.ok === false) {
    return { ok: false, message: data.message || res.statusText };
  }
  return data;
}

export async function removeDailyRunRule(token) {
  if (!isClubSchedulerConfigured() || !token) return { skipped: true };
  const res = await fetch(schedulerUrl('/api/daily-run/me'), {
    method: 'DELETE',
    headers: { token: String(token) },
  });
  const data = await parseJsonSafe(res);
  if (!res.ok || data?.ok === false) {
    return { ok: false, message: data.message || res.statusText };
  }
  return data;
}

