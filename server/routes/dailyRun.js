const express = require('express');
const { DateTime } = require('luxon');
const { encryptToken } = require('../lib/tokenVault');
const { fetchTokenProfile } = require('../lib/clubApi');
const { parseCronMinuteHour } = require('../lib/dailyRunEngine');

function extractToken(req) {
  const h = req.headers.token || req.headers.Token;
  if (h) return String(h).trim();
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return '';
}

function normalizeDistance(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const v = Math.trunc(n);
  if (v < 100 || v > 50000) return null;
  return v;
}

function normalizeCron(body) {
  if (body?.cron) {
    const cron = String(body.cron).trim();
    if (parseCronMinuteHour(cron)) return cron;
  }
  const hour = Number(body?.hour);
  const minute = Number(body?.minute);
  if (Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
    return `${minute} ${hour} * * *`;
  }
  return null;
}

function createDailyRunRouter(db) {
  const router = express.Router();

  router.get('/me', async (req, res) => {
    try {
      const token = extractToken(req);
      if (!token) return res.status(401).json({ ok: false, message: '缺少 token 请求头' });

      const profile = await fetchTokenProfile(token);
      const row = db
        .prepare(
          `SELECT student_id, school_id, map_id, distance_m, cron_expr, timezone, enabled, updated_at
           FROM daily_run_rules WHERE student_id = ?`,
        )
        .get(profile.studentId);
      if (!row) return res.json({ ok: true, rule: null });

      const tz = String(row.timezone || 'Asia/Shanghai');
      const day = DateTime.now().setZone(tz).toFormat('yyyy-MM-dd');
      const todayRun = db
        .prepare(`SELECT run_date, status, message, created_at FROM daily_run_runs WHERE rule_id = ? AND run_date = ?`)
        .get(
          db.prepare('SELECT id FROM daily_run_rules WHERE student_id = ?').get(profile.studentId).id,
          day,
        );
      return res.json({
        ok: true,
        rule: {
          studentId: row.student_id,
          schoolId: row.school_id,
          mapId: row.map_id,
          distance: row.distance_m,
          cron: row.cron_expr,
          timezone: row.timezone,
          enabled: row.enabled === 1,
          updatedAt: row.updated_at,
        },
        todayRun: todayRun || null,
      });
    } catch (e) {
      return res.status(400).json({ ok: false, message: e.message || String(e) });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const token = extractToken(req);
      if (!token) return res.status(401).json({ ok: false, message: '缺少 token 请求头' });

      const profile = await fetchTokenProfile(token);
      const mapId = String(req.body?.mapId ?? req.body?.map_id ?? '').trim();
      if (!mapId) return res.status(400).json({ ok: false, message: '缺少 mapId' });
      const distance = normalizeDistance(req.body?.distance ?? req.body?.distance_m);
      if (!distance) return res.status(400).json({ ok: false, message: 'distance 无效（100~50000）' });
      const cronExpr = normalizeCron(req.body);
      if (!cronExpr) return res.status(400).json({ ok: false, message: 'cron/hour/minute 配置无效' });
      const timezone = String(req.body?.timezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai';
      const enabled =
        req.body?.enabled === false || req.body?.enabled === 0 || req.body?.enabled === 'false' || req.body?.enabled === '0'
          ? 0
          : 1;
      const tokenEnc = encryptToken(token);

      db.prepare(
        `INSERT INTO daily_run_rules
         (student_id, token_enc, school_id, map_id, distance_m, cron_expr, timezone, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(student_id) DO UPDATE SET
           token_enc = excluded.token_enc,
           school_id = excluded.school_id,
           map_id = excluded.map_id,
           distance_m = excluded.distance_m,
           cron_expr = excluded.cron_expr,
           timezone = excluded.timezone,
           enabled = excluded.enabled,
           updated_at = datetime('now')`,
      ).run(profile.studentId, tokenEnc, profile.schoolId, mapId, distance, cronExpr, timezone, enabled);

      return res.json({
        ok: true,
        rule: {
          studentId: profile.studentId,
          schoolId: profile.schoolId,
          mapId,
          distance,
          cron: cronExpr,
          timezone,
          enabled: enabled === 1,
        },
      });
    } catch (e) {
      return res.status(400).json({ ok: false, message: e.message || String(e) });
    }
  });

  router.delete('/me', async (req, res) => {
    try {
      const token = extractToken(req);
      if (!token) return res.status(401).json({ ok: false, message: '缺少 token 请求头' });
      const profile = await fetchTokenProfile(token);
      const info = db.prepare('DELETE FROM daily_run_rules WHERE student_id = ?').run(profile.studentId);
      return res.json({ ok: true, removed: info.changes || 0 });
    } catch (e) {
      return res.status(400).json({ ok: false, message: e.message || String(e) });
    }
  });

  router.get('/runs/today', async (req, res) => {
    try {
      const secret = process.env.SCHEDULER_ADMIN_SECRET;
      if (!secret || req.headers['x-scheduler-admin'] !== secret) {
        return res.status(403).json({ ok: false, message: 'Forbidden' });
      }
      const tz = String(req.query.tz || 'Asia/Shanghai');
      const day = req.query.date ? String(req.query.date).slice(0, 10) : DateTime.now().setZone(tz).toFormat('yyyy-MM-dd');
      const rows = db.prepare(`SELECT * FROM daily_run_runs WHERE run_date = ? ORDER BY created_at DESC`).all(day);
      return res.json({ ok: true, today: day, runs: rows });
    } catch (e) {
      return res.status(500).json({ ok: false, message: e.message || String(e) });
    }
  });

  return router;
}

module.exports = { createDailyRunRouter };

