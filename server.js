const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const { google } = require('googleapis');
const axios = require('axios');
const cron = require('node-cron');

const app = express();

// CORS
app.use(cors({
  origin: ['https://gravity-frontend-rose.vercel.app', 'http://localhost:3000', 'http://localhost:3001'],
  credentials: true
}));
app.use(express.json());

// Simple request logger
app.use((req, res, next) => {
  if (req.path !== '/health') {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  }
  next();
});

// Constants
const DATA_DIR = process.env.DATA_DIR && fs.existsSync(process.env.DATA_DIR)
  ? process.env.DATA_DIR
  : '/opt/render/project/data';

const USERS_DIR = path.join(DATA_DIR, 'users');
const TIMEZONE = 'Asia/Kolkata';

// Init directories
async function init() {
  await fs.ensureDir(USERS_DIR);
  await fs.ensureDir(path.join(DATA_DIR, 'global'));
  console.log('✅ Directories ready at:', DATA_DIR);
}
init();

// ============ ROOT ROUTE ============
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    app: 'Meeting Scheduler AI',
    time: new Date().toLocaleString('en-IN', { timeZone: TIMEZONE }),
    users: 'Check /api/global/users'
  });
});

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ============ OAUTH ROUTES ============

// Generate OAuth URL
app.get('/api/auth/url', (req, res) => {
  const redirectUri = req.query.redirect_uri || 'https://gravity-frontend-rose.vercel.app/oauth/callback';
  const url = 'https://accounts.google.com/o/oauth2/v2/auth' +
    '?client_id=' + process.env.GOOGLE_CLIENT_ID +
    '&redirect_uri=' + encodeURIComponent(redirectUri) +
    '&response_type=code' +
    '&scope=' + encodeURIComponent('https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly') +
    '&access_type=offline' +
    '&prompt=consent';
  
  res.json({ url });
});

// OAuth Callback - THE MOST IMPORTANT ROUTE
app.get('/oauth/callback', async (req, res) => {
  console.log('🔑 OAuth callback received');
  console.log('Query params:', JSON.stringify(req.query));
  
  const { code, error } = req.query;
  
  if (error) {
    console.error('❌ OAuth error:', error);
    return res.redirect('https://gravity-frontend-rose.vercel.app?error=denied');
  }
  
  if (!code) {
    console.error('❌ No code received');
    return res.redirect('https://gravity-frontend-rose.vercel.app?error=no_code');
  }
  
  try {
    const candidateUris = [
      'https://gravity-frontend-rose.vercel.app/oauth/callback',
      'https://gravity-backend-rdvr.onrender.com/oauth/callback',
      'http://localhost:3000/oauth/callback'
    ];
    
    let tokens = null;
    let oauth2Client = null;
    let lastError = null;

    console.log('🔄 Exchanging code for tokens across candidate URIs...');
    
    for (const uri of candidateUris) {
      try {
        const client = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET,
          uri
        );
        const tokenRes = await client.getToken(code);
        tokens = tokenRes.tokens;
        oauth2Client = client;
        console.log(`✅ Tokens received using redirect_uri: ${uri}`);
        break;
      } catch (err) {
        lastError = err;
        console.log(`⚠️ Token exchange failed with ${uri}: ${err.message}`);
      }
    }

    if (!tokens || !oauth2Client) {
      throw lastError || new Error('Failed token exchange with candidate URIs');
    }
    
    console.log('Token keys:', Object.keys(tokens));
    console.log('Has id_token:', !!tokens.id_token);
    console.log('Has access_token:', !!tokens.access_token);
    console.log('Has refresh_token:', !!tokens.refresh_token);
    
    let userEmail = null;
    
    // METHOD 1: Try verifyIdToken if id_token exists
    if (tokens.id_token) {
      try {
        const ticket = await oauth2Client.verifyIdToken({
          idToken: tokens.id_token,
          audience: process.env.GOOGLE_CLIENT_ID
        });
        userEmail = ticket.getPayload().email;
        console.log('✅ Email from id_token:', userEmail);
      } catch (idErr) {
        console.log('⚠️ verifyIdToken failed, trying alternative method...');
        console.log('id_token error:', idErr.message);
      }
    }
    
    // METHOD 2: If no id_token, get email from Gmail API
    if (!userEmail && tokens.access_token) {
      try {
        oauth2Client.setCredentials(tokens);
        const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
        const profile = await gmail.users.getProfile({ userId: 'me' });
        userEmail = profile.data.emailAddress;
        console.log('✅ Email from Gmail API:', userEmail);
      } catch (gmailErr) {
        console.log('⚠️ Gmail profile fetch failed:', gmailErr.message);
      }
    }
    
    // METHOD 3: If still no email, get from People API
    if (!userEmail && tokens.access_token) {
      try {
        oauth2Client.setCredentials(tokens);
        const people = google.people({ version: 'v1', auth: oauth2Client });
        const me = await people.people.get({
          resourceName: 'people/me',
          personFields: 'emailAddresses'
        });
        userEmail = me.data.emailAddresses?.[0]?.value;
        console.log('✅ Email from People API:', userEmail);
      } catch (peopleErr) {
        console.log('⚠️ People API fetch failed:', peopleErr.message);
      }
    }
    
    // METHOD 4: Try to decode access token as JWT
    if (!userEmail && tokens.access_token) {
      try {
        const parts = tokens.access_token.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
          userEmail = payload.email;
          console.log('✅ Email from access token JWT:', userEmail);
        }
      } catch (jwtErr) {
        console.log('⚠️ Could not decode access token');
      }
    }
    
    // If STILL no email, we cannot proceed
    if (!userEmail) {
      console.error('❌ FATAL: Cannot determine user email');
      return res.redirect('https://gravity-frontend-rose.vercel.app?error=cannot_get_email');
    }
    
    userEmail = userEmail.toLowerCase().trim();
    console.log('👤 Final user email:', userEmail);
    
    // Create user directory
    const userDir = path.join(USERS_DIR, userEmail);
    await fs.ensureDir(userDir);
    await fs.ensureDir(path.join(userDir, 'threads'));
    await fs.ensureDir(path.join(userDir, 'processed'));
    
    // Save tokens
    await fs.writeJson(path.join(userDir, 'tokens.json'), tokens);
    console.log('💾 Tokens saved');
    
    // Create default rules
    const rules = {
      workingHours: { start: '09:30', end: '18:30' },
      buffers: { beforeMinutes: 15, afterMinutes: 15 },
      noMeetingDays: ['Saturday', 'Sunday'],
      maxMeetingsPerDay: 6,
      preferredDuration: 30,
      timezone: TIMEZONE,
      confirmed: true,
      createdAt: new Date().toISOString()
    };
    await fs.writeJson(path.join(userDir, 'rules.json'), rules);
    console.log('📋 Default rules created and CONFIRMED');
    
    // Create default tone
    const tone = {
      greeting: 'Hi',
      signOff: 'Best',
      formality: 'friendly',
      name: userEmail.split('@')[0]
    };
    await fs.writeJson(path.join(userDir, 'tone.json'), tone);
    
    // Initialize stats with CURRENT timestamp for "only new emails" filtering
    const now = new Date().toISOString();
    const stats = {
      totalEmailsHandled: 0,
      totalMeetingsBooked: 0,
      emailsToday: 0,
      meetingsToday: 0,
      recentActivity: [],
      serviceStartedAt: now  // THIS IS KEY - only process emails after this time
    };
    await fs.writeJson(path.join(userDir, 'stats.json'), stats);
    console.log('📊 Stats initialized, service started at:', now);
    
    // Add to global users list
    const usersListPath = path.join(DATA_DIR, 'global', 'users-list.json');
    let usersList = [];
    if (await fs.pathExists(usersListPath)) {
      usersList = await fs.readJson(usersListPath);
    }
    if (!usersList.includes(userEmail)) {
      usersList.push(userEmail);
      await fs.writeJson(usersListPath, usersList);
    }
    
    // ============ IMMEDIATELY START PROCESSING EMAILS ============
    console.log('🚀 IMMEDIATELY starting email check for:', userEmail);
    
    // Don't await - fire and forget so the redirect happens fast
    processEmailsForUser(userEmail).then(() => {
      console.log('✅ Initial email check complete for:', userEmail);
    }).catch(err => {
      console.error('❌ Initial email check failed:', err.message);
    });
    
    // Set up Gmail watch
    try {
      oauth2Client.setCredentials(tokens);
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
      
      const watchRes = await gmail.users.watch({
        userId: 'me',
        requestBody: {
          topicName: process.env.PUBSUB_TOPIC || 'projects/meeting-scheduler-ai/topics/gmail-notifications',
          labelIds: ['INBOX']
        }
      });
      console.log('👀 Gmail watch active, expires:', new Date(parseInt(watchRes.data.expiration)).toISOString());
    } catch (err) {
      console.log('⚠️ Gmail watch failed (will use polling):', err.message);
    }
    
    // Redirect to setup page
    res.redirect('https://gravity-frontend-rose.vercel.app/setup?email=' + encodeURIComponent(userEmail) + '&status=connected');
    
  } catch (err) {
    console.error('❌ OAuth failed:', err.message);
    console.error('Full error:', err);
    res.redirect('https://gravity-frontend-rose.vercel.app?error=token_failed');
  }
});

// ============ EMAIL PROCESSING ENGINE ============

async function processEmailsForUser(userEmail) {
  console.log(`\n📬 CHECKING: ${userEmail}`);
  const startTime = Date.now();
  
  try {
    const userDir = path.join(USERS_DIR, userEmail);
    
    // Quick checks
    if (!await fs.pathExists(userDir)) return;
    
    const pausedPath = path.join(userDir, 'paused.json');
    if (await fs.pathExists(pausedPath)) {
      console.log('⏸️ Paused');
      return;
    }
    
    const tokensPath = path.join(userDir, 'tokens.json');
    if (!await fs.pathExists(tokensPath)) return;
    
    const rulesPath = path.join(userDir, 'rules.json');
    if (!await fs.pathExists(rulesPath)) return;
    
    const rules = await fs.readJson(rulesPath);
    if (!rules.confirmed) return;
    
    // Load tokens
    const tokens = await fs.readJson(tokensPath);
    
    // Get service start time from stats
    const statsPath = path.join(userDir, 'stats.json');
    let serviceStartTime = new Date().toISOString();
    if (await fs.pathExists(statsPath)) {
      const stats = await fs.readJson(statsPath);
      serviceStartTime = stats.serviceStartedAt || new Date().toISOString();
    }
    
    console.log('🕐 Service started:', new Date(serviceStartTime).toLocaleString('en-IN', { timeZone: TIMEZONE }));
    
    // Create Gmail client
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'https://gravity-backend-rdvr.onrender.com/oauth/callback'
    );
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    
    // ONLY search for emails received AFTER service start time
    const afterTimestamp = Math.floor(new Date(serviceStartTime).getTime() / 1000);
    
    console.log('🔍 Searching for emails after:', new Date(serviceStartTime).toLocaleString('en-IN', { timeZone: TIMEZONE }));
    
    // Use Gmail's "after:" filter with timestamp
    const messagesResponse = await gmail.users.messages.list({
      userId: 'me',
      q: `is:unread -from:me after:${afterTimestamp}`,
      maxResults: 5  // Only check 5 most recent
    });
    
    const messages = messagesResponse.data.messages || [];
    console.log(`📧 Found ${messages.length} new unread messages`);
    
    if (messages.length === 0) {
      console.log('📭 No new messages');
      return;
    }
    
    // Process only the first 3 (most recent)
    const toProcess = messages.slice(0, 3);
    
    for (const msg of toProcess) {
      // Check if already processed
      const processedDir = path.join(userDir, 'processed');
      await fs.ensureDir(processedDir);
      const processedPath = path.join(processedDir, `${msg.id}.json`);
      
      if (await fs.pathExists(processedPath)) {
        console.log('⏭️ Already processed:', msg.id);
        continue;
      }
      
      await processSingleEmail(userEmail, msg.id, gmail, userDir);
    }
    
    const elapsed = Date.now() - startTime;
    console.log(`✅ Check complete in ${elapsed}ms`);
    
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
}

async function processSingleEmail(userEmail, messageId, gmail, userDir) {
  const startTime = Date.now();
  console.log(`\n📧 Processing message: ${messageId}`);
  
  try {
    // Check if already processed
    const processedDir = path.join(userDir, 'processed');
    await fs.ensureDir(processedDir);
    const processedPath = path.join(processedDir, `${messageId}.json`);
    
    if (await fs.pathExists(processedPath)) {
      console.log('⏭️ Already processed, skipping');
      return;
    }
    
    // Fetch email
    const email = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    });
    
    const headers = email.data.payload.headers;
    const internalDate = parseInt(email.data.internalDate);
    const emailDate = new Date(internalDate);
    
    // Get service start time
    const statsPath = path.join(userDir, 'stats.json');
    let serviceStartTime = new Date().toISOString();
    if (await fs.pathExists(statsPath)) {
      const stats = await fs.readJson(statsPath);
      serviceStartTime = stats.serviceStartedAt || new Date().toISOString();
    }
    const serviceStart = new Date(serviceStartTime);
    
    // SKIP if email is from BEFORE service started
    if (emailDate < serviceStart) {
      console.log('⏭️ SKIPPING: Email from', emailDate.toLocaleString('en-IN', { timeZone: TIMEZONE }), '- BEFORE service start');
      // Mark as processed so we don't check it again
      await fs.writeJson(processedPath, { 
        processedAt: new Date().toISOString(),
        skipped: true,
        reason: 'before_service_start',
        emailDate: emailDate.toISOString(),
        serviceStart: serviceStart.toISOString()
      });
      return;
    }
    
    console.log('📅 Email date:', emailDate.toLocaleString('en-IN', { timeZone: TIMEZONE }));
    console.log('✅ Email is NEW - processing');
    
    // Mark as processed immediately
    await fs.writeJson(processedPath, { processedAt: new Date().toISOString() });
    
    const from = headers.find(h => h.name === 'From')?.value || '';
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const threadId = email.data.threadId;
    
    console.log('📧 From:', from);
    console.log('📧 Subject:', subject);
    console.log('📧 ThreadId:', threadId);
    
    // Skip if from self
    if (from.includes(userEmail)) {
      console.log('↩️ Email from self, skipping');
      return;
    }
    
    // Check for auto-responder
    const autoSubmitted = headers.find(h => h.name === 'Auto-Submitted');
    const xAutoreply = headers.find(h => h.name === 'X-Autoreply');
    
    if (autoSubmitted?.value === 'auto-replied' || xAutoreply?.value === 'yes') {
      console.log('🤖 Auto-responder detected, skipping');
      return;
    }
    
    // Check for out of office
    if (subject.toLowerCase().includes('out of office') || 
        subject.toLowerCase().includes('automatic reply')) {
      console.log('🏖️ Out of office detected, skipping');
      return;
    }
    
    // Extract email body
    let body = '';
    if (email.data.payload.parts) {
      for (const part of email.data.payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          body += Buffer.from(part.body.data, 'base64').toString();
        }
      }
    } else if (email.data.payload.body?.data) {
      body = Buffer.from(email.data.payload.body.data, 'base64').toString();
    }
    
    console.log('📝 Body length:', body.length, 'characters');
    
    if (!body || body.trim().length === 0) {
      console.log('⚠️ Empty body, skipping');
      return;
    }
    
    // CLASSIFY THE EMAIL
    console.log('📧 Processing:', subject);
    console.log('   From:', from);
    console.log('🤖 Classifying with AI...');
    const classification = await classifyEmail(body, subject, from);
    console.log('📊 Classification result:', JSON.stringify(classification));
    
    if (classification.intent === 'NOT_SCHEDULING') {
      console.log('⏭️ SKIPPED:', classification.reason || 'not_scheduling');
      return;
    }
    
    if (classification.intent === 'SCHEDULING') {
      console.log('🎯 GENUINE MEETING REQUEST DETECTED!');
      console.log('   Topic:', classification.extractedTopic);
      console.log('   Urgency:', classification.urgency);
      console.log('   Sender type:', classification.senderType);
      
      // Find available slots
      const slots = findAvailableSlotsSimple();
      console.log('📅 Generated', slots.length, 'slots');
      
      if (slots.length === 0) {
        console.log('❌ No slots available');
        return;
      }
      
      // Load tone and rules
      const tonePath = path.join(userDir, 'tone.json');
      const tone = await fs.pathExists(tonePath) ? await fs.readJson(tonePath) : { greeting: 'Hi', signOff: 'Best' };
      
      // Generate PERSONALIZED reply
      console.log('✍️ Generating personalized reply...');
      const replyBody = await generateReply(from, slots, tone, body, subject, classification);
      console.log('📤 Reply:', replyBody.substring(0, 150) + '...');
      
      // Send reply
      console.log('📤 Sending to:', from);
      await sendEmailReply(gmail, threadId, replyBody, from, subject);
      console.log('✅ PERSONALIZED REPLY SENT!');
      
      // Save thread state
      const threadData = {
        threadId,
        state: 'PROPOSED',
        senderEmail: from,
        subject,
        topic: classification.extractedTopic || subject,
        urgency: classification.urgency,
        proposedSlots: slots,
        history: [{
          timestamp: new Date().toISOString(),
          action: 'PROPOSED_SLOTS',
          slots
        }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      const threadsDir = path.join(userDir, 'threads');
      await fs.ensureDir(threadsDir);
      await fs.writeJson(path.join(threadsDir, `${threadId}.json`), threadData);
      console.log('💾 Thread state saved');
      
      // Update stats
      const statsPath = path.join(userDir, 'stats.json');
      if (await fs.pathExists(statsPath)) {
        const stats = await fs.readJson(statsPath);
        stats.totalEmailsHandled = (stats.totalEmailsHandled || 0) + 1;
        stats.emailsToday = (stats.emailsToday || 0) + 1;
        stats.recentActivity = stats.recentActivity || [];
        stats.recentActivity.unshift({
          timestamp: new Date().toISOString(),
          action: 'PROPOSED',
          senderEmail: from,
          details: `Proposed ${slots.length} slots for ${classification.extractedTopic || subject}`,
          threadId
        });
        stats.recentActivity = stats.recentActivity.slice(0, 50);
        await fs.writeJson(statsPath, stats);
        console.log('📊 Stats updated');
      }
    }
    
  } catch (err) {
    console.error('❌ Error processing email:', err.message);
  }
  
  console.log('--- Message processing complete ---\n');
}

// ============ AI FUNCTIONS ============

async function classifyEmail(body, subject, from) {
  console.log('🤖 Classifying email with full context...');
  
  // QUICK PRE-FILTER: Check for obvious non-scheduling emails BEFORE calling AI
  const bodyLower = (body + ' ' + subject).toLowerCase();
  const fromLower = (from || '').toLowerCase();
  
  // List of promotional/ad/spam patterns
  const promotionalPatterns = [
    'unsubscribe', 'newsletter', 'offer', 'discount', 'sale', 'buy now',
    'limited time', 'free trial', 'click here', 'act now', 'special promotion',
    'exclusive deal', 'save up to', 'order now', 'shop now', 'best seller',
    'noreply@', 'no-reply@', 'donotreply@', 'notification@', 'alert@',
    'marketing@', 'sales@', 'promo@', 'info@', 'news@', 'updates@',
    'your weekly', 'your monthly', 'digest', 'roundup', 'recap',
    'thank you for your purchase', 'order confirmation', 'receipt',
    'shipping confirmation', 'delivery update', 'track your',
    'you have been selected', 'congratulations you', 'you won',
    'social media', 'linkedin notification', 'facebook notification',
    'twitter notification', 'instagram notification', 'new follower',
    'mentioned you', 'tagged you', 'commented on', 'liked your'
  ];
  
  const isPromotional = promotionalPatterns.some(pattern => 
    bodyLower.includes(pattern) || subject.toLowerCase().includes(pattern) || fromLower.includes(pattern)
  );
  
  if (isPromotional) {
    console.log('🛑 Pre-filtered as PROMOTIONAL/AD - skipping');
    return { intent: 'NOT_SCHEDULING', confidence: 0.99, reason: 'promotional_or_ad' };
  }
  
  // Check for automated/system emails
  const automatedPatterns = [
    'automated message', 'do not reply', 'this is an automated',
    'please do not reply', 'auto-generated', 'system notification',
    'password reset', 'verification code', 'security alert',
    'login attempt', 'new sign-in', 'account update'
  ];
  
  const isAutomated = automatedPatterns.some(pattern => bodyLower.includes(pattern));
  
  if (isAutomated) {
    console.log('🛑 Pre-filtered as AUTOMATED/SYSTEM - skipping');
    return { intent: 'NOT_SCHEDULING', confidence: 0.99, reason: 'automated_email' };
  }
  
  // NOW call AI for deeper understanding
  try {
    console.log('🔄 Calling AI for deep classification...');
    
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'meta-llama/llama-3-8b-instruct:free',
        messages: [
          {
            role: 'system',
            content: `You are an expert email classifier. Your job is to read emails carefully and determine if the sender genuinely wants to schedule a meeting/call/discussion.

Return ONLY a valid JSON object with these fields:
{
  "intent": "SCHEDULING" | "NOT_SCHEDULING" | "UNCERTAIN",
  "confidence": 0.0 to 1.0,
  "reason": "brief explanation of your decision",
  "extractedTopic": "the topic/purpose of the meeting if scheduling, otherwise null",
  "extractedDuration": "requested duration in minutes if mentioned, otherwise null",
  "urgency": "high" | "medium" | "low",
  "senderType": "colleague" | "client" | "friend" | "stranger" | "recruiter" | "service"
}

SCHEDULING means:
- Someone explicitly asks to meet, schedule a call, discuss something at a specific time
- Someone asks about your availability for a meeting
- Someone wants to "catch up", "chat", "discuss", "connect" with clear intent to schedule
- Someone proposes specific dates/times
- A recruiter wants to schedule an interview
- A client wants to discuss a project

NOT_SCHEDULING means:
- Newsletters, promotions, ads, marketing emails
- Automated notifications, alerts, system messages
- Casual "how are you" without meeting intent
- Thank you notes, confirmations of things already scheduled
- Information sharing without meeting request
- Calendar invites already sent (these are handled by Google Calendar)

UNCERTAIN means:
- Vague "let's talk sometime" without any concrete ask
- Hard to tell if they want to meet or just chatting
- Mixed signals`
          },
          {
            role: 'user',
            content: `Analyze this email carefully:

FROM: ${from}
SUBJECT: ${subject}
BODY:
${body.substring(0, 1500)}

Does this person genuinely want to schedule a meeting? Extract the topic, duration, and urgency if they do.`
          }
        ],
        max_tokens: 250,
        temperature: 0.1
      },
      {
        headers: {
          'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );
    
    const content = response.data.choices[0].message.content;
    console.log('🤖 AI Classification:', content);
    
    // Extract JSON from response
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      const result = JSON.parse(match[0]);
      console.log('✅ Classification:', result.intent, '-', result.reason);
      return result;
    }
    
    return { intent: 'NOT_SCHEDULING', confidence: 0.5, reason: 'ai_parse_failed' };
    
  } catch (err) {
    console.error('❌ AI classification error:', err.message);
    
    // Fallback keyword detection
    const meetingKeywords = [
      'meet', 'meeting', 'schedule', 'call', 'catch up', 'discuss',
      'availability', 'calendar', 'free for', 'let\'s connect',
      'when can we', 'are you available', 'what time works',
      'set up a', 'book a', 'schedule a', 'find time'
    ];
    
    const hasMeetingIntent = meetingKeywords.some(kw => bodyLower.includes(kw));
    
    return {
      intent: hasMeetingIntent ? 'SCHEDULING' : 'NOT_SCHEDULING',
      confidence: 0.4,
      reason: 'keyword_fallback'
    };
  }
}

function findAvailableSlotsSimple() {
  const slots = [];
  const now = new Date();
  
  // Generate slots for next 5 business days
  for (let i = 1; i <= 5; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() + i);
    
    // Skip weekends
    if (date.getDay() === 0 || date.getDay() === 6) continue;
    
    // Morning slot: 10:00 AM
    const morningSlot = new Date(date);
    morningSlot.setHours(10, 0, 0, 0);
    
    // Afternoon slot: 2:00 PM
    const afternoonSlot = new Date(date);
    afternoonSlot.setHours(14, 0, 0, 0);
    
    // Evening slot: 4:00 PM
    const eveningSlot = new Date(date);
    eveningSlot.setHours(16, 0, 0, 0);
    
    [morningSlot, afternoonSlot, eveningSlot].forEach(slotStart => {
      if (slotStart > now) {
        const slotEnd = new Date(slotStart.getTime() + 30 * 60000);
        slots.push({
          start: slotStart.toISOString(),
          end: slotEnd.toISOString(),
          day: slotStart.toLocaleString('en-US', { weekday: 'long' }),
          date: slotStart.toISOString().split('T')[0],
          startTime: slotStart.toLocaleString('en-IN', { 
            hour: '2-digit', minute: '2-digit', hour12: true, timeZone: TIMEZONE 
          }),
          endTime: slotEnd.toLocaleString('en-IN', { 
            hour: '2-digit', minute: '2-digit', hour12: true, timeZone: TIMEZONE 
          })
        });
      }
    });
  }
  
  return slots.slice(0, 3);
}

async function generateReply(from, slots, tone, emailBody, subject, classification) {
  const name = extractName(from);
  const topic = (classification && classification.extractedTopic) || subject || 'discussion';
  const duration = (classification && classification.extractedDuration) || 30;
  
  const slotLines = slots.map((s, i) => 
    `${i + 1}. ${s.day}, ${s.date} at ${s.startTime} - ${s.endTime} IST (${duration} min)`
  ).join('\n');
  
  console.log('✍️ Generating personalized reply...');
  console.log('   Topic:', topic);
  console.log('   Name:', name);
  console.log('   Sender type:', classification?.senderType);
  
  try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: 'mistralai/mistral-7b-instruct',
        messages: [
          {
            role: 'system',
            content: `You are a personal assistant writing a genuine, human-like email reply. 

CRITICAL RULES:
- READ the original email carefully and reference it naturally
- Mention the topic they want to discuss
- Sound like a real person, not a template
- Be warm but professional
- Use "${tone.greeting}" as greeting style
- Sign off with "${tone.signOff}"
- Keep it 3-5 sentences
- DON'T sound robotic or generic
- Reference something specific from their email
- If they mention urgency, acknowledge it
- Adapt tone based on sender: more casual for friends, more formal for clients

The available time slots are in IST (Indian Standard Time).`
          },
          {
            role: 'user',
            content: `Write a reply to ${name}.

Original email subject: "${subject}"
Original email body: "${emailBody.substring(0, 500)}"
Topic they want to discuss: ${topic}
Sender type: ${classification?.senderType || 'unknown'}

Propose these meeting times (all in IST):
${slotLines}

Make the reply sound natural and reference their email. Don't just list times - acknowledge what they wrote about.`
          }
        ],
        max_tokens: 300,
        temperature: 0.8
      },
      {
        headers: {
          'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );
    
    const reply = response.data.choices[0].message.content;
    console.log('✅ Generated personalized reply');
    return reply;
    
  } catch (err) {
    console.error('❌ AI reply generation failed, using smart template');
    
    // SMART FALLBACK - still personalized
    const urgencyNote = (classification && classification.urgency === 'high') ? 'I understand this is time-sensitive. ' : '';
    const topicRef = topic !== 'discussion' ? ` regarding ${topic}` : '';
    
    return `${tone.greeting} ${name},

Thanks for reaching out${topicRef}! ${urgencyNote}I'd be happy to connect. Here are some times that work for me (IST):

${slotLines}

Let me know which slot works best for you.

${tone.signOff}`;
  }
}

// Helper function to extract name from email
function extractName(from) {
  if (!from) return 'there';
  // Try "Name <email>" format first
  const nameMatch = from.match(/^"?([^"<]+)"?\s*</);
  if (nameMatch) {
    return nameMatch[1].trim().split(' ')[0]; // First name only
  }
  
  // Fallback: extract from email
  const emailPart = from.match(/([^@]+)@/);
  if (emailPart) {
    return emailPart[1].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).split(' ')[0];
  }
  
  return 'there';
}

async function sendEmailReply(gmail, threadId, body, recipientEmail, originalSubject) {
  try {
    console.log('📧 Preparing email to:', recipientEmail);
    
    // Extract clean email address from "Name <email>" format
    let cleanEmail = recipientEmail;
    const emailMatch = recipientEmail.match(/<(.+?)>/);
    if (emailMatch) {
      cleanEmail = emailMatch[1];
    }
    console.log('📧 Clean email:', cleanEmail);
    
    // Create the email in RFC 2822 format with proper headers
    const emailLines = [
      `To: ${recipientEmail}`,
      `Subject: Re: ${originalSubject || 'Meeting'}`,
      'Content-Type: text/plain; charset="UTF-8"',
      'MIME-Version: 1.0',
      '',
      body
    ];
    
    const emailContent = emailLines.join('\r\n');
    
    // Encode to base64 for Gmail API
    const encodedEmail = Buffer.from(emailContent)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    
    console.log('📧 Email encoded, length:', encodedEmail.length);
    
    // Send via Gmail API
    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedEmail,
        threadId: threadId
      }
    });
    
    console.log('✅ Email sent successfully!');
    console.log('📧 Message ID:', response.data.id);
    console.log('📧 Thread ID:', response.data.threadId);
    
    return response.data;
    
  } catch (err) {
    console.error('❌ Send email failed:', err.message);
    console.error('❌ Full error:', err);
    throw err;
  }
}

// ============ USER API ROUTES ============

app.get('/api/user/status', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Email required' });
  
  const userDir = path.join(USERS_DIR, email);
  const exists = await fs.pathExists(userDir);
  
  if (!exists) return res.json({ status: 'not_found' });
  
  const pausedPath = path.join(userDir, 'paused.json');
  const paused = await fs.pathExists(pausedPath);
  
  const rulesPath = path.join(userDir, 'rules.json');
  const rules = await fs.pathExists(rulesPath) ? await fs.readJson(rulesPath) : null;
  
  return res.json({
    status: rules?.confirmed ? 'active' : 'setup_required',
    paused,
    email
  });
});

// Reset processed emails and start fresh
app.post('/api/user/reset-processed', async (req, res) => {
  const email = (req.body?.email || req.query?.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Email required' });
  
  const userDir = path.join(USERS_DIR, email);
  const processedDir = path.join(userDir, 'processed');
  
  if (await fs.pathExists(processedDir)) {
    await fs.remove(processedDir);
    await fs.ensureDir(processedDir);
  }
  
  // Update service start time to NOW
  const statsPath = path.join(userDir, 'stats.json');
  if (await fs.pathExists(statsPath)) {
    const stats = await fs.readJson(statsPath);
    stats.serviceStartedAt = new Date().toISOString();
    await fs.writeJson(statsPath, stats);
  }
  
  console.log('🔄 Reset processed emails for:', email);
  
  // Trigger immediate check
  processEmailsForUser(email);
  
  res.json({ success: true, message: 'Reset complete. Only new emails will be processed.' });
});

// ActivePieces marketplace introspect endpoint
app.get('/api/marketplace/introspect', (req, res) => {
  res.json({
    name: "Gravity Meeting Scheduler",
    version: "1.0.0",
    description: "Autonomous AI agent that handles meeting scheduling emails 24/7",
    author: {
      name: "Jayaprakash Dey",
      email: "deyjayprakash123@gmail.com"
    },
    capabilities: [
      "email_classification",
      "calendar_availability",
      "slot_proposal",
      "auto_reply",
      "meeting_booking",
      "conversation_tracking"
    ],
    integrations: ["gmail", "google-calendar", "openrouter"],
    status: "active",
    url: "https://gravity-backend-rdvr.onrender.com",
    frontend: "https://gravity-frontend-rose.vercel.app"
  });
});

app.post('/api/marketplace/introspect', (req, res) => {
  res.json({
    valid: true,
    name: "Gravity Meeting Scheduler",
    status: "operational",
    endpoints: {
      webhook: "/webhook/gmail",
      health: "/health",
      dashboard: "/api/user/dashboard"
    }
  });
});

app.get('/api/user/dashboard', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Email required' });
  
  try {
    const userDir = path.join(USERS_DIR, email);
    if (!await fs.pathExists(userDir)) {
      return res.json({ status: 'new_user', stats: { emailsHandled: 0, meetingsBooked: 0, activeThreads: 0, needsAttention: 0 }, recentActivity: [] });
    }
    
    const statsPath = path.join(userDir, 'stats.json');
    const stats = await fs.pathExists(statsPath) ? await fs.readJson(statsPath) : { totalEmailsHandled: 0, totalMeetingsBooked: 0 };
    
    // Count active threads
    const threadsDir = path.join(userDir, 'threads');
    let activeCount = 0;
    if (await fs.pathExists(threadsDir)) {
      const files = await fs.readdir(threadsDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const t = await fs.readJson(path.join(threadsDir, file));
          if (['PROPOSED', 'NEGOTIATING'].includes(t.state)) activeCount++;
        }
      }
    }
    
    return res.json({
      status: 'active',
      stats: {
        emailsHandled: stats.totalEmailsHandled || 0,
        meetingsBooked: stats.totalMeetingsBooked || 0,
        activeThreads: activeCount,
        needsAttention: stats.totalThreadsFlagged || 0,
        emailsToday: stats.emailsToday || 0,
        meetingsToday: stats.meetingsToday || 0
      },
      recentActivity: (stats.recentActivity || []).slice(0, 50)
    });
  } catch (err) {
    return res.json({ status: 'error', stats: { emailsHandled: 0, meetingsBooked: 0, activeThreads: 0, needsAttention: 0 }, recentActivity: [] });
  }
});

app.get('/api/user/rules', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Email required' });
  
  const rulesPath = path.join(USERS_DIR, email, 'rules.json');
  if (!await fs.pathExists(rulesPath)) {
    return res.json({
      workingHours: { start: '09:30', end: '18:30' },
      buffers: { beforeMinutes: 15, afterMinutes: 15 },
      noMeetingDays: ['Saturday', 'Sunday'],
      maxMeetingsPerDay: 6,
      preferredDuration: 30,
      timezone: TIMEZONE,
      confirmed: false
    });
  }
  
  return res.json(await fs.readJson(rulesPath));
});

app.post('/api/user/pause', async (req, res) => {
  const email = (req.body.email || req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Email required' });
  
  await fs.writeJson(path.join(USERS_DIR, email, 'paused.json'), { paused: true, pausedAt: new Date().toISOString() });
  console.log('⏸️ Paused:', email);
  return res.json({ success: true });
});

app.post('/api/user/resume', async (req, res) => {
  const email = (req.body.email || req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Email required' });
  
  const pausePath = path.join(USERS_DIR, email, 'paused.json');
  if (await fs.pathExists(pausePath)) {
    await fs.remove(pausePath);
  }
  console.log('▶️ Resumed:', email);
  
  // Trigger immediate email check
  processEmailsForUser(email).catch(err => console.error('Resume check error:', err.message));
  
  return res.json({ success: true });
});

app.post('/api/user/rules/confirm', async (req, res) => {
  const email = (req.body.email || req.query.email || '').toLowerCase().trim();
  const rules = req.body.rules;
  if (!email || !rules) return res.status(400).json({ error: 'Email and rules required' });
  
  const rulesPath = path.join(USERS_DIR, email, 'rules.json');
  const existingRules = await fs.pathExists(rulesPath) ? await fs.readJson(rulesPath) : {};
  const updatedRules = { ...existingRules, ...rules, confirmed: true, confirmedAt: new Date().toISOString() };
  await fs.writeJson(rulesPath, updatedRules);
  
  console.log('✅ Rules confirmed for:', email);
  
  // Trigger immediate email check after rules confirmed
  processEmailsForUser(email).catch(err => console.error('Post-confirm check error:', err.message));
  
  return res.json({ success: true });
});

app.get('/api/user/threads', async (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'Email required' });
  
  const threadsDir = path.join(USERS_DIR, email, 'threads');
  if (!await fs.pathExists(threadsDir)) return res.json({ threads: [] });
  
  const files = await fs.readdir(threadsDir);
  const threads = [];
  for (const file of files) {
    if (file.endsWith('.json')) {
      threads.push(await fs.readJson(path.join(threadsDir, file)));
    }
  }
  
  threads.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return res.json({ threads });
});

app.get('/api/credits/check', async (req, res) => {
  try {
    const response = await axios.get('https://openrouter.ai/api/v1/auth/key', {
      headers: { 'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY }
    });
    const credits = response.data.data?.credits || 0;
    res.json({ credits, sufficient: credits > 0, contactEmail: 'deyjayprakash123@gmail.com' });
  } catch (err) {
    res.json({ credits: 0, sufficient: false, contactEmail: 'deyjayprakash123@gmail.com' });
  }
});

app.get('/api/global/users', async (req, res) => {
  try {
    const userSet = new Set();
    const usersListPath = path.join(DATA_DIR, 'global', 'users-list.json');
    if (await fs.pathExists(usersListPath)) {
      const list = await fs.readJson(usersListPath);
      (list || []).forEach(u => userSet.add(u.toLowerCase().trim()));
    }
    
    if (await fs.pathExists(USERS_DIR)) {
      const dirs = await fs.readdir(USERS_DIR);
      for (const d of dirs) {
        if (d.includes('@')) userSet.add(d.toLowerCase().trim());
      }
    }
    
    const users = Array.from(userSet);
    return res.json({ users, count: users.length });
  } catch (err) {
    return res.json({ users: [], count: 0 });
  }
});

// Manual trigger for email checking
app.post('/api/user/check-emails', async (req, res) => {
  const email = (req.body?.email || req.query?.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Email required' });
  
  console.log('🔍 Manual email check triggered for:', email);
  
  try {
    await processEmailsForUser(email);
    res.json({ success: true, message: 'Email check completed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint to check user state
app.get('/api/user/debug', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'Email required' });
  
  const userDir = path.join(USERS_DIR, email);
  
  const debug = {
    email,
    userDirExists: await fs.pathExists(userDir),
    tokensExist: await fs.pathExists(path.join(userDir, 'tokens.json')),
    rulesExist: await fs.pathExists(path.join(userDir, 'rules.json')),
    statsExist: await fs.pathExists(path.join(userDir, 'stats.json')),
    pausedExist: await fs.pathExists(path.join(userDir, 'paused.json')),
    threadsDirExists: await fs.pathExists(path.join(userDir, 'threads')),
  };
  
  // Get rules if they exist
  if (debug.rulesExist) {
    const rules = await fs.readJson(path.join(userDir, 'rules.json'));
    debug.rulesConfirmed = rules.confirmed;
    debug.rules = rules;
  }
  
  // Get stats if they exist
  if (debug.statsExist) {
    const stats = await fs.readJson(path.join(userDir, 'stats.json'));
    debug.serviceStartedAt = stats.serviceStartedAt;
    debug.emailsHandled = stats.totalEmailsHandled;
  }
  
  // Count threads
  if (debug.threadsDirExists) {
    const files = await fs.readdir(path.join(userDir, 'threads'));
    debug.threadCount = files.filter(f => f.endsWith('.json')).length;
  }
  
  // Count processed emails
  const processedDir = path.join(userDir, 'processed');
  if (await fs.pathExists(processedDir)) {
    const files = await fs.readdir(processedDir);
    debug.processedCount = files.filter(f => f.endsWith('.json')).length;
  }
  
  res.json(debug);
});

// Helper to get all registered users
async function getGlobalUserList() {
  const userSet = new Set();
  const usersListPath = path.join(DATA_DIR, 'global', 'users-list.json');
  if (await fs.pathExists(usersListPath)) {
    const list = await fs.readJson(usersListPath);
    (list || []).forEach(u => userSet.add(u.toLowerCase().trim()));
  }
  if (await fs.pathExists(USERS_DIR)) {
    const dirs = await fs.readdir(USERS_DIR);
    for (const d of dirs) {
      if (d.includes('@')) userSet.add(d.toLowerCase().trim());
    }
  }
  return Array.from(userSet);
}

// ============ GLOBAL SCHEDULER - Run immediately on startup & every 2 mins ============
console.log('🔄 Scheduling initial email check for all users...');
setTimeout(async () => {
  try {
    const users = await getGlobalUserList();
    if (users.length > 0) {
      console.log(`📬 Startup check: Found ${users.length} users, checking emails...`);
      for (const email of users) {
        await processEmailsForUser(email);
      }
    }
  } catch (err) {
    console.error('Initial check error:', err.message);
  }
}, 5000); // Run 5 seconds after startup

cron.schedule('*/2 * * * *', async () => {
  console.log(`\n🔄 [${new Date().toISOString()}] SCHEDULER: Checking all users...`);
  try {
    const users = await getGlobalUserList();
    if (users.length === 0) {
      console.log('📭 No users found');
      return;
    }
    
    console.log(`👥 ${users.length} users in list`);
    
    for (const email of users) {
      console.log(`\n📧 Checking: ${email}`);
      await processEmailsForUser(email);
    }
  } catch (err) {
    console.error('❌ Scheduler error:', err.message);
  }
  console.log('✅ Scheduler cycle complete\n');
});

// Keep-alive
cron.schedule('*/10 * * * *', async () => {
  try {
    await axios.get('https://gravity-backend-rdvr.onrender.com/health');
  } catch (err) {}
});

// ============ START SERVER ============
const rawPort = process.env.PORT;
const parsedPort = parseInt(rawPort, 10);
const PORT = (!isNaN(parsedPort) && parsedPort > 0) ? parsedPort : 10000;

app.listen(PORT, '0.0.0.0', () => {
  console.log('========================================');
  console.log('🚀 MEETING SCHEDULER AI - SERVER READY');
  console.log('========================================');
  console.log('📍 Port:', PORT);
  console.log('📍 Timezone:', TIMEZONE);
  console.log('📍 Health: https://gravity-backend-rdvr.onrender.com/health');
  console.log('📍 OAuth: https://gravity-backend-rdvr.onrender.com/oauth/callback');
  console.log('📍 Users: https://gravity-backend-rdvr.onrender.com/api/global/users');
  console.log('========================================');
  console.log('📧 Waiting for emails to process...');
  console.log('🔄 Polling every 2 minutes');
  console.log('========================================\n');
});
