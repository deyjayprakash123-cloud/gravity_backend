require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const { initializeStorage, listAllThreads, loadThreadState, getSchedulerState, setSchedulerState, saveUserRules, loadUserRules, saveToneProfile, loadToneProfile, LOGS_DIR } = require('./services/memory');
const { handleOAuthCode, getAuthUrl, setupGmailWatch, getGmailClient, verifyPushNotifications } = require('./services/gmailService');
const { initializeUserSetup } = require('./services/setupService');
const { processEmail } = require('./services/emailProcessor');
const { transitionThread, cleanupOldThreads } = require('./services/stateMachine');
const { startKeepAlive } = require('./services/keepAlive');
const { rotateLogs } = require('./services/logger');
const logger = require('./services/logger');

const app = express();
const rawPort = process.env.PORT;
const parsedPort = parseInt(rawPort, 10);
const PORT = (!isNaN(parsedPort) && parsedPort > 0) ? parsedPort : 10000;

// Enable CORS and JSON parsing
app.use(cors({
  origin: ['https://gravity-frontend-rose.vercel.app', 'http://localhost:3000', 'http://localhost:3001'],
  credentials: true
}));
app.use(express.json());

// Initialize persistent directories on startup
initializeStorage().then(() => {
  logger.info('Server', 'Persistent storage initialized');
}).catch(err => {
  logger.error('Server', 'Failed to initialize storage', err);
});

// Start Keep-Alive service
startKeepAlive(PORT);

// Log rotation every 24h
setInterval(() => {
  rotateLogs();
  cleanupOldThreads();
}, 24 * 60 * 60 * 1000);

/**
 * Root Route (GET /) - Shows server status
 */
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    message: 'Meeting Scheduler Backend is active',
    endpoints: [
      'GET /health - Health check',
      'POST /webhook/gmail - Gmail push notifications',
      'GET /oauth/callback - Google OAuth callback',
      'GET /api/dashboard - Activity dashboard data',
      'GET /api/threads - Active threads list',
      'GET /debug/logs - System logs',
      'GET /test-process-recent - Process recent unread emails'
    ],
    timestamp: new Date().toISOString()
  });
});

/**
 * Health Check Endpoint (CRITICAL for Render)
 */
app.get('/health', async (req, res) => {
  try {
    const gmail = await getGmailClient();
    const profile = await gmail.users.getProfile({ userId: 'me' });

    res.status(200).json({
      status: 'healthy',
      gmail: 'connected',
      email: profile.data.emailAddress,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      memory: process.memoryUsage()
    });
  } catch (error) {
    res.status(200).json({
      status: 'healthy',
      gmail: 'disconnected',
      error: error.message,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * Debug Logs Endpoint
 */
app.get('/debug/logs', (req, res) => {
  try {
    const logDir = LOGS_DIR || path.join(__dirname, 'data/logs');

    if (!fs.existsSync(logDir)) {
      return res.json({ logs: 'No logs directory found' });
    }

    const today = new Date().toISOString().split('T')[0];
    const logFile = path.join(logDir, `${today}.log`);

    if (fs.existsSync(logFile)) {
      const logs = fs.readFileSync(logFile, 'utf8');
      const recentLogs = logs.split('\n').slice(-50).join('\n');
      return res.json({ logs: recentLogs });
    }

    res.json({ logs: 'No logs for today' });
  } catch (error) {
    res.json({ error: error.message });
  }
});

/**
 * Get OAuth Authorization URL
 */
app.get('/auth/url', (req, res) => {
  try {
    const url = getAuthUrl();
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * OAuth Callback Redirect
 */
app.get('/oauth/callback', async (req, res) => {
  console.log('🔑 OAuth callback received');
  console.log('Query params:', req.query);

  const { code, error } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || 'https://gravity-frontend-rose.vercel.app';

  if (error) {
    console.error('❌ OAuth error:', error);
    return res.redirect(`${frontendUrl}/setup?error=oauth_denied`);
  }

  if (!code) {
    console.error('❌ No authorization code received');
    return res.redirect(`${frontendUrl}/setup?error=no_code`);
  }

  try {
    const tokens = await handleOAuthCode(code);
    const userEmail = process.env.USER_EMAIL || 'user@example.com';
    await initializeUserSetup(userEmail);

    console.log('✅ Authorization code received & processed successfully');
    res.redirect(`${frontendUrl}/setup?status=connected`);
  } catch (err) {
    await logger.error('Server', 'OAuth Callback Failed', err.message);
    res.redirect(`${frontendUrl}/setup?error=token_failed`);
  }
});

/**
 * Gmail Webhook Notification Endpoint (Pub/Sub)
 */
app.post('/webhook/gmail', async (req, res) => {
  console.log('📧 Webhook received:', new Date().toISOString());
  console.log('Body:', JSON.stringify(req.body));

  // IMPORTANT: Always respond 200 immediately
  res.status(200).send('OK');

  try {
    const { message } = req.body;

    if (!message) {
      console.log('❌ No message in webhook body');
      return;
    }

    if (message.data) {
      const dataStr = Buffer.from(message.data, 'base64').toString('utf8');
      console.log('📨 Notification data:', dataStr);
      const data = JSON.parse(dataStr);

      if (data.messageId) {
        await processEmail(data.messageId);
      }

      const historyId = data.historyId;
      if (historyId) {
        try {
          const gmail = await getGmailClient();
          const history = await gmail.users.history.list({
            userId: 'me',
            startHistoryId: historyId,
            historyTypes: ['messageAdded']
          });

          if (history.data.history) {
            for (const h of history.data.history) {
              if (h.messagesAdded) {
                for (const msg of h.messagesAdded) {
                  if (msg.message && msg.message.id) {
                    await processEmail(msg.message.id);
                  }
                }
              }
            }
          }
        } catch (histErr) {
          console.error('Error fetching Gmail history:', histErr.message);
        }
      }
    }
  } catch (error) {
    console.error('❌ Error processing webhook:', error.message);
  }
});

/**
 * Manual Test Endpoint: process recent unread emails
 */
app.get('/test-process-recent', async (req, res) => {
  try {
    const gmail = await getGmailClient();

    // Get 5 most recent unread messages
    const messages = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 5,
      q: 'is:unread'
    });

    const results = [];

    if (messages.data.messages) {
      for (const msg of messages.data.messages) {
        console.log('Manually processing:', msg.id);
        const procResult = await processEmail(msg.id);
        results.push(`Processed: ${msg.id} - ${procResult?.status || 'DONE'}`);
      }
    } else {
      results.push('No unread messages found');
    }

    res.json({ success: true, results });
  } catch (error) {
    console.error('Test failed:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Direct Manual Message Processing Trigger API (for testing & web UI)
 */
app.post('/api/process-message', async (req, res) => {
  const { messageId } = req.body;
  if (!messageId) return res.status(400).json({ error: 'messageId required' });

  try {
    const result = await processEmail(messageId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Dashboard Overview Stats API
 */
app.get('/api/dashboard', async (req, res) => {
  try {
    const state = await getSchedulerState();
    const threads = await listAllThreads();

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    const todayThreads = threads.filter(t => t.lastUpdated && t.lastUpdated.startsWith(todayStr));
    const bookedToday = todayThreads.filter(t => t.state === 'BOOKED');
    const flagged = threads.filter(t => t.state === 'FLAGGED');

    const recentActivity = threads.slice(0, 10).map(t => ({
      id: t.threadId,
      sender: t.senderEmail || 'Unknown',
      state: t.state,
      lastAction: t.history?.[t.history.length - 1]?.action || 'Updated',
      timestamp: t.lastUpdated,
      subject: t.subject || 'Meeting Request'
    }));

    res.json({
      status: state.paused ? 'PAUSED' : 'ACTIVE',
      stats: {
        emailsHandledToday: todayThreads.length,
        meetingsBookedToday: bookedToday.length,
        activeThreads: threads.filter(t => t.state !== 'BOOKED').length,
        needsAttention: flagged.length
      },
      flaggedThreads: flagged,
      recentActivity
    });
  } catch (err) {
    console.error('❌ Dashboard error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

/**
 * List Threads API
 */
app.get('/api/threads', async (req, res) => {
  try {
    const threads = await listAllThreads();
    res.json({
      threads,
      total: threads.length
    });
  } catch (err) {
    console.error('❌ Threads error:', err.message);
    res.status(500).json({ error: 'Failed to load threads' });
  }
});

/**
 * Get Specific Thread Details API
 */
app.get('/api/threads/:id', async (req, res) => {
  try {
    const thread = await loadThreadState(req.params.id);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    res.json({ thread });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Rules Confirmation & Management API
 */
app.get('/api/rules', async (req, res) => {
  try {
    const rules = (await loadUserRules()) || {};
    res.json({ rules });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rules/confirm', async (req, res) => {
  try {
    const rules = req.body.rules;
    if (!rules) return res.status(400).json({ error: 'rules required' });

    const saved = await saveUserRules(rules);
    await logger.info('Server', 'Confirmed updated user rules', saved);
    res.json({ success: true, rules: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Tone Settings API
 */
app.get('/api/tone', async (req, res) => {
  try {
    const tone = (await loadToneProfile()) || {};
    res.json({ tone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tone', async (req, res) => {
  try {
    const tone = req.body;
    const saved = await saveToneProfile(tone);
    res.json({ success: true, tone: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Pause / Resume Endpoints
 */
app.post('/api/pause', async (req, res) => {
  try {
    const updated = await setSchedulerState(true);
    await logger.warn('Server', 'Scheduler system PAUSED by user');
    res.json({ success: true, state: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/resume', async (req, res) => {
  try {
    const updated = await setSchedulerState(false);
    await logger.info('Server', 'Scheduler system RESUMED by user');
    res.json({ success: true, state: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Manual Thread Takeover / Resolve API
 */
app.post('/api/takeover/:threadId', async (req, res) => {
  const { action, note } = req.body;
  try {
    const threadId = req.params.id || req.params.threadId;
    const targetState = action === 'RESOLVE' ? 'BOOKED' : 'UNRESOLVED';

    const updated = await transitionThread(threadId, targetState, {
      note: note || 'Manual human takeover via dashboard',
      needsAttention: false
    });

    res.json({ success: true, thread: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start Express Server
app.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Meeting Scheduler Backend running on port', PORT);
  console.log('📍 Root endpoint: https://gravity-backend-rdvr.onrender.com/');
  console.log('📍 Health check: https://gravity-backend-rdvr.onrender.com/health');
  console.log('📧 Webhook endpoint: https://gravity-backend-rdvr.onrender.com/webhook/gmail');
  console.log('🔑 OAuth callback: https://gravity-backend-rdvr.onrender.com/oauth/callback');
  console.log('✅ Server ready to receive requests');
  logger.info('Server', `Autonomous Scheduler Backend listening on 0.0.0.0:${PORT}`);
});
