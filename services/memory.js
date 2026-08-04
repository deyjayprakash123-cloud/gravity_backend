const fs = require('fs-extra');
const path = require('path');

// Target persistent directory path (Render disk mount path or local ./data)
const BASE_DIR = process.env.DATA_DIR && fs.existsSync(process.env.DATA_DIR)
  ? process.env.DATA_DIR
  : path.join(__dirname, '../data');

const THREADS_DIR = path.join(BASE_DIR, 'threads');
const TOKENS_DIR = path.join(BASE_DIR, 'tokens');
const RULES_DIR = path.join(BASE_DIR, 'rules');
const LOGS_DIR = path.join(BASE_DIR, 'logs');

const STATE_FILE = path.join(BASE_DIR, 'scheduler-state.json');
const RULES_FILE = path.join(RULES_DIR, 'user-rules.json');
const TONE_FILE = path.join(RULES_DIR, 'user-tone.json');
const TOKEN_FILE = path.join(TOKENS_DIR, 'refresh-token.json');

/**
 * Ensures all required storage directories exist.
 */
async function initializeStorage() {
  await fs.ensureDir(THREADS_DIR);
  await fs.ensureDir(TOKENS_DIR);
  await fs.ensureDir(RULES_DIR);
  await fs.ensureDir(LOGS_DIR);

  if (!await fs.pathExists(STATE_FILE)) {
    await fs.writeJson(STATE_FILE, { paused: false, initializedAt: new Date().toISOString() });
  }
}

/**
 * Thread Operations
 */
async function saveThreadState(threadId, data) {
  await fs.ensureDir(THREADS_DIR);
  const filePath = path.join(THREADS_DIR, `${threadId}.json`);
  const existing = (await loadThreadState(threadId)) || {};
  const updated = {
    ...existing,
    ...data,
    threadId,
    lastUpdated: new Date().toISOString()
  };
  await fs.writeJson(filePath, updated, { spaces: 2 });
  return updated;
}

async function loadThreadState(threadId) {
  const filePath = path.join(THREADS_DIR, `${threadId}.json`);
  if (!await fs.pathExists(filePath)) return null;
  try {
    return await fs.readJson(filePath);
  } catch (err) {
    console.error(`Error loading thread ${threadId}:`, err);
    return null;
  }
}

async function listAllThreads() {
  await fs.ensureDir(THREADS_DIR);
  const files = await fs.readdir(THREADS_DIR);
  const jsonFiles = files.filter(f => f.endsWith('.json'));

  const threads = [];
  for (const file of jsonFiles) {
    try {
      const data = await fs.readJson(path.join(THREADS_DIR, file));
      threads.push(data);
    } catch (err) {
      // skip malformed file
    }
  }

  // Sort by last updated desc
  return threads.sort((a, b) => new Date(b.lastUpdated || 0) - new Date(a.lastUpdated || 0));
}

async function deleteThread(threadId) {
  const filePath = path.join(THREADS_DIR, `${threadId}.json`);
  if (await fs.pathExists(filePath)) {
    await fs.remove(filePath);
    return true;
  }
  return false;
}

/**
 * User Rules Operations
 */
async function saveUserRules(rules) {
  await fs.ensureDir(RULES_DIR);
  const data = {
    ...rules,
    updatedAt: new Date().toISOString()
  };
  await fs.writeJson(RULES_FILE, data, { spaces: 2 });
  return data;
}

async function loadUserRules() {
  if (!await fs.pathExists(RULES_FILE)) return null;
  try {
    return await fs.readJson(RULES_FILE);
  } catch (err) {
    return null;
  }
}

/**
 * User Tone Operations
 */
async function saveToneProfile(tone) {
  await fs.ensureDir(RULES_DIR);
  const data = {
    greeting: tone.greeting || 'Hi',
    signOff: tone.signOff || 'Best',
    formality: tone.formality ?? 5,
    samplePhrase: tone.samplePhrase || '',
    updatedAt: new Date().toISOString()
  };
  await fs.writeJson(TONE_FILE, data, { spaces: 2 });
  return data;
}

async function loadToneProfile() {
  if (!await fs.pathExists(TONE_FILE)) return null;
  try {
    return await fs.readJson(TONE_FILE);
  } catch (err) {
    return null;
  }
}

/**
 * Token Operations
 */
async function saveRefreshToken(tokenData) {
  await fs.ensureDir(TOKENS_DIR);
  const payload = typeof tokenData === 'string' ? { refreshToken: tokenData } : tokenData;
  payload.updatedAt = new Date().toISOString();
  await fs.writeJson(TOKEN_FILE, payload, { spaces: 2 });
}

async function loadRefreshToken() {
  if (!await fs.pathExists(TOKEN_FILE)) return null;
  try {
    const data = await fs.readJson(TOKEN_FILE);
    return data.refreshToken || data;
  } catch (err) {
    return null;
  }
}

/**
 * Scheduler Pause / Resume State
 */
async function getSchedulerState() {
  if (!await fs.pathExists(STATE_FILE)) return { paused: false };
  try {
    return await fs.readJson(STATE_FILE);
  } catch (err) {
    return { paused: false };
  }
}

async function setSchedulerState(paused) {
  await fs.ensureDir(BASE_DIR);
  const currentState = await getSchedulerState();
  const updated = { ...currentState, paused, updated: new Date().toISOString() };
  await fs.writeJson(STATE_FILE, updated, { spaces: 2 });
  return updated;
}

/**
 * Daily Summary & Backup Helper
 */
async function generateDailySummary() {
  const threads = await listAllThreads();
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const recent = threads.filter(t => new Date(t.lastUpdated) >= oneDayAgo);
  const booked = recent.filter(t => t.state === 'BOOKED');
  const flagged = threads.filter(t => t.state === 'FLAGGED');

  return {
    date: now.toISOString().split('T')[0],
    totalActiveThreads: threads.length,
    processedLast24h: recent.length,
    bookedLast24h: booked.length,
    currentlyFlagged: flagged.length,
    flaggedThreads: flagged.map(f => ({ id: f.threadId, sender: f.senderEmail, reason: f.flagReason }))
  };
}

module.exports = {
  BASE_DIR,
  LOGS_DIR,
  initializeStorage,
  saveThreadState,
  loadThreadState,
  listAllThreads,
  deleteThread,
  saveUserRules,
  loadUserRules,
  saveToneProfile,
  loadToneProfile,
  saveRefreshToken,
  loadRefreshToken,
  getSchedulerState,
  setSchedulerState,
  generateDailySummary
};
