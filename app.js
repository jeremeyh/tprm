// app.js — TPRM DM Redirect Bot (dual-mode: Socket locally, HTTP on Vercel)
// - No storage.js required (in-memory state)
// - OAuth install + redirect endpoints
// - Slash command: /availability (on|off|status)
// - DM auto-reply (in-thread) for team members in heads-down mode

require('dotenv').config();

const { App, ExpressReceiver, LogLevel } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const express = require('express');

// -------------------------
// Env / Config
// -------------------------
const BOT_TOKEN       = process.env.SLACK_BOT_TOKEN;
const SIGNING_SECRET  = process.env.SLACK_SIGNING_SECRET;
const APP_TOKEN       = process.env.SLACK_APP_TOKEN; // if present + not Vercel, we'll use Socket Mode locally

const CLIENT_ID       = process.env.SLACK_CLIENT_ID;
const CLIENT_SECRET   = process.env.SLACK_CLIENT_SECRET;
const STATE_SECRET    = process.env.SLACK_STATE_SECRET || 'tp-state';

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/,''); // preferred on Vercel
const VERCEL_URL      = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '';
const IS_VERCEL       = process.env.VERCEL === '1' || !!process.env.VERCEL_URL;

const OAUTH_INSTALL_PATH  = process.env.OAUTH_INSTALL_PATH  || '/slack/install';
const OAUTH_REDIRECT_PATH = process.env.OAUTH_REDIRECT_PATH || '/slack/oauth_redirect';

// local-only fallbacks
const OAUTH_HOST = process.env.OAUTH_REDIRECT_HOST || 'localhost';
const OAUTH_PORT = Number(process.env.OAUTH_PORT || 3000);

// Team/app behavior
const TEAM_USER_IDS = (process.env.TEAM_USER_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const TEAM_NAME          = process.env.TEAM_NAME || 'Team';
const ROUTE_CHANNEL_ID   = process.env.ROUTE_CHANNEL_ID || '';
const ROUTE_CHANNEL_NAME = process.env.ROUTE_CHANNEL_NAME || '#team-channel';

const STATUS_EMOJI = process.env.STATUS_EMOJI || ':no_bell:';
const STATUS_TEXT  = process.env.STATUS_TEXT  || `Heads-down — please post in ${ROUTE_CHANNEL_NAME}`;

// Basic required envs
const missing = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET'].filter(k => !process.env[k]);
if (missing.length) {
  console.error('Missing required env:', missing.join(', '));
  process.exit(1);
}

// -------------------------
// In-memory "persistence"
// -------------------------
// NOTE: resets on server restart / new lambda invocation (expected)
let state = { users: {} };           // userId -> { on, updatedAt }
let users = { by_user: {} };         // userId -> { token, team_id, enterprise_id, updatedAt }

function setUserMode(userId, isOn) {
  state.users[userId] = { on: !!isOn, updatedAt: Date.now() };
}
function getUserMode(userId) {
  return !!(state.users[userId] && state.users[userId].on);
}
function saveUserToken(userId, token, team_id, enterprise_id) {
  users.by_user[userId] = { token, team_id, enterprise_id, updatedAt: Date.now() };
}
function getUserToken(userId) {
  return users.by_user[userId] ? users.by_user[userId].token : null;
}
function isTeamMember(uid) {
  return TEAM_USER_IDS.includes(uid);
}

// -------------------------
// Express HTTP (shared)
// -------------------------
const http = express();
http.disable('x-powered-by');
http.use(express.json());
http.use(express.urlencoded({ extended: true }));

http.get('/', (_req, res) => {
  res
    .status(200)
    .send(
      `TPRM DM Redirect Bot is running.
       <ul>
         <li>Install: <a href="${OAUTH_INSTALL_PATH}">${OAUTH_INSTALL_PATH}</a></li>
         <li>Health: <a href="/health">/health</a></li>
       </ul>`
    );
});

http.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    mode: IS_VERCEL ? 'vercel-http' : (APP_TOKEN ? 'local-socket' : 'local-http'),
    team_users: TEAM_USER_IDS.length,
    has_oauth_creds: !!(CLIENT_ID && CLIENT_SECRET),
    has_public_base_url: !!PUBLIC_BASE_URL
  });
});

// Build redirect_uri for OAuth (works in both local and Vercel)
function getBaseUrl() {
  // Priority: PUBLIC_BASE_URL -> VERCEL_URL -> local http://host:port
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  if (VERCEL_URL) return VERCEL_URL;
  const host = OAUTH_HOST.startsWith('http') ? OAUTH_HOST : `http://${OAUTH_HOST}`;
  return `${host}:${OAUTH_PORT}`;
}
function getRedirectUri() {
  const base = getBaseUrl().replace(/\/+$/,'');
  return `${base}${OAUTH_REDIRECT_PATH}`;
}

// OAuth: /slack/install
http.get(OAUTH_INSTALL_PATH, (req, res) => {
  if (!CLIENT_ID) {
    return res.status(500).send('Missing SLACK_CLIENT_ID in environment.');
  }
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: 'commands', // bot scopes (adjust as needed)
    user_scope: 'im:history,chat:write,users.profile:write', // user token scopes (for status + DM replies)
    redirect_uri: getRedirectUri(),
    state: STATE_SECRET
  });
  return res.redirect(`https://slack.com/oauth/v2/authorize?${params.toString()}`);
});

// OAuth: /slack/oauth_redirect
http.get(OAUTH_REDIRECT_PATH, async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing ?code from Slack.');

    if (!CLIENT_ID || !CLIENT_SECRET) {
      return res.status(500).send('Missing SLACK_CLIENT_ID or SLACK_CLIENT_SECRET.');
    }

    const wc = new WebClient(); // no token needed for oauth
    const result = await wc.oauth.v2.access({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: getRedirectUri()
    });

    const authedUser = result.authed_user || {};
    const userId     = authedUser.id;
    const userToken  = authedUser.access_token;
    const team_id    = result.team && result.team.id;
    const enterprise_id = result.enterprise && result.enterprise.id;

    if (!userId || !userToken) {
      return res
        .status(200)
        .send('<h3>OAuth complete, but no user token returned. Ensure user scopes are granted.</h3>');
    }

    saveUserToken(userId, userToken, team_id, enterprise_id);
    return res
      .status(200)
      .send(`<h3>✅ Success!</h3><p>Saved user token for <code>${userId}</code>. You can close this window.</p>`);
  } catch (err) {
    console.error('OAuth redirect error:', err);
    return res.status(500).send('OAuth failed. Check server logs for details.');
  }
});

// -------------------------
// Slack (Bolt) — shared handlers
// -------------------------
function wireBoltHandlers(boltApp) {
  // Slash command: /availability on|off|status (toggle heads-down)
  boltApp.command('/availability', async ({ command, ack, respond }) => {
    await ack();
    try {
      const uid = command.user_id;
      if (!isTeamMember(uid)) {
        return respond({ text: `You are not on the managed ${TEAM_NAME} list.`, response_type: 'ephemeral' });
      }

      const arg = String((command.text || '').trim().toLowerCase());
      const userToken = getUserToken(uid);
      const uWeb = userToken ? new WebClient(userToken) : null;

      const applyStatus = async (on) => {
        if (!uWeb) return;
        try {
          await uWeb.users.profile.set({
            profile: {
              status_emoji: on ? STATUS_EMOJI : '',
              status_text:  on ? STATUS_TEXT  : '',
              status_expiration: 0
            }
          });
        } catch (e) {
          console.warn('users.profile.set failed:', (e && e.data && e.data.error) || e.message);
        }
      };

      if (['on','enable','start'].includes(arg)) {
        setUserMode(uid, true);
        await applyStatus(true);
        return respond({ text: 'Heads-down is *ON*. I will auto-reply in DMs.', response_type: 'ephemeral' });
      }

      if (['off','disable','stop'].includes(arg)) {
        setUserMode(uid, false);
        await applyStatus(false);
        return respond({ text: 'Heads-down is *OFF*. I will not auto-reply in DMs.', response_type: 'ephemeral' });
      }

      if (arg === 'status') {
        const s = getUserMode(uid) ? 'ON' : 'OFF';
        return respond({ text: `Your heads-down is *${s}*.`, response_type: 'ephemeral' });
      }

      // default: toggle
      const next = !getUserMode(uid);
      setUserMode(uid, next);
      await applyStatus(next);
      return respond({ text: `Toggled. Heads-down is now *${next ? 'ON' : 'OFF'}*.`, response_type: 'ephemeral' });
    } catch (e) {
      console.error('/availability error:', e);
    }
  });

  // DM auto-reply: post in thread to DMs sent to team members who are ON
  boltApp.event('message', async ({ event, logger }) => {
    try {
      if (!event || event.subtype) return;
      if (event.channel_type !== 'im') return;       // 1:1 only
      if (event.thread_ts) return;                   // avoid loops in threads
      const senderId = event.user;
      if (!senderId) return;

      for (const recipientId of TEAM_USER_IDS) {
        if (!getUserMode(recipientId)) continue;
        const token = getUserToken(recipientId);
        if (!token) continue;

        const uWeb = new WebClient(token);

        // Check DM partner
        const info = await uWeb.conversations.info({ channel: event.channel });
        const partner = info && info.channel && info.channel.user;
        if (partner !== senderId) continue;

        if (senderId === recipientId || event.bot_id) return;

        const routeText = ROUTE_CHANNEL_ID
          ? `<#${ROUTE_CHANNEL_ID}|${ROUTE_CHANNEL_NAME}>`
          : ROUTE_CHANNEL_NAME;

        const text =
          'Hi there, thanks for reaching out. I am currently heads down in deep work mode and not checking messages in real time.\n' +
          `For quicker support, please post your question in ${routeText} so a teammate can jump in.\n` +
          "Otherwise, I will respond once I wrap up what I'm working on. Appreciate your patience!";

        await uWeb.chat.postMessage({ channel: event.channel, text, thread_ts: event.ts });
        break;
      }
    } catch (e) { if (logger && logger.error) logger.error(e); }
  });
}

// -------------------------
// Mode selection (Socket locally, HTTP on Vercel or if no APP_TOKEN)
// -------------------------
let boltApp = null;
(async () => {
  if (!IS_VERCEL && APP_TOKEN) {
    // -------- Local Socket Mode --------
    boltApp = new App({
      token: BOT_TOKEN,
      signingSecret: SIGNING_SECRET,
      appToken: APP_TOKEN,
      socketMode: true,
      logLevel: LogLevel.INFO
    });
    wireBoltHandlers(boltApp);

    await boltApp.start(); // WebSocket connect
    http.listen(OAUTH_PORT, () => {
      console.log(`[local-socket] OAuth/health on http://localhost:${OAUTH_PORT}`);
      console.log(`[local-socket] Install URL: http://localhost:${OAUTH_PORT}${OAUTH_INSTALL_PATH}`);
    });
    console.log('TPRM bot running (Socket Mode).');
  } else {
    // -------- HTTP Mode (Vercel-friendly and local fallback) --------
    const receiver = new ExpressReceiver({
      signingSecret: SIGNING_SECRET,
      processBeforeResponse: true,
      endpoints: '/api/slack/events'
    });

    boltApp = new App({
      token: BOT_TOKEN,
      signingSecret: SIGNING_SECRET,
      receiver,
      logLevel: LogLevel.INFO
    });
    wireBoltHandlers(boltApp);

    // Mount Bolt router into our Express app
    http.use(receiver.router);

    if (!IS_VERCEL) {
      http.listen(OAUTH_PORT, () => {
        console.log(`[local-http] Server on http://localhost:${OAUTH_PORT}`);
        console.log(`[local-http] Install URL: http://localhost:${OAUTH_PORT}${OAUTH_INSTALL_PATH}`);
        console.log(`[local-http] Events at /api/slack/events (tunnel required for Slack callbacks)`);
      });
    } else {
      console.log('TPRM bot initialized (HTTP mode, Vercel).');
    }
  }
})();

// -------------------------
// Export for Vercel (serve the Express app)
// -------------------------
module.exports = http;
module.exports.default = http;
