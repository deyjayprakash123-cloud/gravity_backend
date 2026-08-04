const { google } = require('googleapis');
const fs = require('fs-extra');
const path = require('path');
const { createOAuth2Client } = require('./oauthService');
const { getUserTokens } = require('./userManager');
const logger = require('./logger');

const TIMEZONE = 'Asia/Kolkata';
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
 * Create Google OAuth2 Client
 */
function getOAuth2Client() {
  return createOAuth2Client();
}

/**
 * Get Google Calendar client for a specific user
 */
async function getCalendarClient(userEmail) {
  const tokens = await getUserTokens(userEmail);
  if (!tokens || (!tokens.refresh_token && !tokens.refreshToken)) {
    throw new Error(`No OAuth refresh token available for Calendar for user ${userEmail}.`);
  }

  const oauth2Client = createOAuth2Client();
  const refreshToken = tokens.refresh_token || tokens.refreshToken;
  oauth2Client.setCredentials({ ...tokens, refresh_token: refreshToken });

  return google.calendar({ version: 'v3', auth: oauth2Client });
}

/**
 * Analyze past 90 days of events for a user
 */
async function analyze90Days(userEmail) {
  try {
    const calendar = await getCalendarClient(userEmail);

    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const events = await calendar.events.list({
      calendarId: 'primary',
      timeMin: ninetyDaysAgo.toISOString(),
      timeMax: new Date().toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 2500
    });

    return events.data.items || [];
  } catch (error) {
    console.error(`Error in 90-day analysis for ${userEmail}:`, error.message);
    return [];
  }
}

async function analyze90DayHistory(userEmail) {
  try {
    const calendar = await getCalendarClient(userEmail);
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

    if (validEventCount < 10) {
      await logger.info('CalendarService', `Fewer than 10 events for ${userEmail}. Using Indian default parameters.`);
      return {
        analyzedEventCount: validEventCount,
        workingHours: { start: '09:30', end: '18:30', timezone: TIMEZONE },
        preferredDuration: 30,
        preferredHours: [10, 11, 14, 15, 16],
        noMeetingDays: ['Saturday', 'Sunday'],
        holidays: INDIAN_HOLIDAYS_2026,
        suggestedBuffers: { beforeMinutes: 15, afterMinutes: 15 },
        suggestedMaxMeetingsPerDay: 6
      };
    }

    const avgDuration = Math.round(totalDurationMinutes / validEventCount);
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

    return {
      analyzedEventCount: validEventCount,
      workingHours: {
        start: earliestStartHour === 24 ? '09:30' : `${String(earliestStartHour).padStart(2, '0')}:00`,
        end: latestEndHour === 0 ? '18:30' : `${String(latestEndHour).padStart(2, '0')}:00`,
        timezone: TIMEZONE
      },
      preferredDuration: roundedDuration,
      preferredHours: preferredHours.length > 0 ? preferredHours : [10, 11, 14, 15, 16],
      noMeetingDays: noMeetingDays.length > 0 ? noMeetingDays : ['Saturday', 'Sunday'],
      holidays: INDIAN_HOLIDAYS_2026,
      suggestedBuffers: { beforeMinutes: 15, afterMinutes: 15 },
      suggestedMaxMeetingsPerDay: 6
    };

  } catch (err) {
    await logger.error('CalendarService', `Error in 90-day analysis for ${userEmail}: ${err.message}`);
    return {
      analyzedEventCount: 0,
      workingHours: { start: '09:30', end: '18:30', timezone: TIMEZONE },
      preferredDuration: 30,
      preferredHours: [10, 11, 14, 15, 16],
      noMeetingDays: ['Saturday', 'Sunday'],
      holidays: INDIAN_HOLIDAYS_2026,
      suggestedBuffers: { beforeMinutes: 15, afterMinutes: 15 },
      suggestedMaxMeetingsPerDay: 6
    };
  }
}

async function checkFreeBusy(userEmail, timeMin, timeMax, timeZone = TIMEZONE) {
  const calendar = await getCalendarClient(userEmail);
  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      timeZone,
      items: [{ id: 'primary' }]
    }
  });

  return res.data.calendars?.primary?.busy || [];
}

async function checkSlotAvailable(userEmail, startISO, endISO, timeZone = TIMEZONE) {
  const busyList = await checkFreeBusy(userEmail, startISO, endISO, timeZone);
  return busyList.length === 0;
}

async function createCalendarEvent({ userEmail, summary, description, startISO, endISO, attendees = [], timeZone = TIMEZONE }) {
  const calendar = await getCalendarClient(userEmail);

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

  await logger.info('CalendarService', `Created Calendar Event for ${userEmail}: ${createdEvent.id}`, { summary, meetLink });

  return {
    eventId: createdEvent.id,
    summary: createdEvent.summary,
    start: createdEvent.start.dateTime,
    end: createdEvent.end.dateTime,
    meetLink,
    htmlLink: createdEvent.htmlLink
  };
}

module.exports = {
  createOAuth2Client,
  getOAuth2Client,
  getCalendarClient,
  analyze90Days,
  analyze90DayHistory,
  checkFreeBusy,
  checkSlotAvailable,
  createCalendarEvent,
  TIMEZONE,
  INDIAN_HOLIDAYS_2026
};
