const { analyze90DayHistory } = require('./calendarService');
const { saveUserRules, saveUserTone } = require('./userManager');
const { setupGmailWatch } = require('./gmailService');
const logger = require('./logger');

const INDIAN_HOLIDAYS_2026 = [
  '2026-01-26',
  '2026-03-20',
  '2026-04-14',
  '2026-08-15',
  '2026-10-02',
  '2026-10-21',
  '2026-12-25'
];

async function initializeUserSetup(userEmail) {
  await logger.info('SetupService', `Starting setup analysis for user: ${userEmail}`);

  // 1. Run historical calendar analysis
  const calendarAnalysis = await analyze90DayHistory(userEmail);

  // 2. Draft recommended rules
  const proposedRules = {
    workingHours: {
      start: calendarAnalysis?.workingHours?.start || '09:30',
      end: calendarAnalysis?.workingHours?.end || '18:30',
      timezone: 'Asia/Kolkata'
    },
    buffers: {
      beforeMinutes: calendarAnalysis?.suggestedBuffers?.beforeMinutes || 15,
      afterMinutes: calendarAnalysis?.suggestedBuffers?.afterMinutes || 15
    },
    noMeetingDays: calendarAnalysis?.noMeetingDays || ['Saturday', 'Sunday'],
    holidays: INDIAN_HOLIDAYS_2026,
    maxMeetingsPerDay: calendarAnalysis?.suggestedMaxMeetingsPerDay || 6,
    preferredDuration: calendarAnalysis?.preferredDuration || 30,
    preferredTimes: calendarAnalysis?.preferredHours || [10, 11, 14, 15, 16],
    confirmed: false
  };

  await saveUserRules(userEmail, proposedRules);

  // 3. Draft default tone profile
  const defaultTone = {
    greeting: 'Hi',
    signOff: 'Best',
    formality: 5,
    samplePhrase: 'Thanks for reaching out! Here are a few times that work for me:'
  };
  await saveUserTone(userEmail, defaultTone);

  // 4. Register Gmail push notifications watch if configured
  const topicName = process.env.PUBSUB_TOPIC || process.env.GMAIL_PUBSUB_TOPIC;
  if (topicName) {
    try {
      await setupGmailWatch(userEmail, topicName);
    } catch (err) {
      await logger.warn('SetupService', `Watch setup warning for ${userEmail}: ${err.message}`);
    }
  }

  await logger.info('SetupService', `Completed setup initialization for ${userEmail}`);

  return {
    success: true,
    userEmail,
    rules: proposedRules,
    tone: defaultTone,
    analysis: calendarAnalysis
  };
}

module.exports = {
  initializeUserSetup
};
