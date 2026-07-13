import type { Request } from 'express';
import { getDbPath, getRuntimeStatus } from './db';
import { getLlmStatus } from './llm';
import { getSlackRateLimitStatuses } from './slack';
import { getSlackConnectionStatus } from './slack-oauth';
import type { SocketModeStatus, SystemStatus } from './types';

interface SocketRuntimeValue {
  running?: boolean;
  pid?: number;
  startedAt?: string;
  lastHeartbeatAt?: string;
}

const SOCKET_STALE_AFTER_MS = 45_000;

export function getSystemStatus(req?: Request): SystemStatus {
  return {
    ok: true,
    time: new Date().toISOString(),
    dbPath: getDbPath(),
    slack: getSlackConnectionStatus(req),
    llm: getLlmStatus(),
    socketMode: getSocketModeStatus(),
    slackRateLimits: getSlackRateLimitStatuses()
  };
}

export function getSocketModeStatus(): SocketModeStatus {
  const runtime = getRuntimeStatus<SocketRuntimeValue>('socket-mode');
  const value = runtime?.value;
  const lastHeartbeatAt = value?.lastHeartbeatAt ?? runtime?.updatedAt ?? null;
  const stale = Boolean(lastHeartbeatAt && Date.now() - new Date(lastHeartbeatAt).getTime() > SOCKET_STALE_AFTER_MS);
  const running = Boolean(value?.running && !stale);

  return {
    configured: Boolean(process.env.SLACK_APP_TOKEN),
    running,
    pid: running ? value?.pid ?? null : null,
    startedAt: value?.startedAt ?? null,
    lastHeartbeatAt,
    stale
  };
}

export function socketRuntimeIsActive(): boolean {
  const status = getSocketModeStatus();
  return status.configured && status.running;
}
