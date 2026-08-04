const { saveUserThread, getUserThread, listUserThreads } = require('./userManager');
const logger = require('./logger');

const STATES = {
  UNCLASSIFIED: 'UNCLASSIFIED',
  PROPOSED: 'PROPOSED',
  NEGOTIATING: 'NEGOTIATING',
  BOOKED: 'BOOKED',
  COMPLETED: 'COMPLETED',
  UNRESOLVED: 'UNRESOLVED',
  FLAGGED: 'FLAGGED',
  CANCELLED: 'CANCELLED'
};

const VALID_TRANSITIONS = {
  [STATES.UNCLASSIFIED]: [STATES.PROPOSED, STATES.FLAGGED, STATES.UNRESOLVED],
  [STATES.PROPOSED]: [STATES.NEGOTIATING, STATES.BOOKED, STATES.FLAGGED, STATES.UNRESOLVED, STATES.CANCELLED],
  [STATES.NEGOTIATING]: [STATES.BOOKED, STATES.PROPOSED, STATES.FLAGGED, STATES.UNRESOLVED, STATES.CANCELLED],
  [STATES.BOOKED]: [STATES.COMPLETED, STATES.CANCELLED, STATES.UNRESOLVED],
  [STATES.COMPLETED]: [],
  [STATES.UNRESOLVED]: [STATES.PROPOSED, STATES.BOOKED, STATES.COMPLETED],
  [STATES.FLAGGED]: [STATES.PROPOSED, STATES.BOOKED, STATES.UNRESOLVED, STATES.COMPLETED],
  [STATES.CANCELLED]: []
};

async function transitionThread(userEmail, threadId, targetState, metadata = {}) {
  const current = (await getUserThread(userEmail, threadId)) || {
    threadId,
    state: STATES.UNCLASSIFIED,
    history: []
  };

  const currentState = current.state || STATES.UNCLASSIFIED;
  const allowed = VALID_TRANSITIONS[currentState] || [];

  if (!allowed.includes(targetState) && currentState !== targetState) {
    await logger.warn('StateMachine', `Invalid transition ${currentState} -> ${targetState} for thread ${threadId}`);
  }

  const historyEntry = {
    from: currentState,
    to: targetState,
    timestamp: new Date().toISOString(),
    ...metadata
  };

  const updatedThread = {
    ...current,
    state: targetState,
    history: [...(current.history || []), historyEntry],
    lastUpdated: new Date().toISOString()
  };

  await saveUserThread(userEmail, threadId, updatedThread);
  return updatedThread;
}

async function checkThreadTimeouts(userEmail) {
  const threads = await listUserThreads(userEmail);
  const now = Date.now();
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  for (const thread of threads) {
    if ([STATES.PROPOSED, STATES.NEGOTIATING].includes(thread.state)) {
      const lastUpdated = new Date(thread.lastUpdated || 0).getTime();
      if (now - lastUpdated > SEVEN_DAYS_MS) {
        await transitionThread(userEmail, thread.threadId, STATES.UNRESOLVED, {
          reason: 'Auto-timed out after 7 days without response'
        });
      }
    }
  }
}

module.exports = {
  STATES,
  transitionThread,
  checkThreadTimeouts
};
