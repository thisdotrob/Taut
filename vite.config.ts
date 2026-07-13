import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

function readPort(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`Invalid ${name} "${value}". Expected a number between 1 and 65535.`);
  }
  return parsed;
}

function proxyHostFor(host: string | undefined): string {
  if (!host || host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host;
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const apiPort = readPort(env.TAUT_API_PORT ?? env.PORT, 8787, 'TAUT_API_PORT/PORT');
  const webPort = readPort(env.TAUT_WEB_PORT, 5173, 'TAUT_WEB_PORT');
  const apiProxyTarget = env.TAUT_API_ORIGIN ?? `http://${proxyHostFor(env.TAUT_API_HOST)}:${apiPort}`;

  return {
    plugins: [react()],
    server: {
      port: webPort,
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true
        }
      }
    },
    build: {
      outDir: 'dist/client',
      emptyOutDir: true
    }
  };
});
