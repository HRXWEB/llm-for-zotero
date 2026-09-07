import { inspectResearch } from "./inspection";
import { recordResearchReductions } from "./recordReductions";
import { planExecutionCoordinator } from "../plans/coordinator";
import {
  listExecutionTaskEvidence,
  loadPlanArtifact,
  loadPlanExecutionLedger,
} from "../plans/store";
import type { ZoteroGateway } from "../services/zoteroGateway";
import { validateObject } from "../tools/shared";
import { type ResearchUpdateInput } from "./commands";
import { shouldCheckpointResearchExpansion } from "./policy";
import { progress, recomputeJob, reconcileResearchStage } from "./progress";
import { buildReadingManifest, type ReadingManifestEntry } from "./reading";
import { validateStoredResearchTransition } from "./stages";
import {
  listPaperFindings,
  listResearchCorpusItems,
  listResearchEvidence,
  listResearchWorkItems,
  listScopeSnapshotItems,
  loadResearchJobForExecution,
} from "./store";

import type { AgentToolContext } from "../types";
import { finalizeResearch } from "./finalize";
import { inventoryResearchScope } from "./inventory";
import { recordResearchPapers } from "./recordPapers";
import { nextScreenBatch } from "./screening";
import type { CompleteResearchWorkItem } from "./work";
import { completeResearchWorkItem } from "./work";
export async function executeResearchUpdate(
  gateway: ZoteroGateway,
  input: ResearchUpdateInput,
  context: AgentToolContext,
) {
  const plan = context.request.planContext;
  if (!plan || plan.phase !== "executing") {
    throw new Error("research_update requires approved plan execution");
  }
  let job = await loadResearchJobForExecution(plan.executionId);
  if (!job) throw new Error("This plan has no research job");
  if (
    job.status === "waiting_for_user" &&
    !(
      input.operation === "finalize" &&
      (input.outcome === "partial" || input.outcome === "failed")
    )
  ) {
    throw new Error(
      "Research is waiting for the deep-read checkpoint; call approve_research_expansion so the selected mode can decide, or finalize a user-authorized partial result",
    );
  }
  const executionLedger = await loadPlanExecutionLedger(plan.executionId);
  const activeTask = executionLedger?.tasks.find(
    (entry) => entry.taskId === plan.activeTaskId,
  );
  if (!activeTask || activeTask.expectedEffect === "mutation") {
    throw new Error(
      "Research updates require an active non-mutation plan task",
    );
  }
  const artifact = await loadPlanArtifact(plan.planId, plan.revision);
  const investigation = artifact?.contract?.investigation;
  if (!artifact || !investigation || !artifact.contractDigest) {
    throw new Error("The approved research contract is unavailable");
  }
  if (job.contractDigest !== artifact.contractDigest) {
    throw new Error("Research job contract digest no longer matches the plan");
  }
  const adaptiveReview =
    investigation.readingStrategy === "adaptive" &&
    investigation.reviewMode !== "systematic";
  if (input.operation === "inventory_scope")
    job = await reconcileResearchStage(
      job,
      context.request.conversationKey,
      adaptiveReview,
    );
  const corpus = await listResearchCorpusItems({
    researchJobId: job.researchJobId,
  });
  const corpusByKey = new Map(
    corpus.map((entry) => [`${entry.libraryID}:${entry.itemKey}`, entry]),
  );
  const snapshot = await listScopeSnapshotItems(job.snapshotId);
  const snapshotByKey = new Map(
    snapshot.map((entry) => [`${entry.libraryID}:${entry.itemKey}`, entry]),
  );
  const taskEvidence = await listExecutionTaskEvidence(plan.executionId);
  const verifiedReads = new Map(
    taskEvidence
      .filter(
        (entry) =>
          entry.kind === "verified_read" && entry.verified && entry.reference,
      )
      .map((entry) => [
        entry.reference!,
        entry.payload?.type === "verified_read"
          ? entry.payload.observations || []
          : [],
      ]),
  );
  if (input.operation === "next_screen_batch") {
    return await nextScreenBatch({
      adaptiveReview,
      job,
      corpus,
      context,
      investigation,
    });
  }
  if (
    ["list_verified_reads", "list_findings", "list_themes"].includes(
      input.operation,
    )
  )
    return inspectResearch({
      input,
      job,
      investigation,
      corpus,
      snapshotByKey,
      taskEvidence,
    });
  const allowedCriteria = new Set(
    investigation.criteria.map((entry) => entry.id),
  );
  const allowedSubquestions = new Set(
    investigation.subquestions.map((entry) => entry.id),
  );
  const existingEvidence = await listResearchEvidence(job.researchJobId);
  const evidenceByRef = new Map(
    existingEvidence.map((entry) => [entry.evidenceRef, entry]),
  );
  const newEvidenceRefs: Record<string, string> = {};
  const completeWorkItem = (params: Parameters<CompleteResearchWorkItem>[0]) =>
    completeResearchWorkItem(job, params);

  if (input.operation === "set_stage")
    await validateStoredResearchTransition(job, input.stage, adaptiveReview);
  const effectiveStage = job.activeStage;
  const resumesAdaptiveInventory =
    input.operation === "inventory_scope" && effectiveStage !== "inventory";
  if (input.operation === "record_papers" && effectiveStage === "inventory") {
    throw new Error(
      "Use inventory_scope to inventory the frozen corpus, then advance to broad_screening",
    );
  }
  if (
    input.operation === "record_papers" &&
    effectiveStage === "broad_screening" &&
    !adaptiveReview
  ) {
    const issued = await listResearchWorkItems({
      researchJobId: job.researchJobId,
      stage: "broad_screening",
      statuses: ["in_progress"],
    });
    if (!issued.length) {
      throw new Error(
        "Call next_screen_batch before recording broad-screening decisions",
      );
    }
    const expected = new Set(
      issued.map((entry) => `${entry.libraryID}:${entry.itemKey}`),
    );
    const submitted = new Set(
      (input.papers || []).map((paper) =>
        validateObject<Record<string, unknown>>(paper)
          ? `${Number(paper.libraryID)}:${String(paper.itemKey || "")}`
          : "invalid",
      ),
    );
    if (
      expected.size !== submitted.size ||
      [...expected].some((identity) => !submitted.has(identity))
    ) {
      throw new Error(
        "record_papers must commit exactly the current host-issued screening batch before more work is issued",
      );
    }
  }
  if (
    input.operation === "set_stage" &&
    job.activeStage === "inventory" &&
    input.stage === "broad_screening" &&
    corpus.some((entry) => !entry.inventoryRecorded)
  ) {
    throw new Error(
      "Inventory is incomplete; call inventory_scope before broad screening",
    );
  }
  if (
    input.operation === "record_probes" &&
    effectiveStage !== "recall_expansion"
  ) {
    throw new Error(
      "Recall probes may only be recorded during recall expansion",
    );
  }
  if (
    input.operation === "record_themes" &&
    effectiveStage !== "hierarchical_synthesis"
  ) {
    throw new Error(
      "Theme findings may only be recorded during hierarchical synthesis",
    );
  }
  if (
    input.operation === "finalize" &&
    input.outcome === "complete" &&
    job.activeStage !== "hierarchical_synthesis"
  ) {
    throw new Error("Research can finalize only after all six stages");
  }

  let inventoriedItems: number | undefined;
  let readingManifest: ReadingManifestEntry[] | undefined;
  if (input.operation === "inventory_scope") {
    ({ inventoriedItems, readingManifest } = await inventoryResearchScope({
      resumesAdaptiveInventory,
      job,
      corpus,
      investigation,
      snapshotByKey,
      completeWorkItem,
      gateway,
    }));
  }

  if (input.operation === "record_papers") {
    await recordResearchPapers({
      taskEvidence,
      corpusByKey,
      job,
      input,
      snapshotByKey,
      completeWorkItem,
      gateway,
      adaptiveReview,
      allowedCriteria,
      investigation,
      verifiedReads,
      evidenceByRef,
      newEvidenceRefs,
      allowedSubquestions,
    });
  }

  if (
    input.operation === "record_probes" ||
    input.operation === "record_themes"
  )
    await recordResearchReductions({ input, job, corpusByKey, evidenceByRef });

  let automaticStage =
    input.operation === "set_stage" ? input.stage : undefined;
  let remainingReadingManifest: ReadingManifestEntry[] | undefined;
  if (
    adaptiveReview &&
    input.operation === "inventory_scope" &&
    job.activeStage === "inventory"
  ) {
    automaticStage = "broad_screening";
  }
  if (adaptiveReview && input.operation === "record_papers") {
    const [currentCorpus, currentFindings] = await Promise.all([
      listResearchCorpusItems({ researchJobId: job.researchJobId }),
      listPaperFindings(job.researchJobId),
    ]);
    const findingKeys = new Set(
      currentFindings.map((entry) => `${entry.libraryID}:${entry.itemKey}`),
    );
    const everyPaperUnderstood = currentCorpus.every(
      (entry) =>
        entry.screeningStatus === "missing" ||
        (!["pending", "candidate"].includes(entry.screeningStatus) &&
          findingKeys.has(`${entry.libraryID}:${entry.itemKey}`)),
    );
    if (everyPaperUnderstood) {
      automaticStage = "hierarchical_synthesis";
      remainingReadingManifest = [];
    } else {
      remainingReadingManifest = await buildReadingManifest({
        corpus: currentCorpus.filter(
          (entry) =>
            entry.screeningStatus !== "missing" &&
            !findingKeys.has(`${entry.libraryID}:${entry.itemKey}`),
        ),
        gateway,
        requiredEvidenceDepth: investigation.requiredEvidenceDepth,
      });
    }
  }
  let next = await recomputeJob({
    job,
    conversationKey: context.request.conversationKey,
    activeStage: automaticStage,
    adaptive: adaptiveReview,
  });
  const checkpointRequired =
    !adaptiveReview &&
    shouldCheckpointResearchExpansion({
      approvedEstimate: investigation.estimatedDeepReadPapers,
      actualDeepReadCandidates: next.candidateItems,
      approvedLargeCorpus: investigation.approvedLargeCorpus,
      policy: next.policy,
    }) &&
    next.deepReadPlanned < next.candidateItems;
  if (checkpointRequired && input.operation !== "finalize") {
    next = await recomputeJob({
      job: next,
      conversationKey: context.request.conversationKey,
      status: "waiting_for_user",
    });
  }

  if (input.operation === "finalize") {
    next = await finalizeResearch({
      job,
      input,
      next,
      artifact,
      investigation,
      context,
      plan,
    });
  }

  await context.publishPlanEvent?.({
    type: "plan_research_progress",
    progress: progress(next),
  });
  const content = {
    progress: progress(next),
    inventoriedItems,
    ...(readingManifest
      ? {
          readingManifest,
          instruction: adaptiveReview
            ? readingManifest.length
              ? "Read one capacity-sized semantic group with paper_read overview, then immediately record a rich understanding for every identity in that group before reading more. The host will checkpoint raw text and return the exact remaining manifest."
              : "No unread papers remain. Continue from list_findings or list_themes without rereading PDFs."
            : "Request the next systematic-review screening batch.",
        }
      : {}),
    checkpointRequired,
    evidenceRefs: newEvidenceRefs,
  };
  if (
    adaptiveReview &&
    input.operation === "record_papers" &&
    remainingReadingManifest
  ) {
    const compactRemainingManifest = remainingReadingManifest.map((entry) => ({
      identity: entry.identity,
      title: entry.title,
      readable: entry.readable,
      evidenceDepthTarget: entry.evidenceDepthTarget,
      target: entry.target,
    }));
    if (!compactRemainingManifest.length) {
      const advancedLedger =
        await planExecutionCoordinator.advanceVerifiedTasks({
          executionId: job.executionId,
          requirementKinds: ["verified_read"],
        });
      await context.publishPlanEvent?.({
        type: "plan_execution_updated",
        ledger: advancedLedger,
      });
    }
    return {
      content,
      continuationCheckpoint: {
        reason: "research_batch_durable",
        instruction: compactRemainingManifest.length
          ? `The completed paper-understanding group is durable. Raw PDF text from that group has been released. The exact remaining frozen-scope manifest below is authoritative. Do not call inventory_scope or otherwise re-verify it. Call paper_read now for one capacity-sized semantic group from this manifest, immediately persist that group with research_update record_papers, and do not reread recorded papers.\n\n${JSON.stringify(compactRemainingManifest)}`
          : "All paper understandings are durable and the raw PDF text has been released. Do not call inventory_scope again. Call research_update list_findings now, build and persist the cross-paper themes, finalize research, and do not reread the PDFs unless resolving a decisive uncertainty.",
      },
    };
  }
  return content;
}
