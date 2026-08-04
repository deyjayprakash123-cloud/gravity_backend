const fs = require('fs-extra');
const path = require('path');
const { getUserPaths } = require('./userManager');

const DEFAULT_STATS = {
  totalEmailsHandled: 0,
  totalMeetingsBooked: 0,
  totalThreadsFlagged: 0,
  activeThreads: 0,
  emailsToday: 0,
  meetingsToday: 0,
  recentActivity: [],
  monthlyStats: {},
  updatedAt: new Date().toISOString()
};

async function getUserStats(email) {
  const paths = getUserPaths(email);
  if (!await fs.pathExists(paths.statsFile)) {
    return { ...DEFAULT_STATS };
  }
  try {
    const data = await fs.readJson(paths.statsFile);
    return { ...DEFAULT_STATS, ...data };
  } catch (err) {
    return { ...DEFAULT_STATS };
  }
}

async function saveUserStats(email, statsData) {
  const paths = getUserPaths(email);
  await fs.ensureDir(paths.userDir);
  const updated = {
    ...statsData,
    updatedAt: new Date().toISOString()
  };
  await fs.writeJson(paths.statsFile, updated, { spaces: 2 });
  return updated;
}

async function recordActivity(email, activityItem) {
  const stats = await getUserStats(email);
  const item = {
    id: `act-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    timestamp: new Date().toISOString(),
    ...activityItem
  };

  const currentList = stats.recentActivity || [];
  // Keep last 50 activity items
  stats.recentActivity = [item, ...currentList].slice(0, 50);
  await saveUserStats(email, stats);
  return item;
}

async function recordEmailHandled(email, activityNote) {
  const stats = await getUserStats(email);
  stats.totalEmailsHandled = (stats.totalEmailsHandled || 0) + 1;
  stats.emailsToday = (stats.emailsToday || 0) + 1;
  await saveUserStats(email, stats);

  if (activityNote) {
    await recordActivity(email, activityNote);
  }
}

async function recordMeetingBooked(email, activityNote) {
  const stats = await getUserStats(email);
  stats.totalMeetingsBooked = (stats.totalMeetingsBooked || 0) + 1;
  stats.meetingsToday = (stats.meetingsToday || 0) + 1;
  await saveUserStats(email, stats);

  if (activityNote) {
    await recordActivity(email, activityNote);
  }
}

async function recordThreadFlagged(email, activityNote) {
  const stats = await getUserStats(email);
  stats.totalThreadsFlagged = (stats.totalThreadsFlagged || 0) + 1;
  await saveUserStats(email, stats);

  if (activityNote) {
    await recordActivity(email, activityNote);
  }
}

module.exports = {
  getUserStats,
  saveUserStats,
  recordActivity,
  recordEmailHandled,
  recordMeetingBooked,
  recordThreadFlagged
};
