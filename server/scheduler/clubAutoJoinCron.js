const cron = require('node-cron');
const { maybeRunAutoJoin } = require('../lib/clubAutoJoinEngine');

function startClubAutoJoinCron(db, logger) {
  const log = logger?.info?.bind(logger) || console.log;

  const job = cron.schedule('* * * * *', () => {
    void (async () => {
      const rules = db.prepare('SELECT * FROM club_auto_join_rules WHERE enabled = 1').all();
      for (const rule of rules) {
        try {
          await maybeRunAutoJoin(db, logger, rule);
        } catch (e) {
          log(`[auto-join-cron] rule ${rule.id} error: ${e.message || e}`);
        }
      }
    })();
  });

  log('[cron] club auto-join scheduler started');
  return job;
}

module.exports = { startClubAutoJoinCron };
