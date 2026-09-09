import { assert } from "chai";
import { DatabaseSync } from "node:sqlite";
import {
  assertTaskCompletionEvidence,
  PlanExecutionCoordinator,
} from "../src/agent/plans/coordinator";
import { initAgentPlanStore, loadPlanExecutionLedger } from "../src/agent/plans/store";
import type { ExecutionTask, TaskEvidence } from "../src/agent/plans/types";
import {
  initResearchStore,
  loadResearchJobForExecution,
} from "../src/agent/research/store";
import { resolvePlanContract } from "../src/agent/tools/plan/updatePlan";

function installSqliteZotero() {
  const db = new DatabaseSync(":memory:");
  const bindable = (params: unknown[] | undefined) =>
    (params || []).map((value) => (value === undefined ? null : value));
  const items = new Map([
    [
      1,
      {
        id: 1,
        key: "AAAA1111",
        libraryID: 1,
        version: 1,
        getField: () => "",
        getCreators: () => [],
      },
    ],
    [
      2,
      {
        id: 2,
        key: "BBBB2222",
        libraryID: 1,
        version: 1,
        getField: () => "",
        getCreators: () => [],
      },
    ],
  ]);
  globalThis.Zotero = {
    DB: {
      queryAsync: async (sql: string, params?: unknown[]) => {
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
    Items: {
      getByLibraryAndKey: (libraryID: number, itemKey: string) =>
        [...items.values()].find(
          (item) => item.libraryID === libraryID && item.key === itemKey,
        ) || false,
    },
  } as never;
  const gateway = {
    resolveLibraryScopeItemIds: async () => ({ itemIds: [1, 2] }),
    getBibliographicItemTargetsByItemIds: (ids: number[]) =>
      ids.map((id) => ({
        itemId: id,
        title: `Paper ${id}`,
        firstCreator: "Author",
        year: "2026",
        tags: [],
        attachments: [],
      })),
    getItem: (id: number) => items.get(id) || null,
  } as never;
  return { db, gateway };
}

const steps = [
  {
    planStepId: "review:r1:read",
    content: "Read every paper in the collection",
    activeForm: "Reading every paper in the collection",
    acceptanceCriteria: [
      {
        criterionId: "read",
        description: "Every paper is read at body depth",
        verifier: "verified_read" as const,
      },
    ],
    expectedEffect: "read" as const,
  },
  {
    planStepId: "review:r1:synthesize",
    content: "Discover cross-paper relationships",
    activeForm: "Discovering cross-paper relationships",
    acceptanceCriteria: [
      {
        criterionId: "coverage",
        description: "Research coverage is terminal",
        verifier: "research_coverage" as const,
      },
    ],
    expectedEffect: "reasoning" as const,
  },
  {
    planStepId: "review:r1:answer",
    content: "Write the answer",
    activeForm: "Writing the answer",
    acceptanceCriteria: [
      {
        criterionId: "answer",
        description: "The answer is complete",
        verifier: "bounded_reasoning" as const,
      },
    ],
    expectedEffect: "reasoning" as const,
  },
];

async function approveResearchPlan(gateway: unknown) {
  const contract = await resolvePlanContract({
    raw: {
      version: 1,
      deliverable: { kind: "answer" },
      investigation: {
        question: "Which papers report the effect?",
        subquestions: [{ id: "q1", question: "What was reported?" }],
        criteria: [],
        reviewMode: "narrative",
        readingStrategy: "adaptive",
        scope: { libraryID: 1, kind: "collections", collectionIds: [11] },
        requiredEvidenceDepth: "body",
        estimatedDeepReadPapers: 0,
        approvedLargeCorpus: false,
      },
    },
    steps,
    ready: true,
    gateway: gateway as never,
    planId: "review",
    revision: 1,
    conversationKey: 9,
  });
  const coordinator = new PlanExecutionCoordinator();
  await coordinator.updateDraft({
    planId: "review",
    conversationKey: 9,
    provider: "original",
    revision: 1,
    steps,
    contract,
    ready: true,
    now: 1,
  });
  const ledger = await coordinator.approve({
    planId: "review",
    revision: 1,
    conversationGeneration: 1,
    now: 2,
  });
  return { coordinator, ledger };
}

function readingTask(ledger: { tasks: readonly ExecutionTask[] }) {
  return ledger.tasks.find((task) => task.planStepId === "review:r1:read")!;
}

function perReadEvidence(task: ExecutionTask, callId: string): TaskEvidence {
  const requirement = task.completionRequirements!.find(
    (entry) => entry.kind === "verified_read",
  )!;
  return {
    version: 3,
    evidenceId: `${task.executionId}:${task.taskId}:verified_read:${callId}`,
    executionId: task.executionId,
    taskId: task.taskId,
    kind: "verified_read",
    verified: true,
    requirementId: requirement.requirementId,
    criterionIds: requirement.criterionIds,
    contractDigest: requirement.contractDigest,
    payload: {
      type: "verified_read",
      reference: callId,
      observations: [
        {
          version: 1,
          issuer: "zotero_host",
          observationId: `${callId}:obs`,
          toolName: "paper_read",
          callDigest: `sha256:${callId}:call`,
          inputDigest: `sha256:${callId}:input`,
          resultDigest: `sha256:${callId}:result`,
          libraryID: 1,
          itemKey: "AAAA1111",
          capabilities: ["body"],
          certificateDigest: `sha256:${callId}:certificate`,
        },
      ],
    },
    reference: callId,
    summary: "Verified paper_read result",
    createdAt: 3,
  };
}

describe("research reading task ownership", function () {
  const originalZotero = globalThis.Zotero;
  afterEach(function () {
    globalThis.Zotero = originalZotero;
  });

  it("binds the reading step's verified_read requirement to the research scope at approval", async function () {
    const harness = installSqliteZotero();
    try {
      await initAgentPlanStore();
      await initResearchStore();
      const { ledger } = await approveResearchPlan(harness.gateway);
      const job = await loadResearchJobForExecution(ledger.executionId);
      const requirement = readingTask(ledger).completionRequirements!.find(
        (entry) => entry.kind === "verified_read",
      );
      assert.exists(job?.scopeLineageDigest);
      assert.equal(
        requirement?.targetBoundary?.scopeDigest,
        job!.scopeLineageDigest,
      );
    } finally {
      harness.db.close();
    }
  });

  it("keeps the reading task active after a verified paper_read until the host reports every manifest paper durable", async function () {
    const harness = installSqliteZotero();
    try {
      await initAgentPlanStore();
      await initResearchStore();
      const { coordinator, ledger } = await approveResearchPlan(
        harness.gateway,
      );
      const started = await coordinator.startNextTask(ledger.executionId, 3);
      const task = readingTask(started);
      assert.equal(task.status, "in_progress");

      // The exact path PlanExecutionRunSession takes after each paper_read.
      await coordinator.attachEvidence(perReadEvidence(task, "read-1"));
      const afterRead = await coordinator.advanceVerifiedTasks({
        executionId: ledger.executionId,
        requirementKinds: ["verified_read", "material_integrity", "mutation_receipts"],
        now: 4,
      });
      assert.equal(readingTask(afterRead).status, "in_progress");
      assert.equal(afterRead.activeTaskId, task.taskId);

      const job = await loadResearchJobForExecution(ledger.executionId);
      const completed = await coordinator.completeResearchReading({
        executionId: ledger.executionId,
        researchJobId: job!.researchJobId,
        scopeLineageDigest: job!.scopeLineageDigest!,
        durablePapers: 2,
        totalPapers: 2,
        now: 5,
      });
      assert.equal(readingTask(completed).status, "completed");
      assert.equal(
        completed.tasks.find((entry) => entry.planStepId === "review:r1:synthesize")
          ?.status,
        "in_progress",
      );
      assert.equal(
        (await loadPlanExecutionLedger(ledger.executionId))?.activeTaskId,
        completed.activeTaskId,
      );
    } finally {
      harness.db.close();
    }
  });

  it("rejects reading completion reported for a superseded scope", function () {
    const task: ExecutionTask = {
      version: 2,
      taskId: "execution:read",
      executionId: "execution",
      planStepId: "read",
      kind: "required_step",
      content: "Read every paper",
      activeForm: "Reading every paper",
      acceptanceCriteria: [],
      expectedEffect: "read",
      completionRequirements: [
        {
          requirementId: "read:requirement:verified_read",
          kind: "verified_read",
          criterionIds: [],
          contractDigest: "sha256:contract",
          targetBoundary: { scopeDigest: "sha256:scope-2" },
        },
      ],
      obligationIds: [],
      status: "in_progress",
      attemptCount: 1,
      evidenceIds: [],
      failureReasons: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const completion = (scopeLineageDigest: string): TaskEvidence => ({
      version: 3,
      evidenceId: `reading:${scopeLineageDigest}`,
      executionId: "execution",
      taskId: "execution:read",
      kind: "verified_read",
      verified: true,
      requirementId: "read:requirement:verified_read",
      criterionIds: [],
      contractDigest: "sha256:contract",
      payload: {
        type: "research_reading",
        researchJobId: "research",
        scopeLineageDigest,
        durablePapers: 12,
        totalPapers: 12,
      },
      createdAt: 2,
    });
    assert.throws(() =>
      assertTaskCompletionEvidence(task, [completion("sha256:scope-1")]),
    );
    assert.doesNotThrow(() =>
      assertTaskCompletionEvidence(task, [completion("sha256:scope-2")]),
    );
  });
});
