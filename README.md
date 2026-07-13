# Taut

Taut is a lightweight AI triage feed for Slack. It intentionally avoids cloning the Slack UI: there is one feed of incoming items, SLOs by classification, suggested replies/actions, and explicit review-first actions.

## Stack

- React + Vite + TypeScript for the UI
- Express + TypeScript for the local API
- SQLite via `better-sqlite3` for persistence
- Slack Web API ingestion/actions via Slack OAuth **user tokens** by default

## Run locally

```bash
pnpm install
pnpm seed      # optional: seed demo triage items
pnpm dev
```

Open http://localhost:5173.

The API runs on http://localhost:8787 and Vite proxies `/api/*` to it.

## Slack Socket Mode for near-real-time events

Taut supports Slack Socket Mode so ongoing message events do not require a public HTTPS Events API Request URL. Run it with:

```bash
pnpm socket
```

Socket Mode still needs an app-level token:

```bash
SLACK_APP_TOKEN=xapp-... # app-level token with connections:write
```

Socket Mode is only event delivery. Taut still needs the OAuth user-token flow below for Rob-visible Web API access and review-first writes. Keep polling/backfill via **Pull Slack** or `pnpm ingest` for missed events. See `docs/slack-socket-mode.md`.

## Slack setup: use OAuth user tokens

Taut's real Slack path is now **OAuth user-token setup**, not the earlier bot-token smoke-test path.

Why this matters: Rob wants Taut to ingest conversations visible to Rob — public/private channels Rob belongs to, DMs, and group DMs. A bot token only sees conversations the bot is allowed to see, which is usually the wrong scope for Taut.

Use:

- `docs/slack-app-manifest.yaml` to create/configure the Slack app
- `docs/slack-oauth-setup.md` for exact setup steps and redirect URL guidance

Required app env values:

```bash
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_REDIRECT_URI=https://taut.example.com/api/slack/oauth/callback
TAUT_APP_URL=http://localhost:5173
```

Then run Taut and click **Connect Slack** in the UI. The resulting user token is stored in local SQLite on the server side and is never exposed to the client.

### Dev-only token fallbacks

These are escape hatches only:

```bash
SLACK_USER_TOKEN=xoxp-... # local user-token shortcut, bypasses OAuth UI
SLACK_BOT_TOKEN=xoxb-...  # limited smoke test; not Rob's real setup
```

Do not use `SLACK_BOT_TOKEN` as the main path. It can miss private channels, DMs, group DMs, and any public channel where the bot is not present.

## Implemented MVP functionality

### Slack ingestion

- Pulls public channels, private channels, DMs, and group DMs where the authorized user is a member.
- Uses stored Slack OAuth user token by default; env-token fallback only for development.
- Does not rely on starred channels.
- Persists a per-conversation pull setting:
  - `pull_all`
  - `mentions_only`
  - `disabled`
- Supports changing the pull rule from each feed item.

### UI

- Single triage feed, no Slack-style sidebar and no channel browser.
- Slack connection panel that clearly shows OAuth user-token vs dev fallback token use.
- Each item shows source, author, excerpt, classification, SLO/due time, AI suggested action/reply, and Slack permalink.
- SLO view shows performance by classification, overdue items, aging queue inputs, and replied-within-SLO percentage.

### Actions

Each feed item supports:

- send AI draft
- edit then send
- manual reply, observe
- react
- close / no reply needed
- discard / not useful
- change pull rule for the source

`manual reply, observe` posts Rob's manual reply, compares it with the AI draft, and stores a learning delta.

### Persistence and safety

SQLite persists:

- Slack OAuth user-token connection metadata and server-side access token
- conversations and pull rules
- triage items
- classifications and SLO status
- AI drafts
- accepted/edited/manual replies through audit actions
- feedback deltas
- discard/noise signals
- per-conversation preferences JSON

All Slack writes are explicit UI actions. Suggested text and sent text are recorded in the audit trail.

## Useful scripts

```bash
pnpm build     # type-check and build frontend
pnpm start     # serve built frontend through the API server
pnpm seed      # insert demo data
pnpm ingest    # run one Slack ingestion pass from the CLI
pnpm socket    # run the Slack Socket Mode listener
```

## Current limitations

- AI classification and drafts are heuristic placeholders (`heuristic-v0`) ready to be swapped for a model call.
- Conversation names for DMs use Slack IDs unless user-profile hydration is added.
- Ingestion currently pulls the latest N messages per conversation rather than an incremental cursor window.
- Local SQLite token storage is appropriate for this prototype; production should encrypt tokens and add account/session boundaries.
