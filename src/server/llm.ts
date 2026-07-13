import { ProxyAgent, setGlobalDispatcher } from 'undici';
import type { Classification, LlmStatus } from './types';
import { heuristicTriage, TRIAGE_PROMPT_VERSION, type TriageDecision } from './triage';

const proxyUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_OPENAI_MODEL = 'gpt-5.6';
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

interface OpenAIResponsePayload {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  error?: { message?: string };
}

interface TriageJsonPayload {
  classification: Classification;
  classificationRationale: string;
  actionSummary: string;
  draftText: string;
}

export function getLlmStatus(): LlmStatus {
  const provider = llmProvider();
  const configured = provider === 'openai' && Boolean(process.env.OPENAI_API_KEY);
  return {
    provider,
    configured,
    model: llmModel(),
    promptVersion: TRIAGE_PROMPT_VERSION,
    fallback: configured ? null : provider === 'openai' ? 'OPENAI_API_KEY is not set; using heuristic-v0 fallback.' : `Unsupported provider "${provider}"; using heuristic-v0 fallback.`
  };
}

export async function generateTriageDecision(input: GenerateTriageInput): Promise<TriageDecision> {
  const provider = llmProvider();
  if (provider !== 'openai') return heuristicFallback(input, `Unsupported LLM provider "${provider}".`);
  if (!process.env.OPENAI_API_KEY) return heuristicFallback(input, 'OPENAI_API_KEY is not configured.');

  try {
    const payload = await callOpenAI(input);
    return {
      ...payload,
      model: llmModel(),
      promptVersion: TRIAGE_PROMPT_VERSION
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return heuristicFallback(input, `LLM triage failed (${message}); used heuristic fallback.`);
  }
}

async function callOpenAI(input: GenerateTriageInput): Promise<TriageJsonPayload> {
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: llmModel(),
      input: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: userPrompt(input) }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'taut_triage_decision',
          strict: true,
          schema: triageSchema()
        }
      },
      max_output_tokens: maxOutputTokens()
    })
  });

  const body = (await response.json().catch(() => ({}))) as OpenAIResponsePayload;
  if (!response.ok) throw new Error(body.error?.message ?? `OpenAI Responses API HTTP ${response.status}`);

  const outputText = extractOutputText(body);
  if (!outputText) throw new Error('OpenAI response did not include output text.');

  const parsed = JSON.parse(outputText) as Partial<TriageJsonPayload>;
  return validateTriagePayload(parsed);
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

function extractOutputText(payload: OpenAIResponsePayload): string | null {
  if (typeof payload.output_text === 'string') return payload.output_text;
  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string') return content.text;
    }
  }
  return null;
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
  return (process.env.TAUT_LLM_PROVIDER ?? 'openai').trim().toLowerCase();
}

function llmModel(): string {
  return (process.env.TAUT_LLM_MODEL ?? process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL).trim();
}

function maxOutputTokens(): number {
  const raw = process.env.TAUT_LLM_MAX_OUTPUT_TOKENS;
  if (!raw) return 900;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 128 || parsed > 4000) return 900;
  return Math.round(parsed);
}

function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
