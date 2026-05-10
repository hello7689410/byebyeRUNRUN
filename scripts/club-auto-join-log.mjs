#!/usr/bin/env node
/**
 * 查询云端自动报名执行日志（需 server 已配置 SCHEDULER_ADMIN_SECRET）
 *
 *   BYERUN_ADMIN_SECRET=xxx BYERUN_API_BASE=http://127.0.0.1:8787 node scripts/club-auto-join-log.mjs
 *   node scripts/club-auto-join-log.mjs --date 2026-05-09 --student-id 123
 *   node scripts/club-auto-join-log.mjs --json
 */
const base = (process.env.BYERUN_API_BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const secret = process.env.BYERUN_ADMIN_SECRET || process.env.SCHEDULER_ADMIN_SECRET || '';

function parseArgs() {
  const out = { date: '', studentId: '', json: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--date' && argv[i + 1]) {
      out.date = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--student-id' && argv[i + 1]) {
      out.studentId = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--json') {
      out.json = true;
    }
  }
  return out;
}

async function main() {
  if (!secret) {
    console.error('请设置 BYERUN_ADMIN_SECRET 或 SCHEDULER_ADMIN_SECRET');
    process.exit(1);
  }
  const { date, studentId, json } = parseArgs();
  const tz = process.env.TZ_QUERY || 'Asia/Shanghai';
  const qs = new URLSearchParams();
  qs.set('tz', tz);
  if (date) qs.set('date', date);
  if (studentId) qs.set('studentId', studentId);

  const url = `${base}/api/club-auto-join/runs/today?${qs.toString()}`;
  const res = await fetch(url, { headers: { 'X-Scheduler-Admin': secret } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(res.status, body);
    process.exit(1);
  }
  if (json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  console.log('today:', body.today);
  for (const r of body.runs || []) {
    console.log('---');
    console.log('student:', r.student_id, 'status:', r.status);
    console.log('message:', r.message);
    console.log('activity:', r.selected_activity_name, r.selected_activity_time, r.selected_activity_area);
    console.log('at:', r.created_at);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
