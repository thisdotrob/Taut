# Taut

Taut is a lightweight AI triage feed for Slack. It intentionally avoids cloning the Slack UI: there is one feed of incoming items, SLOs by classification, suggested replies/actions, and explicit review-first actions.

## Stack

- React + Vite + TypeScript for the UI
- Express + TypeScript for the local API
- SQLite via `better-sqlite3` for persistence
- Slack Web API ingestion/actions, using either `SLACK_BOT_TOKEN` or OneCLI-managed proxy credentials

## Run locally

```bash
pnpm install
pnpm seed      # optional: seed demo triage items
pnpm dev
```

Open http://localhost:5173.

The API runs on http://localhost:8787 and Vite proxies `/api/*` to it.

## Slack credentials

Taut is review-first and never posts without an explicit UI action.

For Slack API access, use one of:

1. `SLACK_BOT_TOKEN=xoxb-... pnpm dev`, or
2. run in an environment with OneCLI gateway credentials and `HTTPS_PROXY` configured.

The current prototype uses these Slack scopes when available:

- `channels:read`, `groups:read`, `im:read`, `mpim:read`
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `chat:write`, `reactions:write`

## Implemented MVP functionality

### Slack ingestion

- Pulls public channels, private channels, DMs, and group DMs where the user is a member.
- Does not rely on starred channels.
- Persists a per-conversation pull setting:
  - `pull_all`
  - `mentions_only`
  - `disabled`
- Supports changing the pull rule from each feed item.

### UI

- Single triage feed, no Slack-style sidebar and no channel browser.
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
```

## Current limitations

- AI classification and drafts are heuristic placeholders (`heuristic-v0`) ready to be swapped for a model call.
- Conversation names for DMs use Slack IDs unless user-profile hydration is added.
- Ingestion currently pulls the latest N messages per conversation rather than an incremental cursor window.
- Repo creation under `thisdotrob/taut` requires GitHub credentials with access to Rob's personal account.
