# Slack OAuth setup for Taut

Taut's primary Slack setup is **Slack OAuth with a user token**. This is different from the earlier bot-token smoke-test path.

## Why user-token OAuth, not bot tokens?

Rob wants Taut to triage conversations visible to Rob:

- public channels Rob is a member of
- private channels Rob is a member of
- Rob's DMs
- Rob's group DMs

A bot token only sees conversations the bot has access to. That is useful for quick smoke tests, but it is the wrong production path for Taut. The app now stores a Slack OAuth **user token** server-side and uses it by default for ingestion, replies, and reactions. `SLACK_USER_TOKEN` / `SLACK_BOT_TOKEN` remain only as local development escape hatches.

## Slack scopes requested

Taut requests these **User Token Scopes**:

```text
channels:read
groups:read
im:read
mpim:read
channels:history
groups:history
im:history
mpim:history
chat:write
reactions:write
users:read
```

These match the Conversations API surfaces Taut pulls from and the explicit review-first write actions it supports. Slack's OAuth docs use `user_scope` for user-token scopes, and `oauth.v2.access` returns the user token under `authed_user.access_token`.

## Local setup

Slack requires HTTPS OAuth redirect URLs. For local development, expose the API server with an HTTPS tunnel such as ngrok or Cloudflare Tunnel, then use that HTTPS host for the Slack redirect.

1. Start an HTTPS tunnel to the API server, for example `https://taut.example.com` → `http://localhost:8787`.
2. Create a Slack app at <https://api.slack.com/apps>.
3. Choose **Create New App → From an app manifest**.
4. Replace the `https://taut.example.com` placeholder in `docs/slack-app-manifest.yaml` with your HTTPS tunnel or deployed backend host, then paste the manifest.
5. Confirm the redirect URL is exactly:

   ```text
   https://taut.example.com/api/slack/oauth/callback
   ```

6. Save the app, then copy the app's **Client ID** and **Client Secret** from **Basic Information**.
7. Create `.env` locally:

   ```bash
   cp .env.example .env
   ```

8. Fill in:

   ```bash
   SLACK_CLIENT_ID=<your Slack app client id>
   SLACK_CLIENT_SECRET=<your Slack app client secret>
   SLACK_REDIRECT_URI=https://taut.example.com/api/slack/oauth/callback
   TAUT_APP_URL=http://localhost:5173
   ```

9. Start Taut:

   ```bash
   pnpm install
   pnpm dev
   ```

10. Open <http://localhost:5173> and click **Connect Slack**.
11. Authorize the app as Rob.
12. After Slack redirects back, return to Taut and click **Pull Slack**.

The user token is stored in the local SQLite database (`data/taut.db`) and is never returned to the browser. The `/api/slack/connection` endpoint only returns safe metadata such as team/user IDs, token source, and scopes.

## Redirect URL for tunnels or deployed hosts

Slack requires HTTPS and an exact redirect URL match. For local development, use an HTTPS tunnel to `localhost:8787`; for a deployment, use the deployed HTTPS backend. Add this redirect URL in the Slack app:

```text
https://taut.example.com/api/slack/oauth/callback
```

Then set:

```bash
TAUT_PUBLIC_URL=https://taut.example.com
SLACK_REDIRECT_URI=https://taut.example.com/api/slack/oauth/callback
TAUT_APP_URL=http://localhost:5173
```

`SLACK_REDIRECT_URI` must exactly match one of the Slack app redirect URLs.

## Dev-only fallback tokens

Only use these when OAuth is not convenient during local development:

```bash
SLACK_USER_TOKEN=xoxp-...
# or, for a limited bot-token smoke test only:
SLACK_BOT_TOKEN=xoxb-...
```

Important differences:

- `SLACK_USER_TOKEN` can approximate the OAuth user-token behavior, but it bypasses the connect flow.
- `SLACK_BOT_TOKEN` is **not** the main path. It may miss Rob's private channels, DMs, and any channel the bot is not a member of.
- The UI labels env-token use as a dev fallback so Rob does not confuse it with the real setup.

## Safety model

Taut remains review-first:

- Slack ingestion can run after OAuth connection.
- No substantive Slack replies are posted automatically.
- `send AI draft`, `edit then send`, `manual reply, observe`, and `react` only call Slack after explicit UI actions.
- Suggested text, sent text, and manual-vs-draft learning deltas are persisted in SQLite for auditability.
