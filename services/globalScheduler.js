const cron = require('node-cron');
const { getAllUsers, getUserRules, getUserState } = require('./userManager');
const { checkForNewEmails, setupGmailWatch } = require('./gmailService');
const { processEmail } = require('./emailProcessor');
const { checkThreadTimeouts, cleanupOldThreads } = require('./stateMachine');
const logger = require('./logger');

async function startGlobalScheduler() {
  await logger.info('GlobalScheduler', 'Starting global multi-user scheduler tasks');

  // 1. Every 2 minutes: Check unread emails for all active confirmed users
  cron.schedule('*/2 * * * *', async () => {
    try {
      const users = await getAllUsers();
      for (const userEmail of users) {
        try {
          const rules = await getUserRules(userEmail);
          if (!rules || !rules.confirmed) continue;

          const state = await getUserState(userEmail);
          if (state.paused) continue;

          const newEmails = await checkForNewEmails(userEmail);
          if (newEmails && newEmails.length > 0) {
            await logger.info('GlobalScheduler', `Found ${newEmails.length} unread emails for ${userEmail}`);
            for (const msg of newEmails) {
              await processEmail(userEmail, msg.id);
            }
          }

          // Check thread timeouts (7 days)
          await checkThreadTimeouts(userEmail);
        } catch (userErr) {
          // Individual user errors do not stop loop
        }
      }
    } catch (err) {
      console.error('GlobalScheduler 2-min job error:', err);
    }
  });

  // 2. Every 7 days: Renew Gmail push notification watch for all users
  cron.schedule('0 0 */7 * *', async () => {
    try {
      const topicName = process.env.PUBSUB_TOPIC;
      if (!topicName) return;

      const users = await getAllUsers();
      for (const userEmail of users) {
        await setupGmailWatch(userEmail, topicName);
      }
    } catch (err) {
      console.error('GlobalScheduler 7-day watch renewal error:', err);
    }
  });

  // 3. Every 24 hours: Cleanup old completed threads
  cron.schedule('0 0 * * *', async () => {
    try {
      const users = await getAllUsers();
      for (const userEmail of users) {
        await cleanupOldThreads(userEmail);
      }
    } catch (err) {
      console.error('GlobalScheduler 24h cleanup error:', err);
    }
  });
}

module.exports = {
  startGlobalScheduler
};
