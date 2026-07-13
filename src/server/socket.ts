import './env';
import { migrate, setRuntimeStatus } from './db';
import { SocketModeListener } from './socket-mode';
import { socketRuntimeIsActive } from './status';

migrate();

if (socketRuntimeIsActive()) {
  throw new Error('A healthy Taut Socket Mode listener heartbeat already exists. Stop the other pnpm socket/dev:all process before starting another listener.');
}

const startedAt = new Date().toISOString();
const listener = new SocketModeListener();
let heartbeatInterval: NodeJS.Timeout | null = null;

function writeHeartbeat(running = true): void {
  setRuntimeStatus('socket-mode', {
    running,
    pid: process.pid,
    startedAt,
    lastHeartbeatAt: new Date().toISOString()
  });
}

function stopAndExit(signal: string): void {
  console.log(`[socket-mode] ${signal} received, stopping`);
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  listener.stop();
  writeHeartbeat(false);
  process.exit(0);
}

process.once('SIGINT', () => stopAndExit('SIGINT'));
process.once('SIGTERM', () => stopAndExit('SIGTERM'));

writeHeartbeat(true);
heartbeatInterval = setInterval(() => writeHeartbeat(true), 15_000);
await listener.start();
writeHeartbeat(true);
console.log('[socket-mode] listener started');
