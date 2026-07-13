import { ProxyAgent, setGlobalDispatcher } from 'undici';
import type { ConversationRecord, TriageItemRecord } from './types';
import {
  createTriageItem,
  isThreadSuppressed,
  listConversations as listStoredConversations,
  listRecentLearningSignals,
  markConversationPulled,
  markTriageItemDeletedFromSlack,
  updateTriageItemFromSlack,
  upsertConversation
} from './db';
import { generateTriageDecision } from './llm';
import { resolveSlackToken } from './slack-oauth';

const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

interface SlackApiResponse<T> {
  ok: boolean;
  error?: string;
  response_metadata?: { next_cursor?: string; warnings?: string[] };
  warning?: string;
  has_more?: boolean;
  [key: string]: unknown;
}

interface SlackConversation {
  id: string;
  name?: string;
  user?: string;
  is_member?: boolean;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
}

interface SlackMessage {
  type?: string;
  subtype?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel?: string;
  channel_type?: string;
  reply_count?: number;
}

interface SlackAuth {
  user_id: string;
  user: string;
  team: string;
  url: string;
  token_source: string;
}

interface SlackContextSnapshot {
  source: {
    slackChannelId: string;
    name: string;
    kind: string;
    pullSetting: string;
  };
  message: SlackMessageSnapshot;
  threadRoot: SlackMessageSnapshot | null;
  recentThreadReplies: SlackMessageSnapshot[];
  warnings: string[];
  fetchedAt: string;
}

interface SlackMessageSnapshot {
  ts: string | null;
  threadTs: string | null;
  user: string | null;
  username: string | null;
  subtype: string | null;
  text: string;
}

type ConversationListSource = 'slack' | 'cache' | 'stored';

interface SlackIngestResult {
  auth: SlackAuth;
  conversationsSeen: number;
  conversationsPulled: number;
  itemsCreated: number;
  skippedByRule: number;
  conversationListSource: ConversationListSource;
  warnings: string[];
}

export interface SlackMessageEvent extends SlackMessage {
  message?: SlackMessage;
  previous_message?: SlackMessage;
  deleted_ts?: string;
  hidden?: boolean;
}

export interface SlackMessageEventIngestResult {
  created: boolean;
  skipped: boolean;
  reason: string;
  itemId: string | null;
}

const DEFAULT_SLACK_RETRY_AFTER_SECONDS = 60;
const DEFAULT_CONVERSATION_CACHE_TTL_SECONDS = 10 * 60;
const DEFAULT_AUTH_CACHE_TTL_SECONDS = 5 * 60;

const rateLimitedUntilByMethod = new Map<string, number>();
let conversationListCache: { conversations: SlackConversation[]; fetchedAtMs: number } | null = null;
let slackAuthCache: { auth: SlackAuth; token: string; fetchedAtMs: number } | null = null;

export class SlackRateLimitError extends Error {
  readonly code = 'slack_ratelimited';
  readonly method: string;
  readonly retryAfterSeconds: number;
  readonly retryAt: string;

  constructor(method: string, retryAfterSeconds: number) {
    const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
    super(`Slack rate limited; retry after ${seconds} second${seconds === 1 ? '' : 's'}.`);
    this.name = 'SlackRateLimitError';
    this.method = method;
    this.retryAfterSeconds = seconds;
    this.retryAt = new Date(Date.now() + seconds * 1_000).toISOString();
  }
}

export function isSlackRateLimitError(error: unknown): error is SlackRateLimitError {
  return error instanceof SlackRateLimitError;
}

export function getSlackRateLimitStatuses(): Array<{ method: string; retryAfterSeconds: number; retryAt: string }> {
  const statuses: Array<{ method: string; retryAfterSeconds: number; retryAt: string }> = [];
  for (const [method] of rateLimitedUntilByMethod) {
    const retryAfterSeconds = retryAfterFor(method);
    if (!retryAfterSeconds) continue;
    statuses.push({ method, retryAfterSeconds, retryAt: new Date(Date.now() + retryAfterSeconds * 1_000).toISOString() });
  }
  return statuses.sort((a, b) => a.method.localeCompare(b.method));
}

export async function slackApi<T>(method: string, params: Record<string, string | number | boolean | undefined> = {}, httpMethod: 'GET' | 'POST' = 'GET'): Promise<T> {
  const existingRetryAfter = retryAfterFor(method);
  if (existingRetryAfter) throw new SlackRateLimitError(method, existingRetryAfter);

  const url = new URL(`https://slack.com/api/${method}`);
  const bodyParams = new URLSearchParams();
  const resolvedToken = resolveSlackToken();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (httpMethod === 'GET') url.searchParams.set(key, String(value));
    else bodyParams.set(key, String(value));
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${resolvedToken.token}`
  };
  if (httpMethod === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';

  const response = await fetch(url, {
    method: httpMethod,
    headers,
    body: httpMethod === 'POST' ? bodyParams : undefined
  });

  const payload = await parseSlackPayload<T>(response);
  if (response.status === 429 || payload.error === 'ratelimited') {
    const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('retry-after')) ?? DEFAULT_SLACK_RETRY_AFTER_SECONDS;
    rememberRateLimit(method, retryAfterSeconds);
    throw new SlackRateLimitError(method, retryAfterSeconds);
  }

  if (!response.ok) {
    const detail = payload.error ?? `HTTP ${response.status}`;
    throw new Error(`Slack API ${method} failed: ${detail}`);
  }

  if (!payload.ok) {
    const detail = payload.error ?? `HTTP ${response.status}`;
    throw new Error(`Slack API ${method} failed: ${detail}`);
  }

  return payload as T;
}

export async function getSlackAuth(): Promise<SlackAuth> {
  const resolvedToken = resolveSlackToken();
  const cached = slackAuthCache;
  if (cached && cached.token === resolvedToken.token && Date.now() - cached.fetchedAtMs < authCacheTtlMs()) {
    return cached.auth;
  }

  const payload = await slackApi<SlackApiResponse<SlackAuth> & SlackAuth>('auth.test');
  const auth = { user_id: payload.user_id, user: payload.user, team: payload.team, url: payload.url, token_source: resolvedToken.source };
  slackAuthCache = { auth, token: resolvedToken.token, fetchedAtMs: Date.now() };
  return auth;
}

export async function postSlackReply(input: { channel: string; threadTs: string | null; text: string }): Promise<{ ts: string }> {
  const payload = await slackApi<SlackApiResponse<{ ts: string }> & { ts: string }>(
    'chat.postMessage',
    {
      channel: input.channel,
      text: input.text,
      thread_ts: input.threadTs ?? undefined
    },
    'POST'
  );
  return { ts: payload.ts };
}

export async function addSlackReaction(input: { channel: string; timestamp: string; emoji: string }): Promise<void> {
  const cleanEmoji = input.emoji.replace(/^:+|:+$/g, '');
  await slackApi('reactions.add', { channel: input.channel, timestamp: input.timestamp, name: cleanEmoji }, 'POST');
}

export async function ingestSlack(limitPerConversation = 5): Promise<SlackIngestResult> {
  const auth = await getSlackAuth();
  const conversationList = await conversationsForIngestion();
  const conversations = conversationList.conversations;
  const warnings = [...conversationList.warnings];
  let conversationsPulled = 0;
  let itemsCreated = 0;
  let skippedByRule = 0;

  for (const slackConversation of conversations) {
    const conversation = upsertConversation({
      slackChannelId: slackConversation.id,
      name: conversationName(slackConversation),
      kind: conversationKind(slackConversation),
      isMember: Boolean(slackConversation.is_member || slackConversation.is_im || slackConversation.is_mpim)
    });

    if (conversation.pull_setting === 'disabled') {
      skippedByRule += 1;
      continue;
    }

    const history = await conversationHistory(conversation.slack_channel_id, limitPerConversation, conversation.last_seen_slack_ts);
    warnings.push(...history.warnings);
    conversationsPulled += 1;

    const messages = history.messages.slice().sort(compareSlackTsAscending);
    for (const message of messages) {
      if (!shouldIngestMessage(message, auth.user_id, conversation)) continue;
      if (conversation.pull_setting === 'mentions_only' && !messageMentions(message, auth.user_id) && conversation.kind !== 'im') continue;

      const created = await createItemFromSlackMessage(conversation, message, auth);
      if (created) itemsCreated += 1;
    }

    markConversationPulled(conversation.id, maxSlackTs(history.messages));
  }

  return {
    auth,
    conversationsSeen: conversations.length,
    conversationsPulled,
    itemsCreated,
    skippedByRule,
    conversationListSource: conversationList.source,
    warnings
  };
}

export async function ingestSlackMessageEvent(event: SlackMessageEvent): Promise<SlackMessageEventIngestResult> {
  if (event.type !== 'message') return { created: false, skipped: true, reason: 'not_message', itemId: null };
  if (!event.channel) return { created: false, skipped: true, reason: 'missing_channel', itemId: null };

  if (event.subtype === 'message_deleted') {
    const deletedTs = event.deleted_ts ?? event.previous_message?.ts;
    if (!deletedTs) return { created: false, skipped: true, reason: 'missing_deleted_ts', itemId: null };
    const discarded = markTriageItemDeletedFromSlack(event.channel, deletedTs);
    return { created: false, skipped: true, reason: discarded ? 'deleted_message_discarded' : 'deleted_message_not_found', itemId: null };
  }

  if (event.subtype === 'message_changed') {
    const changed = event.message;
    if (!changed?.ts || typeof changed.text !== 'string') return { created: false, skipped: true, reason: 'missing_changed_message', itemId: null };
    const updated = updateTriageItemFromSlack({ slackChannelId: event.channel, slackTs: changed.ts, text: changed.text });
    return { created: false, skipped: true, reason: updated ? 'message_text_updated' : 'changed_message_not_found', itemId: null };
  }

  if (!event.ts || !event.text) return { created: false, skipped: true, reason: 'missing_required_fields', itemId: null };

  const auth = await getSlackAuth();
  const kind = eventConversationKind(event.channel_type);
  const conversation = upsertConversation({
    slackChannelId: event.channel,
    name: await eventConversationName(event.channel, event.channel_type, event.user),
    kind,
    isMember: true
  });

  if (conversation.pull_setting === 'disabled') return { created: false, skipped: true, reason: 'pull_disabled', itemId: null };
  if (!shouldIngestMessage(event, auth.user_id, conversation)) return { created: false, skipped: true, reason: 'filtered_message', itemId: null };
  if (conversation.pull_setting === 'mentions_only' && !messageMentions(event, auth.user_id) && conversation.kind !== 'im') {
    return { created: false, skipped: true, reason: 'mentions_only', itemId: null };
  }

  const created = await createItemFromSlackMessage(conversation, event, auth);
  markConversationPulled(conversation.id, event.ts);

  if (!created) return { created: false, skipped: true, reason: 'duplicate_or_suppressed', itemId: null };
  return { created: true, skipped: false, reason: 'created', itemId: created.id };
}

async function createItemFromSlackMessage(conversation: ConversationRecord, message: SlackMessage, auth: SlackAuth): Promise<TriageItemRecord | null> {
  if (!message.ts || typeof message.text !== 'string') return null;
  const threadTs = message.thread_ts ?? message.ts;
  if (isThreadSuppressed(conversation.slack_channel_id, threadTs)) return null;

  const permalink = await getPermalink(conversation.slack_channel_id, message.ts);
  const contextSnapshot = await buildContextSnapshot(conversation, message);
  const triage = await generateTriageDecision({
    text: message.text,
    sourceName: conversation.name,
    sourceKind: conversation.kind,
    isDirect: conversation.kind === 'im' || conversation.kind === 'mpim',
    mentionsUser: messageMentions(message, auth.user_id),
    contextSnapshot,
    learningSignals: listRecentLearningSignals(6)
  });

  return createTriageItem({
    conversation,
    slackTs: message.ts,
    threadTs,
    author: message.username ?? message.user ?? 'unknown',
    authorId: message.user ?? null,
    text: message.text,
    permalink,
    isDirect: conversation.kind === 'im' || conversation.kind === 'mpim',
    mentionsUser: messageMentions(message, auth.user_id),
    triage,
    contextSnapshot
  });
}

async function buildContextSnapshot(conversation: ConversationRecord, message: SlackMessage): Promise<SlackContextSnapshot> {
  const warnings: string[] = [];
  let threadRoot: SlackMessageSnapshot | null = null;
  let recentThreadReplies: SlackMessageSnapshot[] = [];
  const threadTs = message.thread_ts ?? null;

  if (threadTs) {
    try {
      const replies = await conversationReplies(conversation.slack_channel_id, threadTs, 10);
      const sortedReplies = replies.slice().sort(compareSlackTsAscending);
      threadRoot = toMessageSnapshot(sortedReplies[0] ?? null);
      recentThreadReplies = sortedReplies
        .filter((reply) => reply.ts !== threadRoot?.ts)
        .slice(-8)
        .map((reply) => toMessageSnapshot(reply))
        .filter((reply): reply is SlackMessageSnapshot => Boolean(reply));
    } catch (error) {
      warnings.push(error instanceof SlackRateLimitError ? `${error.message} Thread context was skipped.` : `Thread context fetch failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  return {
    source: {
      slackChannelId: conversation.slack_channel_id,
      name: conversation.name,
      kind: conversation.kind,
      pullSetting: conversation.pull_setting
    },
    message: toMessageSnapshot(message)!,
    threadRoot,
    recentThreadReplies,
    warnings,
    fetchedAt: new Date().toISOString()
  };
}

async function conversationsForIngestion(): Promise<{ conversations: SlackConversation[]; source: ConversationListSource; warnings: string[] }> {
  const freshCached = freshConversationListCache();
  if (freshCached) return { conversations: freshCached, source: 'cache', warnings: [] };

  try {
    const result = await fetchSlackConversations();
    if (result.conversations.length > 0) {
      conversationListCache = { conversations: result.conversations, fetchedAtMs: Date.now() };
    }
    return { ...result, source: 'slack' };
  } catch (error) {
    if (isSlackRateLimitError(error)) {
      if (conversationListCache?.conversations.length) {
        return {
          conversations: conversationListCache.conversations,
          source: 'cache',
          warnings: [`${error.message} Using cached Slack conversation list instead of calling conversations.list again.`]
        };
      }

      const storedConversations = listStoredConversations().map(storedConversationToSlackConversation);
      if (storedConversations.length > 0) {
        return {
          conversations: storedConversations,
          source: 'stored',
          warnings: [`${error.message} Using conversations already stored in Taut until Slack allows conversations.list again.`]
        };
      }
    }
    throw error;
  }
}

async function fetchSlackConversations(): Promise<{ conversations: SlackConversation[]; warnings: string[] }> {
  const conversations: SlackConversation[] = [];
  const warnings: string[] = [];
  let cursor = '';

  do {
    try {
      const payload = await slackApi<SlackApiResponse<{ channels: SlackConversation[] }> & { channels: SlackConversation[] }>('conversations.list', {
        types: 'public_channel,private_channel,im,mpim',
        exclude_archived: true,
        limit: 200,
        cursor: cursor || undefined
      });

      conversations.push(...payload.channels.filter((conversation) => conversation.is_member || conversation.is_im || conversation.is_mpim));
      cursor = payload.response_metadata?.next_cursor ?? '';
    } catch (error) {
      if (isSlackRateLimitError(error) && conversations.length > 0) {
        warnings.push(`${error.message} Continuing with ${conversations.length} conversations fetched before Slack paused conversations.list.`);
        break;
      }
      throw error;
    }
  } while (cursor);

  return { conversations, warnings };
}

function freshConversationListCache(): SlackConversation[] | null {
  if (!conversationListCache) return null;
  if (Date.now() - conversationListCache.fetchedAtMs > conversationCacheTtlMs()) return null;
  return conversationListCache.conversations;
}

function storedConversationToSlackConversation(conversation: ConversationRecord): SlackConversation {
  return {
    id: conversation.slack_channel_id,
    name: conversation.name,
    is_member: Boolean(conversation.is_member),
    is_channel: conversation.kind === 'channel',
    is_group: conversation.kind === 'private_channel',
    is_im: conversation.kind === 'im',
    is_mpim: conversation.kind === 'mpim',
    is_private: conversation.kind === 'private_channel'
  };
}

async function conversationHistory(channel: string, requestedLimit: number, oldestSlackTs: string | null): Promise<{ messages: SlackMessage[]; warnings: string[] }> {
  const messages: SlackMessage[] = [];
  const warnings: string[] = [];
  let cursor = '';
  let page = 0;
  const incremental = Boolean(oldestSlackTs);
  const pageLimit = incremental ? Math.min(Math.max(requestedLimit, 50), 100) : Math.min(Math.max(requestedLimit, 1), 50);
  const maxPages = incremental ? maxHistoryPages() : 1;

  do {
    try {
      const payload = await slackApi<SlackApiResponse<{ messages: SlackMessage[] }> & { messages: SlackMessage[] }>('conversations.history', {
        channel,
        limit: pageLimit,
        oldest: oldestSlackTs ?? undefined,
        inclusive: oldestSlackTs ? false : undefined,
        cursor: cursor || undefined
      });
      messages.push(...payload.messages);
      cursor = payload.response_metadata?.next_cursor ?? '';
      page += 1;
      if (payload.response_metadata?.warnings?.length) warnings.push(...payload.response_metadata.warnings.map((warning) => `Slack conversations.history warning for ${channel}: ${warning}`));
      if (!payload.has_more && !cursor) break;
    } catch (error) {
      if (isSlackRateLimitError(error) && messages.length > 0) {
        warnings.push(`${error.message} Continuing with ${messages.length} messages fetched before Slack paused conversations.history for ${channel}.`);
        break;
      }
      throw error;
    }
  } while (cursor && page < maxPages);

  if (cursor) warnings.push(`Reached TAUT_HISTORY_MAX_PAGES=${maxPages} while syncing ${channel}; run Pull Slack again to continue backfill.`);
  return { messages, warnings };
}

async function conversationReplies(channel: string, threadTs: string, limit: number): Promise<SlackMessage[]> {
  const payload = await slackApi<SlackApiResponse<{ messages: SlackMessage[] }> & { messages: SlackMessage[] }>('conversations.replies', {
    channel,
    ts: threadTs,
    limit: Math.min(Math.max(limit, 1), 20)
  });
  return payload.messages ?? [];
}

async function getPermalink(channel: string, messageTs: string): Promise<string | null> {
  try {
    const payload = await slackApi<SlackApiResponse<{ permalink: string }> & { permalink: string }>('chat.getPermalink', {
      channel,
      message_ts: messageTs
    });
    return payload.permalink;
  } catch {
    return null;
  }
}

async function getConversationInfo(channel: string): Promise<SlackConversation | null> {
  try {
    const payload = await slackApi<SlackApiResponse<{ channel: SlackConversation }> & { channel: SlackConversation }>('conversations.info', {
      channel
    });
    return payload.channel;
  } catch {
    return null;
  }
}

async function parseSlackPayload<T>(response: Response): Promise<SlackApiResponse<T>> {
  const text = await response.text();
  if (!text) return { ok: response.ok } as SlackApiResponse<T>;

  try {
    return JSON.parse(text) as SlackApiResponse<T>;
  } catch {
    return { ok: response.ok, error: `HTTP ${response.status}` } as SlackApiResponse<T>;
  }
}

function parseRetryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.ceil(parsed);
}

function rememberRateLimit(method: string, retryAfterSeconds: number): void {
  rateLimitedUntilByMethod.set(method, Date.now() + Math.max(1, Math.ceil(retryAfterSeconds)) * 1_000);
}

function retryAfterFor(method: string): number | null {
  const until = rateLimitedUntilByMethod.get(method);
  if (!until) return null;
  const remainingMs = until - Date.now();
  if (remainingMs <= 0) {
    rateLimitedUntilByMethod.delete(method);
    return null;
  }
  return Math.ceil(remainingMs / 1_000);
}

function conversationCacheTtlMs(): number {
  return secondsEnv('TAUT_CONVERSATION_CACHE_TTL_SECONDS', DEFAULT_CONVERSATION_CACHE_TTL_SECONDS) * 1_000;
}

function authCacheTtlMs(): number {
  return secondsEnv('TAUT_AUTH_CACHE_TTL_SECONDS', DEFAULT_AUTH_CACHE_TTL_SECONDS) * 1_000;
}

function secondsEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function maxHistoryPages(): number {
  const raw = process.env.TAUT_HISTORY_MAX_PAGES;
  if (!raw) return 3;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) return 3;
  return parsed;
}

function shouldIngestMessage(message: SlackMessage, currentUserId: string, conversation: ConversationRecord): boolean {
  if (!message.ts || !message.text) return false;
  if (message.subtype && !['thread_broadcast'].includes(message.subtype)) return false;
  if (message.user === currentUserId) return false;
  if (message.bot_id) return false;
  if (conversation.kind === 'channel' || conversation.kind === 'private_channel') return true;
  return true;
}

function messageMentions(message: SlackMessage, userId: string): boolean {
  return Boolean(message.text?.includes(`<@${userId}>`));
}

function conversationName(conversation: SlackConversation): string {
  if (conversation.name) return conversation.name;
  if (conversation.is_im && conversation.user) return `DM ${conversation.user}`;
  if (conversation.is_mpim) return `Group DM ${conversation.id}`;
  return conversation.id;
}

function conversationKind(conversation: SlackConversation): string {
  if (conversation.is_im) return 'im';
  if (conversation.is_mpim) return 'mpim';
  if (conversation.is_group || conversation.is_private) return 'private_channel';
  return 'channel';
}

async function eventConversationName(channel: string, channelType: string | undefined, user: string | undefined): Promise<string> {
  const info = await getConversationInfo(channel);
  if (info) return conversationName(info);
  if (channelType === 'im' && user) return `DM ${user}`;
  if (channelType === 'mpim') return `Group DM ${channel}`;
  return channel;
}

function eventConversationKind(channelType: string | undefined): string {
  if (channelType === 'im') return 'im';
  if (channelType === 'mpim') return 'mpim';
  if (channelType === 'group') return 'private_channel';
  return 'channel';
}

function toMessageSnapshot(message: SlackMessage | null | undefined): SlackMessageSnapshot | null {
  if (!message) return null;
  return {
    ts: message.ts ?? null,
    threadTs: message.thread_ts ?? null,
    user: message.user ?? null,
    username: message.username ?? null,
    subtype: message.subtype ?? null,
    text: truncate(message.text ?? '', 1500)
  };
}

function compareSlackTsAscending(a: SlackMessage, b: SlackMessage): number {
  return slackTsNumber(a.ts) - slackTsNumber(b.ts);
}

function maxSlackTs(messages: SlackMessage[]): string | null {
  let max: SlackMessage | null = null;
  for (const message of messages) {
    if (!message.ts) continue;
    if (!max || slackTsNumber(message.ts) > slackTsNumber(max.ts)) max = message;
  }
  return max?.ts ?? null;
}

function slackTsNumber(ts: string | null | undefined): number {
  if (!ts) return 0;
  const parsed = Number(ts);
  return Number.isFinite(parsed) ? parsed : 0;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
