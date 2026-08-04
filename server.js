require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const cron = require('node-cron');
const {
  initStorage,
  getUserTokens,
  getUserRules,
  getUserTone,
  getUserState,
  setUserState,
  saveUserRules,
  saveUserTone,
  listUserThreads,
  getUserThread,
  getUserPaths,
  BASE_DIR
} = require('./services/userManager');
const { generateOAuthUrl, handleOAuthCallback } = require('./services/oauthService');
const { processEmail } = require('./services/emailProcessor');
const { transitionThread } = require('./services/stateMachine');
const { getUserStats, recordActivity } = require('./services/statsTracker');
const { startGlobalScheduler } = require('./services/globalScheduler');
const { startKeepAlive } = require('./services/keepAlive');
const { rotateLogs } = require('./services/logger');
const logger = require('./services/logger');

const app = express();
app.set('query parser', 'simple');

const rawPort = process.env.PORT;
const parsedPort = parseInt(rawPort, 10);
const PORT = (!isNaN(parsedPort) && parsedPort > 0) ? parsedPort : 10000;
const TIMEZONE = 'Asia/Kolkata';

// Prevent infinite loops and log all requests (AT THE VERY TOP BEFORE ALL ROUTES)
app.use((req, res, next) => {
  // Skip logging for health checks to reduce noise
  if (req.path === '/health') {
    return next();
  }

  // Log the request once
  console.log(`📥 [${req.method}] ${req.path} - Query:`, JSON.stringify(req.query));

  // Prevent the request from being processed multiple times
  if (req._processed) {
    console.log('⚠️ Duplicate request detected, skipping');
    return res.status(200).json({ error: 'Request already processed' });
  }
  req._processed = true;

  next();
});

// Enable CORS and JSON parsing
app.use(cors({
  origin: ['https://gravity-frontend-rose.vercel.app', 'http://localhost:3000', 'http://localhost:3001'],
  credentials: true
}));
app.use(express.json());

// Initialize storage and background scheduler
initStorage().then(() => {
  logger.info('Server', 'Multi-user storage initialized');
  startGlobalScheduler();
}).catch(err => {
  logger.error('Server', 'Failed to initialize storage', err);
});

// Keep-Alive self ping
startKeepAlive(PORT);

// Log rotation every 24h
setInterval(() => {
  rotateLogs();
}, 24 * 60 * 60 * 1000);

/**
 * Health Check Endpoint (Proper JSON at GET / and GET /health)
 */
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    app: 'Multi-User Meeting Scheduler SaaS AI',
    uptime: process.uptime(),
    timezone: TIMEZONE,
    serverTime: new Date().toLocaleString('en-IN', { timeZone: TIMEZONE })
  });
});

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'running',
    app: 'Meeting Scheduler AI',
    timezone: TIMEZONE,
    serverTime: new Date().toLocaleString('en-IN', { timeZone: TIMEZONE }),
    endpoints: [
      'GET /health',
      'GET /api/auth/url',
      'GET /oauth/callback',
      'GET /api/user/status?email=',
      'GET /api/user/dashboard?email=',
      'GET /api/credits/check'
    ]
  });
});

/**
 * Credits Check Endpoint
 */
app.get('/api/credits/check', (req, res) => {
  res.json({
    hasCredits: true,
    creditsRemaining: 100,
    message: "Not enough credits. Contact deyjayprakash123@gmail.com"
  });
});

/**
 * Get OAuth Authorization URL
 */
app.get('/api/auth/url', (req, res) => {
  try {
    const url = generateOAuthUrl();
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/auth/url', (req, res) => {
  try {
    const url = generateOAuthUrl();
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * OAuth Callback Route
 */
app.get('/oauth/callback', async (req, res) => {
  console.log('🔑 OAuth callback received');
  console.log('Query params:', JSON.stringify(req.query));

  const { code, error, error_description } = req.query;
  const acceptHeader = req.headers['accept'] || '';
  const wantsJson = acceptHeader.includes('application/json') || req.query.format === 'json';
  const frontendUrl = process.env.FRONTEND_URL || 'https://gravity-frontend-rose.vercel.app';

  if (error || error_description) {
    console.error('❌ OAuth error:', error || error_description);
    if (wantsJson) {
      return res.status(400).json({ success: false, error: error_description || error || 'OAuth denied' });
    }
    return res.redirect(`${frontendUrl}/setup?error=oauth_denied`);
  }

  if (!code) {
    console.error('❌ No authorization code received');
    if (wantsJson) {
      return res.status(400).json({ success: false, error: 'No authorization code received' });
    }
    return res.redirect(`${frontendUrl}/setup?error=no_code`);
  }

  try {
    const result = await handleOAuthCallback(code);
    console.log(`✅ OAuth successful for user: ${result.email}`);

    if (wantsJson) {
      return res.status(200).json({
        success: true,
        email: result.email,
        message: 'Gmail connected and user account initialized successfully'
      });
    }

    res.redirect(`${frontendUrl}/setup?status=connected&email=${encodeURIComponent(result.email)}`);
  } catch (err) {
    await logger.error('Server', 'OAuth Callback Failed', err.message);
    if (wantsJson) {
      return res.status(500).json({ success: false, error: err.message });
    }
    res.redirect(`${frontendUrl}/setup?error=token_failed`);
  }
});

/**
 * User Status Check API
 */
app.get('/api/user/status', async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'email query parameter required' });

  try {
    const tokens = await getUserTokens(email);
    const rules = await getUserRules(email);
    const state = await getUserState(email);

    res.json({
      email,
      authenticated: !!tokens,
      rulesConfirmed: !!(rules && rules.confirmed),
      paused: state.paused,
      timezone: TIMEZONE
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Shared Dashboard Handler
 */
async function handleDashboardRequest(req, res) {
  try {
    const email = req.query.email;

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    const usersBase = path.join(BASE_DIR, 'users');
    const userDir = path.join(usersBase, email.trim().toLowerCase());
    const userExists = await fs.pathExists(userDir);

    if (!userExists) {
      return res.json({
        status: 'new_user',
        stats: {
          emailsHandled: 0,
          meetingsBooked: 0,
          activeThreads: 0,
          needsAttention: 0
        },
        recentActivity: [],
        message: 'Setup required'
      });
    }

    // Get user stats
    let stats = {
      emailsHandled: 0,
      meetingsBooked: 0,
      activeThreads: 0,
      needsAttention: 0
    };

    const statsPath = path.join(userDir, 'stats.json');
    if (await fs.pathExists(statsPath)) {
      try {
        const rawStats = await fs.readJson(statsPath);
        stats = {
          emailsHandled: rawStats.totalEmailsHandled || rawStats.emailsHandled || rawStats.emailsToday || 0,
          meetingsBooked: rawStats.totalMeetingsBooked || rawStats.meetingsBooked || rawStats.meetingsToday || 0,
          activeThreads: rawStats.activeThreads || 0,
          needsAttention: rawStats.totalThreadsFlagged || rawStats.needsAttention || 0
        };
      } catch (e) {}
    }

    // Get recent activity
    let recentActivity = [];
    const threadsDir = path.join(userDir, 'threads');
    if (await fs.pathExists(threadsDir)) {
      const threadFiles = await fs.readdir(threadsDir);
      const threads = [];

      for (const file of threadFiles) {
        if (file.endsWith('.json')) {
          try {
            const threadData = await fs.readJson(path.join(threadsDir, file));
            threads.push(threadData);
          } catch (e) {}
        }
      }

      // Get recent activity from threads
      threads.forEach(thread => {
        if (thread.history) {
          thread.history.forEach(h => {
            recentActivity.push({
              timestamp: h.timestamp || thread.lastUpdated || new Date().toISOString(),
              action: h.action || h.to || 'PROPOSED_SLOTS',
              senderEmail: thread.senderEmail || thread.sender || 'Unknown',
              details: h.slots ? `${h.slots.length} slots proposed` : (h.eventDetails ? 'Meeting booked' : (h.reason || 'Activity logged')),
              threadId: thread.threadId
            });
          });
        }
      });

      // Sort by timestamp descending, take last 50
      recentActivity.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      recentActivity = recentActivity.slice(0, 50);
    }

    // Count active threads
    const activeCount = recentActivity.filter(a =>
      a.action === 'PROPOSED_SLOTS' || a.action === 'NEGOTIATING' || a.action === 'PROPOSED'
    ).length;

    return res.json({
      status: 'active',
      stats: {
        ...stats,
        activeThreads: activeCount || stats.activeThreads || 0,
        needsAttention: stats.needsAttention || 0
      },
      recentActivity
    });

  } catch (error) {
    console.error('Dashboard error:', error.message);
    return res.status(500).json({
      error: 'Failed to load dashboard',
      stats: {
        emailsHandled: 0,
        meetingsBooked: 0,
        activeThreads: 0,
        needsAttention: 0
      },
      recentActivity: []
    });
  }
}

/**
 * Dashboard API Endpoints
 */
app.get('/api/user/dashboard', handleDashboardRequest);
app.get('/api/dashboard', handleDashboardRequest);

/**
 * User Stats API
 */
app.get('/api/user/stats', async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'email query parameter required' });

  try {
    const stats = await getUserStats(email);
    res.json({ stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * User Threads API
 */
app.get('/api/user/threads', async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'email query parameter required' });

  try {
    const threads = await listUserThreads(email);
    res.json({ threads, total: threads.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/threads', async (req, res) => {
  const email = req.query.email || 'user@example.com';
  try {
    const threads = await listUserThreads(email);
    res.json({ threads, total: threads.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Specific Thread Detail API
 */
app.get('/api/user/threads/:id', async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'email query parameter required' });

  try {
    const thread = await getUserThread(email, req.params.id);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    res.json({ thread });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * User Rules Management API
 */
app.get('/api/user/rules', async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'email query parameter required' });

  try {
    const rules = (await getUserRules(email)) || {};
    res.json({ rules });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rules', async (req, res) => {
  const email = req.query.email || 'user@example.com';
  try {
    const rules = (await getUserRules(email)) || {};
    res.json({ rules });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user/rules/confirm', async (req, res) => {
  const email = req.body.email || req.query.email;
  const rulesInput = req.body.rules || req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  try {
    const confirmedRules = {
      ...rulesInput,
      confirmed: true,
      updatedAt: new Date().toISOString()
    };

    const saved = await saveUserRules(email, confirmedRules);
    await logger.info('Server', `Confirmed updated user rules for ${email}`, saved);
    res.json({ success: true, rules: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rules/confirm', async (req, res) => {
  const email = req.body.email || req.query.email || 'user@example.com';
  req.body.email = email;
  const rulesInput = req.body.rules || req.body;

  try {
    const confirmedRules = {
      ...rulesInput,
      confirmed: true,
      updatedAt: new Date().toISOString()
    };

    const saved = await saveUserRules(email, confirmedRules);
    res.json({ success: true, rules: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * User Tone Settings API
 */
app.get('/api/user/tone', async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'email query parameter required' });

  try {
    const tone = (await getUserTone(email)) || {};
    res.json({ tone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user/tone/update', async (req, res) => {
  const email = req.body.email || req.query.email;
  if (!email) return res.status(400).json({ error: 'email required' });

  try {
    const saved = await saveUserTone(email, req.body.tone || req.body);
    res.json({ success: true, tone: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Pause / Resume Endpoints
 */
app.post('/api/user/pause', async (req, res) => {
  const email = req.body.email || req.query.email;
  if (!email) return res.status(400).json({ error: 'email required' });

  try {
    const updated = await setUserState(email, true);
    await recordActivity(email, { icon: 'Pause', description: 'System paused by user' });
    res.json({ success: true, state: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user/resume', async (req, res) => {
  const email = req.body.email || req.query.email;
  if (!email) return res.status(400).json({ error: 'email required' });

  try {
    const updated = await setUserState(email, false);
    await recordActivity(email, { icon: 'Play', description: 'System resumed by user' });
    res.json({ success: true, state: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/pause', async (req, res) => {
  const email = req.body.email || req.query.email || 'user@example.com';
  const updated = await setUserState(email, true);
  res.json({ success: true, state: updated });
});

app.post('/api/resume', async (req, res) => {
  const email = req.body.email || req.query.email || 'user@example.com';
  const updated = await setUserState(email, false);
  res.json({ success: true, state: updated });
});

/**
 * Thread Takeover / Resolve API
 */
app.post('/api/user/takeover/:threadId', async (req, res) => {
  const email = req.body.email || req.query.email;
  const { action, note } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  try {
    const threadId = req.params.threadId;
    const targetState = action === 'RESOLVE' ? 'BOOKED' : 'UNRESOLVED';

    const updated = await transitionThread(email, threadId, targetState, {
      note: note || 'Manual human takeover via dashboard'
    });

    await recordActivity(email, {
      icon: 'Shield',
      description: `Manual takeover on thread ${threadId}`,
      threadId
    });

    res.json({ success: true, thread: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Gmail Webhook Notification Endpoint (Pub/Sub)
 */
app.post('/webhook/gmail', async (req, res) => {
  res.status(200).send('OK');

  try {
    const { message } = req.body;
    if (!message || !message.data) return;

    const dataStr = Buffer.from(message.data, 'base64').toString('utf8');
    const data = JSON.parse(dataStr);
    const emailAddress = data.emailAddress;

    if (emailAddress && data.messageId) {
      await processEmail(emailAddress.toLowerCase(), data.messageId);
    }
  } catch (error) {
    console.error('❌ Webhook error:', error.message);
  }
});

// 404 Catch-All JSON Response (Never returns HTML "Cannot GET")
app.use((req, res) => {
  res.status(404).json({ error: `Cannot ${req.method} ${req.path}` });
});

// Start Express Server
app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Multi-User Meeting Scheduler SaaS Backend running on port', PORT);
  console.log('📍 Root endpoint: https://gravity-backend-rdvr.onrender.com/');
  console.log('📍 Health check: https://gravity-backend-rdvr.onrender.com/health');
  logger.info('Server', `Autonomous Multi-User Backend listening on 0.0.0.0:${PORT}`);
});
