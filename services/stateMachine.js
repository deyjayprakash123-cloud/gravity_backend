const { loadThreadState, saveThreadState, listAllThreads, deleteThread } = require('./memory');
const logger = require('./logger');

const VALID_STATES = {
  UNCLASSIFIED: 'UNCLASSIFIED',
  PROPOSED: 'PROPOSED',
  NEGOTIATING: 'NEGOTIATING',
  BOOKED: 'BOOKED',
  UNRESOLVED: 'UNRESOLVED',
  FLAGGED: 'FLAGGED'
};

const ALLOWED_TRANSITIONS = {
  UNCLASSIFIED: ['PROPOSED', 'FLAGGED', 'UNRESOLVED'],
  PROPOSED: ['NEGOTIATING', 'BOOKED', 'PROPOSED', 'FLAGGED', 'UNRESOLVED'],
  NEGOTIATING: ['PROPOSED', 'BOOKED', 'FLAGGED', 'UNRESOLVED'],
  FLAGGED: ['PROPOSED', 'BOOKED', 'UNRESOLVED'],
  UNRESOLVED: ['PROPOSED', 'BOOKED', 'FLAGGED'],
  BOOKED: [] // Terminal state
};

/**
 * Transition thread state with validation and persistence
 */
async function transitionThread(threadId, newState, updatePayload = {}) {
  if (!VALID_STATES[newState]) {
    throw new Error(`Invalid target state: ${newState}`);
  }

  let thread = await loadThreadState(threadId);

  if (!thread) {
    // New thread state initialization
    thread = {
      threadId,
      state: VALID_STATES.UNCLASSIFIED,
      history: [],
      createdAt: new Date().toISOString()
    };
  }

  const currentState = thread.state || VALID_STATES.UNCLASSIFIED;

  // Check valid transition
  if (currentState !== newState && ALLOWED_TRANSITIONS[currentState] && !ALLOWED_TRANSITIONS[currentState].includes(newState)) {
    await logger.warn('StateMachine', `Direct transition from ${currentState} to ${newState} not allowed for thread ${threadId}`);
  }

  // Update thread fields
  const updatedHistory = thread.history || [];
  updatedHistory.push({
    fromState: currentState,
    toState: newState,
    timestamp: new Date().toISOString(),
    action: updatePayload.action || `Transitioned to ${newState}`,
    note: updatePayload.note || null
  });

  const updatedThread = {
    ...thread,
    ...updatePayload,
    state: newState,
    history: updatedHistory,
    lastUpdated: new Date().toISOString()
  };

  await saveThreadState(threadId, updatedThread);
  await logger.info('StateMachine', `Thread ${threadId} state: ${currentState} -> ${newState}`);

  return updatedThread;
}

/**
 * Cleanup threads older than 30 days in BOOKED state
 */
async function cleanupOldThreads() {
  try {
    const allThreads = await listAllThreads();
    const now = new Date();
    const maxAgeMs = 30 * 24 * 60 * 60 * 1000;

    let count = 0;
    for (const thread of allThreads) {
      if (thread.state === VALID_STATES.BOOKED && thread.lastUpdated) {
        const age = now.getTime() - new Date(thread.lastUpdated).getTime();
        if (age > maxAgeMs) {
          await deleteThread(thread.threadId);
          count++;
        }
      }
    }
    if (count > 0) {
      await logger.info('StateMachine', `Cleaned up ${count} old completed threads`);
    }
  } catch (err) {
    await logger.error('StateMachine', 'Error cleaning up old threads', err.message);
  }
}

module.exports = {
  VALID_STATES,
  transitionThread,
  cleanupOldThreads
};
