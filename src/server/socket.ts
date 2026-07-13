import './env';
import { migrate } from './db';
import { SocketModeListener } from './socket-mode';

migrate();

const listener = new SocketModeListener();

process.once('SIGINT', () => {
  console.log('[socket-mode] SIGINT received, stopping');
  listener.stop();
  process.exit(0);
});

process.once('SIGTERM', () => {
  console.log('[socket-mode] SIGTERM received, stopping');
  listener.stop();
  process.exit(0);
});

await listener.start();
console.log('[socket-mode] listener started');
