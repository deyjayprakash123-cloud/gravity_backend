const { google } = require('googleapis');
const fs = require('fs-extra');
const path = require('path');
const { createOAuth2Client } = require('./oauthService');
const { getUserTokens, saveUserTokens } = require('./userManager');
const logger = require('./logger');

async function getGmailClient(userEmail) {
  const tokens = await getUserTokens(userEmail);
  if (!tokens || (!tokens.refresh_token && !tokens.refreshToken)) {
    throw new Error(`No OAuth refresh token available for user ${userEmail}. Authenticate first.`);
  }

  const oauth2Client = createOAuth2Client();
  const refreshToken = tokens.refresh_token || tokens.refreshToken;
  oauth2Client.setCredentials({ ...tokens, refresh_token: refreshToken });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

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

function getHeader(headers, name) {
  const header = (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase());
  return header ? header.value : '';
}

function detectAutoResponder(headers, subject) {
  const autoSubmitted = getHeader(headers, 'Auto-Submitted');
  const xAutoreply = getHeader(headers, 'X-Autoreply');
  const precedence = getHeader(headers, 'Precedence');

  if (autoSubmitted && autoSubmitted !== 'no') return true;
  if (xAutoreply && xAutoreply.toLowerCase() === 'yes') return true;
  if (precedence && (precedence.toLowerCase() === 'auto_reply' || precedence.toLowerCase() === 'junk' || precedence.toLowerCase() === 'bulk')) return true;
  if (subject && (subject.toLowerCase().includes('out of office') || subject.toLowerCase().includes('automatic reply'))) return true;

  return false;
}

async function fetchEmailContent(userEmail, messageId) {
  const gmail = await getGmailClient(userEmail);
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
  const isAutoReply = detectAutoResponder(headers, subject);

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
    snippet: message.snippet
  };
}

async function sendReply({ userEmail, threadId, to, subject, body, inReplyToMessageId }) {
  const gmail = await getGmailClient(userEmail);

  let targetTo = to;
  let targetSubject = subject;
  let lastMessageId = inReplyToMessageId;

  if (!targetTo || !targetSubject || !lastMessageId) {
    const threadRes = await gmail.users.threads.get({ userId: 'me', id: threadId });
    const messages = threadRes.data.messages || [];
    const lastMessage = messages[messages.length - 1];
    if (lastMessage) {
      lastMessageId = lastMessageId || lastMessage.id;
      const headers = lastMessage.payload.headers || [];
      targetSubject = targetSubject || (getHeader(headers, 'Subject') || 'Meeting Request');
      targetTo = targetTo || getHeader(headers, 'From');
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
      threadId
    }
  });

  await logger.info('GmailService', `Sent reply to ${targetTo} for user ${userEmail}`, { messageId: response.data.id });
  return response.data;
}

async function setupGmailWatch(userEmail, topicName) {
  const targetTopic = topicName || process.env.PUBSUB_TOPIC;
  if (!targetTopic) return null;
  try {
    const gmail = await getGmailClient(userEmail);
    const res = await gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName: targetTopic,
        labelIds: ['INBOX']
      }
    });
    await logger.info('GmailService', `Gmail watch setup for ${userEmail}`, res.data);
    return res.data;
  } catch (err) {
    await logger.warn('GmailService', `Gmail watch setup failed for ${userEmail}: ${err.message}`);
    return null;
  }
}

async function checkForNewEmails(userEmail) {
  try {
    const gmail = await getGmailClient(userEmail);
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread -from:me',
      maxResults: 5
    });
    return res.data.messages || [];
  } catch (err) {
    return [];
  }
}

module.exports = {
  getGmailClient,
  fetchEmailContent,
  sendReply,
  setupGmailWatch,
  checkForNewEmails,
  detectAutoResponder
};
