import type { AgentToolContext } from "../types";
import {
  createAgentToolResultHandleRecord,
  upsertAgentToolResultHandles,
} from "../store/toolResultHandles";
import { requestedLiteratureCount } from "../model/literatureIntent";

export type LiteratureCandidateSet = {
  kind: "literature_candidates";
  runId?: string;
  libraryID?: number;
  requestedCount?: number;
  results: Record<string, unknown>[];
};

/** Reuse the conversation-scoped durable tool-result store; no parallel cache. */
export async function identifyLiteratureCandidates(
  content: Record<string, unknown>,
  context: AgentToolContext,
  reviewRequired: boolean,
): Promise<Record<string, unknown>> {
  const results = Array.isArray(content.results) ? content.results : [];
  if (!results.length) return { ...content, reviewRequired: false };
  const candidateSet: LiteratureCandidateSet = {
    kind: "literature_candidates",
    runId: context.runId,
    libraryID: context.request.libraryID,
    requestedCount: requestedLiteratureCount(context.request.userText || ""),
    results,
  };
  const record = createAgentToolResultHandleRecord({
    conversationKey: context.request.conversationKey,
    toolName: "literature_search",
    toolCallId: context.runId || "literature-search",
    resourceSignature: context.resourceSignature,
    content: candidateSet,
  });
  if (!record) return { ...content, reviewRequired: false };
  await upsertAgentToolResultHandles([record]);
  return {
    ...content,
    candidateSetId: record.handle,
    results: results.map((result, index) => ({
      ...result,
      candidateIndex: index + 1,
    })),
    reviewRequired,
    ...(reviewRequired
      ? {
          nextStep: `Assess relevance from titles and abstracts, search again if needed, and select ${candidateSet.requestedCount || 5} genuinely relevant papers in ranked order. Call literature_review with candidateSetId/candidateIndex references and a short evidence-based reason for each. Do not show the raw search pool as a card or finish with prose. Disclose any genuine shortfall instead of padding with weak matches.`,
        }
      : {}),
  };
}
