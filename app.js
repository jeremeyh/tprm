// app.js — HTTP mode for Vercel (no Socket Mode)

require('dotenv').config();
const { App, ExpressReceiver, LogLevel } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');

const BOT_TOKEN      = process.env.SLACK_BOT_TOKEN;
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const CLIENT_ID      = process.env.SLACK_CLIENT_ID;
const CLIENT_SECRET  = process.env.SLACK_CLIENT_SECRET;
const STATE_SECRET   = process.env.SLACK_STATE_SECRET || 'tp-state';

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const VERCEL_URL      = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '';
const BASE_URL        = PUBLIC_BASE_URL || VERCEL_URL || 'http://localhost:3000';

// Keep all public endpoints under /api/* so Vercel routes to your handler
const EVENTS_PATH   = '/api/slack/events';
const COMMANDS_PATH = '/api/slack/commands';
const INTERACT_PATH = '/api/slack/interactive';
const OAUTH_INSTALL_PATH  = '/api/slack/install';
const OAUTH_REDIRECT_PATH = '/api/slack/oauth_redirect';

const TEAM_USER_IDS = (process.env.TEAM_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const TEAM_NAME          = process.env.TEAM_NAME || 'Team';
const ROUTE_CHANNEL_ID   = process.env.ROUTE_CHANNEL_ID || '';
const ROUTE_CHANNEL_NAME = process.env.ROUTE_CHANNEL_NAME || '#team-channel';
const STATUS_EMOJI = process.env.STATUS_EMOJI || ':no_bell:';
const STATUS_TEXT  = process.env.STATUS_TEXT  || `Heads-down — please post in ${ROUTE_CHANNEL_NAME}`;

if (!BOT_TOKEN || !SIGNING_SECRET) {
  console.error('Missing required env: SLACK_BOT_TOKEN and/or SLACK_SIGNING_SECRET');
  process.exit(1);
}

// ----- In-memory storage (stateless on Vercel) -----
let state = { users: {} };           // userId -> { on, updatedAt }
let users = { by_user: {} };         // userId -> { token, team_id, enterprise_id, updatedAt }
const setUserMode  = (u, on) => { state.users[u] = { on: !!on, updatedAt: Date.now() }; };
const getUserMode  = (u) => !!(state.users[u]?.on);
const saveUserToken = (u, t, team_id, enterprise_id) => { users.by_user[u] = { token: t, team_id, enterprise_id, updatedAt: Date.now() }; };
const getUserToken  = (u) => users.by_user[u]?.token || null;
const isTeamMember  = (u) => TEAM_USER_IDS.includes(u);

// ----- Bolt receiver with explicit endpoints -----
// IMPORTANT: separate COMMANDS_PATH so we can point the slash command there.
const receiver = new ExpressReceiver({
  signingSecret: SIGNING_SECRET,
  processBeforeResponse: true,
  endpoints: {
    events: EVENTS_PATH,
    commands: COMMANDS_PATH,
    interactive: INTERACT_PATH,
  },
});

const app = new App({
  token: BOT_TOKEN,
  receiver,
  logLevel: LogLevel.INFO,
});

// Quick visibility that Slack is actually hitting us
receiver.app.use((req, _res, next) => {
  if (req.path.startsWith('/api/slack/')) {
    console.log('[SLACK] hit', req.method, req.path);
  }
  next();
});

// ----- /availability command -----
// ack() is FIRST LINE to avoid dispatch_failed on cold starts.
app.command('/availability', async ({ command, ack, respond }) => {
  await ack(); // <= critical

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

    if (['on','enable','start'].includes(arg)) {
      setUserMode(uid, true); await applyStatus(true);
      return respond({ text: 'Heads-down is *ON*. I will auto-reply in DMs.', response_type: 'ephemeral' });
    }
    if (['off','disable','stop'].includes(arg)) {
      setUserMode(uid, false); await applyStatus(false);
      return respond({ text: 'Heads-down is *OFF*. I will not auto-reply in DMs.', response_type: 'ephemeral' });
    }
    if (arg === 'status') {
      return respond({ text: `Your heads-down is *${getUserMode(uid) ? 'ON' : 'OFF'}*.`, response_type: 'ephemeral' });
    }

    const next = !getUserMode(uid);
    setUserMode(uid, next); await applyStatus(next);
    return respond({ text: `Toggled. Heads-down is now *${next ? 'ON' : 'OFF'}*.`, response_type: 'ephemeral' });
  } catch (e) {
    console.error('/availability error:', e);
  }
});

// ----- DM auto-reply (threaded) -----
app.event('message', async ({ event, logger }) => {
  try {
    if (!event || event.subtype) return;
    if (event.channel_type !== 'im') return;
    if (event.thread_ts) return;

    const senderId = event.user;
    if (!senderId) return;

    for (const recipientId of TEAM_USER_IDS) {
      if (!getUserMode(recipientId)) continue;
      const token = getUserToken(recipientId);
      if (!token) continue;

      const uWeb = new WebClient(token);
      const info = await uWeb.conversations.info({ channel: event.channel });
      const partner = info?.channel?.user;
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
  } catch (e) {
    logger?.error?.(e);
  }
});

// ----- OAuth + health (under /api/* so Vercel routes to us) -----
const http = receiver.app;

http.get('/api/health', (_req, res) => res.status(200).json({ ok: true, events: EVENTS_PATH, commands: COMMANDS_PATH }));

http.get(OAUTH_INSTALL_PATH, (req, res) => {
  if (!CLIENT_ID) return res.status(500).send('Missing SLACK_CLIENT_ID');
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
    if (!CLIENT_ID || !CLIENT_SECRET) return res.status(500).send('Missing OAuth env');

    const wc = new WebClient();
    const result = await wc.oauth.v2.access({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: `${BASE_URL}${OAUTH_REDIRECT_PATH}`,
    });

    const userId = result?.authed_user?.id;
    const userToken = result?.authed_user?.access_token;
    const team_id = result?.team?.id;
    const enterprise_id = result?.enterprise?.id;

    if (!userId || !userToken) return res.status(200).send('<h3>OAuth complete, but no user token.</h3>');
    saveUserToken(userId, userToken, team_id, enterprise_id);
    res.status(200).send(`<h3>Success!</h3><p>Saved user token for ${userId}.</p>`);
  } catch (err) {
    console.error('OAuth error:', err);
    res.status(500).send('OAuth failed. Check logs.');
  }
});

// Local dev
if (!process.env.VERCEL) {
  const port = Number(process.env.OAUTH_PORT || 3000);
  http.listen(port, () => console.log(`Local HTTP ${BASE_URL || 'http://localhost:' + port}`));
}

// Vercel export
module.exports = http;
module.exports.default = http;
