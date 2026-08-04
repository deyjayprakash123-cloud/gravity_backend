const { checkFreeBusy } = require('./calendarService');
const { getUserRules } = require('./userManager');
const logger = require('./logger');

const DEFAULT_RULES = {
  workingHours: { start: '09:30', end: '18:30', timezone: 'Asia/Kolkata' },
  buffers: { beforeMinutes: 15, afterMinutes: 15 },
  noMeetingDays: ['Saturday', 'Sunday'],
  holidays: [
    '2026-01-26',
    '2026-03-20',
    '2026-04-14',
    '2026-08-15',
    '2026-10-02',
    '2026-10-21',
    '2026-12-25'
  ],
  maxMeetingsPerDay: 6,
  preferredDuration: 30,
  preferredTimes: [10, 11, 14, 15, 16],
  confirmed: true
};

async function getEffectiveUserRules(userEmail) {
  const rules = await getUserRules(userEmail);
  if (rules) {
    return { ...DEFAULT_RULES, ...rules };
  }
  return DEFAULT_RULES;
}

function isSlotWithinRules(slotStartISO, slotEndISO, existingCountToday, rules) {
  const start = new Date(slotStartISO);
  const end = new Date(slotEndISO);

  if (existingCountToday >= (rules.maxMeetingsPerDay || 6)) {
    return { valid: false, reason: 'Max daily meeting limit reached' };
  }

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayName = dayNames[start.getDay()];
  if ((rules.noMeetingDays || []).includes(dayName)) {
    return { valid: false, reason: `Day ${dayName} is a no-meeting day` };
  }

  const dateStr = start.toISOString().split('T')[0];
  if ((rules.holidays || []).includes(dateStr)) {
    return { valid: false, reason: `Date ${dateStr} is a holiday` };
  }

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

async function findAvailableSlots({ userEmail, durationMinutes = 30, daysAhead = 7 }) {
  const rules = await getEffectiveUserRules(userEmail);
  const userTz = rules.workingHours?.timezone || 'Asia/Kolkata';

  const now = new Date();
  const searchStart = new Date(now.getTime() + 2 * 60 * 60 * 1000);
  const searchEnd = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  const busyList = await checkFreeBusy(userEmail, searchStart.toISOString(), searchEnd.toISOString(), userTz);

  const candidates = [];
  const bufferBeforeMs = (rules.buffers?.beforeMinutes || 15) * 60 * 1000;
  const bufferAfterMs = (rules.buffers?.afterMinutes || 15) * 60 * 1000;
  const slotDurationMs = durationMinutes * 60 * 1000;

  const dailyCounts = {};
  let currentDay = new Date(searchStart);

  while (currentDay < searchEnd) {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = dayNames[currentDay.getDay()];
    const dateStr = currentDay.toISOString().split('T')[0];

    if (!rules.noMeetingDays.includes(dayName) && !(rules.holidays || []).includes(dateStr)) {
      const [startH, startM] = (rules.workingHours.start || '09:30').split(':').map(Number);
      const [endH, endM] = (rules.workingHours.end || '18:30').split(':').map(Number);

      const dayStart = new Date(currentDay);
      dayStart.setHours(startH, startM || 0, 0, 0);

      const dayEnd = new Date(currentDay);
      dayEnd.setHours(endH, endM || 0, 0, 0);

      let slotPtr = new Date(dayStart);

      while (new Date(slotPtr.getTime() + slotDurationMs) <= dayEnd) {
        const candidateStart = new Date(slotPtr);
        const candidateEnd = new Date(slotPtr.getTime() + slotDurationMs);

        const bufferedStart = new Date(candidateStart.getTime() - bufferBeforeMs);
        const bufferedEnd = new Date(candidateEnd.getTime() + bufferAfterMs);

        const isOverlap = busyList.some(busy => {
          const bStart = new Date(busy.start);
          const bEnd = new Date(busy.end);
          return (bufferedStart < bEnd && bufferedEnd > bStart);
        });

        const dayKey = candidateStart.toISOString().split('T')[0];
        const currentDailyCount = dailyCounts[dayKey] || 0;

        const ruleCheck = isSlotWithinRules(candidateStart.toISOString(), candidateEnd.toISOString(), currentDailyCount, rules);

        if (!isOverlap && ruleCheck.valid) {
          let score = 10;
          const startHour = candidateStart.getHours();

          if ((rules.preferredTimes || []).includes(startHour)) score += 15;

          const optionsDate = { weekday: 'short', month: 'short', day: 'numeric', timeZone: userTz };
          const optionsTime = { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: userTz };

          candidates.push({
            startISO: candidateStart.toISOString(),
            endISO: candidateEnd.toISOString(),
            day: candidateStart.toLocaleDateString('en-IN', { weekday: 'short', timeZone: userTz }),
            date: candidateStart.toLocaleDateString('en-IN', { month: 'short', day: 'numeric', timeZone: userTz }),
            startTime: candidateStart.toLocaleTimeString('en-IN', optionsTime),
            endTime: candidateEnd.toLocaleTimeString('en-IN', optionsTime),
            score,
            formattedText: `${candidateStart.toLocaleDateString('en-IN', optionsDate)} from ${candidateStart.toLocaleTimeString('en-IN', optionsTime)} to ${candidateEnd.toLocaleTimeString('en-IN', optionsTime)} IST`
          });
        }

        slotPtr = new Date(slotPtr.getTime() + 30 * 60 * 1000);
      }
    }

    currentDay.setDate(currentDay.getDate() + 1);
    currentDay.setHours(0, 0, 0, 0);
  }

  candidates.sort((a, b) => b.score - a.score || new Date(a.startISO) - new Date(b.startISO));
  return candidates.slice(0, 3);
}

module.exports = {
  DEFAULT_RULES,
  getEffectiveUserRules,
  isSlotWithinRules,
  findAvailableSlots
};
