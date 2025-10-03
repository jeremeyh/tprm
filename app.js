// app.js — Vercel HTTP mode (no Socket Mode)
// - One receiver endpoint for commands/interactivity/events: /api/slack/events
// - OAuth install: /slack/install, redirect: /slack/oauth_redirect
// - Slash: /availability on|off|status
// - User-token DM auto-replies in thread when heads-down is ON
//
// NOTE: Do NOT add global express.json/urlencoded ahead of Bolt's receiver;
//       Bolt needs the raw body for signature verification.

require('dotenv').config();

const { App, ExpressReceiver, LogLevel } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const express = require('express');

// --- Env / Config ---
const BOT_TOKEN      = process.env.SLACK_BOT_TOKEN;
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

const CLIENT_ID     = process.env.SLACK_CLIENT_ID;
const CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const STATE_SECRET  = process.env.SLACK_STATE_SECRET || 'tp-state';

// Public URL for Slack to call (set this to your stable prod domain)
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const VERCEL_URL      = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '';
const BASE_URL        = PUBLIC_BASE_URL || VERCEL_URL || 'http://localhost:3000';

const OAUTH_INSTALL_PATH  = process.env.OAUTH_INSTALL_PATH  || '/slack/install';
const OAUTH_REDIRECT_PATH = process.env.OAUTH_REDIRECT_PATH || '/slack/oauth_redirect';

// Team/app behavior
const TEAM_USER_IDS = (process.env.TEAM_USER_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const TEAM_NAME          = process.env.TEAM_NAME || 'Team';
const ROUTE_CHANNEL_ID   = process.env.ROUTE_CHANNEL_ID || '';
const ROUTE_CHANNEL_NAME = process.env.ROUTE_CHANNEL_NAME || '#team-channel';

const STATUS_EMOJI = process.env.STATUS_EMOJI || ':no_bell:';
const STATUS_TEXT  = process.env.STATUS_TEXT  || `Heads-down — please post in ${ROUTE_CHANNEL_NAME}`;

// Require basic env for HTTP mode
const missing = [];
if (!BOT_TOKEN)      missing.push('SLACK_BOT_TOKEN');
if (!SIGNING_SECRET) missing.push('SLACK_SIGNING_SECRET');
if (missing.length) {
  console.error('Missing required env:', missing.join(', '));
  process.exit(1);
}

// --- In-memory "persistence" (resets per lambda boot) ---
let state = { users: {} };   // userId -> { on, updatedAt }
let users = { by_user: {} }; // userId -> { token, team_id, enterprise_id, updatedAt }

const setUserMode = (uid, on) => { state.users[uid] = { on: !!on, updatedAt: Date.now() }; };
const getUserMode = (uid) => !!(state.users[uid]?.on);
const saveUserToken = (uid, token, team_id, enterprise_id) => {
  users.by_user[uid] = { token, team_id, enterprise_id, updatedAt: Date.now() };
};
const getUserToken = (uid) => users.by_user[uid]?.token || null;
const isTeamMember = (uid) => TEAM_USER_IDS.includes(uid);

// --- Bolt Receiver (HTTP) ---
const receiver = new ExpressReceiver({
  signingSecret: SIGNING_SECRET,
  endpoints: '/api/slack/events', // <-- ONE endpoint for commands/interactivity/events
});

const app = new App({
  token: BOT_TOKEN,
  receiver,
  logLevel: LogLevel.INFO,
});

// --- Handlers ---
// Slash: /availability on|off|status
app.command('/availability', async ({ command, ack, respond }) => {
  await ack(); // important: ack within 3s to avoid "dispatch_failed"

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
            status_expiration: 0,
          },
        });
      } catch (e) {
        console.warn('users.profile.set failed:', e?.data?.error || e.message);
      }
    };

    if (['on', 'enable', 'start'].includes(arg)) {
      setUserMode(uid, true);
      await applyStatus(true);
      return respond({ text: 'Heads-down is *ON*. I will auto-reply in DMs.', response_type: 'ephemeral' });
    }

    if (['off', 'disable', 'stop'].includes(arg)) {
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
    // (optional) you can respond with a fallback message, but ack already happened
  }
});

// DM auto-reply (threaded) for team members who turned heads-down ON
// We rely on *user events* (on behalf of users) + user tokens to post as them.
app.event('message', async ({ event, logger }) => {
  try {
    if (!event || event.subtype) return;
    if (event.channel_type !== 'im') return; // 1:1 DMs only
    if (event.thread_ts) return;             // reply only to root messages

    const senderId = event.user;
    if (!senderId) return;

    // For each teammate who is ON, auto-respond *as them* in that DM thread
    for (const recipientId of TEAM_USER_IDS) {
      if (!getUserMode(recipientId)) continue;
      const token = getUserToken(recipientId);
      if (!token) continue;

      const uWeb = new WebClient(token);

      // Verify the DM belongs to (senderId, recipientId) pair
      const info = await uWeb.conversations.info({ channel: event.channel });
      const partner = info?.channel?.user; // human on the other side of the DM
      if (partner !== senderId) continue;

      // prevent loops
      if (senderId === recipientId || event.bot_id) return;

      const routeText = ROUTE_CHANNEL_ID
        ? `<#${ROUTE_CHANNEL_ID}|${ROUTE_CHANNEL_NAME}>`
        : ROUTE_CHANNEL_NAME;

      const text =
        `Hi there, thanks for reaching out. I am currently heads down in deep work mode and not checking messages in real time.\n` +
        `For quicker support, please post your question in ${routeText} so a teammate can jump in.\n` +
        `Otherwise, I will respond once I wrap up what I’m working on. Appreciate your patience!`;

      await uWeb.chat.postMessage({
        channel: event.channel,
        text,
        thread_ts: event.ts, // reply in-thread to the original DM
      });
      break;
    }
  } catch (e) {
    logger?.error?.(e);
  }
});

// --- Minimal OAuth (user tokens) for per-user auto-replies ---
const http = receiver.app; // reuse Bolt's Express app so export works for Vercel

http.get('/', (_req, res) => {
  res.send('TPRM DM Redirect Bot is running. Visit /slack/install to authorize a user.');
});

http.get(OAUTH_INSTALL_PATH, (req, res) => {
  if (!CLIENT_ID) {
    res.status(500).send('Missing SLACK_CLIENT_ID in env.');
    return;
  }
  const redirect_uri = `${BASE_URL}${OAUTH_REDIRECT_PATH}`;
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: 'commands',
    user_scope: 'im:history,chat:write,users.profile:write',
    redirect_uri,
    state: STATE_SECRET,
  });
  res.redirect(`https://slack.com/oauth/v2/authorize?${params.toString()}`);
});

http.get(OAUTH_REDIRECT_PATH, async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing ?code');

    if (!CLIENT_ID || !CLIENT_SECRET) {
      return res.status(500).send('Missing SLACK_CLIENT_ID or SLACK_CLIENT_SECRET.');
    }

    const oauth = new WebClient().oauth;
    const redirect_uri = `${BASE_URL}${OAUTH_REDIRECT_PATH}`;
    const result = await oauth.v2.access({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri,
    });

    const authedUser = result.authed_user || {};
    const userId = authedUser.id;
    const userToken = authedUser.access_token;
    const team_id = result.team?.id;
    const enterprise_id = result.enterprise?.id;

    if (!userId || !userToken) {
      return res
        .status(200)
        .send('<h3>OAuth complete, but no user token was returned. Ensure user scopes are granted.</h3>');
    }

    saveUserToken(userId, userToken, team_id, enterprise_id);
    res.status(200).send(`<h3>Success!</h3><p>Saved user token for ${userId}. You can close this window.</p>`);
  } catch (err) {
    console.error('OAuth error:', err);
    res.status(500).send('OAuth failed. Check logs.');
  }
});

// --- Start (local dev only). On Vercel we just export the Express app. ---
if (!process.env.VERCEL) {
  const PORT = Number(process.env.OAUTH_PORT || 3000);
  http.listen(PORT, () => {
    console.log(`HTTP listening at ${BASE_URL || 'http://localhost:' + PORT}`);
    console.log(`Install URL: ${(BASE_URL || ('http://localhost:' + PORT))}${OAUTH_INSTALL_PATH}`);
  });
}

// Critical export for Vercel
module.exports = { app, http };
