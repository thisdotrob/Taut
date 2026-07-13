import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { ingestSlackMessageEvent, type SlackMessageEvent } from './slack';

const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

interface AppsConnectionsOpenResponse {
  ok: boolean;
  url?: string;
  error?: string;
}

interface SocketModeEnvelope {
  envelope_id?: string;
  type?: string;
  payload?: {
    type?: string;
    event?: SlackMessageEvent;
    event_id?: string;
    event_time?: number;
  };
  reason?: string;
  debug_info?: unknown;
}

export interface SocketModeListenerOptions {
  appToken?: string;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  debugReconnects?: boolean;
}

export class SocketModeListener {
  private readonly appToken: string;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly debugReconnects: boolean;
  private socket: WebSocket | null = null;
  private stopped = false;
  private reconnectAttempt = 0;

  constructor(options: SocketModeListenerOptions = {}) {
    const appToken = options.appToken ?? process.env.SLACK_APP_TOKEN;
    if (!appToken) throw new Error('SLACK_APP_TOKEN is required for Socket Mode. Generate an app-level xapp token with connections:write.');
    this.appToken = appToken;
    this.reconnectMinMs = options.reconnectMinMs ?? 1_000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
    this.debugReconnects = options.debugReconnects ?? process.env.SLACK_SOCKET_DEBUG_RECONNECTS === '1';
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
    this.socket = null;
  }

  private async connect(): Promise<void> {
    const url = await this.openSocketUrl();
    const socketUrl = this.debugReconnects ? appendQuery(url, 'debug_reconnects', 'true') : url;
    const socket = new WebSocket(socketUrl);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      console.log('[socket-mode] connected to Slack Socket Mode');
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      void this.handleRawMessage(String(event.data));
    });

    socket.addEventListener('close', () => {
      console.log('[socket-mode] connection closed');
      this.scheduleReconnect();
    });

    socket.addEventListener('error', (event: Event) => {
      console.error('[socket-mode] websocket error', event);
    });
  }

  private async openSocketUrl(): Promise<string> {
    const response = await fetch('https://slack.com/api/apps.connections.open', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.appToken}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    const payload = (await response.json()) as AppsConnectionsOpenResponse;
    if (!payload.ok || !payload.url) {
      throw new Error(`apps.connections.open failed: ${payload.error ?? `HTTP ${response.status}`}`);
    }
    return payload.url;
  }

  private async handleRawMessage(raw: string): Promise<void> {
    let envelope: SocketModeEnvelope;
    try {
      envelope = JSON.parse(raw) as SocketModeEnvelope;
    } catch (error) {
      console.error('[socket-mode] failed to parse message', error);
      return;
    }

    if (envelope.envelope_id) this.ack(envelope.envelope_id);

    if (envelope.type === 'hello') {
      console.log('[socket-mode] hello from Slack');
      return;
    }

    if (envelope.type === 'disconnect') {
      console.warn('[socket-mode] Slack requested disconnect', envelope.reason ?? envelope.debug_info ?? 'unknown');
      this.socket?.close();
      return;
    }

    if (envelope.type !== 'events_api') return;
    if (envelope.payload?.type !== 'event_callback') return;

    const event = envelope.payload.event;
    if (!event || event.type !== 'message') return;

    try {
      const result = await ingestSlackMessageEvent(event);
      console.log('[socket-mode] message event processed', JSON.stringify(result));
    } catch (error) {
      console.error('[socket-mode] message event failed', error);
    }
  }

  private ack(envelopeId: string): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ envelope_id: envelopeId }));
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.socket = null;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectMinMs * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    console.log(`[socket-mode] reconnecting in ${delay}ms`);
    setTimeout(() => {
      if (this.stopped) return;
      this.connect().catch((error) => {
        console.error('[socket-mode] reconnect failed', error);
        this.scheduleReconnect();
      });
    }, delay);
  }
}

function appendQuery(url: string, key: string, value: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(key, value);
  return parsed.toString();
}
