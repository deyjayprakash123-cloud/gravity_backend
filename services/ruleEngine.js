const { loadUserRules, saveUserRules } = require('./memory');

const DEFAULT_RULES = {
  workingHours: {
    start: '09:00',
    end: '17:00',
    timezone: 'America/New_York'
  },
  buffers: {
    beforeMinutes: 10,
    afterMinutes: 10
  },
  noMeetingDays: ['Saturday', 'Sunday'],
  maxMeetingsPerDay: 5,
  preferredDuration: 30,
  preferredTimes: [10, 11, 14, 15]
};

/**
 * Load user rules or return default
 */
async function getEffectiveRules() {
  const customRules = await loadUserRules();
  if (customRules) {
    return { ...DEFAULT_RULES, ...customRules };
  }
  return DEFAULT_RULES;
}

/**
 * Generate proposed rules based on 90-day calendar analysis
 */
function generateProposedRules(analysis, userTimezone = 'America/New_York') {
  return {
    workingHours: {
      start: analysis?.workingHours?.start || '09:00',
      end: analysis?.workingHours?.end || '17:00',
      timezone: userTimezone
    },
    buffers: {
      beforeMinutes: analysis?.suggestedBuffers?.beforeMinutes || 10,
      afterMinutes: analysis?.suggestedBuffers?.afterMinutes || 10
    },
    noMeetingDays: analysis?.noMeetingDays || ['Saturday', 'Sunday'],
    maxMeetingsPerDay: analysis?.suggestedMaxMeetingsPerDay || 5,
    preferredDuration: analysis?.preferredDuration || 30,
    preferredTimes: analysis?.preferredHours || [10, 11, 14, 15]
  };
}

/**
 * Check if a proposed time slot satisfies working hours, no-meeting days, and max daily meetings
 */
function isSlotWithinRules(slotStartISO, slotEndISO, existingCountToday, rules) {
  const start = new Date(slotStartISO);
  const end = new Date(slotEndISO);

  // 1. Check max meetings per day
  if (existingCountToday >= (rules.maxMeetingsPerDay || 5)) {
    return { valid: false, reason: 'Max daily meeting limit reached' };
  }

  // 2. Check no-meeting days
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = dayNames[start.getDay()];
  if ((rules.noMeetingDays || []).includes(dayName)) {
    return { valid: false, reason: `Day ${dayName} is a no-meeting day` };
  }

  // 3. Check working hours (in rule timezone or UTC local time)
  const startHoursStr = rules.workingHours?.start || '09:00';
  const endHoursStr = rules.workingHours?.end || '17:00';

  const [wStartH, wStartM] = startHoursStr.split(':').map(Number);
  const [wEndH, wEndM] = endHoursStr.split(':').map(Number);

  const slotStartMinutes = start.getHours() * 60 + start.getMinutes();
  const slotEndMinutes = end.getHours() * 60 + end.getMinutes();

  const ruleStartMinutes = wStartH * 60 + (wStartM || 0);
  const ruleEndMinutes = wEndH * 60 + (wEndM || 0);

  if (slotStartMinutes < ruleStartMinutes || slotEndMinutes > ruleEndMinutes) {
    return { valid: false, reason: 'Slot falls outside configured working hours' };
  }

  return { valid: true };
}

module.exports = {
  DEFAULT_RULES,
  getEffectiveRules,
  generateProposedRules,
  isSlotWithinRules
};
