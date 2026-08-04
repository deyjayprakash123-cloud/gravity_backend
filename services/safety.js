const { getSchedulerState } = require('./memory');
const { transitionThread } = require('./stateMachine');
const { checkAutoResponderHeaders } = require('./gmailService');
const logger = require('./logger');

/**
 * Checks if incoming email is an auto-responder
 */
function isAutoResponder(headers = [], subject = '', body = '') {
  if (checkAutoResponderHeaders(headers)) return true;

  const combinedText = `${subject} ${body}`.toLowerCase();
  const autoReplyPatterns = [
    'out of office',
    'automatic reply',
    'auto-reply',
    'autoreply',
    'i am away',
    'on vacation',
    'currently out of the office',
    'do not reply'
  ];

  return autoReplyPatterns.some(pattern => combinedText.includes(pattern));
}

/**
 * Checks if message is duplicate within 5 minutes
 */
function isDuplicateEmail(messageId, body, threadHistory = []) {
  if (!threadHistory || threadHistory.length === 0) return false;

  const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000);

  return threadHistory.some(entry => {
    if (entry.messageId === messageId) return true;
    if (entry.body === body && new Date(entry.timestamp) > fiveMinsAgo) return true;
    return false;
  });
}

/**
 * Checks if thread has exceeded maximum turn limit (5 turns)
 */
function detectInfiniteLoop(threadHistory = []) {
  const exchanges = threadHistory.filter(h => h.action && h.action.includes('Sent reply'));
  return exchanges.length >= 5;
}

/**
 * Emergency stop check: system paused state or user sent "PAUSE SCHEDULER" email
 */
async function isEmergencyPaused(emailSubject = '', emailBody = '') {
  const state = await getSchedulerState();
  if (state && state.paused) return true;

  const text = `${emailSubject} ${emailBody}`.toUpperCase();
  if (text.includes('PAUSE SCHEDULER') || text.includes('STOP SCHEDULER')) {
    return true;
  }

  return false;
}

/**
 * Flags thread for human review
 */
async function flagThreadForHuman(threadId, reason, threadData = {}) {
  await logger.warn('Safety', `Flagging thread ${threadId} for human review: ${reason}`);
  return await transitionThread(threadId, 'FLAGGED', {
    flagReason: reason,
    needsAttention: true,
    ...threadData
  });
}

module.exports = {
  isAutoResponder,
  isDuplicateEmail,
  detectInfiniteLoop,
  isEmergencyPaused,
  flagThreadForHuman
};
