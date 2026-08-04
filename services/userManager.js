const fs = require('fs-extra');
const path = require('path');

// Base persistent storage directory
const BASE_DIR = process.env.DATA_DIR && fs.existsSync(process.env.DATA_DIR)
  ? process.env.DATA_DIR
  : path.join(__dirname, '../data');

const USERS_DIR = path.join(BASE_DIR, 'users');
const GLOBAL_DIR = path.join(BASE_DIR, 'global');
const LOGS_DIR = path.join(BASE_DIR, 'logs');

const USERS_LIST_FILE = path.join(GLOBAL_DIR, 'users-list.json');
const APP_STATS_FILE = path.join(GLOBAL_DIR, 'app-stats.json');

/**
 * Ensures global directories and files exist
 */
async function initStorage() {
  await fs.ensureDir(USERS_DIR);
  await fs.ensureDir(GLOBAL_DIR);
  await fs.ensureDir(LOGS_DIR);

  if (!await fs.pathExists(USERS_LIST_FILE)) {
    await fs.writeJson(USERS_LIST_FILE, { users: [], updatedAt: new Date().toISOString() }, { spaces: 2 });
  }

  if (!await fs.pathExists(APP_STATS_FILE)) {
    await fs.writeJson(APP_STATS_FILE, {
      totalUsers: 0,
      totalEmailsHandled: 0,
      totalMeetingsBooked: 0,
      updatedAt: new Date().toISOString()
    }, { spaces: 2 });
  }
}

/**
 * Sanitize email for folder path usage
 */
function sanitizeEmail(email) {
  if (!email) return 'default_user';
  return email.trim().toLowerCase();
}

/**
 * Get directory paths for a specific user
 */
function getUserPaths(email) {
  const cleanEmail = sanitizeEmail(email);
  const userDir = path.join(USERS_DIR, cleanEmail);
  return {
    userDir,
    tokensFile: path.join(userDir, 'tokens.json'),
    rulesFile: path.join(userDir, 'rules.json'),
    toneFile: path.join(userDir, 'tone.json'),
    statsFile: path.join(userDir, 'stats.json'),
    stateFile: path.join(userDir, 'state.json'),
    threadsDir: path.join(userDir, 'threads')
  };
}

/**
 * Initialize user directory structure on first sign in
 */
async function createUserDirectory(email) {
  await initStorage();
  const cleanEmail = sanitizeEmail(email);
  const paths = getUserPaths(cleanEmail);

  await fs.ensureDir(paths.userDir);
  await fs.ensureDir(paths.threadsDir);

  // Register in global users list if not already present
  const globalData = (await fs.readJson(USERS_LIST_FILE).catch(() => ({ users: [] }))) || { users: [] };
  if (!globalData.users.includes(cleanEmail)) {
    globalData.users.push(cleanEmail);
    globalData.updatedAt = new Date().toISOString();
    await fs.writeJson(USERS_LIST_FILE, globalData, { spaces: 2 });

    // Update app stats count
    const appStats = (await fs.readJson(APP_STATS_FILE).catch(() => ({ totalUsers: 0 }))) || { totalUsers: 0 };
    appStats.totalUsers = globalData.users.length;
    appStats.updatedAt = new Date().toISOString();
    await fs.writeJson(APP_STATS_FILE, appStats, { spaces: 2 });
  }

  // Initialize user state if missing
  if (!await fs.pathExists(paths.stateFile)) {
    await fs.writeJson(paths.stateFile, { paused: false, createdAt: new Date().toISOString() }, { spaces: 2 });
  }

  return paths;
}

/**
 * Get list of all registered user emails
 */
async function getAllUsers() {
  await initStorage();
  try {
    const data = await fs.readJson(USERS_LIST_FILE);
    return data.users || [];
  } catch (err) {
    return [];
  }
}

/**
 * Token Operations per user
 */
async function saveUserTokens(email, tokenData) {
  const paths = getUserPaths(email);
  await fs.ensureDir(paths.userDir);
  const payload = typeof tokenData === 'string' ? { refresh_token: tokenData, refreshToken: tokenData } : tokenData;
  payload.updatedAt = new Date().toISOString();
  await fs.writeJson(paths.tokensFile, payload, { spaces: 2 });
}

async function getUserTokens(email) {
  const paths = getUserPaths(email);
  if (!await fs.pathExists(paths.tokensFile)) return null;
  try {
    return await fs.readJson(paths.tokensFile);
  } catch (err) {
    return null;
  }
}

/**
 * Rules Operations per user
 */
async function saveUserRules(email, rules) {
  const paths = getUserPaths(email);
  await fs.ensureDir(paths.userDir);
  const payload = {
    ...rules,
    updatedAt: new Date().toISOString()
  };
  await fs.writeJson(paths.rulesFile, payload, { spaces: 2 });
  return payload;
}

async function getUserRules(email) {
  const paths = getUserPaths(email);
  if (!await fs.pathExists(paths.rulesFile)) return null;
  try {
    return await fs.readJson(paths.rulesFile);
  } catch (err) {
    return null;
  }
}

/**
 * Tone Operations per user
 */
async function saveUserTone(email, tone) {
  const paths = getUserPaths(email);
  await fs.ensureDir(paths.userDir);
  const payload = {
    greeting: tone.greeting || 'Hi',
    signOff: tone.signOff || 'Best',
    formality: tone.formality ?? 5,
    samplePhrase: tone.samplePhrase || '',
    updatedAt: new Date().toISOString()
  };
  await fs.writeJson(paths.toneFile, payload, { spaces: 2 });
  return payload;
}

async function getUserTone(email) {
  const paths = getUserPaths(email);
  if (!await fs.pathExists(paths.toneFile)) return null;
  try {
    return await fs.readJson(paths.toneFile);
  } catch (err) {
    return null;
  }
}

/**
 * User Pause / Resume State
 */
async function getUserState(email) {
  const paths = getUserPaths(email);
  if (!await fs.pathExists(paths.stateFile)) return { paused: false };
  try {
    return await fs.readJson(paths.stateFile);
  } catch (err) {
    return { paused: false };
  }
}

async function setUserState(email, paused) {
  const paths = getUserPaths(email);
  await fs.ensureDir(paths.userDir);
  const current = await getUserState(email);
  const updated = { ...current, paused, updatedAt: new Date().toISOString() };
  await fs.writeJson(paths.stateFile, updated, { spaces: 2 });
  return updated;
}

/**
 * Thread Operations per user
 */
async function saveUserThread(email, threadId, data) {
  const paths = getUserPaths(email);
  await fs.ensureDir(paths.threadsDir);
  const filePath = path.join(paths.threadsDir, `${threadId}.json`);
  const existing = (await getUserThread(email, threadId)) || {};
  const updated = {
    ...existing,
    ...data,
    threadId,
    lastUpdated: new Date().toISOString()
  };
  await fs.writeJson(filePath, updated, { spaces: 2 });
  return updated;
}

async function getUserThread(email, threadId) {
  const paths = getUserPaths(email);
  const filePath = path.join(paths.threadsDir, `${threadId}.json`);
  if (!await fs.pathExists(filePath)) return null;
  try {
    return await fs.readJson(filePath);
  } catch (err) {
    return null;
  }
}

async function listUserThreads(email) {
  const paths = getUserPaths(email);
  await fs.ensureDir(paths.threadsDir);
  const files = await fs.readdir(paths.threadsDir);
  const jsonFiles = files.filter(f => f.endsWith('.json'));

  const threads = [];
  for (const file of jsonFiles) {
    try {
      const data = await fs.readJson(path.join(paths.threadsDir, file));
      threads.push(data);
    } catch (err) {
      // skip
    }
  }

  return threads.sort((a, b) => new Date(b.lastUpdated || 0) - new Date(a.lastUpdated || 0));
}

module.exports = {
  BASE_DIR,
  USERS_DIR,
  GLOBAL_DIR,
  LOGS_DIR,
  initStorage,
  sanitizeEmail,
  getUserPaths,
  createUserDirectory,
  getAllUsers,
  saveUserTokens,
  getUserTokens,
  saveUserRules,
  getUserRules,
  saveUserTone,
  getUserTone,
  getUserState,
  setUserState,
  saveUserThread,
  getUserThread,
  listUserThreads
};
