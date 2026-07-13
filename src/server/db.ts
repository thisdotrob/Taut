import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Classification,
  ConversationRecord,
  ConversationSourceRecord,
  DraftRecord,
  PullSetting,
  SlackConnectionRecord,
  SloSummary,
  TriageItemRecord,
  TriageItemWithContext
} from './types';
import { compareManualReply, heuristicTriage, makeExcerpt, sloMinutesFor, type TriageDecision } from './triage';

const dbPath = process.env.TAUT_DB_PATH ?? path.resolve(process.cwd(), 'data', 'taut.db');
mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function migrate(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      slack_channel_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      is_member INTEGER NOT NULL DEFAULT 1,
      pull_setting TEXT NOT NULL DEFAULT 'pull_all' CHECK (pull_setting IN ('pull_all', 'mentions_only', 'disabled')),
      preferences_json TEXT NOT NULL DEFAULT '{}',
      last_pulled_at TEXT,
      last_seen_slack_ts TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS triage_items (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      slack_channel_id TEXT NOT NULL,
      slack_ts TEXT NOT NULL,
      thread_ts TEXT,
      author TEXT NOT NULL,
      author_id TEXT,
      text TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      permalink TEXT,
      classification TEXT NOT NULL,
      classification_rationale TEXT,
      triage_model TEXT,
      triage_prompt_version TEXT,
      context_snapshot_json TEXT,
      slo_minutes INTEGER NOT NULL,
      due_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'replied', 'closed', 'discarded')),
      created_at TEXT NOT NULL,
      replied_at TEXT,
      UNIQUE(slack_channel_id, slack_ts)
    );

    CREATE TABLE IF NOT EXISTS ai_drafts (
      id TEXT PRIMARY KEY,
      triage_item_id TEXT NOT NULL REFERENCES triage_items(id) ON DELETE CASCADE,
      draft_text TEXT NOT NULL,
      action_summary TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_version TEXT,
      rationale TEXT,
      context_snapshot_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS item_actions (
      id TEXT PRIMARY KEY,
      triage_item_id TEXT NOT NULL REFERENCES triage_items(id) ON DELETE CASCADE,
      action_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS learning_deltas (
      id TEXT PRIMARY KEY,
      triage_item_id TEXT NOT NULL REFERENCES triage_items(id) ON DELETE CASCADE,
      ai_draft TEXT NOT NULL,
      manual_reply TEXT NOT NULL,
      delta_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS slack_oauth_states (
      state TEXT PRIMARY KEY,
      redirect_after TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS slack_connections (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      team_name TEXT NOT NULL,
      authed_user_id TEXT NOT NULL,
      authed_user_name TEXT,
      access_token TEXT NOT NULL,
      scope TEXT NOT NULL,
      token_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS suppressed_threads (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      slack_channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(slack_channel_id, thread_ts)
    );

    CREATE TABLE IF NOT EXISTS runtime_status (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_triage_items_status_due ON triage_items(status, due_at);
    CREATE INDEX IF NOT EXISTS idx_triage_items_classification ON triage_items(classification);
    CREATE INDEX IF NOT EXISTS idx_actions_item ON item_actions(triage_item_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_slack_oauth_states_expires ON slack_oauth_states(expires_at);
    CREATE INDEX IF NOT EXISTS idx_suppressed_threads_channel_ts ON suppressed_threads(slack_channel_id, thread_ts);

    UPDATE triage_items
    SET permalink = NULL
    WHERE slack_channel_id GLOB '[CDGM]DEMO*';
  `);

  ensureColumn('conversations', 'last_seen_slack_ts', 'TEXT');
  ensureColumn('triage_items', 'classification_rationale', 'TEXT');
  ensureColumn('triage_items', 'triage_model', 'TEXT');
  ensureColumn('triage_items', 'triage_prompt_version', 'TEXT');
  ensureColumn('triage_items', 'context_snapshot_json', 'TEXT');
  ensureColumn('ai_drafts', 'prompt_version', 'TEXT');
  ensureColumn('ai_drafts', 'rationale', 'TEXT');
  ensureColumn('ai_drafts', 'context_snapshot_json', 'TEXT');
}


export function getDbPath(): string {
  return dbPath;
}

export function upsertConversation(input: {
  slackChannelId: string;
  name: string;
  kind: string;
  isMember: boolean;
}): ConversationRecord {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM conversations WHERE slack_channel_id = ?').get(input.slackChannelId) as ConversationRecord | undefined;

  if (existing) {
    db.prepare(`
      UPDATE conversations
      SET name = @name, kind = @kind, is_member = @isMember, updated_at = @now
      WHERE slack_channel_id = @slackChannelId
    `).run({
      name: input.name,
      kind: input.kind,
      isMember: input.isMember ? 1 : 0,
      now,
      slackChannelId: input.slackChannelId
    });
    return getConversationBySlackId(input.slackChannelId)!;
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO conversations (id, slack_channel_id, name, kind, is_member, pull_setting, preferences_json, created_at, updated_at)
    VALUES (@id, @slackChannelId, @name, @kind, @isMember, 'pull_all', '{}', @now, @now)
  `).run({ id, slackChannelId: input.slackChannelId, name: input.name, kind: input.kind, isMember: input.isMember ? 1 : 0, now });

  return getConversationBySlackId(input.slackChannelId)!;
}

export function getConversationBySlackId(slackChannelId: string): ConversationRecord | undefined {
  return db.prepare('SELECT * FROM conversations WHERE slack_channel_id = ?').get(slackChannelId) as ConversationRecord | undefined;
}

export function listConversations(): ConversationRecord[] {
  return db.prepare('SELECT * FROM conversations ORDER BY kind, name').all() as ConversationRecord[];
}

export function listConversationSources(): ConversationSourceRecord[] {
  const recentSince = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  return db.prepare(`
    SELECT
      c.*,
      COALESCE(SUM(CASE WHEN ti.status = 'open' THEN 1 ELSE 0 END), 0) AS open_item_count,
      COALESCE(SUM(CASE WHEN ti.created_at >= @recentSince THEN 1 ELSE 0 END), 0) AS recent_item_count,
      COUNT(ti.id) AS total_item_count,
      MAX(ti.created_at) AS latest_item_at
    FROM conversations c
    LEFT JOIN triage_items ti ON ti.conversation_id = c.id
    GROUP BY c.id
    ORDER BY
      CASE c.kind WHEN 'im' THEN 0 WHEN 'mpim' THEN 1 WHEN 'private_channel' THEN 2 ELSE 3 END,
      c.name COLLATE NOCASE
  `).all({ recentSince }) as ConversationSourceRecord[];
}

export function updateConversationPullSetting(conversationId: string, pullSetting: PullSetting): ConversationRecord {
  const now = new Date().toISOString();
  db.prepare('UPDATE conversations SET pull_setting = ?, updated_at = ? WHERE id = ?').run(pullSetting, now, conversationId);
  const updated = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) as ConversationRecord | undefined;
  if (!updated) throw new Error(`Conversation not found: ${conversationId}`);
  return updated;
}

export function updateConversationPullSettings(input: {
  conversationIds: string[];
  pullSetting: PullSetting;
  closeOpenItems?: boolean;
}): { updatedConversations: number; closedOpenItems: number; pullSetting: PullSetting } {
  const uniqueIds = Array.from(new Set(input.conversationIds.filter(Boolean)));
  if (uniqueIds.length === 0) throw new Error('Select at least one source.');

  const now = new Date().toISOString();
  const updateConversation = db.prepare('UPDATE conversations SET pull_setting = ?, updated_at = ? WHERE id = ?');
  const closeItemsForConversation = db.prepare(
    "UPDATE triage_items SET status = 'closed' WHERE conversation_id = ? AND status = 'open'"
  );

  const result = db.transaction(() => {
    let updatedConversations = 0;
    let closedOpenItems = 0;

    for (const conversationId of uniqueIds) {
      updatedConversations += updateConversation.run(input.pullSetting, now, conversationId).changes;
      if (input.closeOpenItems) closedOpenItems += closeItemsForConversation.run(conversationId).changes;
    }

    return { updatedConversations, closedOpenItems, pullSetting: input.pullSetting };
  })();

  if (result.updatedConversations === 0) throw new Error('No matching sources found.');
  return result;
}

export function markConversationPulled(conversationId: string, latestSlackTs: string | null = null): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE conversations
    SET
      last_pulled_at = @now,
      last_seen_slack_ts = CASE
        WHEN @latestSlackTs IS NOT NULL AND (last_seen_slack_ts IS NULL OR CAST(@latestSlackTs AS REAL) > CAST(last_seen_slack_ts AS REAL))
          THEN @latestSlackTs
        ELSE last_seen_slack_ts
      END,
      updated_at = @now
    WHERE id = @conversationId
  `).run({ now, latestSlackTs, conversationId });
}

export function createSlackOAuthState(redirectAfter: string | null): string {
  const state = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  db.prepare('DELETE FROM slack_oauth_states WHERE expires_at < ?').run(now.toISOString());
  db.prepare('INSERT INTO slack_oauth_states (state, redirect_after, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    state,
    redirectAfter,
    expiresAt,
    now.toISOString()
  );
  return state;
}

export function consumeSlackOAuthState(state: string): { redirectAfter: string | null } | null {
  const row = db.prepare('SELECT state, redirect_after, expires_at FROM slack_oauth_states WHERE state = ?').get(state) as
    | { state: string; redirect_after: string | null; expires_at: string }
    | undefined;
  db.prepare('DELETE FROM slack_oauth_states WHERE state = ? OR expires_at < ?').run(state, new Date().toISOString());

  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) return null;
  return { redirectAfter: row.redirect_after };
}

export function storeSlackConnection(input: {
  teamId: string;
  teamName: string;
  authedUserId: string;
  authedUserName: string | null;
  accessToken: string;
  scope: string;
  tokenType: string;
}): SlackConnectionRecord {
  const now = new Date().toISOString();
  db.prepare('DELETE FROM slack_connections').run();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO slack_connections (
      id, team_id, team_name, authed_user_id, authed_user_name, access_token, scope, token_type, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.teamId, input.teamName, input.authedUserId, input.authedUserName, input.accessToken, input.scope, input.tokenType, now, now);

  return getSlackConnection()!;
}

export function getSlackConnection(): SlackConnectionRecord | null {
  return (db.prepare('SELECT * FROM slack_connections ORDER BY updated_at DESC LIMIT 1').get() as SlackConnectionRecord | undefined) ?? null;
}

export function clearSlackConnection(): void {
  db.prepare('DELETE FROM slack_connections').run();
}

export function createTriageItem(input: {
  conversation: ConversationRecord;
  slackTs: string;
  threadTs: string | null;
  author: string;
  authorId: string | null;
  text: string;
  permalink: string | null;
  isDirect: boolean;
  mentionsUser: boolean;
  triage?: TriageDecision;
  contextSnapshot?: unknown;
}): TriageItemRecord | null {
  const exists = db.prepare('SELECT * FROM triage_items WHERE slack_channel_id = ? AND slack_ts = ?').get(input.conversation.slack_channel_id, input.slackTs) as TriageItemRecord | undefined;
  if (exists) return null;

  const triage = input.triage ?? heuristicTriage({
    text: input.text,
    sourceName: input.conversation.name,
    isDirect: input.isDirect,
    mentionsUser: input.mentionsUser
  });
  const classification = triage.classification;
  const sloMinutes = sloMinutesFor(classification);
  const createdAt = slackTsToIso(input.slackTs) ?? new Date().toISOString();
  const dueAt = new Date(new Date(createdAt).getTime() + sloMinutes * 60_000).toISOString();
  const id = randomUUID();
  const excerpt = makeExcerpt(input.text);
  const contextSnapshotJson = safeJson(input.contextSnapshot);

  db.prepare(`
    INSERT INTO triage_items (
      id, conversation_id, slack_channel_id, slack_ts, thread_ts, author, author_id, text, excerpt, permalink,
      classification, classification_rationale, triage_model, triage_prompt_version, context_snapshot_json, slo_minutes, due_at, status, created_at
    ) VALUES (
      @id, @conversationId, @slackChannelId, @slackTs, @threadTs, @author, @authorId, @text, @excerpt, @permalink,
      @classification, @classificationRationale, @triageModel, @triagePromptVersion, @contextSnapshotJson, @sloMinutes, @dueAt, 'open', @createdAt
    )
  `).run({
    id,
    conversationId: input.conversation.id,
    slackChannelId: input.conversation.slack_channel_id,
    slackTs: input.slackTs,
    threadTs: input.threadTs,
    author: input.author,
    authorId: input.authorId,
    text: input.text,
    excerpt,
    permalink: input.permalink,
    classification,
    classificationRationale: triage.classificationRationale,
    triageModel: triage.model,
    triagePromptVersion: triage.promptVersion,
    contextSnapshotJson,
    sloMinutes,
    dueAt,
    createdAt
  });

  createDraft(id, triage.draftText, triage.actionSummary, triage.model, {
    promptVersion: triage.promptVersion,
    rationale: triage.classificationRationale,
    contextSnapshot: input.contextSnapshot
  });

  return db.prepare('SELECT * FROM triage_items WHERE id = ?').get(id) as TriageItemRecord;
}

export function createDraft(
  triageItemId: string,
  draftText: string,
  actionSummary: string,
  model: string,
  metadata: { promptVersion?: string | null; rationale?: string | null; contextSnapshot?: unknown } = {}
): DraftRecord {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const contextSnapshotJson = safeJson(metadata.contextSnapshot);
  db.prepare(`
    INSERT INTO ai_drafts (id, triage_item_id, draft_text, action_summary, model, prompt_version, rationale, context_snapshot_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, triageItemId, draftText, actionSummary, model, metadata.promptVersion ?? null, metadata.rationale ?? null, contextSnapshotJson, createdAt);
  return db.prepare('SELECT * FROM ai_drafts WHERE id = ?').get(id) as DraftRecord;
}

export function getLatestDraft(triageItemId: string): DraftRecord | undefined {
  return db.prepare('SELECT * FROM ai_drafts WHERE triage_item_id = ? ORDER BY created_at DESC LIMIT 1').get(triageItemId) as DraftRecord | undefined;
}

export function listItems(status = 'open'): TriageItemWithContext[] {
  const where = status === 'all' ? '' : 'WHERE ti.status = @status';
  return db.prepare(`
    SELECT
      ti.*,
      c.name AS source_name,
      c.kind AS source_kind,
      c.pull_setting AS pull_setting,
      d.id AS draft_id,
      d.draft_text AS draft_text,
      d.action_summary AS action_summary,
      d.model AS draft_model,
      d.prompt_version AS draft_prompt_version,
      d.rationale AS draft_rationale
    FROM triage_items ti
    JOIN conversations c ON c.id = ti.conversation_id
    LEFT JOIN ai_drafts d ON d.id = (
      SELECT id FROM ai_drafts WHERE triage_item_id = ti.id ORDER BY created_at DESC LIMIT 1
    )
    ${where}
    ORDER BY
      CASE WHEN ti.status = 'open' AND ti.due_at < @now THEN 0 ELSE 1 END,
      ti.due_at ASC,
      ti.created_at DESC
    LIMIT 200
  `).all({ status, now: new Date().toISOString() }) as TriageItemWithContext[];
}

export function getItem(id: string): TriageItemWithContext | undefined {
  return db.prepare(`
    SELECT
      ti.*,
      c.name AS source_name,
      c.kind AS source_kind,
      c.pull_setting AS pull_setting,
      d.id AS draft_id,
      d.draft_text AS draft_text,
      d.action_summary AS action_summary,
      d.model AS draft_model,
      d.prompt_version AS draft_prompt_version,
      d.rationale AS draft_rationale
    FROM triage_items ti
    JOIN conversations c ON c.id = ti.conversation_id
    LEFT JOIN ai_drafts d ON d.id = (
      SELECT id FROM ai_drafts WHERE triage_item_id = ti.id ORDER BY created_at DESC LIMIT 1
    )
    WHERE ti.id = ?
  `).get(id) as TriageItemWithContext | undefined;
}

export function recordAction(triageItemId: string, actionType: string, payload: unknown = {}): void {
  db.prepare('INSERT INTO item_actions (id, triage_item_id, action_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)').run(
    randomUUID(),
    triageItemId,
    actionType,
    JSON.stringify(payload),
    new Date().toISOString()
  );
}

export function markItemStatus(triageItemId: string, status: 'replied' | 'closed' | 'discarded'): void {
  const repliedAt = status === 'replied' ? new Date().toISOString() : null;
  db.prepare('UPDATE triage_items SET status = ?, replied_at = COALESCE(?, replied_at) WHERE id = ?').run(status, repliedAt, triageItemId);
}

export function storeLearningDelta(triageItemId: string, aiDraft: string, manualReply: string): void {
  db.prepare(`
    INSERT INTO learning_deltas (id, triage_item_id, ai_draft, manual_reply, delta_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), triageItemId, aiDraft, manualReply, compareManualReply(aiDraft, manualReply), new Date().toISOString());
}

export function listRecentLearningSignals(limit = 6): Array<{ classification: Classification; sourceName: string; actionType: string; actionPayloadJson: string | null; aiDraft: string | null; manualReply: string | null; deltaJson: string | null; itemText: string }> {
  return db.prepare(`
    SELECT
      ti.classification,
      c.name AS sourceName,
      COALESCE(a.action_type, 'manual_reply_observe') AS actionType,
      a.payload_json AS actionPayloadJson,
      ld.ai_draft AS aiDraft,
      ld.manual_reply AS manualReply,
      ld.delta_json AS deltaJson,
      ti.text AS itemText
    FROM triage_items ti
    JOIN conversations c ON c.id = ti.conversation_id
    LEFT JOIN learning_deltas ld ON ld.triage_item_id = ti.id
    LEFT JOIN item_actions a ON a.triage_item_id = ti.id AND a.created_at = (
      SELECT MAX(created_at) FROM item_actions WHERE triage_item_id = ti.id
    )
    WHERE ld.id IS NOT NULL OR a.action_type IN ('edit_then_send', 'manual_reply_observe', 'send_ai_draft', 'close_no_reply', 'discard_not_useful')
    ORDER BY COALESCE(ld.created_at, a.created_at, ti.created_at) DESC
    LIMIT @limit
  `).all({ limit: Math.min(Math.max(limit, 1), 20) }) as Array<{
    classification: Classification;
    sourceName: string;
    actionType: string;
    actionPayloadJson: string | null;
    aiDraft: string | null;
    manualReply: string | null;
    deltaJson: string | null;
    itemText: string;
  }>;
}

export function updateTriageItemFromSlack(input: { slackChannelId: string; slackTs: string; text: string }): boolean {
  const result = db.prepare(`
    UPDATE triage_items
    SET text = @text, excerpt = @excerpt
    WHERE slack_channel_id = @slackChannelId AND slack_ts = @slackTs
  `).run({ slackChannelId: input.slackChannelId, slackTs: input.slackTs, text: input.text, excerpt: makeExcerpt(input.text) });
  return result.changes > 0;
}

export function markTriageItemDeletedFromSlack(slackChannelId: string, slackTs: string): boolean {
  const result = db.prepare(`
    UPDATE triage_items
    SET status = 'discarded'
    WHERE slack_channel_id = ? AND slack_ts = ? AND status = 'open'
  `).run(slackChannelId, slackTs);
  return result.changes > 0;
}

export function suppressThread(input: { conversationId: string; slackChannelId: string; threadTs: string; reason?: string | null }): void {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO suppressed_threads (id, conversation_id, slack_channel_id, thread_ts, reason, created_at)
    VALUES (@id, @conversationId, @slackChannelId, @threadTs, @reason, @createdAt)
    ON CONFLICT(slack_channel_id, thread_ts) DO UPDATE SET reason = excluded.reason
  `).run({ id, conversationId: input.conversationId, slackChannelId: input.slackChannelId, threadTs: input.threadTs, reason: input.reason ?? null, createdAt });
}

export function isThreadSuppressed(slackChannelId: string, threadTs: string | null | undefined): boolean {
  if (!threadTs) return false;
  const row = db.prepare('SELECT 1 FROM suppressed_threads WHERE slack_channel_id = ? AND thread_ts = ?').get(slackChannelId, threadTs) as { 1: number } | undefined;
  return Boolean(row);
}

export function setRuntimeStatus(key: string, value: unknown): void {
  db.prepare(`
    INSERT INTO runtime_status (key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), new Date().toISOString());
}

export function getRuntimeStatus<T = unknown>(key: string): { value: T; updatedAt: string } | null {
  const row = db.prepare('SELECT value_json, updated_at FROM runtime_status WHERE key = ?').get(key) as { value_json: string; updated_at: string } | undefined;
  if (!row) return null;
  try {
    return { value: JSON.parse(row.value_json) as T, updatedAt: row.updated_at };
  } catch {
    return null;
  }
}

export function computeSloSummary(): SloSummary {
  const now = new Date().toISOString();
  const rows = db.prepare(`
    SELECT
      classification,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status = 'open' AND due_at < @now THEN 1 ELSE 0 END) AS overdue,
      SUM(CASE WHEN status = 'replied' THEN 1 ELSE 0 END) AS replied,
      SUM(CASE WHEN status = 'replied' AND replied_at <= due_at THEN 1 ELSE 0 END) AS replied_within_slo
    FROM triage_items
    GROUP BY classification
    ORDER BY MIN(slo_minutes)
  `).all({ now }) as Array<{
    classification: Classification;
    total: number;
    open: number;
    overdue: number;
    replied: number;
    replied_within_slo: number;
  }>;

  const buckets = rows.map((row) => ({
    ...row,
    replied_within_slo_percent: row.replied === 0 ? 0 : Math.round((row.replied_within_slo / row.replied) * 100)
  }));

  const totals = buckets.reduce(
    (acc, bucket) => ({ replied: acc.replied + bucket.replied, within: acc.within + bucket.replied_within_slo }),
    { replied: 0, within: 0 }
  );

  const openItems = listItems('open');
  const overdueItems = openItems.filter((item) => item.due_at < now).slice(0, 20);
  const agingQueue = openItems.slice(0, 20);

  return {
    now,
    buckets,
    overdueItems,
    agingQueue,
    repliedWithinSloPercent: totals.replied === 0 ? 0 : Math.round((totals.within / totals.replied) * 100)
  };
}

export function clearDemoData(): { conversationsDeleted: number; itemsDeleted: number } {
  const itemRow = db.prepare("SELECT COUNT(*) AS count FROM triage_items WHERE slack_channel_id GLOB '[CDGM]DEMO*'").get() as { count: number };
  const conversationResult = db.prepare("DELETE FROM conversations WHERE slack_channel_id GLOB '[CDGM]DEMO*'").run();
  return { conversationsDeleted: conversationResult.changes, itemsDeleted: itemRow.count };
}

export function seedDemoData(): void {
  const now = Date.now();
  const samples = [
    {
      channel: 'CDEMO1',
      name: 'growth-personalisation',
      kind: 'channel',
      author: 'Maya',
      text: '<@UROB> can you approve the experiment copy before EOD? We are blocked on the final variant.',
      minutesAgo: 95,
      isDirect: false,
      mentionsUser: true
    },
    {
      channel: 'DDEMO2',
      name: 'Sam DM',
      kind: 'im',
      author: 'Sam',
      text: 'I am stuck on the prompt selection rollout. Could you help decide whether we ship behind the new flag?',
      minutesAgo: 70,
      isDirect: true,
      mentionsUser: false
    },
    {
      channel: 'CDEMO3',
      name: 'eng-leads',
      kind: 'channel',
      author: 'Priya',
      text: 'FYI the metrics review moved to Thursday. No action needed, sharing for context.',
      minutesAgo: 240,
      isDirect: false,
      mentionsUser: false
    },
    {
      channel: 'CDEMO4',
      name: 'product-feedback',
      kind: 'channel',
      author: 'Alex',
      text: 'Can someone follow up on the customer thread and create a task for the missing location parameter?',
      minutesAgo: 1500,
      isDirect: false,
      mentionsUser: false
    },
    {
      channel: 'CDEMO5',
      name: 'random',
      kind: 'channel',
      author: 'Jordan',
      text: 'thanks!',
      minutesAgo: 30,
      isDirect: false,
      mentionsUser: false
    }
  ];

  for (const sample of samples) {
    const conversation = upsertConversation({ slackChannelId: sample.channel, name: sample.name, kind: sample.kind, isMember: true });
    createTriageItem({
      conversation,
      slackTs: String((now - sample.minutesAgo * 60_000) / 1000),
      threadTs: null,
      author: sample.author,
      authorId: null,
      text: sample.text,
      permalink: null,
      isDirect: sample.isDirect,
      mentionsUser: sample.mentionsUser
    });
  }
}

function ensureColumn(table: string, column: string, definition: string): void {
  const safeTable = safeIdentifier(table);
  const safeColumn = safeIdentifier(column);
  const columns = db.prepare(`PRAGMA table_info(${safeTable})`).all() as Array<{ name: string }>;
  if (columns.some((existing) => existing.name === column)) return;
  db.exec(`ALTER TABLE ${safeTable} ADD COLUMN ${safeColumn} ${definition}`);
}

function safeIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return value;
}

function safeJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function slackTsToIso(ts: string): string | null {
  const seconds = Number(ts.split('.')[0]);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}
