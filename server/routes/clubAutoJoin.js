const express = require('express');
const { DateTime } = require('luxon');
const { encryptToken } = require('../lib/tokenVault');
const { fetchStudentIdFromToken } = require('../lib/clubApi');
const { parseJsonKeywordArray } = require('../lib/clubAutoJoinEngine');

function extractToken(req) {
  const h = req.headers.token || req.headers.Token;
  if (h) return String(h).trim();
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return '';
}

function normalizeSchoolId(body) {
  const raw = body?.schoolId ?? body?.school_id;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function createClubAutoJoinRouter(db) {
  const router = express.Router();

  router.get('/me', async (req, res) => {
    try {
      const token = extractToken(req);
      if (!token) return res.status(401).json({ ok: false, message: '缺少 token 请求头' });

      const studentId = await fetchStudentIdFromToken(token);
      const row = db
        .prepare(
          `SELECT student_id, school_id, enabled, area_keywords, exclude_keywords,
                  delay_minutes, max_days_ahead, prefer_earliest, timezone, updated_at
           FROM club_auto_join_rules WHERE student_id = ?`,
        )
        .get(studentId);

      if (!row) {
        return res.json({ ok: true, rule: null });
      }

      return res.json({
        ok: true,
        rule: {
          studentId: row.student_id,
          schoolId: row.school_id,
          enabled: row.enabled === 1,
          areaKeywords: parseJsonKeywordArray(row.area_keywords),
          excludeKeywords: parseJsonKeywordArray(row.exclude_keywords),
          delayMinutes: row.delay_minutes,
          maxDaysAhead: row.max_days_ahead,
          preferEarliest: row.prefer_earliest === 1,
          timezone: row.timezone,
          updatedAt: row.updated_at,
        },
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
      const schoolId = normalizeSchoolId(req.body);
      if (!schoolId) {
        return res.status(400).json({ ok: false, message: '缺少有效的 schoolId' });
      }

      const areaKeywords = Array.isArray(req.body?.areaKeywords) ? req.body.areaKeywords : [];
      const excludeKeywords = Array.isArray(req.body?.excludeKeywords) ? req.body.excludeKeywords : [];
      const delayMinutes = Math.max(0, Math.min(24 * 60, Number(req.body?.delayMinutes ?? 60) || 60));
      const maxDaysAhead = Math.max(1, Math.min(30, Number(req.body?.maxDaysAhead ?? 7) || 7));
      const preferEarliest =
        req.body?.preferEarliest === false || req.body?.preferEarliest === 0 ? 0 : 1;
      const timezone = String(req.body?.timezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai';
      const enabled =
        req.body?.enabled === false ||
        req.body?.enabled === 0 ||
        req.body?.enabled === 'false' ||
        req.body?.enabled === '0'
          ? 0
          : 1;

      const areaEnc = JSON.stringify(areaKeywords.map((x) => String(x || '').trim()).filter(Boolean));
      const excludeEnc = JSON.stringify(excludeKeywords.map((x) => String(x || '').trim()).filter(Boolean));
      const tokenEnc = encryptToken(token);

      db.prepare(
        `INSERT INTO club_auto_join_rules
          (student_id, school_id, token_enc, enabled, area_keywords, exclude_keywords, delay_minutes, max_days_ahead, prefer_earliest, timezone, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(student_id) DO UPDATE SET
           school_id = excluded.school_id,
           token_enc = excluded.token_enc,
           enabled = excluded.enabled,
           area_keywords = excluded.area_keywords,
           exclude_keywords = excluded.exclude_keywords,
           delay_minutes = excluded.delay_minutes,
           max_days_ahead = excluded.max_days_ahead,
           prefer_earliest = excluded.prefer_earliest,
           timezone = excluded.timezone,
           updated_at = datetime('now')`,
      ).run(
        studentId,
        schoolId,
        tokenEnc,
        enabled,
        areaEnc,
        excludeEnc,
        delayMinutes,
        maxDaysAhead,
        preferEarliest,
        timezone,
      );

      return res.json({
        ok: true,
        studentId,
        schoolId,
        enabled: enabled === 1,
        delayMinutes,
        maxDaysAhead,
        preferEarliest: preferEarliest === 1,
      });
    } catch (e) {
      return res.status(400).json({ ok: false, message: e.message || String(e) });
    }
  });

  router.delete('/me', async (req, res) => {
    try {
      const token = extractToken(req);
      if (!token) return res.status(401).json({ ok: false, message: '缺少 token 请求头' });

      const studentId = await fetchStudentIdFromToken(token);
      const info = db.prepare('DELETE FROM club_auto_join_rules WHERE student_id = ?').run(studentId);
      return res.json({ ok: true, removed: info.changes || 0 });
    } catch (e) {
      return res.status(400).json({ ok: false, message: e.message || String(e) });
    }
  });

  router.get('/runs/today', (req, res) => {
    try {
      const secret = process.env.SCHEDULER_ADMIN_SECRET;
      if (!secret || req.headers['x-scheduler-admin'] !== secret) {
        return res.status(403).json({ ok: false, message: 'Forbidden' });
      }
      const tz = String(req.query.tz || 'Asia/Shanghai');
      const day = req.query.date ? String(req.query.date).slice(0, 10) : DateTime.now().setZone(tz).toFormat('yyyy-MM-dd');
      let rows;
      if (req.query.studentId) {
        const sid = Number(req.query.studentId);
        rows = db
          .prepare(
            `SELECT * FROM club_auto_join_runs WHERE run_date = ? AND student_id = ? ORDER BY created_at DESC`,
          )
          .all(day, sid);
      } else {
        rows = db.prepare(`SELECT * FROM club_auto_join_runs WHERE run_date = ? ORDER BY created_at DESC`).all(day);
      }
      return res.json({ ok: true, today: day, runs: rows });
    } catch (e) {
      return res.status(500).json({ ok: false, message: e.message || String(e) });
    }
  });

  return router;
}

module.exports = { createClubAutoJoinRouter };
