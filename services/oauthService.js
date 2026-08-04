const { google } = require('googleapis');
const axios = require('axios');
const { createUserDirectory, saveUserTokens } = require('./userManager');
const { initializeUserSetup } = require('./setupService');
const logger = require('./logger');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://gravity-backend-rdvr.onrender.com/oauth/callback';

function createOAuth2Client() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

function generateOAuthUrl() {
  const oauth2Client = createOAuth2Client();
  const scopes = [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly'
  ];

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes
  });
}

async function extractEmailFromTokens(tokens, oauth2Client) {
  oauth2Client.setCredentials(tokens);
  try {
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userinfo = await oauth2.userinfo.get();
    if (userinfo.data && userinfo.data.email) {
      return userinfo.data.email.toLowerCase();
    }
  } catch (err) {
    // fallback to id_token
    if (tokens.id_token) {
      const decoded = google.auth.jwt.decode(tokens.id_token);
      if (decoded && decoded.email) return decoded.email.toLowerCase();
    }
  }
  return (process.env.USER_EMAIL || 'user@example.com').toLowerCase();
}

async function handleOAuthCallback(code) {
  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);

  const email = await extractEmailFromTokens(tokens, oauth2Client);

  // Initialize user directory structure
  await createUserDirectory(email);

  // Save tokens to user's tokens.json
  await saveUserTokens(email, tokens);

  await logger.info('OAuthService', `Successfully authenticated user: ${email}`);

  // Trigger initial setup & calendar analysis asynchronously
  initializeUserSetup(email).catch(err => {
    logger.error('OAuthService', `Error running initial setup for ${email}: ${err.message}`);
  });

  return {
    email,
    tokens
  };
}

module.exports = {
  createOAuth2Client,
  generateOAuthUrl,
  handleOAuthCallback
};
