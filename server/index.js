require('dotenv').config();

const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: fetchFn }) => fetchFn(...args));
const morgan = require('morgan');
const { createLogger, transports, format } = require('winston');
const { initDb } = require('./db/initDb');
const { createClubSchedulesRouter } = require('./routes/clubSchedules');
const { createClubAutoJoinRouter } = require('./routes/clubAutoJoin');
const { createDailyRunRouter } = require('./routes/dailyRun');
const { startClubSignCron } = require('./scheduler/clubSignCron');
const { startClubAutoJoinCron } = require('./scheduler/clubAutoJoinCron');
const { startDailyRunCron } = require('./scheduler/dailyRunCron');

const app = express();
/** 默认 8787（避开 Windows 动态保留端口段）；可用 PORT 覆盖 */
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';

const logger = createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp(),
    format.printf(({ timestamp, level, message }) => {
      return `${timestamp} ${level}: ${message}`;
    }),
  ),
  transports: [new transports.Console(), new transports.File({ filename: 'combined.log' })],
});

app.use(morgan('combined', { stream: { write: (message) => logger.info(message.trim()) } }));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

/** CORS：定时配置 API 需被前端跨域调用（见 backend-club-sign-scheduler.md） */
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, token, Token, X-Scheduler-Admin, X-Requested-With',
};

app.use((req, res, next) => {
  Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

(async () => {
  let db;
  try {
    db = await initDb(logger);
  } catch (e) {
    logger.error(`DB init failed: ${e.message}`);
    process.exit(1);
  }

  app.use('/api/club-schedules', createClubSchedulesRouter(db));
  app.use('/api/club-auto-join', createClubAutoJoinRouter(db));
  app.use('/api/daily-run', createDailyRunRouter(db));

  app.all('*', async (req, res) => {
    const url = new URL(req.originalUrl, `http://${req.headers.host}`);
    const backendUrl = 'https://run-lb.tanmasports.com/v1' + url.pathname + url.search;

    logger.info(`Forwarding request to: ${backendUrl}`);

    const newHeaders = { ...req.headers };
    delete newHeaders.host;

    const init = {
      method: req.method,
      headers: newHeaders,
      body: req.method === 'GET' ? null : JSON.stringify(req.body),
    };

    try {
      const response = await fetch(backendUrl, init);
      const body = await response.text();

      Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));
      res.status(response.status).send(body);
    } catch (error) {
      logger.error(`Error during fetch: ${error.message}`);
      res.status(500).send('Internal Server Error');
    }
  });

  app.listen(port, host, () => {
    logger.info(`Server is running on http://${host}:${port}`);
    try {
      startClubSignCron(db, logger);
      startClubAutoJoinCron(db, logger);
      startDailyRunCron(db, logger);
    } catch (e) {
      logger.error(`Scheduler failed to start: ${e.message}`);
    }
  });
})();
