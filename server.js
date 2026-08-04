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
  console.log(`\n📬 ========== CHECKING EMAILS FOR: ${userEmail} ==========`);
  
  try {
    // Check if user exists
    const userDir = path.join(USERS_DIR, userEmail);
    if (!await fs.pathExists(userDir)) {
      console.log('❌ User directory not found');
      return;
    }
    
    // Check if paused
    const pausePath = path.join(userDir, 'paused.json');
    if (await fs.pathExists(pausePath)) {
      console.log('⏸️ Scheduler is PAUSED for', userEmail);
      return;
    }
    
    // Check tokens
    const tokensPath = path.join(userDir, 'tokens.json');
    if (!await fs.pathExists(tokensPath)) {
      console.log('❌ No tokens found');
      return;
    }
    
    const tokens = await fs.readJson(tokensPath);
    console.log('✅ Tokens loaded');
    
    // Create Gmail client
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'https://gravity-backend-rdvr.onrender.com/oauth/callback'
    );
    oauth2Client.setCredentials(tokens);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    
    // Get service start time from stats
    const statsPath = path.join(userDir, 'stats.json');
    let serviceStartTime = new Date().toISOString();
    if (await fs.pathExists(statsPath)) {
      const stats = await fs.readJson(statsPath);
      serviceStartTime = stats.serviceStartedAt || new Date().toISOString();
    }
    console.log('🕐 Service started at:', serviceStartTime);
    
    // Search for unread emails received AFTER service start
    const afterTimestamp = Math.floor(new Date(serviceStartTime).getTime() / 1000);
    
    console.log('🔍 Searching for unread emails...');
    
    const messagesResponse = await gmail.users.messages.list({
      userId: 'me',
      q: `is:unread -from:me after:${afterTimestamp}`,
      maxResults: 10
    });
    
    const messages = messagesResponse.data.messages || [];
    console.log(`📧 Found ${messages.length} unread messages`);
    
    if (messages.length === 0) {
      console.log('📭 No new unread messages to process');
      console.log('========================================\n');
      return;
    }
    
    // Process each message
    for (const msg of messages) {
      await processSingleEmail(userEmail, msg.id, gmail, userDir);
    }
    
    console.log('========================================\n');
    
  } catch (err) {
    console.error('❌ Email processing error:', err.message);
    console.error('Full error:', err);
  }
}

async function processSingleEmail(userEmail, messageId, gmail, userDir) {
  console.log(`\n--- Processing message: ${messageId} ---`);
  
  try {
    // Check if already processed
    const processedDir = path.join(userDir, 'processed');
    await fs.ensureDir(processedDir);
    const processedPath = path.join(processedDir, `${messageId}.json`);
    
    if (await fs.pathExists(processedPath)) {
      console.log('⏭️ Already processed, skipping');
      return;
    }
    
    // Mark as processed immediately to prevent double processing
    await fs.writeJson(processedPath, { 
      processedAt: new Date().toISOString(),
      messageId 
    });
    
    // Get full email
    console.log('📥 Fetching full email...');
    const email = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full'
    });
    
    const headers = email.data.payload.headers;
    const from = headers.find(h => h.name === 'From')?.value || '';
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const threadId = email.data.threadId;
    const messageIdHeader = headers.find(h => h.name === 'Message-ID')?.value || '';
    
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
    console.log('🤖 Classifying with AI...');
    const classification = await classifyEmail(body, subject);
    console.log('📊 Classification result:', JSON.stringify(classification));
    
    if (classification.intent === 'NOT_SCHEDULING') {
      console.log('📝 Not a meeting request, leaving in inbox');
      return;
    }
    
    if (classification.intent === 'SCHEDULING') {
      console.log('🎯 MEETING REQUEST DETECTED! Finding slots...');
      
      // Find available slots
      const slots = findAvailableSlotsSimple();
      console.log('📅 Generated slots:', slots.length);
      
      if (slots.length === 0) {
        console.log('❌ No slots available');
        return;
      }
      
      // Load tone and rules
      const tonePath = path.join(userDir, 'tone.json');
      const tone = await fs.pathExists(tonePath) ? await fs.readJson(tonePath) : { greeting: 'Hi', signOff: 'Best' };
      
      // Generate reply
      console.log('✍️ Generating reply...');
      const replyBody = await generateReply(from, slots, tone, body);
      console.log('📤 Reply generated:', replyBody.substring(0, 100));
      
      // Send reply - PASS THE FROM ADDRESS
      console.log('📤 Sending reply to:', from);
      await sendEmailReply(gmail, threadId, replyBody, from, subject);
      console.log('✅ REPLY SENT SUCCESSFULLY!');
      
      // Save thread state
      const threadData = {
        threadId,
        state: 'PROPOSED',
        senderEmail: from,
        subject,
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
          details: `Proposed ${slots.length} time slots`,
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

async function classifyEmail(body, subject) {
  try {
    console.log('🔄 Calling OpenRouter API for classification...');
    
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
        messages: [
          {
            role: 'system',
            content: 'You classify emails. Return ONLY valid JSON: {"intent":"SCHEDULING","confidence":0.95} or {"intent":"NOT_SCHEDULING","confidence":0.95}. SCHEDULING means the sender wants to schedule a meeting/call/discussion at a specific time. NOT_SCHEDULING means newsletter, notification, casual chat, or anything not asking to meet.'
          },
          {
            role: 'user',
            content: `Subject: ${subject}\n\nBody: ${body.substring(0, 800)}`
          }
        ],
        max_tokens: 80,
        temperature: 0.1
      },
      {
        headers: {
          'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    
    const content = response.data.choices[0].message.content;
    console.log('🤖 AI response:', content);
    
    // Extract JSON
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    
    return { intent: 'NOT_SCHEDULING', confidence: 0.5 };
    
  } catch (err) {
    console.error('❌ Classification error:', err.message);
    
    // Check for credit exhaustion
    if (err.response?.status === 402 || (err.response?.data?.error?.message || '').includes('credits')) {
      console.error('⚠️⚠️⚠️ OPENROUTER CREDITS EXHAUSTED ⚠️⚠️⚠️');
      console.error('Contact: deyjayprakash123@gmail.com');
    }
    
    // Fallback: simple keyword check
    const meetingWords = ['meet', 'meeting', 'call', 'schedule', 'catch up', 'discuss', 'calendar', 'availability', 'free', 'time', 'slot'];
    const bodyLower = (body + ' ' + subject).toLowerCase();
    const hasMeetingWords = meetingWords.some(word => bodyLower.includes(word));
    
    return { intent: hasMeetingWords ? 'SCHEDULING' : 'NOT_SCHEDULING', confidence: 0.4 };
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

async function generateReply(from, slots, tone, originalBody) {
  const name = from.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  
  const slotLines = slots.map((s, i) => 
    `${i + 1}. ${s.day}, ${s.date} at ${s.startTime} - ${s.endTime} IST`
  ).join('\n');
  
  try {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
        messages: [
          {
            role: 'system',
            content: `Write a brief, friendly email reply to schedule a meeting. Use "${tone.greeting}" as greeting style. Sign off with "${tone.signOff}". Keep it 3-4 sentences maximum. Be warm but professional.`
          },
          {
            role: 'user',
            content: `Write to ${name}. Propose these meeting times (all in IST):\n${slotLines}\n\nAsk them to pick one slot that works for them. Keep it short and friendly.`
          }
        ],
        max_tokens: 200,
        temperature: 0.7
      },
      {
        headers: {
          'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    
    return response.data.choices[0].message.content;
    
  } catch (err) {
    console.error('❌ Reply generation error, using template');
    
    // Template fallback
    return `${tone.greeting} ${name},\n\nThanks for reaching out! I'd love to meet. Here are some times that work for me (IST):\n\n${slotLines}\n\nLet me know which works best for you.\n\n${tone.signOff}`;
  }
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

// ============ GLOBAL SCHEDULER - Checks all users every 2 minutes ============
cron.schedule('*/2 * * * *', async () => {
  try {
    const usersListPath = path.join(DATA_DIR, 'global', 'users-list.json');
    if (!await fs.pathExists(usersListPath)) return;
    
    const users = await fs.readJson(usersListPath);
    console.log(`\n🔄 [SCHEDULER] Checking emails for ${users.length} users...`);
    
    for (const email of users) {
      await processEmailsForUser(email);
    }
  } catch (err) {
    console.error('Scheduler error:', err.message);
  }
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
