import type { Classification } from './types';

const SLO_MINUTES_BY_CLASSIFICATION: Record<Classification, number> = {
  'direct ask / decision needed': 120,
  'team unblock / direct-report request': 60,
  'task or follow-up': 24 * 60,
  'FYI/context': 3 * 24 * 60,
  noise: 7 * 24 * 60
};

export function sloMinutesFor(classification: Classification): number {
  return SLO_MINUTES_BY_CLASSIFICATION[classification];
}

export function classifyMessage(text: string, context: { isDirect: boolean; mentionsUser: boolean }): Classification {
  const normalized = text.toLowerCase();
  const directAsk = /\?|\b(can you|could you|will you|would you|do you|should we|please|pls|wdyt|thoughts|approve|approval|sign off|decision|decide)\b/.test(normalized);
  const unblock = /\b(blocked|blocking|unblock|stuck|urgent|asap|prod|incident|customer waiting|need help|help me|direct report|1:1)\b/.test(normalized);
  const task = /\b(todo|to-do|follow up|follow-up|action item|can you take|own this|ticket|jira|pr|review|ship|send|schedule|book)\b/.test(normalized);
  const fyi = /\b(fyi|for context|heads up|update|sharing|not urgent|no action)\b/.test(normalized);
  const noise = /^(:\w+:|\+1|thanks|thank you|lol|haha|nice|ship it|lgtm|approved)[.!\s:]*$/i.test(text.trim());

  if (noise) return 'noise';
  if ((context.isDirect || context.mentionsUser) && unblock) return 'team unblock / direct-report request';
  if ((context.isDirect || context.mentionsUser) && directAsk) return 'direct ask / decision needed';
  if (fyi && !context.isDirect && !context.mentionsUser && !unblock) return 'FYI/context';
  if (task) return 'task or follow-up';
  if (directAsk) return 'direct ask / decision needed';
  if (context.isDirect || context.mentionsUser) return 'direct ask / decision needed';
  return 'FYI/context';
}

export function makeExcerpt(text: string, maxLength = 220): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1).trim()}…`;
}

export function buildDraft(input: { classification: Classification; text: string; sourceName: string }): { draftText: string; actionSummary: string } {
  const clean = makeExcerpt(input.text.replace(/<@[A-Z0-9]+>/g, '').trim(), 180);

  switch (input.classification) {
    case 'team unblock / direct-report request':
      return {
        draftText: `Thanks — I can help unblock this. My read is: ${clean}\n\nProposed next step: I’ll take a look and come back with either a decision or a concrete owner/timebox.`,
        actionSummary: 'Prioritise and unblock; confirm next step and owner.'
      };
    case 'direct ask / decision needed':
      return {
        draftText: `Thanks — I’ll make a call on this. Current answer: [add decision].\n\nReasoning: [brief rationale].`,
        actionSummary: 'Reply with a clear decision and concise rationale.'
      };
    case 'task or follow-up':
      return {
        draftText: `Got it — I’ll follow up on this. I’ll update here once it’s done or if I hit a blocker.`,
        actionSummary: 'Acknowledge ownership and create a follow-up.'
      };
    case 'FYI/context':
      return {
        draftText: `Thanks for the context — noted.`,
        actionSummary: 'Acknowledge only if useful; otherwise close as no reply needed.'
      };
    case 'noise':
      return {
        draftText: ``,
        actionSummary: 'Likely no reply needed; discard or close.'
      };
  }
}

export function compareManualReply(aiDraft: string, manualReply: string): string {
  const aiWords = tokenize(aiDraft);
  const manualWords = tokenize(manualReply);
  const aiSet = new Set(aiWords);
  const manualSet = new Set(manualWords);
  const added = [...manualSet].filter((word) => !aiSet.has(word)).slice(0, 20);
  const omitted = [...aiSet].filter((word) => !manualSet.has(word)).slice(0, 20);

  return JSON.stringify(
    {
      summary: 'Manual reply observed and compared with AI draft.',
      manualLength: manualReply.length,
      draftLength: aiDraft.length,
      addedTerms: added,
      omittedTerms: omitted
    },
    null,
    2
  );
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3);
}
