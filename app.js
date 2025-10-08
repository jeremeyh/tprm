\// app.js — TPRM DM Redirect Bot (Socket locally if xapp is present; HTTP on Vercel)
require('dotenv').config();

const { App, LogLevel, ExpressReceiver } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const express = require('express');

// Use native fetch on Node 18+; fall back to node-fetch only if needed
const fetch =
  globalThis.fetch ||
  ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

// ---------------- Env ----------------
const BOT_TOKEN      = process.env.SLACK_BOT_TOKEN;
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const APP_TOKEN      = process.env.SLACK_APP_TOKEN; // xapp-... (Socket Mode; optional)

const CLIENT_ID      = process.env.SLACK_CLIENT_ID;
const CLIENT_SECRET  = process.env.SLACK_CLIENT_SECRET;
const STATE_SECRET   = process.env.SLACK_STATE_SECRET || 'state-not-set';

const TEAM_NAME          = process.env.TEAM_NAME || 'Team';
const ROUTE_CHANNEL_ID   = process.env.ROUTE_CHANNEL_ID || '';
const ROUTE_CHANNEL_NAME = process.env.ROUTE_CHANNEL_NAME || '#team-channel';
const STATUS_EMOJI       = process.env.STATUS_EMOJI || ':no_bell:';
const STATUS_TEXT        = process.env.STATUS_TEXT  || `Heads-down — please post in ${ROUTE_CHANNEL_NAME}`;

const PORT      = Number(process.env.OAUTH_PORT || 3000);
const IS_VERCEL = !!process.env.VERCEL;

// Prefer explicit override, else fall back to Vercel URL or localhost
const HOST = (process.env.OAUTH_REDIRECT_HOST || (
  process.env.VERCEL_URL
    ? process.env.VERCEL_URL.replace(/^https?:\/\//, '')
    : 'localhost'
));

// KV (Upstash / Vercel KV via REST)
const KV_URL   = process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KV_ENABLED = !!(KV_URL && KV_TOKEN);

// Fail fast locally if critical env missing
if (!BOT_TOKEN || !SIGNING_SECRET) {
  console.error('Missing SLACK_BOT_TOKEN or SLACK_SIGNING_SECRET');
  if (!IS_VERCEL) process.exit(1);
}

// ---------------- Allow-list (normalized) ----------------
const norm = (s = '') => s.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
const RAW_TEAM_USER_IDS = process.env.TEAM_USER_IDS || '';
const TEAM_USER_ID_SET = new Set(RAW_TEAM_USER_IDS.split(',').map(norm).filter(Boolean));
const isTeamMember = (uid) => TEAM_USER_ID_SET.has(norm(uid));

if (TEAM_USER_ID_SET.size === 0) {
  console.warn('[DM-Redirect] TEAM_USER_IDS normalized to EMPTY. RAW:', RAW_TEAM_USER_IDS);
}

// ---------------- KV helpers ----------------
async function kvGet(key) {
  if (!KV_ENABLED) return null;
  try {
    const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    if (!res.ok) return null;
    const out = await res.json();
    return out.result ?? null;
  } catch {
    return null;
  }
}

async function kvSet(key, value) {
  if (!KV_ENABLED) return;
  try {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
  } catch {}
}

async function kvDel(key) {
  if (!KV_ENABLED) return;
  try {
    await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
  } catch {}
}

// ---------------- Persistence (KV-backed, fallback memory) ----------------
let mem = { users: {}, by_user: {} }; // fallback only

const setUserMode = async (uid, on) => {
  if (KV_ENABLED) {
    await kvSet(`hd:state:${uid}`, on ? '1' : '0');
  } else {
    mem.users[uid] = { on: !!on, updatedAt: Date.now() };
  }
};

const getUserMode = async (uid) => {
  if (KV_ENABLED) {
    const v = await kvGet(`hd:state:${uid}`);
    return v === '1';
  }
  return !!(mem.users?.[uid]?.on);
};

const saveUserToken = async (uid, token, team_id, enterprise_id) => {
  if (KV_ENABLED) {
    await kvSet(`hd:token:${uid}`, JSON.stringify({ token, team_id, enterprise_id, updatedAt: Date.now() }));
  } else {
    mem.by_user[uid] = { token, team_id, enterprise_id, updatedAt: Date.now() };
  }
};

const getUserToken = async (uid) => {
  if (KV_ENABLED) {
    const raw = await kvGet(`hd:token:${uid}`);
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw);
      return obj.token || null;
    } catch {
      return null;
    }
  }
  return mem?.by_user?.[uid]?.token || null;
};

const deleteUserToken = async (uid) => {
  if (KV_ENABLED) {
    await kvDel(`hd:token:${uid}`);
  } else {
    delete mem.by_user[uid];
  }
};

// ---------------- Build app depending on env ----------------
const useSocketMode = !process.env.VERCEL && !!process.env.SLACK_APP_TOKEN;

let boltApp;
let webApp;
let receiver;

if (useSocketMode) {
  boltApp = new App({
    token: BOT_TOKEN,
    signingSecret: SIGNING_SECRET,
    appToken: APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });
  webApp = express();
} else {
  receiver = new ExpressReceiver({
    signingSecret: SIGNING_SECRET,
    processBeforeResponse: true,
    endpoints: {
      events:   '/api/slack/events',
      commands: '/api/slack/commands',
      actions:  '/api/slack/interactive',
    },
  });
  boltApp = new App({
    token: BOT_TOKEN,
    signingSecret: SIGNING_SECRET,
    logLevel: LogLevel.INFO,
    receiver,
  });
  webApp = receiver.app;
}

const botWeb = new WebClient(BOT_TOKEN);

// ---------------- Slash command: /availability ----------------
boltApp.command('/availability', async ({ command, ack, respond }) => {
  await ack();

  try {
    const uid = command.user_id || '';
    const allowed = isTeamMember(uid);

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
    const userToken = await getUserToken(uid);
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
      await setUserMode(uid, true);
      await setStatus(STATUS_EMOJI, STATUS_TEXT);
      return respond({ response_type: 'ephemeral', text: 'Heads-down is *ON*. I will auto-reply in DMs.' });
    }

    if (['off','disable','stop'].includes(arg)) {
      await setUserMode(uid, false);
      await setStatus('', '');
      return respond({ response_type: 'ephemeral', text: 'Heads-down is *OFF*. I will not auto-reply in DMs.' });
    }

    if (arg === 'status') {
      const on = await getUserMode(uid);
      return respond({ response_type: 'ephemeral', text: `Your heads-down guard is *${on ? 'ON' : 'OFF'}*.` });
    }

    // default toggle
    const now = !(await getUserMode(uid));
    await setUserMode(uid, now);
    await setStatus(now ? STATUS_EMOJI : '', now ? STATUS_TEXT : '');
    return respond({ response_type: 'ephemeral', text: `Toggled. Heads-down is now *${now ? 'ON' : 'OFF'}*.` });
  } catch (e) {
    console.error('/availability error:', e);
    return respond({ response_type: 'ephemeral', text: 'Something went wrong handling /availability.' });
  }
});

// ---------------- DM auto-reply (message.im) ----------------
boltApp.event('message', async ({ event, logger }) => {
  try {
    if (!event || event.subtype) return;
    if (event.channel_type !== 'im') return;
    if (event.thread_ts) return;
    if (!event.user) return;

    const senderId = event.user;

    for (const recipientId of TEAM_USER_ID_SET) {
      if (!(await getUserMode(recipientId))) continue;
      const userToken = await getUserToken(recipientId);
      if (!userToken) continue;

      const uWeb = new WebClient(userToken);

      // Ensure this DM is with the intended recipient
      try {
        const info = await uWeb.conversations.info({ channel: event.channel });
        const partner = info?.channel?.user;
        if (partner !== senderId) continue;
      } catch (e) {
        logger?.warn?.('conversations.info failed, skipping partner check:', e?.data || e?.message || e);
      }

      if (senderId === recipientId || event.bot_id) return;

      // Channel mention (will render as #name)
      const routeText = (() => {
        if (ROUTE_CHANNEL_ID) return `<#${ROUTE_CHANNEL_ID}>`;
        const cleanName = ROUTE_CHANNEL_NAME.replace(/^#/, '');
        return `#${cleanName}`;
      })();

      const text =
        `Hi there — I’m currently heads-down and not checking DMs in real time.\n` +
        `For quicker support, please post in ${routeText} and a teammate will jump in.\n` +
        `Otherwise I’ll follow up when I’m back. Thanks!`;

      await uWeb.chat.postMessage({
        channel: event.channel,
        text,
        thread_ts: event.ts,
        mrkdwn: true,
        parse: 'full',
        link_names: true,
        unfurl_links: false,
        unfurl_media: false,
      });
      break;
    }
  } catch (e) {
    logger?.error?.(e);
  }
});

// ---------------- OAuth + health/debug ----------------
function redirectUri() {
  const isProd = !!process.env.VERCEL_URL;
  const proto = isProd ? 'https' : 'http';
  const host  = HOST.replace(/^https?:\/\//, '');
  const portSeg = (!isProd && PORT) ? `:${PORT}` : '';
  return `${proto}://${host}${portSeg}/slack/oauth_redirect`;
}

webApp.get('/', (_req, res) => {
  res.send('TPRM DM Redirect Bot is running. Visit /slack/install to authorize a user.');
});

webApp.get('/slack/install', (_req, res) => {
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

// OAuth redirect with state validation
webApp.get('/slack/oauth_redirect', async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code) return res.status(400).send('Missing ?code');
    if (state !== STATE_SECRET) return res.status(400).send('Invalid state');
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
    if (userId && token) await saveUserToken(userId, token, out.team?.id, out.enterprise?.id);

    res.status(200).send(`<h1>Success!</h1><p>Saved user token for ${userId}. You can close this window.</p>`);
  } catch (e) {
    console.error('OAuth error:', e?.data || e?.message || e);
    res.status(500).send('OAuth failed. Check logs.');
  }
});

webApp.get('/health', (_req, res) => res.json({ ok: true }));

// Debug: show allow-list + which users we have tokens for (KV-aware)
webApp.get('/api/debug/team', async (_req, res) => {
  let tokens = [];
  if (!KV_ENABLED) {
    tokens = Object.keys(mem.by_user || {});
  } else {
    // Cheap approximation: check known allow-list users
    const list = Array.from(TEAM_USER_ID_SET);
    const found = [];
    for (const uid of list) {
      const t = await kvGet(`hd:token:${uid}`);
      if (t) found.push(uid);
    }
    tokens = found;
  }

  res.json({
    team_name: TEAM_NAME,
    raw_env: RAW_TEAM_USER_IDS,
    normalized: Array.from(TEAM_USER_ID_SET),
    has_tokens_for: tokens,
    transport: useSocketMode ? 'socket' : 'http',
    kv: KV_ENABLED ? 'on' : 'off',
  });
});

// Debug: show exact OAuth redirect URI
webApp.get('/slack/redirect_uri', (_req, res) => {
  res.type('text/plain').send(redirectUri());
});

// Debug: list endpoints
webApp.get('/api/debug/urls', (_req, res) => {
  const isProd  = !!process.env.VERCEL_URL;
  const proto   = isProd ? 'https' : 'http';
  const host    = HOST.replace(/^https?:\/\//, '');
  const portSeg = (!isProd && PORT) ? `:${PORT}` : '';
  const base    = `${proto}://${host}${portSeg}`;

  res.json({
    install:        `${base}/slack/install`,
    oauth_redirect: `${base}/slack/oauth_redirect`,
    events:         `${base}/api/slack/events`,
    commands:       `${base}/api/slack/commands`,
    interactive:    `${base}/api/slack/interactive`,
  });
});

// ---------------- Start ----------------
(async () => {
  await boltApp.start();
  console.log(`[DM-Redirect] Started. Transport=${useSocketMode ? 'SocketMode' : 'HTTP'}; KV=${KV_ENABLED ? 'on' : 'off'}`);

  if (!IS_VERCEL) {
    webApp.listen(PORT, () => {
      console.log(`HTTP listening on http://localhost:${PORT}`);
      console.log(`OAuth Redirect: ${redirectUri()}`);
      console.log(`Install URL: http://localhost:${PORT}/slack/install`);
      console.log(`Events URL:  http://localhost:${PORT}/api/slack/events`);
      console.log(`Cmd URL:     http://localhost:${PORT}/api/slack/commands`);
    });
  }
})();

module.exports = webApp;
