import type { Classification } from './types';

export const TRIAGE_PROMPT_VERSION = 'taut-triage-v1';

export interface TriageDecision {
  classification: Classification;
  classificationRationale: string;
  actionSummary: string;
  draftText: string;
  model: string;
  promptVersion: string;
}

export function classifyMessage(text: string, context: { isDirect: boolean; mentionsUser: boolean }): Classification {
  const normalized = text.toLowerCase();
  if (/\b(blocked|stuck|urgent|asap|need you|can you approve|decision)\b/.test(normalized) || context.isDirect) return 'team unblock / direct-report request';
  if (/\b(can you|could you|please|wdyt|decision|approve|ship)\b/.test(normalized) || context.mentionsUser) return 'direct ask / decision needed';
  if (/\b(todo|follow up|ticket|task|remind|next step)\b/.test(normalized)) return 'task or follow-up';
  if (/\b(fyi|context|heads up|sharing|note)\b/.test(normalized)) return 'FYI/context';
  return text.trim().length < 12 ? 'noise' : 'FYI/context';
}

export function sloMinutesFor(classification: Classification): number {
  switch (classification) {
    case 'team unblock / direct-report request':
      return 60;
    case 'direct ask / decision needed':
      return 4 * 60;
    case 'task or follow-up':
      return 24 * 60;
    case 'FYI/context':
      return 3 * 24 * 60;
    case 'noise':
      return 7 * 24 * 60;
  }
}

export function buildDraft(input: { classification: Classification; text: string; sourceName: string }): { actionSummary: string; draftText: string } {
  const excerpt = makeExcerpt(input.text, 180);
  if (input.classification === 'noise') {
    return { actionSummary: 'Likely no reply needed; discard or close.', draftText: '' };
  }
  if (input.classification === 'FYI/context') {
    return { actionSummary: 'Acknowledge only if useful; otherwise close as no reply needed.', draftText: 'Thanks for the context — noted.' };
  }
  if (input.classification === 'task or follow-up') {
    return {
      actionSummary: 'Acknowledge ownership and create a follow-up.',
      draftText: `Got it — I’ll follow up on this. I’ll update here once it’s done or if I hit a blocker.`
    };
  }
  if (input.classification === 'direct ask / decision needed') {
    return {
      actionSummary: 'Respond with a decision or a clear timebox for the decision.',
      draftText: `Thanks — I’ve seen this. My initial take is: ${excerpt}\n\nI’ll make a call / come back with a decision shortly.`
    };
  }
  return {
    actionSummary: 'Prioritise and unblock; confirm next step and owner.',
    draftText: `Thanks — I can help unblock this. My read is: ${excerpt}\n\nProposed next step: I’ll take a look and come back with either a decision or a concrete owner/timebox.`
  };
}

export function heuristicTriage(input: { text: string; sourceName: string; isDirect: boolean; mentionsUser: boolean; model?: string; rationale?: string }): TriageDecision {
  const classification = classifyMessage(input.text, { isDirect: input.isDirect, mentionsUser: input.mentionsUser });
  const draft = buildDraft({ classification, text: input.text, sourceName: input.sourceName });
  return {
    classification,
    classificationRationale: input.rationale ?? 'Heuristic fallback based on directness, mention markers, urgency/task/FYI keywords, and message length.',
    actionSummary: draft.actionSummary,
    draftText: draft.draftText,
    model: input.model ?? 'heuristic-v0',
    promptVersion: 'heuristic-v0'
  };
}

export function makeExcerpt(text: string, length = 140): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= length) return compact;
  return `${compact.slice(0, length - 1)}…`;
}

export function compareManualReply(aiDraft: string, manualReply: string): string {
  const aiWords = new Set(aiDraft.toLowerCase().split(/\W+/).filter(Boolean));
  const manualWords = manualReply.toLowerCase().split(/\W+/).filter(Boolean);
  const newWords = manualWords.filter((word) => !aiWords.has(word));
  return JSON.stringify({ newTerms: Array.from(new Set(newWords)).slice(0, 20), manualLength: manualReply.length, aiDraftLength: aiDraft.length });
}
