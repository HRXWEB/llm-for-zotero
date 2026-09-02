import { assert } from "chai";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  decodeActionContract,
  decodePlanContract,
} from "../src/agent/plans/contracts";
import { decodePlanDocument } from "../src/agent/documents/decoders";
import {
  decodePaperFinding,
  decodeResearchCorpusItem,
  decodeResearchJob,
} from "../src/agent/research/decoders";
import {
  decodePlanArtifact,
  decodeTaskEvidence,
} from "../src/agent/plans/decoders";
import { extractVerifiedReadSources } from "../src/agent/plans/readEvidence";
import {
  resolveResearchPolicy,
  shouldCheckpointResearchExpansion,
} from "../src/agent/research/policy";
import {
  scoreResearchEvaluation,
  type ResearchEvaluationCase,
} from "../src/agent/research/evaluation";
import {
  assertTaskCompletionEvidence,
  resolvePreResearchActionContract,
} from "../src/agent/plans/coordinator";
import type { AgentActionContract } from "../src/agent/contracts/types";
import { createSubmitPlanDocumentTool } from "../src/agent/tools/plan/submitPlanDocument";
import {
  createResearchUpdateTool,
  selectPreferredVerifiedReads,
} from "../src/agent/tools/plan/researchUpdate";
import { createUpdatePlanTool } from "../src/agent/tools/plan/updatePlan";
import { createTaskUpdateTool } from "../src/agent/tools/plan/taskUpdate";
import { buildPlanFinalCorrection } from "../src/agent/plans/runSession";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import type {
  ExecutionTask,
  TaskEvidence,
  TrustedReadObservation,
} from "../src/agent/plans/types";
import {
  OPERATION_CATALOG,
  operationAuthorityIsConsistent,
} from "../src/agent/contracts/operationCatalog";

const policy = resolveResearchPolicy("plan_research");

function investigation() {
  return {
    question: "Which papers report the effect?",
    subquestions: [{ id: "q1", question: "What effect was reported?" }],
    criteria: [
      { id: "c1", kind: "include", description: "Reports the effect" },
    ],
    scope: { libraryID: 1, kind: "items", itemKeys: ["AAAA1111"] },
    scopeSnapshot: {
      snapshotId: "plan:r1:scope",
      digest: "sha256:scope",
      itemCount: 1,
      createdAt: 1,
      policyVersion: policy.version,
    },
    requiredEvidenceDepth: "body",
    estimatedDeepReadPapers: 10,
    approvedLargeCorpus: false,
  };
}

describe("Plan Mode research architecture v3", function () {
  it("directs an unfinished document plan to the terminal document tool", function () {
    const correction = buildPlanFinalCorrection(
      "The document task is incomplete",
      true,
    );
    assert.include(correction, "Call submit_plan_document now");
    assert.include(correction, "do not try to complete");
    assert.include(correction, "host finalizer owns References");
    assert.notInclude(
      correction,
      "Continue the approved plan. Use task_update",
    );
  });

  it("advertises an exact document contract and bounded host inventory updates", function () {
    const updatePlan = createUpdatePlanTool();
    const contractSchema = (updatePlan.spec.inputSchema as any).properties
      .contract;
    assert.isFalse(contractSchema.additionalProperties);
    assert.deepEqual(
      contractSchema.properties.deliverable.properties.kind.enum,
      ["answer", "document", "completion_report"],
    );
    assert.deepEqual(
      contractSchema.properties.deliverable.properties.spec.properties.kind
        .enum,
      [
        "research_brief",
        "literature_review",
        "comparison",
        "report",
        "guide",
        "custom",
      ],
    );
    assert.equal(
      contractSchema.properties.investigation.properties.criteria.minItems,
      1,
    );

    const researchUpdate = createResearchUpdateTool({} as ZoteroGateway);
    assert.isTrue(researchUpdate.validate({ operation: "inventory_scope" }).ok);
    assert.isTrue(
      researchUpdate.validate({ operation: "list_verified_reads" }).ok,
    );
    assert.isTrue(
      researchUpdate.validate({ operation: "list_findings", limit: 20 }).ok,
    );
    assert.isFalse(
      researchUpdate.validate({ operation: "list_findings", limit: 26 }).ok,
    );
    assert.isTrue(
      researchUpdate.validate({
        operation: "record_papers",
        papers: Array.from({ length: 2 }, () => ({})),
      }).ok,
    );
    assert.isFalse(
      researchUpdate.validate({
        operation: "record_papers",
        papers: Array.from({ length: 26 }, () => ({})),
      }).ok,
    );
    assert.equal(
      (researchUpdate.spec.inputSchema as any).properties.papers.maxItems,
      25,
    );
    assert.include(
      researchUpdate.guidance?.instruction || "",
      "host inventories every frozen item",
    );
    assert.include(
      researchUpdate.guidance?.instruction || "",
      "exact approved criterion/subquestion IDs",
    );
    assert.include(
      researchUpdate.guidance?.instruction || "",
      "exact findingId",
    );
    assert.include(
      researchUpdate.guidance?.instruction || "",
      "copy findingId and evidenceRefs exactly",
    );
    assert.include(
      researchUpdate.guidance?.instruction || "",
      "durable normalized findings",
    );
    assert.include(
      researchUpdate.guidance?.instruction || "",
      "batch up to 25 papers",
    );
    const taskUpdate = createTaskUpdateTool();
    assert.include(
      taskUpdate.guidance?.instruction || "",
      "include reasoningAssertion",
    );
    assert.match(
      (taskUpdate.spec.inputSchema as any).properties.tasks.items.properties
        .reasoningAssertion.description,
      /required when completing a reasoning task/i,
    );
    const probeSchema = (researchUpdate.spec.inputSchema as any).properties
      .probes.items;
    assert.deepEqual(probeSchema.required, [
      "probeId",
      "kind",
      "query",
      "addedTargets",
    ]);
    assert.deepEqual(probeSchema.properties.kind.enum, [
      "synonym",
      "abbreviation",
      "translation",
      "semantic",
      "reformulation",
    ]);
  });

  it("decodes a composable research-to-document contract with exact policy", function () {
    const contract = decodePlanContract(
      {
        investigation: investigation(),
        deliverable: {
          kind: "document",
          spec: {
            kind: "literature_review",
            title: "Effect review",
            requiredSections: ["Findings", "Scope and limitations"],
            requiresReferences: true,
            requiresCoverageSection: true,
            allowFigures: false,
            citationStyle: {
              styleId: "http://www.zotero.org/styles/apa",
              styleTitle: "APA",
              locale: "en-US",
            },
          },
        },
        researchPolicy: policy,
      },
      { requireSnapshot: true },
    );
    assert.equal(contract.deliverable.kind, "document");
    assert.equal(contract.investigation?.scopeSnapshot?.itemCount, 1);
    assert.deepEqual(contract.researchPolicy, policy);
  });

  it("rejects empty, mismatched, or silently widened research scopes", function () {
    const contract = (scope: unknown) => ({
      investigation: { ...investigation(), scope },
      deliverable: { kind: "answer" },
      researchPolicy: policy,
    });
    assert.throws(
      () =>
        decodePlanContract(
          contract({ libraryID: 1, kind: "items", itemKeys: [] }),
        ),
      /requires itemKeys/,
    );
    assert.throws(
      () =>
        decodePlanContract(
          contract({
            libraryID: 1,
            kind: "library",
            itemKeys: ["AAAA1111"],
          }),
        ),
      /does not accept filters/,
    );
    assert.throws(
      () => decodePlanContract(contract({ libraryID: 1, kind: "mixed" })),
      /requires at least one filter/,
    );
    assert.doesNotThrow(() =>
      decodePlanContract(contract({ libraryID: 1, kind: "library" })),
    );
  });

  it("deep-decodes action authority and rejects inconsistent capability pairs", function () {
    const valid = {
      version: 2,
      id: "contract-1",
      writeDisposition: "required",
      interpretationSource: "deterministic_fallback",
      obligations: [
        {
          id: "o1",
          capability: "zotero.tags",
          operation: "apply_tags",
          proofDomain: "zotero_state",
          coverage: "all",
          targetKind: "papers",
          parameters: { tags: ["reviewed"] },
          targetBoundary: {
            kind: "selection",
            libraryID: 1,
            frozenTargetIds: [10],
            scopeDigest: "sha256:targets",
          },
        },
      ],
    };
    assert.equal(decodeActionContract(valid).obligations[0].id, "o1");
    assert.throws(
      () =>
        decodeActionContract({
          ...valid,
          obligations: [
            { ...valid.obligations[0], capability: "zotero.notes" },
          ],
        }),
      /authority is inconsistent/,
    );
    assert.throws(
      () =>
        decodeActionContract({
          ...valid,
          obligations: [{ ...valid.obligations[0], proofDomain: "execution" }],
        }),
      /authority is inconsistent/,
    );
  });

  it("defines one exhaustive capability and proof domain for every operation", function () {
    for (const [operation, authority] of Object.entries(OPERATION_CATALOG)) {
      assert.isTrue(
        operationAuthorityIsConsistent({
          operation,
          capability: authority.capability,
          proofDomain: authority.proofDomain,
        }),
        operation,
      );
      assert.isFalse(
        operationAuthorityIsConsistent({
          operation,
          capability: authority.capability,
          proofDomain:
            authority.proofDomain === "execution"
              ? "zotero_state"
              : "execution",
        }),
        operation,
      );
    }
  });

  it("never lets an inferred contract pre-authorize research-selected targets", function () {
    const inferred: AgentActionContract = {
      version: 2,
      id: "inferred-before-research",
      writeDisposition: "required",
      interpretationSource: "classifier",
      obligations: [],
    };
    const contract = decodePlanContract(
      {
        investigation: investigation(),
        deliverable: { kind: "completion_report" },
        effects: {
          libraryMutation: {
            approval: "after_research",
            intent: {
              summary: "Tag the papers selected by the research criteria",
              targetSelectionDescription: "Included papers",
              intents: [
                {
                  capability: "zotero.tags",
                  operation: "apply_tags",
                  proofDomain: "zotero_state",
                  coverage: "all",
                  targetKind: "papers",
                  parameters: { tags: ["reviewed"] },
                },
              ],
            },
          },
        },
        researchPolicy: policy,
      },
      { requireSnapshot: true },
    );
    assert.isUndefined(resolvePreResearchActionContract(contract, inferred));
  });

  it("rejects malformed normalized research records", function () {
    assert.throws(
      () =>
        decodeResearchCorpusItem({
          version: 1,
          researchJobId: "r",
          executionId: "e",
          parentTaskId: "t",
          libraryID: 1,
          itemKey: "AAAA1111",
          ordinal: 0,
          screeningStatus: "included",
          criterionResults: { c1: "maybe" },
          inventoryRecorded: true,
          hasAbstract: true,
          attachmentItemKeys: [],
          duplicateAttachmentKeys: [],
          readable: true,
          indexed: true,
          updatedAt: 1,
        }),
      /criterion result/i,
    );
    assert.throws(
      () =>
        decodePaperFinding({
          version: 1,
          findingId: "f",
          researchJobId: "r",
          executionId: "e",
          parentTaskId: "t",
          libraryID: 1,
          itemKey: "AAAA1111",
          subquestionIds: [],
          criterionIds: [],
          findings: [],
          contradictions: [],
          negativeEvidence: [],
          limitations: [],
          evidenceRefs: [],
          sourceFingerprint: "sha256:x",
          inclusionDecision: "maybe",
          confidence: "absolute",
          unresolvedQuestions: [],
          createdAt: 1,
        }),
      /inclusion decision/,
    );
  });

  it("projects stable item and trusted PDF locator identity from read results", function () {
    const priorZotero = (globalThis as { Zotero?: unknown }).Zotero;
    (globalThis as { Zotero?: unknown }).Zotero = {
      Items: {
        get: (itemId: number) =>
          itemId === 10
            ? { id: 10, libraryID: 1, key: "AAAA1111" }
            : itemId === 20
              ? {
                  id: 20,
                  libraryID: 1,
                  key: "PDFP2222",
                  parentID: 10,
                }
              : false,
      },
    };
    try {
      const sources = extractVerifiedReadSources({
        papers: [
          {
            paperContext: { itemId: 10, contextItemId: 20 },
            passages: [
              {
                pageIndex: 4,
                sourceFingerprint: "pdfjs:document-1",
              },
            ],
          },
        ],
      });
      assert.deepInclude(sources, {
        libraryID: 1,
        itemKey: "AAAA1111",
        attachmentItemKey: "PDFP2222",
        pageIndex: 4,
        sourceFingerprint: "pdfjs:document-1",
      });
      assert.throws(
        () =>
          decodeTaskEvidence({
            version: 2,
            evidenceId: "e",
            executionId: "x",
            taskId: "t",
            kind: "verified_read",
            verified: true,
            requirementId: "r",
            contractDigest: "d",
            payload: {
              type: "verified_read",
              reference: "read",
              sources: [{ libraryID: -1, itemKey: "AAAA1111" }],
            },
            createdAt: 1,
          }),
        /libraryID/,
      );
    } finally {
      (globalThis as { Zotero?: unknown }).Zotero = priorZotero;
    }
  });

  it("keeps an earlier body receipt visible when a later metadata read covers the same paper", function () {
    const evidence = (
      reference: string,
      createdAt: number,
      observations: TrustedReadObservation[],
    ): TaskEvidence => ({
      version: 3,
      evidenceId: reference,
      executionId: "execution",
      taskId: "task",
      kind: "verified_read",
      verified: true,
      reference,
      payload: { type: "verified_read", reference, observations },
      createdAt,
    });
    const observation = (
      observationId: string,
      capabilities: TrustedReadObservation["capabilities"],
      extra: Partial<TrustedReadObservation> = {},
    ): TrustedReadObservation => ({
      version: 1,
      observationId,
      issuer: "zotero_host",
      toolName: "paper_read",
      callDigest: `sha256:${observationId}:call`,
      inputDigest: `sha256:${observationId}:input`,
      resultDigest: `sha256:${observationId}:result`,
      libraryID: 1,
      itemKey: "AAAA1111",
      capabilities,
      certificateDigest: `sha256:${observationId}:certificate`,
      ...extra,
    });
    const selected = selectPreferredVerifiedReads(
      [
        evidence("body-read", 1, [
          observation("body-observation", ["body"], {
            attachmentItemKey: "PDFP2222",
            pageIndex: 4,
            sourceFingerprint: "pdfjs:document-1",
          }),
        ]),
        evidence("later-metadata-read", 2, [
          observation("metadata-observation", ["metadata"]),
        ]),
      ],
      new Set(["1:AAAA1111"]),
    );
    assert.equal(selected.get("1:AAAA1111")?.sourceReadRef, "body-read");
    assert.equal(selected.get("1:AAAA1111")?.evidenceDepth, "body");
    assert.equal(selected.get("1:AAAA1111")?.sources[0].pageIndex, 4);
  });

  it("requires the material research-expansion checkpoint at both policy boundaries", function () {
    assert.isTrue(
      shouldCheckpointResearchExpansion({
        approvedEstimate: 10,
        actualDeepReadCandidates: 31,
        approvedLargeCorpus: false,
        policy,
      }),
    );
    assert.isTrue(
      shouldCheckpointResearchExpansion({
        approvedEstimate: 80,
        actualDeepReadCandidates: 101,
        approvedLargeCorpus: false,
        policy,
      }),
    );
    assert.isFalse(
      shouldCheckpointResearchExpansion({
        approvedEstimate: 10,
        actualDeepReadCandidates: 29,
        approvedLargeCorpus: false,
        policy,
      }),
    );
  });

  it("requires every bound mutation obligation receipt", function () {
    const task: ExecutionTask = {
      version: 2,
      taskId: "t",
      executionId: "e",
      planStepId: "s",
      kind: "required_step",
      content: "Apply changes",
      activeForm: "Applying changes",
      acceptanceCriteria: [
        {
          criterionId: "c1",
          description: "Every target is verified",
          verifier: "mutation_receipts",
        },
      ],
      expectedEffect: "mutation",
      completionRequirements: [
        {
          requirementId: "r",
          kind: "mutation_receipts",
          criterionIds: ["c1"],
          contractDigest: "d",
        },
      ],
      obligationIds: ["o1", "o2"],
      status: "in_progress",
      attemptCount: 1,
      evidenceIds: [],
      failureReasons: [],
      createdAt: 1,
      updatedAt: 1,
    };
    const evidence = (obligationId: string): TaskEvidence => ({
      version: 3,
      evidenceId: `e-${obligationId}`,
      executionId: "e",
      taskId: "t",
      kind: "mutation_receipt",
      verified: true,
      requirementId: "r",
      criterionIds: ["c1"],
      contractDigest: "d",
      receipt: {
        version: 2,
        id: `receipt-${obligationId}`,
        obligationId,
        proposalId: `p-${obligationId}`,
        proofDomain: "zotero_state",
        capability: "zotero.tags",
        operation: "apply_tags",
        verification: "verified",
        status: "applied",
        requestedTargets: ["1"],
        appliedTargets: ["1"],
        alreadySatisfiedTargets: [],
        rejectedTargets: [],
        reasons: [],
        verifiedFacts: ["verified"],
      },
      payload: {
        type: "mutation_receipts",
        receiptIds: [`receipt-${obligationId}`],
      },
      createdAt: 1,
    });
    assert.throws(() => assertTaskCompletionEvidence(task, [evidence("o1")]));
    assert.doesNotThrow(() =>
      assertTaskCompletionEvidence(task, [evidence("o1"), evidence("o2")]),
    );
    assert.throws(
      () =>
        decodeTaskEvidence({
          ...evidence("o1"),
          receipt: {
            ...evidence("o1").receipt,
            capability: "zotero.notes",
          },
        }),
      /authority is inconsistent/,
    );
  });

  it("requires terminal research coverage from the same task and contract", function () {
    const task: ExecutionTask = {
      version: 2,
      taskId: "research-task",
      executionId: "execution",
      planStepId: "research-step",
      kind: "required_step",
      content: "Research",
      activeForm: "Researching",
      acceptanceCriteria: [
        {
          criterionId: "coverage",
          description: "Cover the approved corpus",
          verifier: "research_coverage",
        },
      ],
      expectedEffect: "read",
      completionRequirements: [
        {
          requirementId: "coverage-requirement",
          kind: "research_coverage",
          criterionIds: ["coverage"],
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
    };
    const evidence = (
      coverageStatus: "complete" | "complete_with_limitations" | "partial",
      overrides: Partial<TaskEvidence> = {},
    ): TaskEvidence => ({
      version: 3,
      evidenceId: `coverage-${coverageStatus}`,
      executionId: "execution",
      taskId: "research-task",
      kind: "research_coverage",
      verified: true,
      requirementId: "coverage-requirement",
      criterionIds: ["coverage"],
      contractDigest: "sha256:contract",
      payload: {
        type: "research_coverage",
        researchJobId: "research",
        coverageStatus,
        totalItems: 10,
        screenedItems: coverageStatus === "partial" ? 5 : 10,
        candidateItems: 4,
        deepReadCompleted: coverageStatus === "partial" ? 2 : 4,
      },
      createdAt: 1,
      ...overrides,
    });

    assert.throws(() =>
      assertTaskCompletionEvidence(task, [evidence("partial")]),
    );
    assert.throws(() =>
      assertTaskCompletionEvidence(task, [
        evidence("complete", { taskId: "another-task" }),
      ]),
    );
    assert.doesNotThrow(() =>
      assertTaskCompletionEvidence(task, [evidence("complete")]),
    );
    assert.doesNotThrow(() =>
      assertTaskCompletionEvidence(task, [
        evidence("complete_with_limitations"),
      ]),
    );
  });

  it("deep-decodes persisted skill routing receipts", function () {
    const artifact = {
      version: 1,
      planId: "plan-1",
      conversationKey: 1,
      provider: "original",
      revision: 1,
      digest: "sha256:plan",
      status: "drafting",
      skillRoutingReceipt: {
        routerSchemaVersion: 1,
        skillManifestHash: "sha256:manifest",
        skills: [
          {
            id: "literature-review",
            version: 1,
            instructionHash: "sha256:skill",
            source: "automatic",
          },
        ],
      },
      steps: [
        {
          planStepId: "step-1",
          content: "Review the evidence",
          activeForm: "Reviewing the evidence",
          acceptanceCriteria: ["Evidence reviewed"],
          expectedEffect: "read",
        },
      ],
      createdAt: 1,
      updatedAt: 1,
    };
    assert.equal(
      decodePlanArtifact(artifact).skillRoutingReceipt?.skills[0].source,
      "automatic",
    );
    assert.throws(
      () =>
        decodePlanArtifact({
          ...artifact,
          skillRoutingReceipt: {
            ...artifact.skillRoutingReceipt,
            skills: [
              { ...artifact.skillRoutingReceipt.skills[0], source: "invented" },
            ],
          },
        }),
      /source is invalid/,
    );
  });

  it("rejects deeply invalid persisted documents and research jobs", function () {
    assert.throws(() => decodePlanDocument({ version: 1 }), /required|arrays/i);
    assert.throws(
      () =>
        decodeResearchJob({
          version: 1,
          researchJobId: "r",
          executionId: "e",
          parentTaskId: "t",
          contractDigest: "d",
          snapshotId: "s",
          policy,
          status: "running",
          activeStage: "made_up",
          totalItems: 1,
          screenedItems: 0,
          candidateItems: 0,
          deepReadCompleted: 0,
          deepReadPlanned: 1,
          createdAt: 1,
          updatedAt: 1,
        }),
      /research stage/,
    );
  });

  it("keeps quote verification host-owned and deeply decodes certificates", function () {
    const tool = createSubmitPlanDocumentTool({} as ZoteroGateway);
    const required = tool.spec.inputSchema.required as string[];
    assert.include(required, "quotes");
    assert.notInclude(required, "quoteVerified");
    const document = {
      version: 1,
      documentId: "document-1",
      documentVersion: 1,
      planId: "plan-1",
      planRevision: 1,
      executionId: "execution-1",
      conversationKey: 1,
      parentTaskId: "task-1",
      contractDigest: "sha256:contract",
      title: "Review",
      visibleMarkdown: "> Verified wording",
      visibleHtml: "<blockquote>Verified wording</blockquote>",
      citationBundle: {
        clusters: [],
        bibliographyEntries: [],
        style: { id: "apa", title: "APA" },
        locale: "en-US",
      },
      verifiedQuotes: [
        {
          quoteId: "Q1",
          text: "Verified wording",
          libraryID: 1,
          itemKey: "AAAA1111",
          attachmentItemKey: "PDFP2222",
          evidenceRefs: ["evidence-1"],
          certificate: {
            contextItemId: 20,
            sourceFingerprint: "pdfjs:fingerprint",
            pageIndex: 4,
            sourceMatchText: "Verified wording",
            sourceMatchKind: "exact",
            sourceMatchPageOccurrence: 0,
          },
        },
      ],
      assets: [],
      coverageItems: [],
      validation: {
        integrityValidated: true,
        groundingReviewed: "passed",
        quoteVerified: "verified",
        issues: [],
      },
      contentHash: "sha256:document",
      createdAt: 1,
    };
    assert.equal(
      decodePlanDocument(document).verifiedQuotes[0].certificate.pageIndex,
      4,
    );
    assert.throws(
      () =>
        decodePlanDocument({
          ...document,
          verifiedQuotes: [
            {
              ...document.verifiedQuotes[0],
              certificate: {
                ...document.verifiedQuotes[0].certificate,
                pageIndex: -1,
              },
            },
          ],
        }),
      /pageIndex/,
    );
  });

  it("meets the fixed offline corpus release gates", function () {
    const fixturePath = fileURLToPath(
      new URL("./fixtures/planResearchEvaluationCorpus.json", import.meta.url),
    );
    const corpus = JSON.parse(
      readFileSync(fixturePath, "utf8"),
    ) as ResearchEvaluationCase[];
    const score = scoreResearchEvaluation(corpus);
    assert.equal(score.inventoryAccounting, 1);
    assert.isAtLeast(score.relevantPaperRecall, 0.95);
    assert.isAtMost(score.falseExclusionRate, 0.01);
    assert.equal(score.sourceRetention, 1);
    assert.equal(score.unauthorizedMutationCount, 0);
    assert.isTrue(score.passesInitialReleaseGate);
  });
});
