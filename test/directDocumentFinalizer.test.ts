import { assert } from "chai";
import { DirectDocumentFinalizer } from "../src/agent/documents/finalizer";
import type {
  DocumentOutcomePolicy,
  PlanCitationCluster,
} from "../src/agent/documents/types";
import type { TrustedReadObservation } from "../src/agent/plans/types";
import type { ZoteroGateway } from "../src/agent/services/zoteroGateway";
import type { AgentRuntimeRequest } from "../src/agent/types";

const observation: TrustedReadObservation = {
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
};

const groundedCitation: PlanCitationCluster = {
  citationId: "C1",
  sources: [
    {
      libraryID: 1,
      itemKey: "AAAA1111",
      evidenceRefs: [observation.observationId],
    },
  ],
};

function request(
  policy: DocumentOutcomePolicy,
  observations: readonly TrustedReadObservation[] = [],
): AgentRuntimeRequest {
  return {
    conversationKey: 42,
    mode: "agent",
    userText: "Write the requested document",
    documentOutcomePolicy: policy,
    documentReadObservations: observations,
    turnPaperScope: {} as AgentRuntimeRequest["turnPaperScope"],
    zoteroMetadataContext: {} as AgentRuntimeRequest["zoteroMetadataContext"],
    metadata: { sourceMessageTimestamp: 100 },
    skillRoutingReceipt: {
      routerSchemaVersion: 1,
      routerIdentityHash: "sha256:router",
      skillManifestHash: "sha256:manifest",
      skills: [
        {
          id: "literature-review",
          source: "automatic",
          requestedScope: "library-corpus",
          version: 1,
          instructionHash: "sha256:instruction",
        },
      ],
    },
  };
}

function input(params?: {
  markdown?: string;
  citations?: readonly PlanCitationCluster[];
}) {
  return {
    title: "Representational drift",
    markdown:
      params?.markdown ?? "# Representational drift\n\nA complete guide.",
    citations: params?.citations ?? [],
    quotes: [],
    assets: [],
    groundingReviewed: "passed" as const,
    groundingIssues: [],
  };
}

async function expectRejected(
  promise: Promise<unknown>,
  message: RegExp,
): Promise<void> {
  try {
    await promise;
    assert.fail("expected the document finalizer to reject");
  } catch (error) {
    assert.match(String(error), message);
  }
}

describe("DirectDocumentFinalizer", function () {
  let originalZotero: unknown;
  let finalizer: DirectDocumentFinalizer;
  const queries: Array<{ sql: string; params: unknown[] }> = [];

  before(function () {
    originalZotero = (globalThis as typeof globalThis & { Zotero?: unknown })
      .Zotero;
  });

  beforeEach(function () {
    queries.length = 0;
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero = {
      DB: {
        queryAsync: async (sql: string, params?: unknown[]) => {
          queries.push({ sql, params: params || [] });
          return [];
        },
        executeTransaction: async (callback: () => Promise<unknown>) =>
          callback(),
      },
      Items: {
        getByLibraryAndKey: (libraryID: number, itemKey: string) =>
          libraryID === 1 && itemKey === "AAAA1111"
            ? {
                id: 101,
                isNote: () => false,
                getField: (field: string) =>
                  field === "title" ? "Verified paper" : "",
              }
            : false,
      },
      Libraries: {
        userLibraryID: 1,
        get: () => undefined,
      },
    } as unknown as typeof Zotero;
    const gateway = {
      formatStructuredCitations: (params: {
        clusters: Array<{ citationId: string }>;
        styleId?: string;
        locale?: string;
      }) => ({
        styleId: params.styleId || "apa",
        styleTitle: "APA",
        locale: params.locale || "en-US",
        clusters: params.clusters.map((cluster) => ({
          citationId: cluster.citationId,
          text: "(Author, 2024)",
          html: "(Author, 2024)",
        })),
        bibliographyEntries: [
          {
            itemId: 101,
            text: "Author. (2024). Verified paper.",
            html: "Author. (2024). Verified paper.",
          },
        ],
      }),
    } as unknown as ZoteroGateway;
    finalizer = new DirectDocumentFinalizer(gateway);
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: unknown }).Zotero =
      originalZotero;
  });

  it("rejects literature reviews without verified research evidence", async function () {
    const policy: DocumentOutcomePolicy = {
      required: true,
      documentKind: "literature_review",
      integrityPolicy: "research_grounded",
      trigger: "document_intent",
    };
    await expectRejected(
      finalizer.finalize({
        request: request(policy),
        runId: "run-no-evidence",
        input: input(),
      }),
      /host-verified abstract or body evidence/,
    );
  });

  it("rejects missing coverage disclosure and missing references", async function () {
    const policy: DocumentOutcomePolicy = {
      required: true,
      documentKind: "literature_review",
      integrityPolicy: "research_grounded",
      trigger: "literature_review_skill",
    };
    await expectRejected(
      finalizer.finalize({
        request: request(policy, [observation]),
        runId: "run-no-references",
        input: input(),
      }),
      /requires grounded citations/,
    );
    await expectRejected(
      finalizer.finalize({
        request: request(policy, [observation]),
        runId: "run-no-coverage",
        input: input({ citations: [groundedCitation] }),
      }),
      /missing required sections: scope and limitations/,
    );
  });

  it("rejects fabricated citation evidence references", async function () {
    const policy: DocumentOutcomePolicy = {
      required: true,
      documentKind: "literature_review",
      integrityPolicy: "research_grounded",
      trigger: "document_intent",
    };
    const fabricated: PlanCitationCluster = {
      citationId: "C1",
      sources: [
        {
          libraryID: 1,
          itemKey: "AAAA1111",
          evidenceRefs: ["made-up-evidence"],
        },
      ],
    };
    await expectRejected(
      finalizer.finalize({
        request: request(policy, [observation]),
        runId: "run-fabricated",
        input: input({
          markdown:
            "# Review\n\nEvidence [[cite:C1]].\n\n## Scope and limitations\n\nOne verified paper was reviewed.",
          citations: [fabricated],
        }),
      }),
      /invalid evidence reference/,
    );
  });

  it("rejects document assets that were not emitted by a host tool", async function () {
    const policy: DocumentOutcomePolicy = {
      required: true,
      documentKind: "guide",
      integrityPolicy: "authored",
      trigger: "document_intent",
    };
    await expectRejected(
      finalizer.finalize({
        request: request(policy),
        runId: "run-invented-asset",
        input: {
          ...input(),
          assets: [
            {
              assetId: "invented",
              contentHash: `sha256:${"a".repeat(64)}`,
              mimeType: "image/png",
              byteLength: 10,
              width: 10,
              height: 10,
              caption: "Invented path",
              durablePath: "/tmp/invented.png",
              provenance: {
                origin: "generated",
                generator: "model",
                generatorVersion: "1",
                evidenceRefs: [],
              },
            },
          ],
        },
      }),
      /not emitted by a successful host tool call/,
    );
  });

  it("persists a validated research-grounded document with generated references", async function () {
    const policy: DocumentOutcomePolicy = {
      required: true,
      documentKind: "literature_review",
      integrityPolicy: "research_grounded",
      trigger: "literature_review_skill",
    };
    const result = await finalizer.finalize({
      request: request(policy, [observation]),
      runId: "run-grounded",
      input: input({
        markdown:
          "# Review\n\nEvidence [[cite:C1]].\n\n## Scope and limitations\n\nOne verified paper was reviewed.",
        citations: [groundedCitation],
      }),
      now: 200,
    });

    assert.equal(result.document.version, 2);
    assert.deepInclude(result.document.origin, {
      kind: "direct",
      runId: "run-grounded",
      sourceMessageTimestamp: 100,
    });
    assert.deepInclude(
      result.document.version === 2 && result.document.origin.kind === "direct"
        ? result.document.origin.routingReceipt
        : {},
      { routerIdentityHash: "sha256:router" },
    );
    assert.include(result.document.visibleMarkdown, "## References");
    assert.lengthOf(result.document.coverageItems, 1);
    assert.isTrue(
      queries.some((entry) =>
        entry.sql.includes("INSERT INTO llm_for_zotero_plan_documents"),
      ),
    );
  });

  it("accepts authored documents with or without optional citations", async function () {
    const policy: DocumentOutcomePolicy = {
      required: true,
      documentKind: "guide",
      integrityPolicy: "authored",
      trigger: "document_intent",
    };
    const uncited = await finalizer.finalize({
      request: request(policy),
      runId: "run-authored-plain",
      input: input(),
      now: 300,
    });
    assert.equal(uncited.document.validation.groundingReviewed, "not_run");

    const cited = await finalizer.finalize({
      request: request(policy),
      runId: "run-authored-cited",
      input: input({
        markdown: "# Guide\n\nOptional context [[cite:C1]].",
        citations: [
          {
            citationId: "C1",
            sources: [{ libraryID: 1, itemKey: "AAAA1111", evidenceRefs: [] }],
          },
        ],
      }),
      now: 301,
    });
    assert.include(cited.document.visibleMarkdown, "## References");
  });
});
