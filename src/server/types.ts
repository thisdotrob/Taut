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
  created_at: string;
  updated_at: string;
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
  created_at: string;
}

export interface TriageItemWithContext extends TriageItemRecord {
  source_name: string;
  source_kind: string;
  pull_setting: PullSetting;
  draft_id: string | null;
  draft_text: string | null;
  action_summary: string | null;
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
