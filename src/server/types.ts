export type PullSetting = 'pull_all' | 'mentions_only' | 'disabled';

export type Classification =
  | 'direct ask / decision needed'
  | 'team unblock / direct-report request'
  | 'task or follow-up'
  | 'FYI/context'
  | 'noise';

export type ItemStatus = 'open' | 'replied' | 'closed' | 'discarded';

export interface ConversationRecord {
  id: string;
  slack_channel_id: string;
  name: string;
  kind: string;
  is_member: number;
  pull_setting: PullSetting;
  preferences_json: string;
  last_pulled_at: string | null;
  last_seen_slack_ts: string | null;
  created_at: string;
  updated_at: string;
}


export interface ConversationSourceRecord extends ConversationRecord {
  open_item_count: number;
  recent_item_count: number;
  total_item_count: number;
  latest_item_at: string | null;
}

export interface TriageItemRecord {
  id: string;
  conversation_id: string;
  slack_channel_id: string;
  slack_ts: string;
  thread_ts: string | null;
  author: string;
  author_id: string | null;
  text: string;
  excerpt: string;
  permalink: string | null;
  classification: Classification;
  classification_rationale: string | null;
  triage_model: string | null;
  triage_prompt_version: string | null;
  context_snapshot_json: string | null;
  slo_minutes: number;
  due_at: string;
  status: ItemStatus;
  created_at: string;
  replied_at: string | null;
}

export interface DraftRecord {
  id: string;
  triage_item_id: string;
  draft_text: string;
  action_summary: string;
  model: string;
  prompt_version: string | null;
  rationale: string | null;
  context_snapshot_json: string | null;
  created_at: string;
}

export interface TriageItemWithContext extends TriageItemRecord {
  source_name: string;
  source_kind: string;
  pull_setting: PullSetting;
  draft_id: string | null;
  draft_text: string | null;
  action_summary: string | null;
  draft_model: string | null;
  draft_prompt_version: string | null;
  draft_rationale: string | null;
}

export interface LlmStatus {
  provider: string;
  configured: boolean;
  model: string;
  promptVersion: string;
  fallback: string | null;
}

export interface SocketModeStatus {
  configured: boolean;
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  stale: boolean;
}

export interface SystemStatus {
  ok: boolean;
  time: string;
  dbPath: string;
  slack: SlackConnectionStatus;
  llm: LlmStatus;
  socketMode: SocketModeStatus;
  slackRateLimits: Array<{ method: string; retryAfterSeconds: number; retryAt: string }>;
}

export interface SloBucket {
  classification: Classification;
  total: number;
  open: number;
  overdue: number;
  replied: number;
  replied_within_slo: number;
  replied_within_slo_percent: number;
}

export interface SloSummary {
  now: string;
  buckets: SloBucket[];
  overdueItems: TriageItemWithContext[];
  agingQueue: TriageItemWithContext[];
  repliedWithinSloPercent: number;
}

export type SlackTokenSource = 'oauth_user' | 'env_user' | 'env_bot';

export interface SlackConnectionRecord {
  id: string;
  team_id: string;
  team_name: string;
  authed_user_id: string;
  authed_user_name: string | null;
  access_token: string;
  scope: string;
  token_type: string;
  created_at: string;
  updated_at: string;
}

export interface SlackConnectionStatus {
  connected: boolean;
  configured: boolean;
  tokenSource: SlackTokenSource | null;
  teamId: string | null;
  teamName: string | null;
  userId: string | null;
  userName: string | null;
  scopes: string[];
  connectUrl: string;
  devFallbackAvailable: boolean;
}
