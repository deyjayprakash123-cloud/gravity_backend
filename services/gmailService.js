const { google } = require('googleapis');
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
  const refreshToken = await loadRefreshToken();
  if (!refreshToken) {
    throw new Error('No OAuth refresh token available. User must connect Gmail first.');
  }

  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  return google.gmail({ version: 'v1', auth: oauth2Client });
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
    // Example: "Mon, 04 Aug 2026 10:00:00 -0400"
    const tzMatch = dateHeader.match(/([+-]\d{4})/);
    if (tzMatch) {
      return tzMatch[1]; // e.g. -0400
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

  // Extract clean email address from From header (e.g. "John Doe <john@example.com>" -> "john@example.com")
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
async function sendReply({ threadId, to, subject, body, inReplyToMessageId }) {
  const gmail = await getGmailClient();

  const formattedSubject = subject.toLowerCase().startsWith('re:') ? subject : `Re: ${subject}`;

  let rawEmail = [
    `To: ${to}`,
    `Subject: ${formattedSubject}`,
    `In-Reply-To: ${inReplyToMessageId}`,
    `References: ${inReplyToMessageId}`,
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

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw: encodedMessage,
      threadId: threadId
    }
  });

  await logger.info('GmailService', `Sent reply to ${to} in thread ${threadId}`, { messageId: res.data.id });
  return res.data;
}

/**
 * Set up Gmail Push Notifications (Watch API)
 */
async function setupGmailWatch(topicName) {
  if (!topicName) {
    logger.warn('GmailService', 'No Pub/Sub topicName provided for Gmail watch setup');
    return null;
  }
  try {
    const gmail = await getGmailClient();
    const res = await gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName,
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
 * Renew Gmail watch (expires every 7 days)
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
  renewGmailWatch,
  checkAutoResponderHeaders,
  getSenderTimezone
};
