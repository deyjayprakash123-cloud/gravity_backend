const { checkFreeBusy } = require('./calendarService');
const { getEffectiveRules, isSlotWithinRules } = require('./ruleEngine');
const logger = require('./logger');

/**
 * Finds top candidate meeting slots that adhere to user rules & calendar availability
 */
async function findAvailableSlots({ durationMinutes = 30, daysAhead = 7, senderTimezone = null, constraints = [] }) {
  const rules = await getEffectiveRules();
  const userTz = rules.workingHours.timezone || 'Asia/Kolkata';
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
  const bufferBeforeMs = (rules.buffers?.beforeMinutes || 15) * 60 * 1000;
  const bufferAfterMs = (rules.buffers?.afterMinutes || 15) * 60 * 1000;
  const slotDurationMs = durationMinutes * 60 * 1000;

  const dailyCounts = {};

  let currentDay = new Date(searchStart);

  while (currentDay < searchEnd) {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = dayNames[currentDay.getDay()];
    const dateStr = currentDay.toISOString().split('T')[0];

    // Check no-meeting days and Indian holidays
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
          let score = 10;
          const startHour = candidateStart.getHours();

          if ((rules.preferredTimes || []).includes(startHour)) {
            score += 15;
          }

          if (startHour === 10 || startHour === 11 || startHour === 15) {
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

    currentDay.setDate(currentDay.getDate() + 1);
    currentDay.setHours(0, 0, 0, 0);
  }

  if (candidates.length < 3 && daysAhead < 14) {
    await logger.info('SlotFinder', `Only found ${candidates.length} slots in ${daysAhead} days. Expanding search to 14 days.`);
    return findAvailableSlots({ durationMinutes, daysAhead: 14, senderTimezone, constraints });
  }

  candidates.sort((a, b) => b.score - a.score || new Date(a.startISO) - new Date(b.startISO));

  const topSlots = candidates.slice(0, 3);

  await logger.info('SlotFinder', `Found ${topSlots.length} optimal slots out of ${candidates.length} candidates`);
  return topSlots;
}

/**
 * Format slot time cleanly for email string
 */
function formatSlotTime(start, end, timeZone) {
  const optionsDate = { weekday: 'short', month: 'short', day: 'numeric', timeZone: timeZone || 'Asia/Kolkata' };
  const optionsTime = { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: timeZone || 'Asia/Kolkata' };

  const dateStr = start.toLocaleDateString('en-IN', optionsDate);
  const startTimeStr = start.toLocaleTimeString('en-IN', optionsTime);
  const endTimeStr = end.toLocaleTimeString('en-IN', optionsTime);

  const tzLabel = (timeZone === 'Asia/Kolkata' || !timeZone) ? 'IST' : timeZone;
  return `${dateStr} from ${startTimeStr} to ${endTimeStr} (${tzLabel})`;
}

module.exports = {
  findAvailableSlots,
  formatSlotTime
};
