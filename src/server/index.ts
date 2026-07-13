import './env';
import { createApp } from './routes';

function readPort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`Invalid API port "${value}". Set TAUT_API_PORT or PORT to a number between 1 and 65535.`);
  }
  return parsed;
}

const port = readPort(process.env.TAUT_API_PORT ?? process.env.PORT, 8787);
const host = process.env.TAUT_API_HOST;
const app = createApp();

const onListening = () => {
  console.log(`Taut API listening on http://${host ?? 'localhost'}:${port}`);
};

if (host) {
  app.listen(port, host, onListening);
} else {
  app.listen(port, onListening);
}
