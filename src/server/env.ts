import { existsSync } from 'node:fs';
import path from 'node:path';

let loaded = false;

export function loadLocalEnv() {
  if (loaded) return;
  loaded = true;

  const configuredPath = process.env.TAUT_ENV_FILE;
  const envPath = configuredPath ? path.resolve(process.cwd(), configuredPath) : path.resolve(process.cwd(), '.env');

  if (!existsSync(envPath)) return;

  process.loadEnvFile(envPath);
}

loadLocalEnv();
