const cron = require('node-cron');
const axios = require('axios');
const logger = require('./logger');

/**
 * Start Keep-Alive self pinging cron job every 10 minutes
 */
function startKeepAlive(serverPort = 3000) {
  const targetUrl = process.env.RENDER_EXTERNAL_URL
    ? `${process.env.RENDER_EXTERNAL_URL}/health`
    : `http://localhost:${serverPort}/health`;

  // Schedule task every 10 minutes (* /10 * * * *)
  cron.schedule('*/10 * * * *', async () => {
    try {
      const res = await axios.get(targetUrl, { timeout: 5000 });
      await logger.info('KeepAlive', `Keep-alive ping sent to ${targetUrl} [Status: ${res.status}]`);
    } catch (err) {
      await logger.warn('KeepAlive', `Keep-alive ping failed: ${err.message}`);
    }
  });

  logger.info('KeepAlive', `Keep-alive scheduled for target: ${targetUrl}`);
}

module.exports = {
  startKeepAlive
};
