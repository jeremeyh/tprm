// CommonJS app.js — DM-only, user-token auto-replies in-thread (Socket Mode)
require('dotenv').config();

const { App, LogLevel } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const express = require('express');
const path = require('path');
// NOTE: The line below is intentionally removed to fix the local crash:
// const { loadJson, saveJson } = require('./storage.js'); 

// --- Env / Config ---
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const APP_TOKEN = process.env.SLACK_APP_TOKEN; // Socket Mode xapp-...

const CLIENT_ID = process.env.SLACK_CLIENT_ID; // for OAuth V2
const CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const STATE_SECRET = process.env.SLACK_STATE_SECRET; // optional state to mitigate CSRF

// Vercel Host Detection: Use VERCEL_URL if available, otherwise fallback to host/port.
const IS_VERCEL = process.env.VERCEL_URL && process.env.VERCEL_ENV === 'production';
const OAUTH_HOST = IS_VERCEL ? process.env.VERCEL_URL : (process.env.OAUTH_REDIRECT_HOST || 'localhost');
const OAUTH_PORT = Number(process.env.OAUTH_PORT || 3000);
const OAUTH_PROTOCOL = IS_VERCEL ? 'https' : 'http';

const OAUTH_REDIRECT_PATH = process.env.OAUTH_REDIRECT_PATH || '/slack/oauth_redirect';
const OAUTH_INSTALL_PATH = process.env.OAUTH_INSTALL_PATH || '/slack/install';

// App behavior config
const TEAM_USER_IDS = (process.env.TEAM_USER_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const TEAM_NAME = process.env.TEAM_NAME || 'Team';

const ROUTE_CHANNEL_ID = process.env.ROUTE_CHANNEL_ID || '';
const ROUTE_CHANNEL_NAME = process.env.ROUTE_CHANNEL_NAME || '#team-channel';

// Optional cosmetic status values (auto-set when toggling)
const STATUS_EMOJI = process.env.STATUS_EMOJI || ':no_bell:';
const STATUS_TEXT = process.env.STATUS_TEXT || `Heads-down - please post in ${ROUTE_CHANNEL_NAME}`;

// Required env check
if (!BOT_TOKEN || !SIGNING_SECRET || !APP_TOKEN) {
  console.error('Missing required env: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_APP_TOKEN (xapp-...)');
  process.exit(1);
}

// --- Persistence helpers (IN-MEMORY ONLY for Vercel Serverless Function) ---
// Note: This data will be reset on every function invocation, but it fixes the "dispatch_failed" timeout.
let state = { users: {} }; // { users: { U123: { on, updatedAt } } }
let users = { by_user: {} }; // { by_user: { U123: { token, team_id, enterprise_id, updatedAt } } }

function setUserMode(userId, isOn) {
  state.users[userId] = { on: !!isOn, updatedAt: Date.now() };
  // No file save
}
function getUserMode(userId) {
  return !!(state.users?.[userId]?.on);
}
function getUserToken(userId) {
  return users?.by_user?.[userId]?.token || null;
}
function saveUserToken(userId, token, team_id, enterprise_id) {
  users.by_user = users.by_user || {};
  users.by_user[userId] = { token, team_id, enterprise_id, updatedAt: Date.now() };
  // No file save
}
function isTeamMember(uid) {
  return TEAM_USER_IDS.includes(uid);
}

// --- Slack Bolt (Socket Mode) ---
const app = new App({
  token: BOT_TOKEN,
  signingSecret: SIGNING_SECRET,
  appToken: APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.INFO
});

const botWeb = new WebClient(BOT_TOKEN);

// --- Slash: /availability on|off|status (DM-only guard toggle)
app.command('/availability', async ({ command, ack, respond }) => {
  // Acknowledge immediately to prevent Slack timeout (dispatch_failed)
  await ack();
  try {
    const uid = command.user_id;
    if (!isTeamMember(uid)) {
      await respond({ text: "You are not on the managed team list for toggling.", response_type: 'ephemeral' });
      return;
    }
    const arg = (command.text || '').trim().toLowerCase();

    const userToken = getUserToken(uid);
    const uWeb = userToken ? new WebClient(userToken) : null;

    if (['on', 'enable', 'start'].includes(arg)) {
      setUserMode(uid, true);
      if (uWeb) {
        try {
          await uWeb.users.profile.set({
            profile: {
              status_emoji: STATUS_EMOJI,
              status_text: STATUS_TEXT,
              status_expiration: 0
            }
          });
        } catch (e) {
          console.error('Failed to set status for ON:', e);
        }
      }
      await respond({ text: "Guard is ON. I will auto-reply in DMs.", response_type: 'ephemeral' });
      return;
    }
    if (['off', 'disable', 'stop'].includes(arg)) {
      setUserMode(uid, false);
      if (uWeb) {
        try {
          await uWeb.users.profile.set({
            profile: {
              status_emoji: '',
              status_text: '',
              status_expiration: 0
            }
          });
        } catch (e) {
          console.error('Failed to set status for OFF:', e);
        }
      }
      await respond({ text: "Guard is OFF. I will not auto-reply in DMs.", response_type: 'ephemeral' });
      return;
    }
    if (arg === 'status') {
      const status = getUserMode(uid) ? 'ON' : 'OFF';
      await respond({ text: "Your guard is *" + status + "*.", response_type: 'ephemeral' });
      return;
    }

    // Toggle by default
    const now = !getUserMode(uid);
    setUserMode(uid, now);
    if (uWeb) {
      try {
        await uWeb.users.profile.set({
          profile: {
            status_emoji: now ? STATUS_EMOJI : '',
            status_text: now ? STATUS_TEXT : '',
            status_expiration: 0
          }
        });
      } catch (e) {
        console.error('Failed to set status for toggle:', e);
      }
    }
    await respond({ text: "Toggled. Guard is now " + (now ? 'ON' : 'OFF') + ".", response_type: 'ephemeral' });
  } catch (e) {
    console.error('/availability error:', e);
  }
});

// --- DM-only auto-reply handler (user tokens, in-thread)
app.event('message', async ({ event, logger }) => {
  try {
    if (!event || event.subtype) return;
    if (event.channel_type !== 'im') return; // only 1:1 human DMs
    if (event.thread_ts) return; // skip replies in threads to avoid repeated auto-replies
    const senderId = event.user;
    if (!senderId) return;

    for (const recipientId of TEAM_USER_IDS) {
      if (!getUserMode(recipientId)) continue;
      const userToken = getUserToken(recipientId);
      if (!userToken) continue;

      const uWeb = new WebClient(userToken);

      const info = await uWeb.conversations.info({ channel: event.channel });
      const partner = info?.channel?.user;
      if (partner !== senderId) continue;

      if (event.user === recipientId || event.bot_id) return;

      const routeText = ROUTE_CHANNEL_ID
        ? `<#${ROUTE_CHANNEL_ID}|${ROUTE_CHANNEL_NAME}>`
        : ROUTE_CHANNEL_NAME;

      const text =
        `Hi there, thanks for reaching out. I am currently heads down in deep work mode and not checking messages in real time.\n` +
        `For quicker support, please post your question in ${routeText} so a teammate can jump in.\n` +
        `If you are an internal stakeholder, feel free to use one of our shared channels as needed.\n` +
        `Otherwise, I will respond once I wrap up what I am currently working on. Appreciate your patience!`;

      // Use event.ts to reply in thread
      await uWeb.chat.postMessage({ channel: event.channel, text, thread_ts: event.ts });
      break;
    }
  } catch (e) {
    logger?.error?.(e);
  }
});

// --- Minimal OAuth (User Tokens) via Express ---
const http = express();

function generateRedirectUri() {
  const host = OAUTH_HOST.startsWith('http') ? OAUTH_HOST.split('//')[1] : OAUTH_HOST;
  const portSegment = (OAUTH_PORT && !IS_VERCEL) ? `:${OAUTH_PORT}` : '';
  return `${OAUTH_PROTOCOL}://${host}${portSegment}${OAUTH_REDIRECT_PATH}`;
}

http.get('/', (_req, res) => {
  res.send('TPRM DM Redirect Bot is running. Visit /slack/install to authorize a user.');
});

http.get(OAUTH_INSTALL_PATH, (req, res) => {
  if (!CLIENT_ID) {
    res.status(500).send('Missing SLACK_CLIENT_ID in .env');
    return;
  }
  const redirectUri = generateRedirectUri();

  console.log(`[OAUTH] Redirecting to Slack Auth with URI: ${redirectUri}`);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: 'commands',
    user_scope: 'im:history,chat:write,users.profile:write',
    redirect_uri: redirectUri,
    state: STATE_SECRET || 'state-not-set'
  });
  res.redirect(`https://slack.com/oauth/v2/authorize?${params.toString()}`);
});

http.get(OAUTH_REDIRECT_PATH, async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) {
      res.status(400).send('Missing ?code param in redirect');
      return;
    }
    if (!CLIENT_ID || !CLIENT_SECRET) {
      res.status(500).send('Missing SLACK_CLIENT_ID or SLACK_CLIENT_SECRET in .env');
      return;
    }
    const redirectUri = generateRedirectUri();

    const oauth = new WebClient().oauth;
    const result = await oauth.v2.access({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: redirectUri
    });

    const authedUser = result.authed_user || {};
    const userId = authedUser.id;
    const userToken = authedUser.access_token;
    const team_id = result.team?.id;
    const enterprise_id = result.enterprise?.id;

    if (!userId || !userToken) {
      res.status(200).send('<h3>OAuth complete, but no user token was returned. Ensure user scopes are granted.</h3>');
      return;
    }

    saveUserToken(userId, userToken, team_id, enterprise_id);
    res.status(200).send(`<h3>Success!</h3><p>Saved user token for ${userId}. You can close this window.</p>`);
  } catch (err) {
    console.error('OAuth error:', err);
    res.status(500).send('OAuth failed. Check logs.');
  }
});

http.get('/health', (_req, res) => res.json({ ok: true }));

// --- Start Socket Mode + HTTP (OAuth/health) ---
(async () => {
  await app.start();
  // We use the same host/port logic for the listener as for the OAuth URL
  const host = OAUTH_HOST.startsWith('http') ? OAUTH_HOST.split('//')[1] : OAUTH_HOST;
  const port = OAUTH_PORT; // Local port is always 3000 unless overridden

  // Only listen on HTTP if NOT running on Vercel, where the environment handles the listener
  if (!IS_VERCEL) {
    http.listen(port, () => {
      console.log(`HTTP (OAuth/health) listening on ${OAUTH_PROTOCOL}://${host}:${port}`);
      console.log(`Install URL: ${OAUTH_PROTOCOL}://${host}:${port}${OAUTH_INSTALL_PATH}`);
    });
  }
  
  console.log('TPRM DM Redirect Bot is running (Socket Mode)...');
})();

// CRITICAL EXPORT FOR VERCEL
// Vercel requires the Express instance (http) to be exported for routing to work.
module.exports = { app, http };
