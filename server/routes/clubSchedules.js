const express = require('express');
const { DateTime } = require('luxon');
const { encryptToken } = require('../lib/tokenVault');
const { fetchStudentIdFromToken } = require('../lib/clubApi');

function normalizeHHMM(value) {
  const m = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const min = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function extractToken(req) {
  const h = req.headers.token || req.headers.Token;
  if (h) return String(h).trim();
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return '';
}

function createClubSchedulesRouter(db) {
  const router = express.Router();

  router.get('/me', async (req, res) => {
    try {
      const token = extractToken(req);
      if (!token) return res.status(401).json({ ok: false, message: '缺少 token 请求头' });

      const studentId = await fetchStudentIdFromToken(token);
      const row = db
        .prepare(
          `SELECT student_id, sign_in_time, sign_out_time, timezone, enabled, updated_at
           FROM club_sign_schedules WHERE student_id = ?`,
        )
        .get(studentId);

      return res.json({
        ok: true,
        schedule: row
          ? {
              studentId: row.student_id,
              signInTime: row.sign_in_time,
              signOutTime: row.sign_out_time,
              timezone: row.timezone,
              enabled: row.enabled === 1,
              updatedAt: row.updated_at,
            }
          : null,
      });
    } catch (e) {
      return res.status(400).json({ ok: false, message: e.message || String(e) });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const token = extractToken(req);
      if (!token) return res.status(401).json({ ok: false, message: '缺少 token 请求头' });

      const studentId = await fetchStudentIdFromToken(token);
      const signInTime = normalizeHHMM(req.body?.signInTime ?? req.body?.sign_in_time);
      const signOutTime = normalizeHHMM(req.body?.signOutTime ?? req.body?.sign_out_time);
      const timezone = String(req.body?.timezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai';
      const enabled =
        req.body?.enabled === false ||
        req.body?.enabled === 0 ||
        req.body?.enabled === 'false' ||
        req.body?.enabled === '0'
          ? 0
          : 1;

      if (!signInTime || !signOutTime) {
        return res.status(400).json({ ok: false, message: 'signInTime / signOutTime 须为 HH:mm' });
      }

      const tokenEnc = encryptToken(token);

      db.prepare(
        `INSERT INTO club_sign_schedules
          (student_id, token_enc, sign_in_time, sign_out_time, timezone, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(student_id) DO UPDATE SET
           token_enc = excluded.token_enc,
           sign_in_time = excluded.sign_in_time,
           sign_out_time = excluded.sign_out_time,
           timezone = excluded.timezone,
           enabled = excluded.enabled,
           updated_at = datetime('now')`,
      ).run(studentId, tokenEnc, signInTime, signOutTime, timezone, enabled);

      return res.json({ ok: true, studentId, signInTime, signOutTime, timezone, enabled: enabled === 1 });
    } catch (e) {
      return res.status(400).json({ ok: false, message: e.message || String(e) });
    }
  });

  router.delete('/me', async (req, res) => {
    try {
      const token = extractToken(req);
      if (!token) return res.status(401).json({ ok: false, message: '缺少 token 请求头' });

      const studentId = await fetchStudentIdFromToken(token);
      const info = db.prepare('DELETE FROM club_sign_schedules WHERE student_id = ?').run(studentId);
      return res.json({ ok: true, removed: info.changes || 0 });
    } catch (e) {
      return res.status(400).json({ ok: false, message: e.message || String(e) });
    }
  });

  /** 管理用途：列出今日执行记录（可选 query studentId） */
  router.get('/runs/today', (req, res) => {
    try {
      const secret = process.env.SCHEDULER_ADMIN_SECRET;
      if (!secret || req.headers['x-scheduler-admin'] !== secret) {
        return res.status(403).json({ ok: false, message: 'Forbidden' });
      }
      const tz = String(req.query.tz || 'Asia/Shanghai');
      const today = DateTime.now().setZone(tz).toFormat('yyyy-MM-dd');
      let rows;
      if (req.query.studentId) {
        const sid = Number(req.query.studentId);
        rows = db
          .prepare(
            `SELECT r.* FROM club_sign_runs r
             JOIN club_sign_schedules s ON s.id = r.schedule_id
             WHERE r.run_date = ? AND s.student_id = ?
             ORDER BY r.created_at DESC`,
          )
          .all(today, sid);
      } else {
        rows = db
          .prepare(`SELECT * FROM club_sign_runs WHERE run_date = ? ORDER BY created_at DESC`)
          .all(today);
      }
      return res.json({ ok: true, today, runs: rows });
    } catch (e) {
      return res.status(500).json({ ok: false, message: e.message || String(e) });
    }
  });

  return router;
}

module.exports = { createClubSchedulesRouter };
