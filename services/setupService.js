const { analyze90DayHistory } = require('./calendarService');
const { generateProposedRules, getEffectiveRules } = require('./ruleEngine');
const { saveUserRules, saveToneProfile, saveThreadState, loadThreadState } = require('./memory');
const { sendReply, setupGmailWatch } = require('./gmailService');
const logger = require('./logger');

/**
 * Execute initial onboarding scan and generate recommended rules
 */
async function initializeUserSetup(userEmail) {
  await logger.info('SetupService', `Starting setup analysis for user: ${userEmail}`);

  // 1. Run 90-day calendar analysis
  const calendarAnalysis = await analyze90DayHistory();

  // 2. Generate proposed rules
  const proposedRules = generateProposedRules(calendarAnalysis);

  // 3. Save initial rules as draft/confirmed
  await saveUserRules(proposedRules);

  // 4. Default proposed tone
  const defaultTone = {
    greeting: 'Hi',
    signOff: 'Best',
    formality: 5,
    samplePhrase: 'Thanks for reaching out! Here are a few times that work for me:'
  };
  await saveToneProfile(defaultTone);

  // 5. Attempt watch setup if topic provided
  if (process.env.GMAIL_PUBSUB_TOPIC) {
    try {
      await setupGmailWatch(process.env.GMAIL_PUBSUB_TOPIC);
    } catch (err) {
      await logger.warn('SetupService', 'Could not enable Pub/Sub watch during setup', err.message);
    }
  }

  await logger.info('SetupService', 'User setup initialized successfully');

  return {
    success: true,
    rules: proposedRules,
    tone: defaultTone,
    analysis: calendarAnalysis
  };
}

module.exports = {
  initializeUserSetup
};
