const { loadUserRules, saveUserRules } = require('./memory');

const DEFAULT_RULES = {
  workingHours: {
    start: '09:30',
    end: '18:30',
    timezone: 'Asia/Kolkata'
  },
  buffers: {
    beforeMinutes: 15,
    afterMinutes: 15
  },
  noMeetingDays: ['Saturday', 'Sunday'],
  holidays: [
    '2026-01-26', // Republic Day
    '2026-03-20', // Holi
    '2026-04-14', // Ambedkar Jayanti
    '2026-08-15', // Independence Day
    '2026-10-02', // Gandhi Jayanti
    '2026-10-21', // Diwali
    '2026-12-25'  // Christmas
  ],
  maxMeetingsPerDay: 6,
  preferredDuration: 30,
  preferredTimes: [10, 11, 14, 15, 16],
  confirmed: false
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
function generateProposedRules(analysis, userTimezone = 'Asia/Kolkata') {
  return {
    workingHours: {
      start: analysis?.workingHours?.start || '09:30',
      end: analysis?.workingHours?.end || '18:30',
      timezone: userTimezone
    },
    buffers: {
      beforeMinutes: analysis?.suggestedBuffers?.beforeMinutes || 15,
      afterMinutes: analysis?.suggestedBuffers?.afterMinutes || 15
    },
    noMeetingDays: analysis?.noMeetingDays || ['Saturday', 'Sunday'],
    holidays: analysis?.holidays || DEFAULT_RULES.holidays,
    maxMeetingsPerDay: analysis?.suggestedMaxMeetingsPerDay || 6,
    preferredDuration: analysis?.preferredDuration || 30,
    preferredTimes: analysis?.preferredHours || [10, 11, 14, 15, 16],
    confirmed: false
  };
}

/**
 * Check if a proposed time slot satisfies working hours, no-meeting days, holidays, and max daily meetings
 */
function isSlotWithinRules(slotStartISO, slotEndISO, existingCountToday, rules) {
  const start = new Date(slotStartISO);
  const end = new Date(slotEndISO);

  // 1. Check max meetings per day
  if (existingCountToday >= (rules.maxMeetingsPerDay || 6)) {
    return { valid: false, reason: 'Max daily meeting limit reached' };
  }

  // 2. Check no-meeting days
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = dayNames[start.getDay()];
  if ((rules.noMeetingDays || []).includes(dayName)) {
    return { valid: false, reason: `Day ${dayName} is a no-meeting day` };
  }

  // 3. Check Indian holidays
  const dateStr = start.toISOString().split('T')[0];
  if ((rules.holidays || []).includes(dateStr)) {
    return { valid: false, reason: `Date ${dateStr} is a holiday` };
  }

  // 4. Check working hours (in rule timezone or UTC local time)
  const startHoursStr = rules.workingHours?.start || '09:30';
  const endHoursStr = rules.workingHours?.end || '18:30';

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
