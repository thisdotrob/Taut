import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addSlackReaction, getSlackAuth, ingestSlack, postSlackReply } from './slack';
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
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, dbPath: getDbPath(), time: new Date().toISOString() });
  });

  app.get('/api/slack/auth', asyncHandler(async (_req, res) => {
    res.json(await getSlackAuth());
  }));

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
