const fs = require('fs-extra');
const path = require('path');
const { LOGS_DIR } = require('./memory');

/**
 * Format today's log file path (e.g. data/logs/2026-08-04.log)
 */
function getTodayLogPath() {
  const dateStr = new Date().toISOString().split('T')[0];
  return path.join(LOGS_DIR, `${dateStr}.log`);
}

/**
 * Log message with level and optional context data
 */
async function log(level, category, message, details = null) {
  const timestamp = new Date().toISOString();
  const entry = {
    timestamp,
    level: level.toUpperCase(),
    category,
    message,
    ...(details ? { details } : {})
  };

  const line = `[${timestamp}] [${entry.level}] [${category}] ${message} ${details ? JSON.stringify(details) : ''}\n`;

  // Always output to stdout/stderr
  if (level === 'error') {
    console.error(line.trim());
  } else {
    console.log(line.trim());
  }

  try {
    await fs.ensureDir(LOGS_DIR);
    await fs.appendFile(getTodayLogPath(), line, 'utf8');
  } catch (err) {
    console.error('Failed to write to log file:', err);
  }
}

async function info(category, message, details) {
  await log('info', category, message, details);
}

async function warn(category, message, details) {
  await log('warn', category, message, details);
}

async function error(category, message, details) {
  await log('error', category, message, details);
}

/**
 * Rotate log files older than 30 days
 */
async function rotateLogs() {
  try {
    await fs.ensureDir(LOGS_DIR);
    const files = await fs.readdir(LOGS_DIR);
    const now = new Date();
    const maxAgeMs = 30 * 24 * 60 * 60 * 1000;

    for (const file of files) {
      if (file.endsWith('.log')) {
        const filePath = path.join(LOGS_DIR, file);
        const stats = await fs.stat(filePath);
        if (now.getTime() - stats.mtime.getTime() > maxAgeMs) {
          await fs.remove(filePath);
          console.log(`Rotated log file: ${file}`);
        }
      }
    }
  } catch (err) {
    console.error('Error during log rotation:', err);
  }
}

module.exports = {
  log,
  info,
  warn,
  error,
  rotateLogs
};
