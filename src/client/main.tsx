import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type PullSetting = 'pull_all' | 'mentions_only' | 'disabled';
type ItemStatus = 'open' | 'replied' | 'closed' | 'discarded';
type Classification =
  | 'direct ask / decision needed'
  | 'team unblock / direct-report request'
  | 'task or follow-up'
  | 'FYI/context'
  | 'noise';

interface TriageItem {
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
  source_name: string;
  source_kind: string;
  pull_setting: PullSetting;
  draft_id: string | null;
  draft_text: string | null;
  action_summary: string | null;
}

interface Conversation {
  id: string;
  slack_channel_id: string;
  name: string;
  kind: string;
  is_member: number;
  pull_setting: PullSetting;
  last_pulled_at: string | null;
}

interface SloBucket {
  classification: Classification;
  total: number;
  open: number;
  overdue: number;
  replied: number;
  replied_within_slo: number;
  replied_within_slo_percent: number;
}

interface SloSummary {
  now: string;
  buckets: SloBucket[];
  overdueItems: TriageItem[];
  agingQueue: TriageItem[];
  repliedWithinSloPercent: number;
}

interface ToastState {
  kind: 'success' | 'error' | 'info';
  message: string;
}

interface ApiErrorPayload {
  ok?: boolean;
  error?: string;
  code?: string;
  retryAfterSeconds?: number;
  retryAt?: string;
}

interface SlackConnectionStatus {
  connected: boolean;
  configured: boolean;
  tokenSource: 'oauth_user' | 'env_user' | 'env_bot' | null;
  teamId: string | null;
  teamName: string | null;
  userId: string | null;
  userName: string | null;
  scopes: string[];
  connectUrl: string;
  devFallbackAvailable: boolean;
}

const classificationAccent: Record<Classification, string> = {
  'team unblock / direct-report request': 'critical',
  'direct ask / decision needed': 'decision',
  'task or follow-up': 'task',
  'FYI/context': 'context',
  noise: 'noise'
};

function App(): React.ReactElement {
  const [items, setItems] = useState<TriageItem[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [slo, setSlo] = useState<SloSummary | null>(null);
  const [slackConnection, setSlackConnection] = useState<SlackConnectionStatus | null>(null);
  const [statusFilter, setStatusFilter] = useState<'open' | 'all'>('open');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [pullRetryAt, setPullRetryAt] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [draftEdits, setDraftEdits] = useState<Record<string, string>>({});
  const [manualReplies, setManualReplies] = useState<Record<string, string>>({});

  useEffect(() => {
    void refresh();
  }, [statusFilter]);

  useEffect(() => {
    if (!pullRetryAt) return;
    const interval = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [pullRetryAt]);

  useEffect(() => {
    if (pullRetryAt && new Date(pullRetryAt).getTime() <= nowMs) setPullRetryAt(null);
  }, [pullRetryAt, nowMs]);

  async function refresh(): Promise<void> {
    setLoading(true);
    try {
      const [itemsResponse, conversationsResponse, sloResponse, slackConnectionResponse] = await Promise.all([
        api<TriageItem[]>(`/api/items?status=${statusFilter}`),
        api<Conversation[]>('/api/conversations'),
        api<SloSummary>('/api/slo'),
        api<SlackConnectionStatus>('/api/slack/connection')
      ]);
      setItems(itemsResponse);
      setConversations(conversationsResponse);
      setSlo(sloResponse);
      setSlackConnection(slackConnectionResponse);
    } catch (error) {
      showError(error);
    } finally {
      setLoading(false);
    }
  }

  async function seedDemo(): Promise<void> {
    setBusy('seed');
    try {
      await api('/api/demo/seed', { method: 'POST' });
      setToast({ kind: 'success', message: 'Seeded demo triage items.' });
      await refresh();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(null);
    }
  }

  async function clearDemo(): Promise<void> {
    setBusy('clear-demo');
    try {
      const response = await api<{ result: { itemsDeleted: number; conversationsDeleted: number } }>('/api/demo/clear', { method: 'POST' });
      setToast({ kind: 'success', message: `Cleared ${response.result.itemsDeleted} demo items and ${response.result.conversationsDeleted} demo conversations.` });
      await refresh();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(null);
    }
  }

  async function ingestSlack(): Promise<void> {
    setBusy('ingest');
    try {
      const result = await api<{ result: { conversationsSeen: number; itemsCreated: number; warnings?: string[] } }>('/api/ingest/slack', {
        method: 'POST',
        body: JSON.stringify({ limitPerConversation: 5 })
      });
      setPullRetryAt(null);
      const warning = result.result.warnings?.length ? ` ${result.result.warnings.join(' ')}` : '';
      setToast({
        kind: warning ? 'info' : 'success',
        message: `Pulled ${result.result.conversationsSeen} Slack conversations and created ${result.result.itemsCreated} triage items.${warning}`
      });
      await refresh();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'slack_ratelimited') {
        setPullRetryAt(error.retryAt ?? new Date(Date.now() + (error.retryAfterSeconds ?? 60) * 1_000).toISOString());
      }
      showError(error);
    } finally {
      setBusy(null);
    }
  }

  function connectSlack(): void {
    const startUrl = slackConnection?.connectUrl ?? '/api/slack/oauth/start';
    window.location.href = `${startUrl}?redirect=/`;
  }

  async function disconnectSlack(): Promise<void> {
    setBusy('disconnect');
    try {
      await api('/api/slack/disconnect', { method: 'POST' });
      setToast({ kind: 'success', message: 'Disconnected the stored Slack OAuth user token.' });
      await refresh();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(null);
    }
  }

  async function performAction(item: TriageItem, action: string, payload: Record<string, unknown> = {}): Promise<void> {
    setBusy(`${item.id}:${action}`);
    try {
      await api(`/api/items/${item.id}/actions`, {
        method: 'POST',
        body: JSON.stringify({ action, ...payload })
      });
      const label = action.replace(/_/g, ' ');
      setToast({ kind: 'success', message: `Action recorded: ${label}.` });
      await refresh();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(null);
    }
  }

  async function updatePullRule(item: TriageItem, pullSetting: PullSetting): Promise<void> {
    await performAction(item, 'change_pull_rule', { pullSetting });
  }

  function showError(error: unknown): void {
    setToast({ kind: 'error', message: error instanceof Error ? error.message : 'Something went wrong.' });
  }

  const openItems = useMemo(() => items.filter((item) => item.status === 'open'), [items]);
  const pullRetrySeconds = pullRetryAt ? Math.max(0, Math.ceil((new Date(pullRetryAt).getTime() - nowMs) / 1_000)) : 0;
  const pullSlackDisabled = busy === 'ingest' || slackConnection?.connected === false || pullRetrySeconds > 0;

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Taut</p>
          <h1>AI triage feed for Slack</h1>
          <p className="hero-copy">
            A single attention queue that pulls Slack messages, classifies urgency, proposes replies, tracks reply SLOs, and observes Rob’s manual replies as learning signals.
          </p>
        </div>
        <div className="hero-actions" aria-label="Data controls">
          <button type="button" className="primary" onClick={() => void ingestSlack()} disabled={pullSlackDisabled}>
            {busy === 'ingest' ? 'Pulling Slack…' : pullRetrySeconds > 0 ? `Retry in ${pullRetrySeconds}s` : 'Pull Slack'}
          </button>
          <button type="button" className="secondary" onClick={() => void seedDemo()} disabled={busy === 'seed'}>
            {busy === 'seed' ? 'Seeding…' : 'Seed demo'}
          </button>
          <button type="button" className="ghost" onClick={() => void clearDemo()} disabled={busy === 'clear-demo'}>
            {busy === 'clear-demo' ? 'Clearing…' : 'Clear demo'}
          </button>
          <button type="button" className="ghost" onClick={() => void refresh()} disabled={loading}>
            Refresh
          </button>
        </div>
      </header>

      {toast ? (
        <section className={`toast ${toast.kind}`} role="status" aria-live="polite">
          {toast.message}
          <button type="button" aria-label="Dismiss notification" onClick={() => setToast(null)}>
            ×
          </button>
        </section>
      ) : null}

      <section className="panel slack-connect-panel" aria-labelledby="slack-connect-heading">
        <div>
          <p className="eyebrow">Slack connection</p>
          <h2 id="slack-connect-heading">OAuth user token is the primary path</h2>
          <p className="muted">
            Taut uses Slack OAuth user tokens so ingestion sees Rob’s public/private channels, DMs, and group DMs. Env tokens are only a dev escape hatch.
          </p>
          <div className="connection-status">
            <span className={`status-dot ${slackConnection?.connected ? 'connected' : ''}`} aria-hidden="true" />
            <strong>{connectionLabel(slackConnection)}</strong>
            <span>{connectionDetail(slackConnection)}</span>
          </div>
        </div>
        <div className="hero-actions">
          <button type="button" className="primary" onClick={connectSlack} disabled={!slackConnection?.configured}>
            Connect Slack
          </button>
          <button type="button" className="ghost" onClick={() => void disconnectSlack()} disabled={!slackConnection || slackConnection.tokenSource !== 'oauth_user' || busy === 'disconnect'}>
            Disconnect OAuth token
          </button>
        </div>
        {!slackConnection?.configured ? (
          <p className="setup-warning">
            Set <code>SLACK_CLIENT_ID</code> and <code>SLACK_CLIENT_SECRET</code>, then add the redirect URL from <code>docs/slack-oauth-setup.md</code> to the Slack app.
          </p>
        ) : null}
      </section>

      <section className="metrics-grid" aria-label="Triage summary">
        <MetricCard label="Open items" value={String(openItems.length)} hint="Visible attention queue" />
        <MetricCard label="Overdue" value={String(slo?.overdueItems.length ?? 0)} hint="Past classification SLO" tone={(slo?.overdueItems.length ?? 0) > 0 ? 'warning' : 'default'} />
        <MetricCard label="Within SLO" value={`${slo?.repliedWithinSloPercent ?? 0}%`} hint="Sent replies inside due time" />
        <MetricCard label="Sources" value={String(conversations.length)} hint="Channels, DMs, group DMs" />
      </section>

      <section className="panel slo-panel" aria-labelledby="slo-heading">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">SLO view</p>
            <h2 id="slo-heading">Performance by classification</h2>
          </div>
          <div className="filter-tabs" aria-label="Feed filter">
            <button type="button" className={statusFilter === 'open' ? 'active' : ''} onClick={() => setStatusFilter('open')}>
              Open
            </button>
            <button type="button" className={statusFilter === 'all' ? 'active' : ''} onClick={() => setStatusFilter('all')}>
              All
            </button>
          </div>
        </div>
        <div className="slo-table" role="table" aria-label="SLO performance by classification">
          <div className="slo-row header" role="row">
            <span>Classification</span>
            <span>Open</span>
            <span>Overdue</span>
            <span>Replied</span>
            <span>Within SLO</span>
          </div>
          {(slo?.buckets ?? []).map((bucket) => (
            <div className="slo-row" role="row" key={bucket.classification}>
              <span>{bucket.classification}</span>
              <span>{bucket.open}</span>
              <span>{bucket.overdue}</span>
              <span>{bucket.replied}</span>
              <span>{bucket.replied_within_slo_percent}%</span>
            </div>
          ))}
          {slo?.buckets.length === 0 ? <p className="empty-inline">No SLO data yet. Seed demo data or pull Slack.</p> : null}
        </div>
      </section>

      <section className="feed-section" aria-labelledby="feed-heading">
        <div className="panel-heading feed-heading">
          <div>
            <p className="eyebrow">Triage feed</p>
            <h2 id="feed-heading">Incoming items</h2>
          </div>
          <p className="muted">No sidebar. No channel browser. Just work to triage.</p>
        </div>

        {loading ? <div className="empty-state">Loading Taut…</div> : null}
        {!loading && items.length === 0 ? (
          <div className="empty-state">
            <h3>No triage items yet</h3>
            <p>Pull Slack if credentials are connected, or seed the local demo to explore the prototype.</p>
          </div>
        ) : null}

        <div className="feed-list">
          {items.map((item) => {
            const editValue = draftEdits[item.id] ?? item.draft_text ?? '';
            const manualValue = manualReplies[item.id] ?? '';
            const overdue = item.status === 'open' && new Date(item.due_at).getTime() < Date.now();
            return (
              <article className={`feed-card ${overdue ? 'overdue' : ''}`} key={item.id}>
                <div className="card-topline">
                  <div className="source-pill">
                    <span>{kindLabel(item.source_kind)}</span>
                    <strong>{item.source_name}</strong>
                  </div>
                  <span className={`classification ${classificationAccent[item.classification]}`}>{item.classification}</span>
                </div>

                <div className="message-block">
                  <div className="avatar" aria-hidden="true">{initials(item.author)}</div>
                  <div>
                    <p className="author">{item.author}</p>
                    <p className="excerpt">{item.excerpt}</p>
                  </div>
                </div>

                <dl className="item-details">
                  <div>
                    <dt>Due</dt>
                    <dd className={overdue ? 'danger-text' : ''}>{formatRelativeDue(item.due_at)}</dd>
                  </div>
                  <div>
                    <dt>SLO</dt>
                    <dd>{formatSlo(item.slo_minutes)}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{item.status}</dd>
                  </div>
                </dl>

                <section className="suggestion" aria-label="AI suggested reply or action">
                  <p className="suggestion-label">Suggested action</p>
                  <p>{item.action_summary}</p>
                  {item.draft_text ? <blockquote>{item.draft_text}</blockquote> : <p className="muted">No substantive reply suggested.</p>}
                </section>

                <div className="reply-grid">
                  <label>
                    Edit AI draft then send
                    <textarea value={editValue} onChange={(event) => setDraftEdits((state) => ({ ...state, [item.id]: event.target.value }))} />
                  </label>
                  <label>
                    Manual reply, observe
                    <textarea
                      placeholder="Write Rob’s manual reply here; Taut posts it and stores a learning delta."
                      value={manualValue}
                      onChange={(event) => setManualReplies((state) => ({ ...state, [item.id]: event.target.value }))}
                    />
                  </label>
                </div>

                <div className="action-bar">
                  <button type="button" className="primary" onClick={() => void performAction(item, 'send_ai_draft')} disabled={!item.draft_text || busy !== null}>
                    Send AI draft
                  </button>
                  <button type="button" className="secondary" onClick={() => void performAction(item, 'edit_then_send', { text: editValue })} disabled={!editValue.trim() || busy !== null}>
                    Edit then send
                  </button>
                  <button type="button" className="secondary" onClick={() => void performAction(item, 'manual_reply_observe', { text: manualValue })} disabled={!manualValue.trim() || busy !== null}>
                    Manual reply, observe
                  </button>
                  <button type="button" className="ghost" onClick={() => void performAction(item, 'react', { emoji: 'eyes' })} disabled={busy !== null}>
                    React 👀
                  </button>
                  <button type="button" className="ghost" onClick={() => void performAction(item, 'close_no_reply')} disabled={busy !== null}>
                    Close
                  </button>
                  <button type="button" className="danger" onClick={() => void performAction(item, 'discard_not_useful')} disabled={busy !== null}>
                    Discard
                  </button>
                </div>

                <footer className="card-footer">
                  <label>
                    Pull rule for this source
                    <select value={item.pull_setting} onChange={(event) => void updatePullRule(item, event.target.value as PullSetting)} disabled={busy !== null}>
                      <option value="pull_all">pull_all</option>
                      <option value="mentions_only">mentions_only</option>
                      <option value="disabled">disabled</option>
                    </select>
                  </label>
                  {item.permalink ? (
                    <a href={item.permalink} target="_blank" rel="noreferrer">
                      Open in Slack
                    </a>
                  ) : (
                    <span className="muted">{isDemoSlackId(item.slack_channel_id) ? 'Demo item — no Slack link' : 'No Slack permalink'}</span>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}

function MetricCard(props: { label: string; value: string; hint: string; tone?: 'default' | 'warning' }): React.ReactElement {
  return (
    <section className={`metric-card ${props.tone === 'warning' ? 'warning' : ''}`}>
      <p>{props.label}</p>
      <strong>{props.value}</strong>
      <span>{props.hint}</span>
    </section>
  );
}

class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryAfterSeconds?: number;
  readonly retryAt?: string;

  constructor(message: string, status: number, payload: ApiErrorPayload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload.code;
    this.retryAfterSeconds = payload.retryAfterSeconds;
    this.retryAt = payload.retryAt;
  }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init
  });
  const payload = (await response.json()) as T & ApiErrorPayload;
  if (!response.ok || payload.ok === false) throw new ApiError(payload.error ?? `Request failed: ${response.status}`, response.status, payload);
  return payload;
}

function isDemoSlackId(slackChannelId: string): boolean {
  return /^[CDGM]DEMO/.test(slackChannelId);
}

function kindLabel(kind: string): string {
  if (kind === 'im') return 'DM';
  if (kind === 'mpim') return 'Group DM';
  if (kind === 'private_channel') return 'Private';
  return 'Channel';
}

function connectionLabel(connection: SlackConnectionStatus | null): string {
  if (!connection) return 'Checking Slack connection…';
  if (connection.tokenSource === 'oauth_user') return 'Connected with Slack OAuth user token';
  if (connection.tokenSource === 'env_user') return 'Using dev fallback SLACK_USER_TOKEN';
  if (connection.tokenSource === 'env_bot') return 'Using dev fallback SLACK_BOT_TOKEN';
  return 'Slack not connected';
}

function connectionDetail(connection: SlackConnectionStatus | null): string {
  if (!connection) return 'Loading connection status.';
  if (connection.tokenSource === 'oauth_user') {
    return `${connection.teamName ?? connection.teamId ?? 'Slack workspace'} · user ${connection.userName ?? connection.userId ?? 'unknown'}`;
  }
  if (connection.tokenSource === 'env_user') return 'OAuth setup is bypassed for local development only.';
  if (connection.tokenSource === 'env_bot') return 'Bot tokens only see conversations the bot can access; do not use this for Rob’s real setup.';
  if (!connection.configured) return 'OAuth client credentials are missing.';
  return 'Use Connect Slack to authorize Rob’s Slack account.';
}

function initials(author: string): string {
  return author
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

function formatRelativeDue(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  const absMinutes = Math.round(Math.abs(diffMs) / 60_000);
  if (absMinutes < 60) return diffMs < 0 ? `${absMinutes}m overdue` : `in ${absMinutes}m`;
  const hours = Math.round(absMinutes / 60);
  if (hours < 48) return diffMs < 0 ? `${hours}h overdue` : `in ${hours}h`;
  const days = Math.round(hours / 24);
  return diffMs < 0 ? `${days}d overdue` : `in ${days}d`;
}

function formatSlo(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (24 * 60))}d`;
}

createRoot(document.getElementById('root')!).render(<App />);
