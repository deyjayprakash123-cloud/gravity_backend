const { google } = require('googleapis');
const { createOAuth2Client } = require('./gmailService');
const { loadRefreshToken } = require('./memory');
const logger = require('./logger');

const INDIAN_HOLIDAYS_2026 = [
  '2026-01-26', // Republic Day
  '2026-03-20', // Holi
  '2026-04-14', // Ambedkar Jayanti
  '2026-08-15', // Independence Day
  '2026-10-02', // Gandhi Jayanti
  '2026-10-21', // Diwali
  '2026-12-25'  // Christmas
];

/**
 * Get authenticated Google Calendar client
 */
async function getCalendarClient() {
  const refreshToken = await loadRefreshToken();
  if (!refreshToken) {
    throw new Error('No OAuth refresh token available for Google Calendar.');
  }

  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  return google.calendar({ version: 'v3', auth: oauth2Client });
}

/**
 * Analyze past 90 days of events to extract scheduling patterns and defaults
 */
async function analyze90DayHistory() {
  try {
    const calendar = await getCalendarClient();
    const now = new Date();
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: ninetyDaysAgo.toISOString(),
      timeMax: now.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 2500
    });

    const events = res.data.items || [];

    let totalDurationMinutes = 0;
    let validEventCount = 0;
    const startHoursCount = {};
    const dayOfWeekCount = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    let earliestStartHour = 24;
    let latestEndHour = 0;

    for (const evt of events) {
      if (!evt.start || !evt.end) continue;
      const start = new Date(evt.start.dateTime || evt.start.date);
      const end = new Date(evt.end.dateTime || evt.end.date);

      if (isNaN(start.getTime()) || isNaN(end.getTime())) continue;

      // Skip all-day events or multi-day events
      const durationMin = (end.getTime() - start.getTime()) / (1000 * 60);
      if (durationMin < 10 || durationMin > 480) continue;

      totalDurationMinutes += durationMin;
      validEventCount++;

      const hour = start.getHours();
      const endHour = end.getHours() + (end.getMinutes() > 0 ? 1 : 0);
      const day = start.getDay();

      startHoursCount[hour] = (startHoursCount[hour] || 0) + 1;
      dayOfWeekCount[day] = (dayOfWeekCount[day] || 0) + 1;

      if (hour < earliestStartHour) earliestStartHour = hour;
      if (endHour > latestEndHour) latestEndHour = endHour;
    }

    // If not enough data (< 10 events), return Indian default working patterns
    if (validEventCount < 10) {
      await logger.info('CalendarService', `Fewer than 10 valid events (${validEventCount}) found. Using Indian default parameters.`);
      return {
        analyzedEventCount: validEventCount,
        workingHours: { start: '09:30', end: '18:30', timezone: 'Asia/Kolkata' },
        preferredDuration: 30,
        preferredHours: [10, 11, 14, 15, 16],
        noMeetingDays: ['Saturday', 'Sunday'],
        holidays: INDIAN_HOLIDAYS_2026,
        suggestedBuffers: { beforeMinutes: 15, afterMinutes: 15 },
        suggestedMaxMeetingsPerDay: 6
      };
    }

    const avgDuration = validEventCount > 0 ? Math.round(totalDurationMinutes / validEventCount) : 30;
    const roundedDuration = avgDuration <= 20 ? 15 : (avgDuration <= 45 ? 30 : 60);

    const preferredHours = Object.keys(startHoursCount)
      .map(Number)
      .sort((a, b) => startHoursCount[b] - startHoursCount[a])
      .slice(0, 4);

    const noMeetingDays = [];
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    Object.keys(dayOfWeekCount).forEach(dayNum => {
      if (dayOfWeekCount[dayNum] === 0 && (dayNum === '0' || dayNum === '6')) {
        noMeetingDays.push(dayNames[dayNum]);
      }
    });

    const analysis = {
      analyzedEventCount: validEventCount,
      workingHours: {
        start: earliestStartHour === 24 ? '09:30' : `${String(earliestStartHour).padStart(2, '0')}:00`,
        end: latestEndHour === 0 ? '18:30' : `${String(latestEndHour).padStart(2, '0')}:00`,
        timezone: 'Asia/Kolkata'
      },
      preferredDuration: roundedDuration,
      preferredHours: preferredHours.length > 0 ? preferredHours : [10, 11, 14, 15, 16],
      noMeetingDays: noMeetingDays.length > 0 ? noMeetingDays : ['Saturday', 'Sunday'],
      holidays: INDIAN_HOLIDAYS_2026,
      suggestedBuffers: {
        beforeMinutes: 15,
        afterMinutes: 15
      },
      suggestedMaxMeetingsPerDay: 6
    };

    await logger.info('CalendarService', 'Completed 90-day historical analysis', analysis);
    return analysis;
  } catch (err) {
    await logger.error('CalendarService', 'Error in 90-day analysis, using Indian defaults', err.message);
    return {
      analyzedEventCount: 0,
      workingHours: { start: '09:30', end: '18:30', timezone: 'Asia/Kolkata' },
      preferredDuration: 30,
      preferredHours: [10, 11, 14, 15, 16],
      noMeetingDays: ['Saturday', 'Sunday'],
      holidays: INDIAN_HOLIDAYS_2026,
      suggestedBuffers: { beforeMinutes: 15, afterMinutes: 15 },
      suggestedMaxMeetingsPerDay: 6
    };
  }
}

/**
 * Check busy time intervals for a range
 */
async function checkFreeBusy({ timeMin, timeMax, timeZone = 'Asia/Kolkata' }) {
  const calendar = await getCalendarClient();
  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      timeZone,
      items: [{ id: 'primary' }]
    }
  });

  return res.data.calendars.primary.busy || [];
}

/**
 * Check if a specific time slot is still free right now
 */
async function checkSlotAvailable(startISO, endISO, timeZone = 'Asia/Kolkata') {
  const busyList = await checkFreeBusy({
    timeMin: startISO,
    timeMax: endISO,
    timeZone
  });

  return busyList.length === 0;
}

/**
 * Create a new calendar event with Google Meet link
 */
async function createCalendarEvent({ summary, description, startISO, endISO, attendees = [], timeZone = 'Asia/Kolkata' }) {
  const calendar = await getCalendarClient();

  const eventBody = {
    summary,
    description,
    start: { dateTime: startISO, timeZone },
    end: { dateTime: endISO, timeZone },
    attendees: attendees.map(email => ({ email })),
    conferenceData: {
      createRequest: {
        requestId: `meet-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        conferenceSolutionKey: { type: 'hangoutsMeet' }
      }
    }
  };

  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: eventBody,
    conferenceDataVersion: 1
  });

  const createdEvent = res.data;
  const meetLink = createdEvent.hangoutLink || createdEvent.conferenceData?.entryPoints?.[0]?.uri || null;

  await logger.info('CalendarService', `Created Calendar Event: ${createdEvent.id}`, { summary, meetLink });

  return {
    eventId: createdEvent.id,
    summary: createdEvent.summary,
    start: createdEvent.start.dateTime,
    end: createdEvent.end.dateTime,
    meetLink,
    htmlLink: createdEvent.htmlLink
  };
}

/**
 * Fetch specific event details
 */
async function getEventDetails(eventId) {
  const calendar = await getCalendarClient();
  const res = await calendar.events.get({
    calendarId: 'primary',
    eventId
  });
  return res.data;
}

module.exports = {
  getCalendarClient,
  analyze90DayHistory,
  checkFreeBusy,
  checkSlotAvailable,
  createCalendarEvent,
  getEventDetails
};
