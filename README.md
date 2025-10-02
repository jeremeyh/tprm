# TPRM DM Redirect Bot (User-Token, DM-only)

Auto-replies **inside the DM thread** when a teammate has their guard **ON**. Uses **user tokens** (per-user OAuth)
to receive `message.im` events and post replies as that user.

## What it does
- `/availability on|off|status` — teammates toggle personal "guard" state (stored in JSON).
- When **ON** and someone DM’s them, the app auto-replies **in the same DM** with a polite redirect to **#tprm-questions**.
- Team members are restricted by `TEAM_USER_IDS`.

## Setup (high level)
1) Create app from `manifest.yaml` (YAML tab). Ensure **Socket Mode** is enabled.
2) Set `.env` with your values (bot token, app token, OAuth client, secrets).
3) Run:
   ```bash
   npm install
   npm run dev
   ```
4) Visit `http://localhost:3000/slack/install` and have each teammate complete OAuth.
5) Use `/availability on` to enable the guard. Send a DM to test; expect an in-thread reply from the user.

## Notes
- Requires user scopes: `im:history`, `chat:write`, optionally `users.profile:write` for status.
- Tokens are stored in `./data/user_tokens.json` (replace with a proper secret manager in production).
- Only DM replies are implemented — channel behavior is deliberately omitted per your requirement.

