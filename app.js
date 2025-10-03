// app.js — Slack DM Redirect Bot (Express + Bolt) — Vercel-ready
// Adds /slack/install and /slack/oauth_redirect
require('dotenv/config');
const express = require('express');
const bodyParser = require('body-parser');
const { loadJson, saveJson } = require('./storage');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const {
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  SLACK_CLIENT_ID,
  SLACK_CLIENT_SECRET,
  // Optional, but recommended so we can build redirect URIs:
  PUBLIC_BASE_URL, // e.g. https://tprm-two.vercel.app
  NODE_ENV,
  PORT = 3000,
} = process.env;

const BASE_URL = (PUBLIC_BASE_URL || '').replace(/\/+$/,''); // no trailing slash
const REDIRECT_URI = BASE_URL ? `${BASE_URL}/slack/oauth_redirect` : ''; // used in install URL

const app = express();
app.disable('x-powered-by');
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ---------- Health ----------
app.get('/', (_req, res) => res.status(200).send('OK: root is alive.'));
app.get('/api/health', async (_req, res) => {
  const state = await loadJson('state.json', { ok: true, ts: Date.now() });
  res.status(200).json({
    status: 'healthy',
    env: {
      slack_http_mode: Boolean(SLACK_BOT_TOKEN && SLACK_SIGNING_SECRET),
      has_oauth_creds: Boolean(SLACK_CLIENT_ID && SLACK_CLIENT_SECRET),
      node_env: NODE_ENV || 'development',
      base_url_configured: Boolean(BASE_URL),
    },
    state,
  });
});

// ---------- Slack OAuth (Install) ----------
/**
 * Presents the "Add to Slack" flow.
 * Works whether or not Bolt is initialized.
 */
app.get('/slack/install', (req, res) => {
  if (!SLACK_CLIENT_ID) {
    return res
      .status(500)
      .send('Missing SLACK_CLIENT_ID. Set it in Vercel → Project → Settings → Environment Variables.');
  }

  // Scopes: adjust as needed for your app
  const scopes = [
    'commands',
    'chat:write',
    'app_mentions:read',
    'channels:history',
    'groups:history',
    'im:history',
    'mpim:history',
    'reactions:read',
    'users:read',
  ];

  const userScopes = []; // e.g. 'users:read.email' if you need user token scopes

  const params = new URLSearchParams({
    client_id: SLACK_CLIENT_ID,
    scope: scopes.join(','),
    user_scope: userScopes.join(','),
    redirect_uri: REDIRECT_URI || '',
    // You can add state here if you want extra CSRF protection
  });

  const url = `https://slack.com/oauth/v2/authorize?${params.toString()}`;
  // Redirect to Slack's consent screen
  res.redirect(url);
});

/**
 * Handles Slack OAuth redirect. Exchanges ?code for tokens.
 * Saves bot token & team installation to /tmp (ephemeral) or project root in dev.
 */
app.get('/slack/oauth_redirect', async (req, res) => {
  try {
    const { code } = req.query || {};
    if (!code) return res.status(400).send('Missing ?code from Slack.');

    if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET) {
      return res
        .status(500)
        .send('Missing SLACK_CLIENT_ID/SLACK_CLIENT_SECRET. Set them in Vercel env.');
    }

    const form = new URLSearchParams({
      code,
      client_id: SLACK_CLIENT_ID,
      client_secret: SLACK_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI || '',
    });

    const resp = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });

    const data = await resp.json();
    if (!data.ok) {
      console.error('Slack OAuth error:', data);
      return res.status(400).send(`Slack OAuth failed: ${data.error || 'unknown_error'}`);
    }

    // Persist minimal install record (ephemeral on Vercel)
    const installs = await loadJson('installs.json', {});
    const key = `${data.team?.id || 'unknown'}:${data.enterprise?.id || 'none'}`;
    installs[key] = {
      installed_at: Date.now(),
      team: data.team || null,
      enterprise: data.enterprise || null,
      app_id: data.app_id || null,
      authed_user: data.authed_user || null,
      bot_token: data.access_token || data.bot_token || null,
      scope: data.scope || null,
    };
    await saveJson('installs.json', installs);

    // Friendly success page
    res
      .status(200)
      .send(
        `<h2>✅ Slack app installed</h2>
         <p>Team: <code>${data.team?.name || data.team?.id || 'unknown'}</code></p>
         <p>You can close this window and return to Slack.</p>`
      );
  } catch (err) {
    console.error('OAuth redirect handler error:', err);
    res.status(500).send('Internal error during Slack OAuth redirect.');
  }
});

// ---------- Optional: Bolt HTTP mode ----------
let boltApp = null;
(async () => {
  if (SLACK_BOT_TOKEN && SLACK_SIGNING_SECRET) {
    const { App, ExpressReceiver } = require('@slack/bolt');

    const receiver = new ExpressReceiver({
      signingSecret: SLACK_SIGNING_SECRET,
      processBeforeResponse: true,
      endpoints: '/api/slack/events', // Bolt events live here
    });

    boltApp = new App({
      token: SLACK_BOT_TOKEN,
      signingSecret: SLACK_SIGNING_SECRET,
      receiver,
    });

    // Example handler
    boltApp.event('app_mention', async ({ say }) => {
      await say('👋 DM Redirect Bot is online (Vercel HTTP mode).');
    });

    // Slash command example
    boltApp.command('/dm-guard', async ({ ack, respond }) => {
      await ack();
      const state = await loadJson('state.json', { guard: false });
      state.guard = !state.guard;
      await saveJson('state.json', state);
      await respond({ text: `Your guard is *${state.guard ? 'ON' : 'OFF'}*.`, response_type: 'ephemeral' });
    });

    // Mount Bolt under /api/slack/*
    app.use(receiver.router);
    console.log('Bolt HTTP mode initialized.');
  } else {
    console.warn('Bolt not initialized (missing SLACK_BOT_TOKEN/SLACK_SIGNING_SECRET).');
  }
})();

// ---------- Simple state API ----------
app.post('/api/state', async (req, res) => {
  try {
    const current = await loadJson('state.json', {});
    const next = { ...current, ...(req.body || {}), ts: Date.now() };
    await saveJson('state.json', next);
    res.status(200).json({ ok: true, state: next });
  } catch (e) {
    console.error('POST /api/state error:', e);
    res.status(500).json({ ok: false, error: 'STATE_WRITE_FAILED' });
  }
});

// Local dev server only
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => console.log(`Local dev: http://localhost:${PORT}`));
}

module.exports = app;
module.exports.default = app;
