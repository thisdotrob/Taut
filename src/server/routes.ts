import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addSlackReaction, getSlackAuth, ingestSlack, postSlackReply } from './slack';
import { buildSlackOAuthStartUrl, completeSlackOAuth, disconnectSlack, getSlackConnectionStatus, tautAppUrl } from './slack-oauth';
import {
  computeSloSummary,
  getDbPath,
  getItem,
  getLatestDraft,
  listConversations,
  listItems,
  markItemStatus,
  migrate,
  recordAction,
  seedDemoData,
  storeLearningDelta,
  updateConversationPullSetting
} from './db';
import type { PullSetting } from './types';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(): express.Express {
  migrate();

  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, dbPath: getDbPath(), time: new Date().toISOString() });
  });

  app.get('/api/slack/auth', asyncHandler(async (_req, res) => {
    res.json(await getSlackAuth());
  }));

  app.get('/api/slack/connection', (req, res) => {
    res.json(getSlackConnectionStatus(req));
  });

  app.get('/api/slack/oauth/start', (req, res, next) => {
    try {
      res.redirect(buildSlackOAuthStartUrl(req));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/slack/oauth/callback', asyncHandler(async (req, res) => {
    const result = await completeSlackOAuth(req);
    const redirectPath = result.redirectAfter ?? '/';
    const appUrl = `${tautAppUrl()}${redirectPath}`;
    res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Taut Slack connected</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f0e8; color: #17130f; }
      main { max-width: 640px; margin: 24px; padding: 32px; border-radius: 28px; background: #fffaf1; box-shadow: 0 24px 80px rgba(60, 42, 26, 0.14); }
      a { color: #ad3f1a; font-weight: 800; }
    </style>
  </head>
  <body>
    <main>
      <h1>Slack connected</h1>
      <p>Taut connected to ${escapeHtml(result.teamName)} with a Slack user token for user ${escapeHtml(result.userId)}.</p>
      <p>Granted scopes: ${escapeHtml(result.scopes.join(', ') || 'none reported')}.</p>
      <p><a href="${escapeHtml(appUrl)}">Return to Taut</a></p>
    </main>
  </body>
</html>`);
  }));

  app.post('/api/slack/disconnect', (_req, res) => {
    disconnectSlack();
    res.json({ ok: true });
  });

  app.get('/api/items', (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : 'open';
    res.json(listItems(status));
  });

  app.get('/api/conversations', (_req, res) => {
    res.json(listConversations());
  });

  app.get('/api/slo', (_req, res) => {
    res.json(computeSloSummary());
  });

  app.post('/api/demo/seed', (_req, res) => {
    seedDemoData();
    res.json({ ok: true, items: listItems('open'), slo: computeSloSummary() });
  });

  app.post('/api/ingest/slack', asyncHandler(async (req, res) => {
    const rawLimit = typeof req.body?.limitPerConversation === 'number' ? req.body.limitPerConversation : 10;
    const result = await ingestSlack(rawLimit);
    res.json({ ok: true, result, items: listItems('open'), slo: computeSloSummary() });
  }));

  app.post('/api/conversations/:id/pull-rule', (req, res) => {
    const pullSetting = req.body?.pullSetting as PullSetting | undefined;
    if (!pullSetting || !['pull_all', 'mentions_only', 'disabled'].includes(pullSetting)) {
      res.status(400).json({ ok: false, error: 'pullSetting must be pull_all, mentions_only, or disabled' });
      return;
    }
    res.json(updateConversationPullSetting(String(req.params.id), pullSetting));
  });

  app.post('/api/items/:id/actions', asyncHandler(async (req, res) => {
    const item = getItem(String(req.params.id));
    if (!item) {
      res.status(404).json({ ok: false, error: 'Item not found' });
      return;
    }

    const action = String(req.body?.action ?? '');
    const draft = getLatestDraft(item.id);

    if (action === 'send_ai_draft') {
      if (!draft?.draft_text) throw new Error('No AI draft available for this item');
      await postReplyOrSimulate(item, draft.draft_text);
      markItemStatus(item.id, 'replied');
      recordAction(item.id, action, { sentText: draft.draft_text, draftId: draft.id });
    } else if (action === 'edit_then_send') {
      const text = requireText(req.body?.text, 'Edited reply text is required');
      await postReplyOrSimulate(item, text);
      markItemStatus(item.id, 'replied');
      recordAction(item.id, action, { sentText: text, originalDraft: draft?.draft_text ?? null });
    } else if (action === 'manual_reply_observe') {
      const text = requireText(req.body?.text, 'Manual reply text is required');
      await postReplyOrSimulate(item, text);
      markItemStatus(item.id, 'replied');
      storeLearningDelta(item.id, draft?.draft_text ?? '', text);
      recordAction(item.id, action, { sentText: text, comparedToDraft: draft?.id ?? null });
    } else if (action === 'react') {
      const emoji = requireText(req.body?.emoji, 'Emoji is required');
      await addReactionOrSimulate(item, emoji);
      recordAction(item.id, action, { emoji });
    } else if (action === 'close_no_reply') {
      markItemStatus(item.id, 'closed');
      recordAction(item.id, action);
    } else if (action === 'discard_not_useful') {
      markItemStatus(item.id, 'discarded');
      recordAction(item.id, action, { signal: 'not_useful' });
    } else if (action === 'change_pull_rule') {
      const pullSetting = req.body?.pullSetting as PullSetting | undefined;
      if (!pullSetting || !['pull_all', 'mentions_only', 'disabled'].includes(pullSetting)) {
        res.status(400).json({ ok: false, error: 'pullSetting must be pull_all, mentions_only, or disabled' });
        return;
      }
      updateConversationPullSetting(item.conversation_id, pullSetting);
      recordAction(item.id, action, { pullSetting });
    } else {
      res.status(400).json({ ok: false, error: `Unsupported action: ${action}` });
      return;
    }

    res.json({ ok: true, item: getItem(item.id), slo: computeSloSummary() });
  }));

  const clientDist = path.resolve(dirname, '..', '..', 'dist', 'client');
  app.use(express.static(clientDist));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ ok: false, error: message });
  });

  return app;
}


async function postReplyOrSimulate(item: { slack_channel_id: string; thread_ts: string | null; slack_ts: string }, text: string): Promise<void> {
  if (item.slack_channel_id.includes('DEMO')) return;
  await postSlackReply({ channel: item.slack_channel_id, threadTs: item.thread_ts ?? item.slack_ts, text });
}

async function addReactionOrSimulate(item: { slack_channel_id: string; slack_ts: string }, emoji: string): Promise<void> {
  if (item.slack_channel_id.includes('DEMO')) return;
  await addSlackReaction({ channel: item.slack_channel_id, timestamp: item.slack_ts, emoji });
}

function asyncHandler(handler: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

function requireText(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(message);
  return value.trim();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
