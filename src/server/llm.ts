import { query, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Classification, LlmStatus } from './types';
import { heuristicTriage, TRIAGE_PROMPT_VERSION, type TriageDecision } from './triage';

const DEFAULT_CLAUDE_MODEL = 'sonnet';
const CLASSIFICATIONS: Classification[] = [
  'direct ask / decision needed',
  'team unblock / direct-report request',
  'task or follow-up',
  'FYI/context',
  'noise'
];

export interface LearningSignalForPrompt {
  classification: Classification;
  sourceName: string;
  actionType: string;
  actionPayloadJson?: string | null;
  aiDraft: string | null;
  manualReply: string | null;
  deltaJson: string | null;
  itemText: string;
}

export interface GenerateTriageInput {
  text: string;
  sourceName: string;
  sourceKind: string;
  isDirect: boolean;
  mentionsUser: boolean;
  contextSnapshot?: unknown;
  learningSignals?: LearningSignalForPrompt[];
}

interface TriageJsonPayload {
  classification: Classification;
  classificationRationale: string;
  actionSummary: string;
  draftText: string;
}

export function getLlmStatus(): LlmStatus {
  const provider = llmProvider();
  const configured = provider === 'claude' && Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
  return {
    provider,
    configured,
    model: llmModel(),
    promptVersion: TRIAGE_PROMPT_VERSION,
    fallback: configured ? null : provider === 'claude' ? 'CLAUDE_CODE_OAUTH_TOKEN is not set; using heuristic-v0 fallback.' : `Unsupported provider "${provider}"; using heuristic-v0 fallback.`
  };
}

export async function generateTriageDecision(input: GenerateTriageInput): Promise<TriageDecision> {
  const provider = llmProvider();
  if (provider !== 'claude') return heuristicFallback(input, `Unsupported LLM provider "${provider}".`);
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) return heuristicFallback(input, 'CLAUDE_CODE_OAUTH_TOKEN is not configured.');

  try {
    const payload = await callClaude(input);
    return {
      ...payload,
      model: llmModel(),
      promptVersion: TRIAGE_PROMPT_VERSION
    };
  } catch (error) {
    return heuristicFallback(input, `Claude triage failed (${safeLlmError(error)}); used heuristic fallback.`);
  }
}

async function callClaude(input: GenerateTriageInput): Promise<TriageJsonPayload> {
  let result: SDKResultMessage | null = null;
  for await (const message of query({
    prompt: userPrompt(input),
    options: {
      model: llmModel(),
      systemPrompt: systemPrompt(),
      outputFormat: { type: 'json_schema', schema: triageSchema() },
      tools: [],
      maxTurns: 1,
      permissionMode: 'dontAsk',
      persistSession: false,
      settingSources: [],
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN }
    }
  })) {
    if (message.type === 'result') result = message;
  }

  if (!result) throw new Error('Claude Agent SDK did not return a result.');
  if (result.subtype !== 'success') throw new Error(result.errors.join('; ') || `Claude Agent SDK returned ${result.subtype}.`);
  return validateTriagePayload(result.structured_output as Partial<TriageJsonPayload>);
}

function systemPrompt(): string {
  return `You are Taut, Rob's private Slack triage assistant. Classify incoming Slack items, identify whether Rob needs to respond, and draft concise Slack replies in Rob's voice. Preserve the review-first model: never imply a reply was sent. Use only the provided context. Return strict JSON only.`;
}

function userPrompt(input: GenerateTriageInput): string {
  return JSON.stringify(
    {
      promptVersion: TRIAGE_PROMPT_VERSION,
      task: 'Classify this Slack item and draft a review-first suggested reply/action for Rob.',
      classificationOptions: CLASSIFICATIONS,
      sloSemantics: {
        'team unblock / direct-report request': 'High urgency. Someone appears blocked, a direct report/team member needs Rob, or a decision is preventing progress.',
        'direct ask / decision needed': 'Rob is explicitly asked for a decision, answer, approval, or opinion.',
        'task or follow-up': 'There is a task, next step, reminder, or follow-up to track.',
        'FYI/context': 'Useful context with low/no reply requirement.',
        noise: 'Low-signal chatter, thanks/emoji-like messages, or irrelevant noise.'
      },
      source: {
        name: input.sourceName,
        kind: input.sourceKind,
        isDirect: input.isDirect,
        mentionsRob: input.mentionsUser
      },
      messageText: input.text,
      contextSnapshot: input.contextSnapshot ?? null,
      recentLearningSignals: (input.learningSignals ?? []).map((signal) => ({
        classification: signal.classification,
        sourceName: signal.sourceName,
        actionType: signal.actionType,
        itemText: truncate(signal.itemText, 500),
        actionPayloadJson: truncate(signal.actionPayloadJson ?? '', 500),
        aiDraft: truncate(signal.aiDraft ?? '', 500),
        manualReply: truncate(signal.manualReply ?? '', 500),
        deltaJson: signal.deltaJson
      })),
      responseContract: {
        classification: 'one classification option exactly',
        classificationRationale: 'one concise sentence explaining key evidence from the message/context',
        actionSummary: 'short imperative summary of what Rob should do',
        draftText: 'empty string when no reply should be sent; otherwise concise Slack-ready reply Rob can edit'
      }
    },
    null,
    2
  );
}

function triageSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      classification: { type: 'string', enum: CLASSIFICATIONS },
      classificationRationale: { type: 'string', minLength: 1, maxLength: 500 },
      actionSummary: { type: 'string', minLength: 1, maxLength: 500 },
      draftText: { type: 'string', maxLength: 2000 }
    },
    required: ['classification', 'classificationRationale', 'actionSummary', 'draftText']
  };
}

function validateTriagePayload(payload: Partial<TriageJsonPayload>): TriageJsonPayload {
  if (!CLASSIFICATIONS.includes(payload.classification as Classification)) throw new Error('LLM returned an unsupported classification.');
  return {
    classification: payload.classification as Classification,
    classificationRationale: stringOrFallback(payload.classificationRationale, 'LLM supplied no rationale.'),
    actionSummary: stringOrFallback(payload.actionSummary, 'Review this Slack item.'),
    draftText: typeof payload.draftText === 'string' ? payload.draftText : ''
  };
}

function heuristicFallback(input: GenerateTriageInput, reason: string): TriageDecision {
  return heuristicTriage({
    text: input.text,
    sourceName: input.sourceName,
    isDirect: input.isDirect,
    mentionsUser: input.mentionsUser,
    rationale: `${reason} Heuristic fallback based on directness, mentions, urgency/task/FYI keywords, and message length.`
  });
}

function llmProvider(): string {
  return (process.env.TAUT_LLM_PROVIDER ?? 'claude').trim().toLowerCase();
}

function llmModel(): string {
  return (process.env.TAUT_LLM_MODEL ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_CLAUDE_MODEL).trim();
}

function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function safeLlmError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  if (/auth|credential|401|403/i.test(message)) return 'authentication failed; check CLAUDE_CODE_OAUTH_TOKEN';
  if (/rate|429|limit/i.test(message)) return 'Claude rate limit reached';
  return 'Claude Agent SDK request failed';
}
