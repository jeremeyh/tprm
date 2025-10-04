// app.js — HTTP mode for Vercel (no Socket Mode required)
require('dotenv').config();

const { App, LogLevel, ExpressReceiver } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const express = require('express');

// -------- Env / Config --------
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const CLIENT_ID = process.env.SLACK_CLIENT_ID;
const CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const STATE_SECRET = process.env.SLACK_STATE_SECRET || 'state-not-set';

const TEAM_USER_IDS = (process.env.TEAM_USER_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const TEAM_NAME = process.env.TEAM_NAME || 'Team';
const ROUTE_CHANNEL_ID = process.env.ROUTE_CHANNEL_ID || '';
const ROUTE_CHANNEL_NAME = process.env.ROUTE_CHANNEL_NAME || '#team-channel';

const STATUS_EMOJI = process.env.STATUS_EMOJI || ':no_bell:';
const STATUS_TEXT = process.env.STATUS_TEXT || `Heads-down — please post in ${ROUTE_CHANNEL_NAME}`;

// Fail fast if the HTTP essentials are missing
if (!BOT_TOKEN || !SIGNING_SECRET) {
  console.error('[BOOT] Missing SLACK_BOT_TOKEN or SLACK_SIGNING_SECRET');
  // Export a minimal app so /api/health returns something readable on Vercel
  const fail = express();
  fail.get(['/health', '/api/health'], (_req, res) =>
    res.status(500).json({ ok: false, reason: 'missing Slack env' })
  );
  module.exports = fail;
  module.exports.default = fail;
  return;
}

// -------- In-memory persistence (stateless on Vercel) --------
let state = { users: {} }; // { users: { U123: { on, updatedAt } } }
let users = { by_user: {} }; // { by_user: { U123: { token, team_id, enterprise_id, updatedAt } } }

const setUserMode = (uid, on) => { state.users[uid] = { on: !!on, updatedAt: Date.now() }; };
const getUserMode = (uid) => !!(state.users?.[uid]?.on);
const saveUserToken = (uid, token, team_id, enterprise_id) => {
  users.by_user[uid] = { token, team_id, enterprise_id, updatedAt: Date.now() };
};
const getUserToken = (uid) => users?.by_user?.[uid]?.token || null;
const isTeamMember = (uid) => TEAM_USER_IDS.includes(uid);

// -------- Bolt (HTTP mode via ExpressReceiver) --------
const receiver = new ExpressReceiver({
  signingSecret: SIGNING_SECRET,
  endpoints: {
    events: '/slack/events',
    commands: '/slack/commands',
    actions: '/slack/interactive',
  },
});

const app = new App({
  token: BOT_TOKEN,
  receiver,
  logLevel: LogLevel.INFO,
});

const botWeb = new WebClient(BOT_TOKEN);

// -------- Slash Command: /availability --------
app.command('/availability', async ({ command, ack, respond }) => {
  await ack(); // ack immediately to avoid "dispatch_failed"

  try {
    const uid = command.user_id;
    if (!isTeamMember(uid)) {
      return respond({
        text: `You are not on the managed team list for ${TEAM_NAME}.`,
        response_type: 'ephemeral',
      });
    }

    const arg = (command.text || '').trim().toLowerCase();
    const uToken = getUserToken(uid);
    const uWeb = uToken ? new WebClient(uToken) : null;

    const setStatus = async (emoji, text) => {
      if (!uWeb) return;
      try {
        await uWeb.users.profile.set({
          profile: { status_emoji: emoji, status_text: text, status_expiration: 0 },
        });
      } catch (e) {
        console.error('users.profile.set failed:', e?.data || e?.message || e);
      }
    };

    if (['on', 'enable', 'start'].includes(arg)) {
      setUserMode(uid, true);
      await setStatus(STATUS_EMOJI, STATUS_TEXT);
      return respond({ text: 'Heads-down is *ON*. I will auto-reply in DMs.', response_type: 'ephemeral' });
    }

    if (['off', 'disable', 'stop'].includes(arg)) {
      setUserMode(uid, false);
      await setStatus('', '');
      return respond({ text: 'Heads-down is *OFF*. I will not auto-reply in DMs.', response_type: 'ephemeral' });
    }

    if (arg === 'status') {
      return respond({
        text: `Your heads-down guard is *${getUserMode(uid) ? 'ON' : 'OFF'}*.`,
        response_type: 'ephemeral',
      });
    }

    // toggle default
    const now = !getUserMode(uid);
    setUserMode(uid, now);
    await setStatus(now ? STATUS_EMOJI : '', now ? STATUS_TEXT : '');
    return respond({
      text: `Toggled. Heads-down is now *${now ? 'ON' : 'OFF'}*.`,
      response_type: 'ephemeral',
    });
  } catch (e) {
    console.error('/availability error:', e);
    return respond({ text: 'Something went wrong handling /availability.', response_type: 'ephemeral' });
  }
});

// -------- DM-only Auto-reply (in thread) --------
app.event('message', async ({ event, logger }) => {
  try {
    if (!event || event.subtype) return;
    if (event.channel_type !== 'im') return;
    if (event.thread_ts) return;

    const senderId = event.user;
    if (!senderId) return;

    for (const recipientId of TEAM_USER_IDS) {
      if (!getUserMode(recipientId)) continue;

      const uToken = getUserToken(recipientId);
      if (!uToken) continue;

      const uWeb = new WebClient(uToken);

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
        `Otherwise, I will respond once I wrap up what I am currently working on. Appreciate your patience!`;

      await uWeb.chat.postMessage({ channel: event.channel, text, thread_ts: event.ts });
      break;
    }
  } catch (e) {
    logger?.error?.(e);
  }
});

// -------- OAuth (install + redirect) on BOTH /slack/* and /api/slack/* --------
const http = receiver.app; // reuse the Express app that Bolt created

function installHandler(req, res) {
  if (!CLIENT_ID) return res.status(500).send('Missing SLACK_CLIENT_ID');

  // Build redirect_uri using the current host
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const redirectUri = `${proto}://${host}/slack/oauth_redirect`;

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: 'commands',
    user_scope: 'im:history,chat:write,users.profile:write',
    redirect_uri: redirectUri,
    state: STATE_SECRET,
  });

  res.redirect(`https://slack.com/oauth/v2/authorize?${params.toString()}`);
}

async function oauthRedirectHandler(req, res) {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing ?code');
    if (!CLIENT_ID || !CLIENT_SECRET) return res.status(500).send('Missing Slack OAuth client env');

    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const redirectUri = `${proto}://${host}/slack/oauth_redirect`;

    const result = await new WebClient().oauth.v2.access({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    });

    const authedUser = result.authed_user || {};
    if (!authedUser.id || !authedUser.access_token) {
      return res.status(200).send('<h3>OAuth complete, but no user token was returned.</h3>');
    }

    saveUserToken(authedUser.id, authedUser.access_token, result.team?.id, result.enterprise?.id);
    return res
      .status(200)
      .send(`<h3>Success!</h3><p>Saved user token for ${authedUser.id}. You can close this window.</p>`);
  } catch (err) {
    console.error('OAuth error:', err?.data || err?.message || err);
    return res.status(500).send('OAuth failed. Check logs.');
  }
}

// Register routes under both plain and /api paths (Vercel)
http.get(['/health', '/api/health'], (_req, res) => res.json({ ok: true }));
http.get(['/slack/install', '/api/slack/install'], installHandler);
http.get(['/slack/oauth_redirect', '/api/slack/oauth_redirect'], oauthRedirectHandler);

// -------- Export Express app for Vercel --------
module.exports = http;
module.exports.default = http;
