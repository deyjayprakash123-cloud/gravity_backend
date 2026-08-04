const { google } = require('googleapis');
const fs = require('fs-extra');
const path = require('path');
const { loadRefreshToken, saveRefreshToken } = require('./memory');
const logger = require('./logger');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth/callback';

/**
 * Creates OAuth2 client instance
 */
function createOAuth2Client() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

/**
 * Get authorization URL for user onboarding
 */
function getAuthUrl() {
  const oauth2Client = createOAuth2Client();
  const scopes = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar'
  ];

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes
  });
}

/**
 * Get authenticated Gmail client using stored refresh token
 */
async function getGmailClient() {
  try {
    let refreshToken = await loadRefreshToken();
    if (!refreshToken) {
      const altTokenPath1 = path.join('/opt/render/project/data/tokens', 'refresh_token.json');
      const altTokenPath2 = path.join('/opt/render/project/data/tokens', 'refresh-token.json');
      if (fs.existsSync(altTokenPath1)) {
        const raw = fs.readFileSync(altTokenPath1, 'utf8').trim();
        try {
          const parsed = JSON.parse(raw);
          refreshToken = parsed.refreshToken || parsed.refresh_token || raw;
        } catch (e) {
          refreshToken = raw;
        }
      } else if (fs.existsSync(altTokenPath2)) {
        const raw = fs.readFileSync(altTokenPath2, 'utf8').trim();
        try {
          const parsed = JSON.parse(raw);
          refreshToken = parsed.refreshToken || parsed.refresh_token || raw;
        } catch (e) {
          refreshToken = raw;
        }
      }
    }

    if (!refreshToken) {
      throw new Error('No refresh token found. User needs to authenticate first.');
    }

    const oauth2Client = createOAuth2Client();
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    await oauth2Client.getAccessToken();
    console.log('✅ Gmail client authenticated');

    return google.gmail({ version: 'v1', auth: oauth2Client });
  } catch (error) {
    console.error('❌ Gmail auth failed:', error.message);
    throw error;
  }
}

/**
 * Exchange OAuth authorization code for tokens
 */
async function handleOAuthCode(code) {
  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  if (tokens.refresh_token) {
    await saveRefreshToken(tokens.refresh_token);
    await logger.info('GmailService', 'Stored new OAuth refresh token');
  }
  return tokens;
}

/**
 * Decode base64 / base64url email content
 */
function decodeBody(part) {
  if (!part) return '';
  let bodyStr = '';
  if (part.body && part.body.data) {
    bodyStr = Buffer.from(part.body.data, 'base64url').toString('utf8');
  } else if (part.parts) {
    for (const subPart of part.parts) {
      if (subPart.mimeType === 'text/plain' && subPart.body && subPart.body.data) {
        bodyStr += Buffer.from(subPart.body.data, 'base64url').toString('utf8');
      } else if (subPart.mimeType === 'text/html' && !bodyStr && subPart.body && subPart.body.data) {
        bodyStr = Buffer.from(subPart.body.data, 'base64url').toString('utf8').replace(/<[^>]+>/g, ' ');
      }
    }
  }
  return bodyStr;
}

/**
 * Extract headers helper
 */
function getHeader(headers, name) {
  const header = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return header ? header.value : '';
}

/**
 * Detect sender timezone from Date header or Received headers
 */
function getSenderTimezone(headers) {
  const dateHeader = getHeader(headers, 'Date');
  if (dateHeader) {
    const tzMatch = dateHeader.match(/([+-]\d{4})/);
    if (tzMatch) {
      return tzMatch[1];
    }
  }
  return null;
}

/**
 * Check for auto-responder headers
 */
function checkAutoResponderHeaders(headers) {
  const autoSubmitted = getHeader(headers, 'Auto-Submitted');
  const xAutoreply = getHeader(headers, 'X-Autoreply');
  const precedence = getHeader(headers, 'Precedence');
  const xAutoResponse = getHeader(headers, 'X-Autorespond');

  if (autoSubmitted && autoSubmitted !== 'no') return true;
  if (xAutoreply && xAutoreply.toLowerCase() === 'yes') return true;
  if (precedence && (precedence.toLowerCase() === 'auto_reply' || precedence.toLowerCase() === 'junk' || precedence.toLowerCase() === 'bulk')) return true;
  if (xAutoResponse) return true;

  return false;
}

/**
 * Fetch complete email details by message ID
 */
async function fetchEmailContent(messageId) {
  const gmail = await getGmailClient();
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full'
  });

  const message = res.data;
  const headers = message.payload.headers || [];

  const from = getHeader(headers, 'From');
  const to = getHeader(headers, 'To');
  const subject = getHeader(headers, 'Subject');
  const date = getHeader(headers, 'Date');
  const messageIdHeader = getHeader(headers, 'Message-ID');
  const references = getHeader(headers, 'References');

  const senderMatch = from.match(/<([^>]+)>/) || [null, from];
  const senderEmail = senderMatch[1].trim().toLowerCase();

  const body = decodeBody(message.payload);
  const isAutoReply = checkAutoResponderHeaders(headers);
  const senderTimezone = getSenderTimezone(headers);

  return {
    id: message.id,
    threadId: message.threadId,
    from,
    senderEmail,
    to,
    subject,
    date,
    messageIdHeader,
    references,
    body: body.trim(),
    isAutoReply,
    senderTimezone,
    snippet: message.snippet
  };
}

/**
 * Send reply preserving thread context
 */
async function sendReply(arg1, arg2, arg3) {
  let threadId, to, subject, body, inReplyToMessageId, auth;

  if (typeof arg1 === 'object' && arg1 !== null) {
    threadId = arg1.threadId;
    to = arg1.to;
    subject = arg1.subject || 'Meeting Request';
    body = arg1.body || arg1.replyText || '';
    inReplyToMessageId = arg1.inReplyToMessageId || arg1.messageId;
    auth = arg1.auth;
  } else {
    threadId = arg1;
    body = arg2;
    auth = arg3;
  }

  try {
    const gmail = auth ? google.gmail({ version: 'v1', auth }) : await getGmailClient();

    let lastMessageId = inReplyToMessageId;
    let targetSubject = subject;
    let targetTo = to;

    if (!targetTo || !targetSubject || !lastMessageId) {
      const threadRes = await gmail.users.threads.get({ userId: 'me', id: threadId });
      const messages = threadRes.data.messages || [];
      const lastMessage = messages[messages.length - 1];
      if (lastMessage) {
        lastMessageId = lastMessageId || lastMessage.id;
        const headers = lastMessage.payload.headers || [];
        const subjHeader = headers.find(h => h.name.toLowerCase() === 'subject')?.value || 'Meeting Request';
        targetSubject = targetSubject || (subjHeader.toLowerCase().startsWith('re:') ? subjHeader : `Re: ${subjHeader}`);
        const fromHeader = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
        targetTo = targetTo || fromHeader;
      }
    }

    const formattedSubject = targetSubject.toLowerCase().startsWith('re:') ? targetSubject : `Re: ${targetSubject}`;

    const rawEmail = [
      `To: ${targetTo}`,
      `Subject: ${formattedSubject}`,
      `In-Reply-To: ${lastMessageId}`,
      `References: ${lastMessageId}`,
      `Content-Type: text/plain; charset=utf-8`,
      `MIME-Version: 1.0`,
      '',
      body
    ].join('\r\n');

    const encodedMessage = Buffer.from(rawEmail)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
        threadId: threadId
      }
    });

    console.log('✅ Reply sent! Message ID:', response.data.id);
    await logger.info('GmailService', `Sent reply in thread ${threadId}`, { messageId: response.data.id });
    return response.data;
  } catch (error) {
    console.error('❌ Failed to send reply:', error);
    throw error;
  }
}

/**
 * Set up Gmail Push Notifications (Watch API)
 */
async function setupGmailWatch(topicName) {
  const targetTopic = topicName || process.env.PUBSUB_TOPIC;
  if (!targetTopic) {
    logger.warn('GmailService', 'No Pub/Sub topicName provided for Gmail watch setup');
    return null;
  }
  try {
    const gmail = await getGmailClient();
    const res = await gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName: targetTopic,
        labelIds: ['INBOX']
      }
    });

    await logger.info('GmailService', 'Gmail push notification watch enabled', res.data);
    return res.data;
  } catch (err) {
    await logger.error('GmailService', 'Error setting up Gmail watch', err.message);
    throw err;
  }
}

/**
 * Verify push notifications status
 */
async function verifyPushNotifications(auth) {
  const gmail = auth ? google.gmail({ version: 'v1', auth }) : await getGmailClient();
  const topicName = process.env.PUBSUB_TOPIC;
  try {
    const response = await gmail.users.watch({
      userId: 'me',
      requestBody: {
        labelIds: ['INBOX'],
        topicName: topicName
      }
    });
    console.log('Watch active until:', new Date(response.data.expiration));
    return response.data;
  } catch (error) {
    console.error('Watch setup failed:', error);
    throw error;
  }
}

/**
 * Renew Gmail watch
 */
async function renewGmailWatch(topicName) {
  return await setupGmailWatch(topicName);
}

module.exports = {
  createOAuth2Client,
  getAuthUrl,
  handleOAuthCode,
  getGmailClient,
  fetchEmailContent,
  sendReply,
  setupGmailWatch,
  verifyPushNotifications,
  renewGmailWatch,
  checkAutoResponderHeaders,
  getSenderTimezone
};
