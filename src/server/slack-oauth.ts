import type { Request } from 'express';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { clearSlackConnection, consumeSlackOAuthState, createSlackOAuthState, getSlackConnection, storeSlackConnection } from './db';
import type { SlackConnectionStatus, SlackTokenSource } from './types';

const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

export const SLACK_USER_SCOPES = [
  'channels:read',
  'groups:read',
  'im:read',
  'mpim:read',
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'chat:write',
  'reactions:write',
  'users:read'
] as const;

interface SlackOAuthAccessResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  token_type?: string;
  scope?: string;
  team?: {
    id?: string;
    name?: string;
  };
  authed_user?: {
    id?: string;
    scope?: string;
    access_token?: string;
    token_type?: string;
  };
}

export interface ResolvedSlackToken {
  token: string;
  source: SlackTokenSource;
  teamId: string | null;
  teamName: string | null;
  userId: string | null;
  userName: string | null;
  scopes: string[];
}

export function getSlackConnectionStatus(req?: Request): SlackConnectionStatus {
  const connection = getSlackConnection();
  const fallback = getEnvFallbackToken();
  const resolved = connection
    ? {
        tokenSource: 'oauth_user' as const,
        teamId: connection.team_id,
        teamName: connection.team_name,
        userId: connection.authed_user_id,
        userName: connection.authed_user_name,
        scopes: splitScopes(connection.scope)
      }
    : fallback
      ? {
          tokenSource: fallback.source,
          teamId: null,
          teamName: null,
          userId: null,
          userName: null,
          scopes: []
        }
      : null;

  return {
    connected: Boolean(resolved),
    configured: slackOAuthClientIsConfigured(),
    tokenSource: resolved?.tokenSource ?? null,
    teamId: resolved?.teamId ?? null,
    teamName: resolved?.teamName ?? null,
    userId: resolved?.userId ?? null,
    userName: resolved?.userName ?? null,
    scopes: resolved?.scopes ?? [],
    connectUrl: '/api/slack/oauth/start',
    devFallbackAvailable: Boolean(fallback)
  };
}

export function resolveSlackToken(): ResolvedSlackToken {
  const connection = getSlackConnection();
  if (connection) {
    return {
      token: connection.access_token,
      source: 'oauth_user',
      teamId: connection.team_id,
      teamName: connection.team_name,
      userId: connection.authed_user_id,
      userName: connection.authed_user_name,
      scopes: splitScopes(connection.scope)
    };
  }

  const fallback = getEnvFallbackToken();
  if (fallback) return fallback;

  throw new Error('Slack is not connected. Use the Slack OAuth user-token flow at /api/slack/oauth/start, or set SLACK_USER_TOKEN as a dev-only fallback.');
}

export function buildSlackOAuthStartUrl(req: Request): string {
  assertSlackOAuthClientConfigured();
  const state = createSlackOAuthState(safeRedirectPath(req.query.redirect));
  const redirectUri = slackRedirectUri(req);
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', process.env.SLACK_CLIENT_ID!);
  url.searchParams.set('user_scope', SLACK_USER_SCOPES.join(','));
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

export async function completeSlackOAuth(req: Request): Promise<{ redirectAfter: string | null; teamName: string; userId: string; scopes: string[] }> {
  assertSlackOAuthClientConfigured();
  const code = singleQueryValue(req.query.code);
  const state = singleQueryValue(req.query.state);
  const error = singleQueryValue(req.query.error);

  if (error) throw new Error(`Slack OAuth failed: ${error}`);
  if (!code || !state) throw new Error('Slack OAuth callback was missing code or state.');

  const stateRecord = consumeSlackOAuthState(state);
  if (!stateRecord) throw new Error('Slack OAuth state is invalid or expired. Start the connection flow again.');

  const tokenResponse = await exchangeSlackOAuthCode(code, slackRedirectUri(req));
  const userToken = tokenResponse.authed_user?.access_token;
  const userId = tokenResponse.authed_user?.id;
  const teamId = tokenResponse.team?.id;
  const teamName = tokenResponse.team?.name;

  if (!userToken || !userId || !teamId || !teamName) {
    throw new Error('Slack OAuth did not return a user token. Confirm the app requests user scopes with user_scope, not only bot scopes.');
  }

  const scope = tokenResponse.authed_user?.scope ?? tokenResponse.scope ?? '';
  const tokenType = tokenResponse.authed_user?.token_type ?? tokenResponse.token_type ?? 'user';
  storeSlackConnection({
    teamId,
    teamName,
    authedUserId: userId,
    authedUserName: null,
    accessToken: userToken,
    scope,
    tokenType
  });

  return { redirectAfter: stateRecord.redirectAfter, teamName, userId, scopes: splitScopes(scope) };
}

export function disconnectSlack(): void {
  clearSlackConnection();
}

export function slackRedirectUri(req?: Request): string {
  if (process.env.SLACK_REDIRECT_URI) return process.env.SLACK_REDIRECT_URI;
  const publicUrl = process.env.TAUT_PUBLIC_URL ?? requestOrigin(req) ?? `http://localhost:${process.env.PORT ?? 8787}`;
  return `${publicUrl.replace(/\/$/, '')}/api/slack/oauth/callback`;
}

export function tautAppUrl(): string {
  return (process.env.TAUT_APP_URL ?? 'http://localhost:5173').replace(/\/$/, '');
}

function slackOAuthClientIsConfigured(): boolean {
  return Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET);
}

function assertSlackOAuthClientConfigured(): void {
  if (!slackOAuthClientIsConfigured()) {
    throw new Error('Slack OAuth is not configured. Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET, then add the redirect URL from the setup docs to your Slack app.');
  }
}

async function exchangeSlackOAuthCode(code: string, redirectUri: string): Promise<SlackOAuthAccessResponse> {
  const body = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID!,
    client_secret: process.env.SLACK_CLIENT_SECRET!,
    code,
    redirect_uri: redirectUri
  });

  const response = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const payload = (await response.json()) as SlackOAuthAccessResponse;
  if (!payload.ok) throw new Error(`Slack OAuth token exchange failed: ${payload.error ?? `HTTP ${response.status}`}`);
  return payload;
}

function getEnvFallbackToken(): ResolvedSlackToken | null {
  if (process.env.SLACK_USER_TOKEN) {
    return {
      token: process.env.SLACK_USER_TOKEN,
      source: 'env_user',
      teamId: null,
      teamName: null,
      userId: null,
      userName: null,
      scopes: []
    };
  }

  if (process.env.SLACK_BOT_TOKEN) {
    return {
      token: process.env.SLACK_BOT_TOKEN,
      source: 'env_bot',
      teamId: null,
      teamName: null,
      userId: null,
      userName: null,
      scopes: []
    };
  }

  return null;
}

function splitScopes(scope: string): string[] {
  return scope
    .split(/[ ,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
}

function requestOrigin(req?: Request): string | null {
  if (!req) return null;
  const forwardedProto = singleHeaderValue(req.headers['x-forwarded-proto']);
  const forwardedHost = singleHeaderValue(req.headers['x-forwarded-host']);
  const proto = forwardedProto ?? req.protocol;
  const host = forwardedHost ?? req.get('host');
  if (!host) return null;
  return `${proto}://${host}`;
}

function singleHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function singleQueryValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

function safeRedirectPath(value: unknown): string | null {
  const candidate = singleQueryValue(value);
  if (!candidate) return null;
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return null;
  return candidate;
}
