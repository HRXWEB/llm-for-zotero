import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import { PlanExecutionCoordinator } from "../src/agent/plans/coordinator";
import { deliverPendingPlanDocumentMessage } from "../src/agent/documents/finalizer";
import {
  initPlanDocumentStore,
  loadPlanDocumentOutbox,
  savePlanDocumentInTransaction,
} from "../src/agent/documents/store";
import type {
  PlanDocument,
  PlanDocumentOutboxRecord,
} from "../src/agent/documents/types";
import {
  initAgentPlanStore,
  loadPlanExecutionLedger,
  savePlanExecutionLedger,
  saveTaskEvidence,
} from "../src/agent/plans/store";
import type {
  ExecutionTask,
  PlanExecutionLedger,
  TaskEvidence,
} from "../src/agent/plans/types";
import { takePendingPlanExecution } from "../src/modules/contextPanel/planModeState";
import { PlanExecutionRunSession } from "../src/agent/plans/runSession";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };

function reasoningTask(): ExecutionTask {
  return {
    version: 2,
    taskId: "execution-1:task-1",
    executionId: "execution-1",
    planStepId: "step-1",
    kind: "required_step",
    content: "Synthesize the evidence",
    activeForm: "Synthesizing the evidence",
    acceptanceCriteria: [
      {
        criterionId: "criterion-1",
        description: "A bounded conclusion is recorded",
        verifier: "bounded_reasoning",
      },
    ],
    expectedEffect: "reasoning",
    completionRequirements: [
      {
        requirementId: "requirement-1",
        kind: "bounded_reasoning",
        criterionIds: ["criterion-1"],
        contractDigest: "sha256:contract",
      },
    ],
    obligationIds: [],
    status: "in_progress",
    attemptCount: 1,
    evidenceIds: [],
    failureReasons: [],
    createdAt: 1,
    updatedAt: 1,
    startedAt: 1,
  };
}

function execution(): PlanExecutionLedger {
  return {
    version: 2,
    executionId: "execution-1",
    planId: "plan-1",
    revision: 1,
    planDigest: "sha256:plan",
    conversationKey: 41,
    attempt: 1,
    provider: "original",
    grant: {
      version: 1,
      planId: "plan-1",
      revision: 1,
      planDigest: "sha256:plan",
      conversationKey: 41,
      conversationGeneration: 1,
      approvedAt: 1,
    },
    status: "running",
    activeTaskId: "execution-1:task-1",
    tasks: [reasoningTask()],
    createdAt: 1,
    updatedAt: 1,
  };
}

function reasoningEvidence(): TaskEvidence {
  return {
    version: 3,
    evidenceId: "evidence-1",
    executionId: "execution-1",
    taskId: "execution-1:task-1",
    kind: "reasoning_assertion",
    verified: true,
    requirementId: "requirement-1",
    criterionIds: ["criterion-1"],
    contractDigest: "sha256:contract",
    payload: {
      type: "bounded_reasoning",
      assertion: "The evidence supports the bounded conclusion.",
    },
    summary: "The evidence supports the bounded conclusion.",
    createdAt: 2,
  };
}

function hostVerifiedResearchExecution(): PlanExecutionLedger {
  const makeTask = (params: {
    suffix: string;
    content: string;
    status: ExecutionTask["status"];
    requirementKind:
      | "verified_read"
      | "research_coverage"
      | "document_integrity";
  }): ExecutionTask => ({
    version: 2,
    taskId: `execution-1:task-${params.suffix}`,
    executionId: "execution-1",
    planStepId: `step-${params.suffix}`,
    kind: "required_step",
    content: params.content,
    activeForm: params.content,
    acceptanceCriteria: [
      {
        criterionId: `criterion-${params.suffix}`,
        description: params.content,
        verifier: params.requirementKind,
      },
    ],
    expectedEffect:
      params.requirementKind === "document_integrity" ? "artifact" : "read",
    completionRequirements: [
      {
        requirementId: `requirement-${params.suffix}`,
        kind: params.requirementKind,
        criterionIds: [`criterion-${params.suffix}`],
        contractDigest: "sha256:contract",
      },
    ],
    obligationIds: [],
    status: params.status,
    attemptCount: params.status === "in_progress" ? 1 : 0,
    evidenceIds: [],
    failureReasons: [],
    createdAt: 1,
    updatedAt: 1,
    startedAt: params.status === "in_progress" ? 1 : undefined,
  });
  return {
    ...execution(),
    activeTaskId: "execution-1:task-1",
    tasks: [
      makeTask({
        suffix: "1",
        content: "Understand every paper",
        status: "in_progress",
        requirementKind: "verified_read",
      }),
      makeTask({
        suffix: "2",
        content: "Synthesize relationships",
        status: "pending",
        requirementKind: "research_coverage",
      }),
      makeTask({
        suffix: "3",
        content: "Publish the document",
        status: "pending",
        requirementKind: "document_integrity",
      }),
    ],
  };
}

function hostVerifiedResearchEvidence(): TaskEvidence[] {
  return [
    {
      version: 3,
      evidenceId: "evidence-read",
      executionId: "execution-1",
      taskId: "execution-1:task-1",
      kind: "verified_read",
      verified: true,
      requirementId: "requirement-1",
      criterionIds: ["criterion-1"],
      contractDigest: "sha256:contract",
      payload: {
        type: "verified_read",
        reference: "read-1",
        observations: [
          {
            version: 1,
            observationId: "observation-1",
            issuer: "zotero_host",
            toolName: "paper_read",
            callDigest: "sha256:call",
            inputDigest: "sha256:input",
            resultDigest: "sha256:result",
            libraryID: 1,
            itemKey: "AAAA1111",
            capabilities: ["body"],
            certificateDigest: "sha256:certificate",
          },
        ],
      },
      createdAt: 2,
    },
    {
      version: 3,
      evidenceId: "evidence-coverage",
      executionId: "execution-1",
      taskId: "execution-1:task-2",
      kind: "research_coverage",
      verified: true,
      requirementId: "requirement-2",
      criterionIds: ["criterion-2"],
      contractDigest: "sha256:contract",
      payload: {
        type: "research_coverage",
        researchJobId: "research-1",
        coverageStatus: "complete",
        totalItems: 1,
        screenedItems: 1,
        candidateItems: 1,
        deepReadCompleted: 1,
      },
      createdAt: 3,
    },
  ];
}

function documentExecution(): PlanExecutionLedger {
  const taskId = "execution-1:task-document";
  return {
    ...execution(),
    activeTaskId: taskId,
    tasks: [
      {
        ...reasoningTask(),
        taskId,
        planStepId: "step-document",
        content: "Publish the document",
        activeForm: "Publishing the document",
        acceptanceCriteria: [
          {
            criterionId: "criterion-document",
            description: "The document is validated and published",
            verifier: "document_published",
          },
        ],
        expectedEffect: "artifact",
        completionRequirements: [
          {
            requirementId: "requirement-integrity",
            kind: "document_integrity",
            criterionIds: ["criterion-document"],
            contractDigest: "sha256:contract",
          },
          {
            requirementId: "requirement-published",
            kind: "document_published",
            criterionIds: ["criterion-document"],
            contractDigest: "sha256:contract",
          },
        ],
        evidenceIds: [],
      },
    ],
  };
}

function plannedDocument(): {
  document: PlanDocument;
  outbox: PlanDocumentOutboxRecord;
} {
  const visibleMarkdown = "# Report\n\nComplete.";
  const document: PlanDocument = {
    version: 2,
    documentId: "document-1",
    documentVersion: 1,
    documentKind: "report",
    integrityPolicy: "authored",
    origin: {
      kind: "planned",
      planId: "plan-1",
      planRevision: 1,
      executionId: "execution-1",
      parentTaskId: "execution-1:task-document",
      contractDigest: "sha256:contract",
    },
    conversationKey: 41,
    title: "Report",
    visibleMarkdown,
    visibleHtml: "<h1>Report</h1><p>Complete.</p>",
    citationBundle: {
      clusters: [],
      bibliographyEntries: [],
      style: { id: "apa", title: "APA" },
      locale: "en-US",
    },
    verifiedQuotes: [],
    assets: [],
    coverageItems: [],
    validation: {
      integrityValidated: true,
      groundingReviewed: "not_run",
      quoteVerified: "not_applicable",
      issues: [],
    },
    contentHash: "sha256:document",
    createdAt: 2,
  };
  return {
    document,
    outbox: {
      version: 1,
      outboxId: "document-1:message",
      documentId: document.documentId,
      conversationKey: document.conversationKey,
      messageTimestamp: 2,
      visibleMarkdown,
      status: "pending",
      attemptCount: 0,
      createdAt: 2,
      updatedAt: 2,
    },
  };
}

function documentIntegrityEvidence(): TaskEvidence {
  return {
    version: 3,
    evidenceId: "document-1:integrity",
    executionId: "execution-1",
    taskId: "execution-1:task-document",
    kind: "document_integrity",
    verified: true,
    requirementId: "requirement-integrity",
    criterionIds: ["criterion-document"],
    contractDigest: "sha256:contract",
    payload: {
      type: "document_integrity",
      documentId: "document-1",
      contentHash: "sha256:document",
      integrityValidated: true,
    },
    summary: "Document integrity validated",
    createdAt: 2,
  };
}

describe("transactional Plan task transitions", function () {
  let originalZotero: unknown;
  let db: DatabaseSync;
  let failTransitionInsert = false;

  before(function () {
    originalZotero = globalScope.Zotero;
  });

  beforeEach(async function () {
    failTransitionInsert = false;
    db = new DatabaseSync(":memory:");
    const bindable = (params: unknown[] | undefined) =>
      (params || []).map((value) => (value === undefined ? null : value));
    globalScope.Zotero = {
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          if (
            failTransitionInsert &&
            sql.includes("INSERT INTO llm_for_zotero_plan_task_transitions")
          ) {
            throw new Error("injected transition write failure");
          }
          const statement = db.prepare(sql);
          const normalized = sql.trimStart().toUpperCase();
          if (
            normalized.startsWith("SELECT") ||
            normalized.startsWith("PRAGMA") ||
            normalized.startsWith("WITH")
          ) {
            return statement.all(...(bindable(params) as never[]));
          }
          statement.run(...(bindable(params) as never[]));
          return [];
        },
        executeTransaction: async (task: () => Promise<unknown>) => {
          db.exec("BEGIN");
          try {
            const result = await task();
            db.exec("COMMIT");
            return result;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        },
      },
    } as unknown as typeof Zotero;
    await initAgentPlanStore();
    await initPlanDocumentStore();
    await savePlanExecutionLedger(execution());
  });

  afterEach(function () {
    db.close();
    globalScope.Zotero = originalZotero;
  });

  it("commits bounded evidence and completion together", async function () {
    const coordinator = new PlanExecutionCoordinator();
    const updated = await coordinator.requestTransitionWithEvidence({
      request: {
        executionId: "execution-1",
        taskId: "execution-1:task-1",
        toStatus: "completed",
        requestedBy: "original",
      },
      evidence: reasoningEvidence(),
      now: 2,
    });

    assert.equal(updated.tasks[0].status, "completed");
    assert.deepEqual(updated.tasks[0].evidenceIds, ["evidence-1"]);
    assert.equal(
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM llm_for_zotero_plan_task_evidence",
          )
          .get()?.count,
      ),
      1,
    );
  });

  it("advances sequential host-verified research tasks without model bookkeeping", async function () {
    await savePlanExecutionLedger(hostVerifiedResearchExecution());
    for (const evidence of hostVerifiedResearchEvidence()) {
      await saveTaskEvidence(evidence);
    }

    const updated = await new PlanExecutionCoordinator().advanceVerifiedTasks({
      executionId: "execution-1",
      requirementKinds: ["verified_read", "research_coverage"],
      now: 4,
    });

    assert.deepEqual(
      updated.tasks.map((task) => task.status),
      ["completed", "completed", "in_progress"],
    );
    assert.equal(updated.activeTaskId, "execution-1:task-3");
  });

  it("refreshes the runtime active task after a same-run transition", async function () {
    const first = reasoningTask();
    const second: ExecutionTask = {
      ...reasoningTask(),
      taskId: "execution-1:task-2",
      planStepId: "step-2",
      content: "Publish the document",
      activeForm: "Publishing the document",
      status: "pending",
      attemptCount: 0,
      startedAt: undefined,
    };
    await savePlanExecutionLedger({
      ...execution(),
      tasks: [first, second],
    });
    const coordinator = new PlanExecutionCoordinator();
    await coordinator.requestTransitionWithEvidence({
      request: {
        executionId: "execution-1",
        taskId: first.taskId,
        toStatus: "completed",
        requestedBy: "original",
      },
      evidence: reasoningEvidence(),
      now: 2,
    });
    await coordinator.startNextTask("execution-1", 3);
    const request = resolvedAgentRequest({
      conversationKey: 41,
      mode: "agent",
      userText: "Continue the plan",
      libraryID: 1,
      planContext: {
        phase: "executing",
        planId: "plan-1",
        revision: 1,
        executionId: "execution-1",
        approvedDigest: "sha256:plan",
        activeTaskId: first.taskId,
        provider: "original",
      },
    });
    const session = new PlanExecutionRunSession(request, async () => {});

    await session.recordToolResult({
      toolName: "task_update",
      executionClass: "control",
      result: {
        callId: "call-1",
        name: "task_update",
        ok: true,
        actionReceipts: [],
        content: { status: "completed" },
      },
      runId: "run-1",
    });

    assert.equal(
      request.planContext?.phase === "executing"
        ? request.planContext.activeTaskId
        : undefined,
      second.taskId,
    );
  });

  it("rolls back evidence and progress when the transition write fails", async function () {
    const coordinator = new PlanExecutionCoordinator();
    failTransitionInsert = true;
    let failure = "";
    try {
      await coordinator.requestTransitionWithEvidence({
        request: {
          executionId: "execution-1",
          taskId: "execution-1:task-1",
          toStatus: "completed",
          requestedBy: "original",
        },
        evidence: reasoningEvidence(),
        now: 2,
      });
    } catch (error) {
      failure = String(error);
    }

    assert.match(failure, /injected transition write failure/);
    assert.equal(
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM llm_for_zotero_plan_task_evidence",
          )
          .get()?.count,
      ),
      0,
    );
    const persisted = await loadPlanExecutionLedger("execution-1");
    assert.equal(persisted?.tasks[0].status, "in_progress");
    assert.deepEqual(persisted?.tasks[0].evidenceIds, []);
  });

  it("reattaches the durable non-terminal execution after in-memory state is gone", async function () {
    const resumable = { ...execution(), conversationKey: 9041 };
    await savePlanExecutionLedger(resumable);

    assert.deepInclude(await takePendingPlanExecution(9041), {
      phase: "executing",
      executionId: resumable.executionId,
      planId: resumable.planId,
      revision: resumable.revision,
    });

    await savePlanExecutionLedger({
      ...resumable,
      status: "completed",
      activeTaskId: undefined,
      completedAt: 3,
      updatedAt: 3,
      tasks: resumable.tasks.map((task) => ({
        ...task,
        status: "completed",
        completedAt: 3,
        updatedAt: 3,
      })),
    });
    assert.isUndefined(await takePendingPlanExecution(9041));
  });

  it("commits document delivery and terminal Plan progress together", async function () {
    db.exec("DELETE FROM llm_for_zotero_plan_execution_tasks");
    const staged = plannedDocument();
    const integrity = documentIntegrityEvidence();
    const ledger = documentExecution();
    ledger.tasks[0].evidenceIds = [integrity.evidenceId];
    await savePlanExecutionLedger(ledger);
    await saveTaskEvidence(integrity);
    await savePlanDocumentInTransaction(staged);

    await deliverPendingPlanDocumentMessage({
      conversationKey: 41,
      visibleMarkdown: staged.document.visibleMarkdown,
      messageTimestamp: 3,
      documentId: staged.document.documentId,
    });

    assert.equal(
      (await loadPlanDocumentOutbox(staged.document.documentId))?.status,
      "delivered",
    );
    assert.equal(
      (await loadPlanExecutionLedger("execution-1"))?.tasks[0].status,
      "completed",
    );

    // Simulate the legacy crash gap: the outbox is already delivered, but
    // the terminal transition was never persisted. A replay must reconcile it.
    const completed = await loadPlanExecutionLedger("execution-1");
    assert.exists(completed);
    const regressed: PlanExecutionLedger = {
      ...completed!,
      status: "running",
      activeTaskId: "execution-1:task-document",
      completedAt: undefined,
      tasks: completed!.tasks.map((task) => ({
        ...task,
        status: "in_progress",
        completedAt: undefined,
      })),
    };
    await savePlanExecutionLedger(regressed);
    await deliverPendingPlanDocumentMessage({
      conversationKey: 41,
      visibleMarkdown: staged.document.visibleMarkdown,
      messageTimestamp: 3,
      documentId: staged.document.documentId,
    });
    assert.equal(
      (await loadPlanExecutionLedger("execution-1"))?.tasks[0].status,
      "completed",
    );
  });

  it("rolls back document delivery when terminal progress cannot commit", async function () {
    db.exec("DELETE FROM llm_for_zotero_plan_execution_tasks");
    const staged = plannedDocument();
    await savePlanExecutionLedger(documentExecution());
    await savePlanDocumentInTransaction(staged);

    let failure = "";
    try {
      await deliverPendingPlanDocumentMessage({
        conversationKey: 41,
        visibleMarkdown: staged.document.visibleMarkdown,
        messageTimestamp: 3,
        documentId: staged.document.documentId,
      });
    } catch (error) {
      failure = String(error);
    }

    assert.match(failure, /document_integrity/);
    assert.equal(
      (await loadPlanDocumentOutbox(staged.document.documentId))?.status,
      "pending",
    );
    assert.equal(
      (await loadPlanExecutionLedger("execution-1"))?.tasks[0].status,
      "in_progress",
    );
    assert.equal(
      Number(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM llm_for_zotero_plan_task_evidence WHERE kind = 'document_published'",
          )
          .get()?.count,
      ),
      0,
    );
  });
});
