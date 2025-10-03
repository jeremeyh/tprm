// app.js — Slack DM Redirect Bot (Vercel-safe Express server)
// Last updated: 2025-10-03

require('dotenv/config');
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { loadJson, saveJson } = require('./storage');

// Optional Slack wiring (only boot if env is present)
let boltApp = null;
let receiver = null;

const {
  SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET,
  // If you run Socket Mode locally, you'll also have SLACK_APP_TOKEN,
  // but for Vercel (HTTP events) it's not required.
  SLACK_APP_TOKEN,
  NODE_ENV,
  PORT = 3000,
} = process.env;

const app = express();

// Basic hardening and JSON body parse
app.disable('x-powered-by');
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

/**
 * Minimal health endpoint so Vercel can hit something that never crashes
 */
app.get('/', (_req, res) => {
  res.status(200).send('OK: root is alive.');
});

app.get('/api/health', async (_req, res) => {
  // Prove the storage layer won’t crash even when files don’t exist
  const state = await loadJson('state.json', { ok: true, ts: Date.now() });
  res.status(200).json({
    status: 'healthy',
    env: {
      slack: Boolean(SLACK_BOT_TOKEN && SLACK_SIGNING_SECRET),
      node_env: NODE_ENV || 'development',
    },
    state,
  });
});

/**
 * Slack verification helper (used only if you wire custom routes without Bolt)
 */
function verifySlackSignature(req) {
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  if (!SLACK_SIGNING_SECRET || !timestamp || !signature) return false;

  const fiveMinutes = 60 * 5;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > fiveMinutes) {
    return false;
  }

  const body = req.rawBody || JSON.stringify(req.body || {});
  const basestring = `v0:${timestamp}:${body}`;
  const mySig = `v0=${crypto
    .createHmac('sha256', SLACK_SIGNING_SECRET)
    .update(basestring, 'utf8')
    .digest('hex')}`;

  return crypto.timingSafeEqual(Buffer.from(mySig), Buffer.from(signature));
}

/**
 * OPTIONAL: Slack (Bolt) HTTP mode
 * We only initialize Bolt if required env vars exist to avoid Vercel 500s.
 */
(async () => {
  if (SLACK_BOT_TOKEN && SLACK_SIGNING_SECRET) {
    const { App, ExpressReceiver } = require('@slack/bolt');

    receiver = new ExpressReceiver({
      signingSecret: SLACK_SIGNING_SECRET,
      // Mount under /api/slack to keep it tidy for Vercel
      processBeforeResponse: true,
      endpoints: '/api/slack/events',
    });

    boltApp = new App({
      token: SLACK_BOT_TOKEN,
      signingSecret: SLACK_SIGNING_SECRET,
      // No appToken necessary for HTTP mode (appToken is for Socket Mode)
      receiver,
    });

    // Example listener — keeps function warm and demonstrates no-crash
    boltApp.event('app_home_opened', async ({ event, client }) => {
      try {
        await client.views.publish({
          user_id: event.user,
          view: {
            type: 'home',
            blocks: [
              { type: 'section', text: { type: 'mrkdwn', text: '*DM Redirect Bot is online*' } },
              { type: 'context', elements: [{ type: 'mrkdwn', text: 'Vercel HTTP mode ✅' }] },
            ],
          },
        });
      } catch (err) {
        console.error('Error publishing home view:', err);
      }
    });

    // Example slash command (adjust name in Slack config)
    boltApp.command('/dm-guard', async ({ ack, respond }) => {
      await ack();
      const state = await loadJson('state.json', { guard: false });
      state.guard = !state.guard;
      await saveJson('state.json', state);
      await respond({ text: `Your guard is *${state.guard ? 'ON' : 'OFF'}*.`, response_type: 'ephemeral' });
    });

    // Attach Bolt receiver into our Express app (mounted at /api/slack/*)
    app.use(receiver.router);

    console.log('Slack Bolt (HTTP mode) initialized.');
  } else {
    console.warn(
      'Slack env vars missing — running in API-only mode. Set SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET in Vercel to enable Slack.'
    );
  }
})();

/**
 * Simple key/value state API to prove read/write works in Vercel (/tmp)
 */
app.post('/api/state', async (req, res) => {
  try {
    const body = req.body || {};
    const current = await loadJson('state.json', {});
    const next = { ...current, ...body, ts: Date.now() };
    await saveJson('state.json', next);
    res.status(200).json({ ok: true, state: next });
  } catch (e) {
    console.error('POST /api/state error:', e);
    res.status(500).json({ ok: false, error: 'STATE_WRITE_FAILED' });
  }
});

/**
 * Local dev server — Vercel will ignore this (it exports the Express app below)
 */
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`Local dev server listening on http://localhost:${PORT}`);
  });
}

// Export for Vercel serverless
module.exports = app;
// ESM default export (harmless in CJS; useful if bundlers expect default)
module.exports.default = app;
