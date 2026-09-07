import type { PlanContract, PlanExecutionLedger } from "./types";
import { planRequiresModelTaskUpdates } from "./taskOwnership";

/** Shared provider handoff from the authoritative execution ledger. */
export function buildApprovedPlanExecutionInstructions(
  ledger: PlanExecutionLedger,
  approvedContract?: PlanContract | null,
): string {
  const taskProgressInstruction = planRequiresModelTaskUpdates(ledger)
    ? "The host has already started the first pending task and owns the full ledger. It automatically advances tasks verified by research_update or submit_document; never call task_update for tasks whose requirements are only verified_read, material_integrity, mutation_receipts, research_coverage, document_integrity, or document_published. For other active tasks, call task_update with only the task whose status changes, using its exact taskId, after its required evidence exists. The host automatically starts the next pending task. Do not rename, delete, reorder, or silently skip approved tasks."
    : "The host automatically advances these tasks from verified reads, mutation receipts, and finalized material. Bound operations run automatically when their prerequisites are complete. Do not call task_update for these tasks, including tasks already shown as completed; continue with the active scholarly or document tool instead.";
  const deliverableLines = approvedContract
    ? approvedContract.deliverable.kind === "document"
      ? [
          "Approved document contract:",
          `- Exact title: ${approvedContract.deliverable.spec.title}`,
          `- Kind: ${approvedContract.deliverable.spec.kind}`,
          `- Required sections: ${approvedContract.deliverable.spec.requiredSections.join("; ")}`,
          `- References required: ${approvedContract.deliverable.spec.requiresReferences ? "yes" : "no"}`,
          `- Coverage section required: ${approvedContract.deliverable.spec.requiresCoverageSection ? "yes" : "no"}`,
          `- Citation style: ${approvedContract.deliverable.spec.citationStyle.styleTitle} (${approvedContract.deliverable.spec.citationStyle.locale})`,
          "submit_document.title must match the exact approved title above.",
        ]
      : [`Approved deliverable: ${approvedContract.deliverable.kind}.`]
    : [];
  return [
    "APPROVED PLAN EXECUTION:",
    `Plan identity: ${ledger.planId} revision ${ledger.revision}; execution ${ledger.executionId}.`,
    `Approved digest: ${ledger.planDigest}.`,
    "The host has already frozen and fingerprinted the approved base scope. The active research job owns its effective immutable snapshot. Do not re-enumerate it with library_search; research_update inventory_scope is authoritative. If a paper newly qualifies inside an expandable approved source, use amend_plan research_scope with its exact Zotero identity. Use amend_plan contract_revision for a changed question, source boundary, deliverable, operation, or parameters.",
    "Execute required tasks in order. Provider task status is only a request; the host accepts completion only from verified evidence.",
    ...ledger.tasks.map(
      (task, index) =>
        `${index + 1}. [${task.status}] taskId=${task.taskId}\n` +
        `   ${task.content}\n` +
        `   While active: ${task.activeForm}\n` +
        (task.materialOutputId
          ? `   Generate materialOutputId=${task.materialOutputId} with submit_document.\n`
          : "") +
        (task.actionIndexes
          ? `   Fulfill semantic actionIndexes=${JSON.stringify(task.actionIndexes)}.\n`
          : "") +
        `   Acceptance: ${task.acceptanceCriteria
          .map((criterion) =>
            typeof criterion === "string" ? criterion : criterion.description,
          )
          .join("; ")}`,
    ),
    ...deliverableLines,
    taskProgressInstruction,
    "Your final answer should answer the original request naturally. Do not expose plan IDs, execution IDs, task IDs, digests, or append a plan-status/checklist recap; the host renders progress separately.",
  ].join("\n");
}
