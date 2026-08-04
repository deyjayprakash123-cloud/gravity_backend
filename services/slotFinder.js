const { checkFreeBusy } = require('./calendarService');
const { getEffectiveRules, isSlotWithinRules } = require('./ruleEngine');
const logger = require('./logger');

/**
 * Finds top candidate meeting slots that adhere to user rules & calendar availability
 */
async function findAvailableSlots({ durationMinutes = 30, daysAhead = 7, senderTimezone = null, constraints = [] }) {
  const rules = await getEffectiveRules();
  const userTz = rules.workingHours.timezone || 'UTC';
  const targetTz = senderTimezone || userTz;

  const now = new Date();
  const searchStart = new Date(now.getTime() + 2 * 60 * 60 * 1000); // at least 2 hours from now
  const searchEnd = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

  // Fetch busy events from calendar
  const busyList = await checkFreeBusy({
    timeMin: searchStart.toISOString(),
    timeMax: searchEnd.toISOString(),
    timeZone: userTz
  });

  const candidates = [];
  const bufferBeforeMs = (rules.buffers?.beforeMinutes || 10) * 60 * 1000;
  const bufferAfterMs = (rules.buffers?.afterMinutes || 10) * 60 * 1000;
  const slotDurationMs = durationMinutes * 60 * 1000;

  // Track daily meeting counts to enforce max per day
  const dailyCounts = {};

  // Iterate day by day
  let currentDay = new Date(searchStart);

  while (currentDay < searchEnd) {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = dayNames[currentDay.getDay()];

    // Check no-meeting days
    if (!rules.noMeetingDays.includes(dayName)) {
      const [startH, startM] = (rules.workingHours.start || '09:00').split(':').map(Number);
      const [endH, endM] = (rules.workingHours.end || '17:00').split(':').map(Number);

      const dayStart = new Date(currentDay);
      dayStart.setHours(startH, startM, 0, 0);

      const dayEnd = new Date(currentDay);
      dayEnd.setHours(endH, endM, 0, 0);

      let slotPtr = new Date(dayStart);

      while (new Date(slotPtr.getTime() + slotDurationMs) <= dayEnd) {
        const candidateStart = new Date(slotPtr);
        const candidateEnd = new Date(slotPtr.getTime() + slotDurationMs);

        // Include buffers when checking calendar overlap
        const bufferedStart = new Date(candidateStart.getTime() - bufferBeforeMs);
        const bufferedEnd = new Date(candidateEnd.getTime() + bufferAfterMs);

        // Check busy overlaps
        const isOverlap = busyList.some(busy => {
          const bStart = new Date(busy.start);
          const bEnd = new Date(busy.end);
          return (bufferedStart < bEnd && bufferedEnd > bStart);
        });

        const dayKey = candidateStart.toISOString().split('T')[0];
        const currentDailyCount = dailyCounts[dayKey] || 0;

        const ruleCheck = isSlotWithinRules(candidateStart.toISOString(), candidateEnd.toISOString(), currentDailyCount, rules);

        if (!isOverlap && ruleCheck.valid) {
          // Score candidate based on preferred times
          let score = 10;
          const startHour = candidateStart.getHours();

          if ((rules.preferredTimes || []).includes(startHour)) {
            score += 15;
          }

          // Avoid early morning or late afternoon slight penalty
          if (startHour === 9 || startHour === 16) {
            score += 5;
          }

          candidates.push({
            startISO: candidateStart.toISOString(),
            endISO: candidateEnd.toISOString(),
            dayName,
            hour: startHour,
            score,
            formattedUserTz: formatSlotTime(candidateStart, candidateEnd, userTz),
            formattedSenderTz: formatSlotTime(candidateStart, candidateEnd, targetTz)
          });
        }

        // Advance by 30-minute steps
        slotPtr = new Date(slotPtr.getTime() + 30 * 60 * 1000);
      }
    }

    // Move to next day
    currentDay.setDate(currentDay.getDate() + 1);
    currentDay.setHours(0, 0, 0, 0);
  }

  // If fewer than 3 candidates, extend days ahead if possible
  if (candidates.length < 3 && daysAhead < 14) {
    await logger.info('SlotFinder', `Only found ${candidates.length} slots in ${daysAhead} days. Expanding search to 14 days.`);
    return findAvailableSlots({ durationMinutes, daysAhead: 14, senderTimezone, constraints });
  }

  // Sort candidates by score desc then chronologically
  candidates.sort((a, b) => b.score - a.score || new Date(a.startISO) - new Date(b.startISO));

  // Pick top 3 non-overlapping on the same day if possible
  const topSlots = candidates.slice(0, 3);

  await logger.info('SlotFinder', `Found ${topSlots.length} optimal slots out of ${candidates.length} candidates`);
  return topSlots;
}

/**
 * Format slot time cleanly for email string
 */
function formatSlotTime(start, end, timeZone) {
  const optionsDate = { weekday: 'short', month: 'short', day: 'numeric', timeZone };
  const optionsTime = { hour: 'numeric', minute: '2-digit', hour12: true, timeZone };

  const dateStr = start.toLocaleDateString('en-US', optionsDate);
  const startTimeStr = start.toLocaleTimeString('en-US', optionsTime);
  const endTimeStr = end.toLocaleTimeString('en-US', optionsTime);

  return `${dateStr} from ${startTimeStr} to ${endTimeStr} (${timeZone})`;
}

module.exports = {
  findAvailableSlots,
  formatSlotTime
};
