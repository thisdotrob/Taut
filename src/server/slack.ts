import { ProxyAgent, setGlobalDispatcher } from 'undici';
import type { ConversationRecord } from './types';
import { createTriageItem, markConversationPulled, upsertConversation } from './db';
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
}

interface SlackAuth {
  user_id: string;
  user: string;
  team: string;
  url: string;
  token_source: string;
}

interface SlackIngestResult {
  auth: SlackAuth;
  conversationsSeen: number;
  conversationsPulled: number;
  itemsCreated: number;
  skippedByRule: number;
}

export async function slackApi<T>(method: string, params: Record<string, string | number | boolean | undefined> = {}, httpMethod: 'GET' | 'POST' = 'GET'): Promise<T> {
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

  const payload = (await response.json()) as SlackApiResponse<T>;
  if (!payload.ok) {
    const detail = payload.error ?? `HTTP ${response.status}`;
    throw new Error(`Slack API ${method} failed: ${detail}`);
  }

  return payload as T;
}

export async function getSlackAuth(): Promise<SlackAuth> {
  const resolvedToken = resolveSlackToken();
  const payload = await slackApi<SlackApiResponse<SlackAuth> & SlackAuth>('auth.test');
  return { user_id: payload.user_id, user: payload.user, team: payload.team, url: payload.url, token_source: resolvedToken.source };
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

export async function ingestSlack(limitPerConversation = 10): Promise<SlackIngestResult> {
  const auth = await getSlackAuth();
  const conversations = await listSlackConversations();
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

    const history = await conversationHistory(conversation.slack_channel_id, limitPerConversation);
    conversationsPulled += 1;

    for (const message of history) {
      if (!shouldIngestMessage(message, auth.user_id, conversation)) continue;
      if (conversation.pull_setting === 'mentions_only' && !messageMentions(message, auth.user_id) && conversation.kind !== 'im') continue;

      const permalink = await getPermalink(conversation.slack_channel_id, message.ts!);
      const created = createTriageItem({
        conversation,
        slackTs: message.ts!,
        threadTs: message.thread_ts ?? message.ts ?? null,
        author: message.username ?? message.user ?? 'unknown',
        authorId: message.user ?? null,
        text: message.text ?? '',
        permalink,
        isDirect: conversation.kind === 'im' || conversation.kind === 'mpim',
        mentionsUser: messageMentions(message, auth.user_id)
      });
      if (created) itemsCreated += 1;
    }

    markConversationPulled(conversation.id);
  }

  return { auth, conversationsSeen: conversations.length, conversationsPulled, itemsCreated, skippedByRule };
}

async function listSlackConversations(): Promise<SlackConversation[]> {
  const conversations: SlackConversation[] = [];
  let cursor = '';

  do {
    const payload = await slackApi<SlackApiResponse<{ channels: SlackConversation[] }> & { channels: SlackConversation[] }>('conversations.list', {
      types: 'public_channel,private_channel,im,mpim',
      exclude_archived: true,
      limit: 200,
      cursor: cursor || undefined
    });

    conversations.push(...payload.channels.filter((conversation) => conversation.is_member || conversation.is_im || conversation.is_mpim));
    cursor = payload.response_metadata?.next_cursor ?? '';
  } while (cursor);

  return conversations;
}

async function conversationHistory(channel: string, limit: number): Promise<SlackMessage[]> {
  const payload = await slackApi<SlackApiResponse<{ messages: SlackMessage[] }> & { messages: SlackMessage[] }>('conversations.history', {
    channel,
    limit: Math.min(Math.max(limit, 1), 50)
  });
  return payload.messages;
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
