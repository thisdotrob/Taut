# Slack Socket Mode setup for Taut

Socket Mode is now the preferred path for near-real-time Slack event delivery in Taut.

## What Socket Mode does and does not solve

Socket Mode **does** remove the need for a public HTTPS Events API Request URL. Taut opens an outbound WebSocket to Slack, so local development can receive subscribed Events API payloads without exposing `/api/events` or doing Slack URL verification.

Socket Mode **does not** replace Slack OAuth. Taut still needs the OAuth user-token flow from `docs/slack-oauth-setup.md` so Web API calls happen with Rob-visible access. In practice Taut uses two tokens:

1. `SLACK_APP_TOKEN` (`xapp-...`) with `connections:write` — opens the Socket Mode WebSocket.
2. Stored Slack OAuth user token (`xoxp-...`, stored server-side in SQLite) — lists/fetches Rob-visible conversations, creates triage items with context/permalinks, and performs explicit review-first writes.

Polling/backfill (`pnpm ingest` or the **Pull Slack** UI action) remains available and should be kept. Socket events are near-real-time but not a durable queue; if the local listener is down, backfill catches up later. The UI health panel reports whether the local Socket Mode heartbeat is fresh.

## Event coverage model

Taut subscribes to these **workspace/user events**:

```text
message.channels
message.groups
message.im
message.mpim
```

Slack documents these required scopes:

- `message.channels` → `channels:history`
- `message.groups` → `groups:history`
- `message.im` → `im:history`
- `message.mpim` → `mpim:history`

Slack's Events API permission model says workspace/user events are scoped to what authorized users can see. That matches Taut's model better than bot-only events, because Rob authorizes the app and Taut uses Rob's user token for Web API context. Caveat: workspace admin policy or Slack app configuration can still affect which events are delivered. Keep polling/backfill enabled for safety.

## Slack app setup

1. Update/create the Slack app from `docs/slack-app-manifest.yaml`.
2. Confirm **Socket Mode** is enabled.
3. Confirm **Event Subscriptions** include these user events:
   - `message.channels`
   - `message.groups`
   - `message.im`
   - `message.mpim`
4. Under **Basic Information → App-Level Tokens**, generate an app-level token with:

   ```text
   connections:write
   ```

5. Set the token locally:

   ```bash
   SLACK_APP_TOKEN=xapp-...
   ```

6. Complete the OAuth user-token setup in `docs/slack-oauth-setup.md` if it is not already connected.

## Running locally

Run the API/UI as usual:

```bash
pnpm dev
```

In another terminal, run the Socket Mode listener:

```bash
pnpm socket
```

Or run API, web, and Socket Mode together after `SLACK_APP_TOKEN` is set:

```bash
pnpm dev:all
```

The listener will:

1. Call `apps.connections.open` with `SLACK_APP_TOKEN`.
2. Connect to Slack's dynamic WebSocket URL.
3. Acknowledge event envelopes.
4. For incoming `message.*` events, create/dedupe a Taut triage item.
5. Fetch conversation names/permalinks through the stored Slack OAuth user token.
6. Respect per-conversation pull rules (`pull_all`, `mentions_only`, `disabled`).
7. Update a local heartbeat so the UI can show Socket Mode health and a second listener can fail fast instead of silently duplicating work.

## Fallback/backfill

Use this any time the Socket Mode listener was offline or you want to reconcile missed events:

```bash
pnpm ingest
```

or click **Pull Slack** in the UI.

## Safety

Socket Mode only changes how Taut receives incoming message events. Slack writes are still review-first:

- no automatic replies
- no automatic reactions
- `send AI draft`, `edit then send`, `manual reply, observe`, and `react` still require explicit UI action
