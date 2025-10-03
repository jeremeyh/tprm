// app.js — TPRM DM Redirect Bot (Vercel HTTP mode)
// One Slack entrypoint: https://<domain>/api/slack/events
// Socket Mode is NOT used on Vercel.

require('dotenv').config();

const { App, ExpressReceiver, LogLevel } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');

// ---------- ENV ----------
const BOT_TOKEN      = process.env.SLACK_BOT_TOKEN;        // xoxb-...
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;   // from Slack Basic Information
const CLIENT_ID      = process.env.SLACK_CLIENT_ID;
const CLIENT_SECRET  = process.env.SLACK_CLIENT_SECRET;
const STATE_SECRET   = process.env.SLACK_STATE_SECRET || 'tp-state';

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const VERCEL_URL      = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '';
const BASE_URL        = PUBLIC_BASE_URL || VERCEL_URL || 'http://localhost:3000';

const OAUTH_INSTALL_PATH  = process.env.OAUTH_INSTALL_PATH  || '/slack/install';
const OAUTH_REDIRECT_PATH = process.env.OAUTH_REDIRECT_PATH || '/slack/oauth_redirect';

// Behavior
const TEAM_USER_IDS = (process.env.TEAM_USER_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const TEAM_NAME          = process.env.TEAM_NAME || 'Team';
const ROUTE_CHANNEL_ID   = process.env.ROUTE_CHANNEL_ID || '';
const ROUTE_CHANNEL_NAME = process.env.ROUTE_CHANNEL_NAME || '#team-channel';

const STATUS_EMOJI = process.env.STATUS_EMOJI || ':no_bell:';
const STATUS_TEXT  = process.env.STATUS_TEXT  || `Heads-down — please post in ${ROUTE_CHANNEL_NAME}`;

// Validate required env
const missing = [];
if (!BOT_TOKEN)      missing.push('SLACK_BOT_TOKEN');
if (!SIGNING_SECRET) missing.push('SLACK_SIGNING_SECRET');
if (missing.length) {
  console.error('Missing required env:', missing.join(', '));
  process.exit(1);
}

// ---------- In-memory storage (stateless on Vercel) ----------
let state = { users: {} };   // userId -> { on, updatedAt }
let users = { by_user: {} }; // userId -> { token, team_id, enterprise_id, updatedAt }

const setUserMode = (uid, on) => { state.users[uid] = { on: !!on, updatedAt: Date.now() }; };
const getUserMode = (uid) => !!(state.users[uid]?.on);
const saveUserToken = (uid, token, team_id, enterprise_id) => {
  users.by_user[uid] = { token, team_id, enterprise_id, updatedAt: Date.now() };
};
const getUserToken = (uid) => users.by_user[uid]?.token || null;
const isTeamMember  = (uid) => TEAM_USER_IDS.includes(uid);

// ---------- Bolt Receiver (HTTP) ----------
// Map ALL Slack entry points to one path. Bolt auto-responds to url_verification (challenge).
const receiver = new ExpressReceiver({
  signingSecret: SIGNING_SECRET,
  processBeforeResponse: true,
  endpoints: {
    events: '/api/slack/events',
    commands: '/api/slack/events',
    interactive: '/api/slack/events',
  },
});

const app = new App({
  token: BOT_TOKEN,
  receiver,
  logLevel: LogLevel.INFO,
});

// ---------- /availability command ----------
app.command('/availability', async ({ command, ack, respond }) => {
  await ack(); // ack within 3s to avoid "dispatch_failed"

  try {
    const uid = command.user_id;
    if (!isTeamMember(uid)) {
      return respond({
        text: `You are not on the managed ${TEAM_NAME} list.`,
        response_type: 'ephemeral',
      });
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

    // Default: toggle
    const next = !getUserMode(uid);
    setUserMode(uid, next);
    await applyStatus(next);
    return respond({ text: `Toggled. Heads-down is now *${next ? 'ON' : 'OFF'}*.`, response_type: 'ephemeral' });
  } catch (e) {
    console.error('/availability error:', e);
  }
});

// ---------- DM auto-reply (threaded) ----------
app.event('message', async ({ event, logger }) => {
  try {
    if (!event || event.subtype) return;
    if (event.channel_type !== 'im') return; // 1:1 DMs only
    if (event.thread_ts) return;             // only reply to root messages

    const senderId = event.user;
    if (!senderId) return;

    for (const recipientId of TEAM_USER_IDS) {
      if (!getUserMode(recipientId)) continue;
      const token = getUserToken(recipientId);
      if (!token) continue;

      const uWeb = new WebClient(token);

      // Confirm this DM is between sender and the recipient we're auto-replying for
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

// ---------- Extra routes (reuse Bolt's Express app) ----------
const http = receiver.app;

http.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    base_url: BASE_URL,
    events_endpoint: '/api/slack/events',
    team_users: TEAM_USER_IDS.length,
    has_oauth_creds: !!(CLIENT_ID && CLIENT_SECRET),
  });
});

http.get('/', (_req, res) => {
  res.status(200).send('TPRM DM Redirect Bot is running. Visit /slack/install to authorize a user.');
});

// OAuth install
http.get(OAUTH_INSTALL_PATH, (req, res) => {
  if (!CLIENT_ID) return res.status(500).send('Missing SLACK_CLIENT_ID in env.');

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

// OAuth redirect
http.get(OAUTH_REDIRECT_PATH, async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing ?code');

    if (!CLIENT_ID || !CLIENT_SECRET) {
      return res.status(500).send('Missing SLACK_CLIENT_ID or SLACK_CLIENT_SECRET.');
    }

    const wc = new WebClient();
    const result = await wc.oauth.v2.access({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: `${BASE_URL}${OAUTH_REDIRECT_PATH}`,
    });

    const userId       = result?.authed_user?.id;
    const userToken    = result?.authed_user?.access_token;
    const team_id      = result?.team?.id;
    const enterprise_id= result?.enterprise?.id;

    if (!userId || !userToken) {
      return res.status(200).send('<h3>OAuth complete, but no user token was returned.</h3>');
    }

    saveUserToken(userId, userToken, team_id, enterprise_id);
    return res.status(200).send(`<h3>Success!</h3><p>Saved user token for ${userId}. You can close this window.</p>`);
  } catch (err) {
    console.error('OAuth error:', err);
    return res.status(500).send('OAuth failed. Check logs.');
  }
});

// Local dev only
if (!process.env.VERCEL) {
  const port = Number(process.env.OAUTH_PORT || 3000);
  http.listen(port, () => {
    console.log(`Local HTTP listening at ${BASE_URL || 'http://localhost:' + port}`);
    console.log(`Install URL: ${(BASE_URL || ('http://localhost:' + port))}${OAUTH_INSTALL_PATH}`);
  });
}

// ---------- Vercel export (critical) ----------
module.exports = http;
module.exports.default = http;
