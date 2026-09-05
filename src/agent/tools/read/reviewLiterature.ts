import type { AgentToolDefinition } from "../../types";
import type { ZoteroGateway } from "../../services/zoteroGateway";
import { getAgentToolResultHandle } from "../../store/toolResultHandles";
import { isExplicitLiteratureImport } from "../../model/literatureIntent";
import type { LiteratureCandidateSet } from "../../services/literatureDiscovery";
import {
  createSearchLiteratureReviewAction,
  resolveSearchLiteratureReview,
} from "../../reviewCards";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import { fail, ok, validateObject, normalizePositiveInt } from "../shared";

type LiteratureReviewInput = {
  selections: Array<{
    candidateSetId: string;
    candidateIndex: number;
    reason: string;
  }>;
  targetCollectionId?: number;
  shortfallReason?: string;
};

export function createLiteratureReviewTool(
  gateway: ZoteroGateway,
): AgentToolDefinition<LiteratureReviewInput, unknown> {
  return {
    spec: {
      name: "literature_review",
      description:
        "Show a ranked paper-only import-selection card after literature_search. Select the requested number using saved candidate references and evidence-based relevance reasons. Discovery requires this card in every permission mode. Explicit import requests use library_import directly instead.",
      executionClass: "read",
      requiresConfirmation: false,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["selections"],
        properties: {
          selections: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["candidateSetId", "candidateIndex", "reason"],
              properties: {
                candidateSetId: {
                  type: "string",
                  description:
                    "Exact candidateSetId returned by literature_search in this turn.",
                },
                candidateIndex: {
                  type: "integer",
                  minimum: 1,
                  description:
                    "One-based candidateIndex from that saved candidate set.",
                },
                reason: {
                  type: "string",
                  description:
                    "Brief relevance explanation grounded in the retrieved title/abstract, not invented findings.",
                },
              },
            },
          },
          targetCollectionId: {
            type: "integer",
            minimum: 1,
            description:
              "Requested destination, after resolving its native collection identity. Otherwise use the one scoped collection or the current library.",
          },
          shortfallReason: {
            type: "string",
            description:
              "Only when fewer genuinely relevant papers can be found than requested: explain the shortfall. Never pad the shortlist with irrelevant papers.",
          },
        },
      },
    },
    presentation: {
      label: "Review relevant papers",
      summaries: {
        onCall: "Preparing ranked paper shortlist",
        onPending: "Choose papers to import",
      },
    },
    validate(args) {
      if (
        !validateObject<Record<string, unknown>>(args) ||
        !Array.isArray(args.selections) ||
        !args.selections.length
      )
        return fail("Provide a nonempty ranked selections list.");
      const selections: LiteratureReviewInput["selections"] = [];
      for (const entry of args.selections) {
        if (
          !validateObject<Record<string, unknown>>(entry) ||
          typeof entry.candidateSetId !== "string" ||
          !/^trh_[a-z0-9]+$/i.test(entry.candidateSetId) ||
          !Number.isSafeInteger(entry.candidateIndex) ||
          Number(entry.candidateIndex) < 1 ||
          typeof entry.reason !== "string" ||
          !entry.reason.trim()
        )
          return fail(
            "Each selection requires a saved candidateSetId, one-based candidateIndex and relevance reason.",
          );
        selections.push({
          candidateSetId: entry.candidateSetId,
          candidateIndex: Number(entry.candidateIndex),
          reason: entry.reason.trim(),
        });
      }
      const targetCollectionId = normalizePositiveInt(args.targetCollectionId);
      if (args.targetCollectionId !== undefined && !targetCollectionId)
        return fail("Invalid targetCollectionId.");
      return ok({
        selections,
        targetCollectionId,
        shortfallReason:
          typeof args.shortfallReason === "string"
            ? args.shortfallReason.trim() || undefined
            : undefined,
      });
    },
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: ["zotero_library"],
        effects: ["read"],
        targets: [],
        reason:
          "Review saved scholarly candidates without changing the library.",
      }),
    execute: async (input, context) => {
      if (isExplicitLiteratureImport(context.request.userText || ""))
        throw new Error(
          "This is an explicit import request. Use library_import for the requested count and destination; do not substitute a discovery card.",
        );
      const selected: Record<string, unknown>[] = [];
      const identities = new Set<string>();
      let requestedCount: number | undefined;
      for (const selection of input.selections) {
        const record = await getAgentToolResultHandle({
          conversationKey: context.request.conversationKey!,
          handle: selection.candidateSetId,
        });
        const set = record?.content as LiteratureCandidateSet | undefined;
        if (
          !record ||
          record.toolName !== "literature_search" ||
          set?.kind !== "literature_candidates" ||
          set.runId !== context.runId ||
          set.libraryID !== context.request.libraryID ||
          record.resourceSignature !== context.resourceSignature
        )
          throw new Error(
            "Candidate set is unavailable or belongs to another turn/library/paper. Search again before reviewing.",
          );
        requestedCount = set.requestedCount || requestedCount;
        const candidate = set.results[selection.candidateIndex - 1];
        if (!candidate)
          throw new Error(
            "Candidate index does not exist in the saved search results.",
          );
        const identity = String(
          candidate.doi ||
            candidate.arxivId ||
            candidate.id ||
            candidate.sourceUrl ||
            candidate.title,
        ).toLowerCase();
        if (identities.has(identity))
          throw new Error(
            "The shortlist contains the same paper more than once.",
          );
        identities.add(identity);
        selected.push({ ...candidate, relevanceReason: selection.reason });
      }
      const expected = requestedCount || 5;
      if (
        selected.length > expected ||
        (selected.length < expected && !input.shortfallReason)
      )
        throw new Error(
          `Review requires ${expected} ranked papers, not ${selected.length}. Search further or disclose a genuine shortfall.`,
        );
      const targetCollectionId =
        input.targetCollectionId ||
        (context.request.turnPaperScope.collections.length === 1
          ? context.request.turnPaperScope.collections[0].collectionId
          : undefined);
      const collection = targetCollectionId
        ? gateway.getCollectionSummary(targetCollectionId)
        : null;
      if (
        targetCollectionId &&
        (!collection || collection.libraryID !== context.request.libraryID)
      )
        throw new Error(
          "The destination collection is unavailable or outside the current library.",
        );
      const library = globalThis.Zotero?.Libraries?.get?.(
        context.request.libraryID!,
      );
      const libraryName =
        (library && library.name) || `Library ${context.request.libraryID}`;
      return {
        mode: "search",
        results: selected,
        reviewRequired: true,
        libraryID: context.request.libraryID,
        targetCollectionId,
        destinationLabel: collection
          ? `${libraryName} › ${collection.path || collection.name}`
          : libraryName,
        shortfallReason: input.shortfallReason,
      };
    },
    createResultReviewAction: (_input, result, context) =>
      createSearchLiteratureReviewAction(result, context, result.content),
    resolveResultReview: (_input, result, resolution, context) =>
      resolveSearchLiteratureReview(
        result.content as never,
        result,
        resolution,
        context,
      ),
  };
}
