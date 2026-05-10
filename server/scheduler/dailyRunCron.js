const cron = require('node-cron');
const { maybeRunDailySubmit } = require('../lib/dailyRunEngine');

function startDailyRunCron(db, logger) {
  const log = logger?.info?.bind(logger) || console.log;
  const job = cron.schedule('* * * * *', () => {
    void (async () => {
      const rules = db.prepare('SELECT * FROM daily_run_rules WHERE enabled = 1').all();
      for (const rule of rules) {
        try {
          await maybeRunDailySubmit(db, logger, rule);
        } catch (e) {
          log(`[daily-run-cron] rule ${rule.id} error: ${e.message || e}`);
        }
      }
    })();
  });
  log('[cron] daily run scheduler started');
  return job;
}

module.exports = { startDailyRunCron };

