// app.js — TPRM DM Redirect Bot (HTTP on Vercel, Socket Mode locally)
require('dotenv').config();

const { App, LogLevel, ExpressReceiver } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const express = require('express');

// ---- Env ----
const BOT_TOKEN      = process.env.SLACK_BOT_TOKEN;
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const APP_TOKEN      = process.env.SLACK_APP_TOKEN; // xapp-... (used only locally)

const CLIENT_ID      = process.env.SLACK_CLIENT_ID;
const CLIENT_SECRET  = process.env.SLACK_CLIENT_SECRET;
const STATE_SECRET   = process.env.SLACK_STATE_SECRET || 'state-not-set';

const TEAM_NAME            = process.env.TEAM_NAME || 'Team';
const ROUTE_CHANNEL_ID     = process.env.ROUTE_CHANNEL_ID || '';
const ROUTE_CHANNEL_NAME   = process.env.ROUTE_CHANNEL_NAME || '#team-channel';
const STATUS_EMOJI         = process.env.STATUS_EMOJI || ':no_bell:';
const STATUS_TEXT          = process.env.STATUS_TEXT  || `Heads-down — please post in ${ROUTE_CHANNEL_NAME}`;

const PORT   = Number(process.env.OAUTH_PORT || 3000);
const IS_VERCEL = !!process.env.VERCEL; // on Vercel this is set
const HOST   = process.env.VERCEL_URL
  ? process.env.VERCEL_URL.replace(/^https?:\/\//, '')
  : (process.env.OAUTH_REDIRECT_HOST || 'localhost');

// Guard in dev
if (!BOT_TOKEN || !SIGNING_SECRET) {
  console.error('Missing SLACK_BOT_TOKEN or SLACK_SIGNING_SECRET');
  if (!IS_VERCEL) process.exit(1);
}

// ---- Team allow-list (normalized) ----
const norm = (s='') => s.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
const RAW_TEAM_USER_IDS = process.env.TEAM_USER_IDS || '';
const TEAM_USER_ID_SET = new Set(
  RAW_TEAM_USER_IDS.split(',').map(norm).filter(Boolean)
);
const isTeamMember = (uid) => TEAM_USER_ID_SET.has(norm(uid));

// ---- Memory persistence ----
let state = { users: {} };            // { users: { U123: { on, updatedAt } } }
let users = { by_user: {} };          // { by_user: { U123: { token, ... } } }

const setUserMode = (uid, on) => { state.users[uid] = { on: !!on, updatedAt: Date.now() }; };
const getUserMode = (uid) => !!(state.users?.[uid]?.on);
const getUserToken = (uid) => users?.by_user?.[uid]?.token || null;
const saveUserToken = (uid, token, team_id, enterprise_id) => {
  users.by_user = users.by_user || {};
  users.by_user[uid] = { token, team_id, enterprise_id, updatedAt: Date.now() };
};

// ---- ExpressReceiver (gives us an Express app & HTTP endpoints) ----
const receiver = new ExpressReceiver({
  signingSecret: SIGNING_SECRET,
  processBeforeResponse: true,
});

// Choose transport: HTTP on Vercel, Socket Mode locally
const useSocketMode = !IS_VERCEL;

const app = new App({
  token: BOT_TOKEN,
  signingSecret: SIGNING_SECRET,
  logLevel: LogLevel.INFO,
  receiver,
  ...(useSocketMode ? { socketMode: true, appToken: APP_TOKEN } : {})
});

const botWeb = new WebClient(BOT_TOKEN);

// ---- Slash command: /availability ----
app.command('/availability', async ({ command, ack, respond }) => {
  await ack(); // critical to avoid "dispatch_failed"

  try {
    const uid = command.user_id || '';
    const allowed = isTeamMember(uid);

    console.log('[availability]', { uid, allowed, normalizedAllowList: Array.from(TEAM_USER_ID_SET) });

    if (!allowed) {
      const preview = Array.from(TEAM_USER_ID_SET).slice(0, 6).join(', ') || '(empty)';
      return respond({
        response_type: 'ephemeral',
        text:
          `You're not on the managed team list for *${TEAM_NAME}*.\n` +
          `• Your UID: \`${uid}\`\n` +
          `• Allow-list (first few): \`${preview}\`\n` +
          `If this is wrong, update TEAM_USER_IDS in Vercel env and redeploy.`,
      });
    }

    const arg = (command.text || '').trim().toLowerCase();
    const userToken = getUserToken(uid);
    const uWeb = userToken ? new WebClient(userToken) : null;

    const setStatus = async (emoji, text) => {
      if (!uWeb) return;
      try {
        await uWeb.users.profile.set({ profile: { status_emoji: emoji, status_text: text, status_expiration: 0 } });
      } catch (e) {
        console.error('users.profile.set failed:', e?.data || e?.message || e);
      }
    };

    if (['on','enable','start'].includes(arg)) {
      setUserMode(uid, true);
      await setStatus(STATUS_EMOJI, STATUS_TEXT);
      return respond({ response_type: 'ephemeral', text: 'Heads-down is *ON*. I will auto-reply in DMs.' });
    }

    if (['off','disable','stop'].includes(arg)) {
      setUserMode(uid, false);
      await setStatus('', '');
      return respond({ response_type: 'ephemeral', text: 'Heads-down is *OFF*. I will not auto-reply in DMs.' });
    }

    if (arg === 'status') {
      return respond({ response_type: 'ephemeral', text: `Your heads-down guard is *${getUserMode(uid) ? 'ON' : 'OFF'}*.` });
    }

    // default toggle
    const now = !getUserMode(uid);
    setUserMode(uid, now);
    await setStatus(now ? STATUS_EMOJI : '', now ? STATUS_TEXT : '');
    return respond({ response_type: 'ephemeral', text: `Toggled. Heads-down is now *${now ? 'ON' : 'OFF'}*.` });
  } catch (e) {
    console.error('/availability error:', e);
    return respond({ response_type: 'ephemeral', text: 'Something went wrong handling /availability.' });
  }
});

// ---- DM auto-reply (HTTP Events path on Vercel; Socket Mode locally) ----
app.event('message', async ({ event, logger }) => {
  try {
    if (!event || event.subtype) return;
    if (event.channel_type !== 'im') return;
    if (event.thread_ts) return;
    if (!event.user) return;

    const senderId = event.user;

    for (const recipientId of TEAM_USER_ID_SET) {
      if (!getUserMode(recipientId)) continue;
      const userToken = getUserToken(recipientId);
      if (!userToken) continue;

      const uWeb = new WebClient(userToken);
      const info = await uWeb.conversations.info({ channel: event.channel });
      const partner = info?.channel?.user;
      if (partner !== senderId) continue;
      if (senderId === recipientId || event.bot_id) return;

      const routeText = ROUTE_CHANNEL_ID
        ? `<#${ROUTE_CHANNEL_ID}|${ROUTE_CHANNEL_NAME}>`
        : ROUTE_CHANNEL_NAME;

      const text =
        `Hi there — I’m currently heads-down and not checking DMs in real time.\n` +
        `For quicker support, please post in ${routeText} and a teammate will jump in.\n` +
        `Otherwise I’ll follow up when I’m back. Thanks!`;

      await uWeb.chat.postMessage({ channel: event.channel, text, thread_ts: event.ts });
      break;
    }
  } catch (e) {
    logger?.error?.(e);
  }
});

// ---- OAuth (install + redirect) ----
function redirectUri() {
  const isProd = !!process.env.VERCEL_URL;
  const proto = isProd ? 'https' : 'http';
  const host  = HOST.replace(/^https?:\/\//, '');
  const portSeg = (!isProd && PORT) ? `:${PORT}` : '';
  return `${proto}://${host}${portSeg}/slack/oauth_redirect`;
}

receiver.app.get('/', (_req, res) => {
  res.send('TPRM DM Redirect Bot is running. Visit /slack/install to authorize a user.');
});

receiver.app.get('/slack/install', (_req, res) => {
  if (!CLIENT_ID) return res.status(500).send('Missing SLACK_CLIENT_ID');
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: 'commands',
    user_scope: 'im:history,chat:write,users.profile:write',
    redirect_uri: redirectUri(),
    state: STATE_SECRET,
  });
  res.redirect(`https://slack.com/oauth/v2/authorize?${params.toString()}`);
});

receiver.app.get('/slack/oauth_redirect', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing ?code');
    if (!CLIENT_ID || !CLIENT_SECRET) return res.status(500).send('Missing CLIENT_ID/CLIENT_SECRET');

    const oauth = new WebClient().oauth;
    const out = await oauth.v2.access({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: redirectUri(),
    });

    const authed = out.authed_user || {};
    const userId = authed.id;
    const token  = authed.access_token;
    saveUserToken(userId, token, out.team?.id, out.enterprise?.id);

    res.status(200).send(`<h1>Success!</h1><p>Saved user token for ${userId}. You can close this window.</p>`);
  } catch (e) {
    console.error('OAuth error:', e?.data || e?.message || e);
    res.status(500).send('OAuth failed. Check logs.');
  }
});

// ---- Health + debug ----
receiver.app.get('/health', (_req, res) => res.json({ ok: true }));
receiver.app.get('/api/debug/team', (_req, res) => {
  res.json({
    team_name: TEAM_NAME,
    raw_env: RAW_TEAM_USER_IDS,
    normalized: Array.from(TEAM_USER_ID_SET),
    has_tokens_for: Object.keys(users.by_user || {}),
    transport: useSocketMode ? 'socket' : 'http'
  });
});

// ---- Start ----
(async () => {
  await app.start();
  console.log(`[DM-Redirect] Started. Transport=${useSocketMode ? 'SocketMode' : 'HTTP'}`);

  if (!IS_VERCEL) {
    receiver.app.listen(PORT, () => {
      console.log(`HTTP listening on http://localhost:${PORT}`);
      console.log(`Install URL: http://localhost:${PORT}/slack/install`);
      console.log(`Events URL:  http://localhost:${PORT}/api/slack/events`);
      console.log(`Cmd URL:     http://localhost:${PORT}/api/slack/commands`);
    });
  }
})();

// Export Express app so Vercel can handle the HTTP routes
module.exports = receiver.app;
