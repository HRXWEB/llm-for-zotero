import { decodeActionContract } from "../src/agent/plans/contracts";
import { assert } from "chai";
import { ActionContractService } from "../src/agent/contracts/actionContract";
import { actionFixture } from "./helpers/semanticIntent";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

function setup(resolve: (input: any) => Promise<any>) {
  const items = [17, 18, 99].map((id) => ({
    id,
    libraryID: 1,
    isRegularItem: () => true,
    getField: (field: string) =>
      field === "title" ? `Paper ${id}` : "Evidence",
  }));
  const gateway = {
    listCollectionSummaries: () => [
      { libraryID: 1, collectionId: 7, name: "Source", path: "Source" },
    ],
    listCurrentCollectionTargetIds: () => [17, 18],
    listCurrentLibraryTargetIds: () => [17, 18, 99],
    getItem: (id: number) => items.find((item) => item.id === id),
  };
  const intent = actionFixture("apply_tags", { tags: ["reviewed"] });
  intent.actionIntents[0] = {
    ...intent.actionIntents[0],
    coverage: "all",
    discovery: {
      description: "papers studying drift",
      source: "collection",
      collectionPath: "Source",
    },
  };
  const request = resolvedAgentRequest({
    conversationKey: 1,
    mode: "agent",
    libraryID: 1,
    userText: "Tag drift papers in Source",
    classifiedIntent: intent,
  });
  return {
    request,
    service: new ActionContractService(gateway as never, { resolve }),
  };
}

describe("semantic reference discovery", function () {
  it("does not send native metadata to semantic discovery when egress is prohibited", async function () {
    let calls = 0;
    const { request, service } = setup(async () => {
      calls++;
      return { state: "resolved", ids: [17], reason: "metadata" };
    });
    request.classifiedIntent!.semantic!.constraints = [
      {
        kind: "deny_effects",
        domains: ["network"],
        effects: ["egress"],
        description: "Keep library evidence local",
      },
    ];
    try {
      await service.createContract(request);
      assert.fail("must keep evidence local");
    } catch (error) {
      assert.include(String(error), "Keep library evidence local");
    }
    assert.equal(calls, 0);
  });
  it("freezes the source boundary before selecting descriptive targets", async function () {
    let candidates: number[] = [];
    const { request, service } = setup(async (input) => {
      candidates = input.candidates.map((entry: any) => entry.id);
      return { state: "resolved", ids: [17], reason: "native metadata" };
    });
    const contract = await service.createContract(request);
    assert.deepEqual(candidates, [17, 18]);
    assert.deepEqual(
      contract.obligations[0].targetBoundary?.frozenTargetIds,
      [17],
    );
    assert.equal(
      contract.intent?.actionIntents[0].discovery?.description,
      "papers studying drift",
    );
    const restored = decodeActionContract(JSON.parse(JSON.stringify(contract)));
    assert.deepEqual(
      restored.obligations[0].targetSelectors,
      contract.obligations[0].targetSelectors,
    );
    assert.deepEqual(
      restored.obligations[0].discovery,
      contract.obligations[0].discovery,
    );
  });
  it("rejects a semantic target outside the frozen source", async function () {
    const { request, service } = setup(async () => ({
      state: "resolved",
      ids: [99],
      reason: "provider guessed",
    }));
    try {
      await service.createContract(request);
      assert.fail("must reject an out-of-source target");
    } catch (error) {
      assert.include(String(error), "outside the frozen source");
    }
  });
  it("preserves missing-reference questions without manufacturing a target", async function () {
    const { request, service } = setup(async () => ({
      state: "needs_input",
      question: "Does drift mean neural or behavioral drift?",
    }));
    try {
      await service.createContract(request);
      assert.fail("must remain unresolved");
    } catch (error) {
      assert.include(String(error), "neural or behavioral");
    }
  });
});

describe("semantic integration", function () {
  it("does not turn an unresolved literal collection name into a fuzzy destination", async function () {
    let called = false;
    const intent = actionFixture("move_to_collection");
    intent.actionIntents[0].scope = {
      kind: "collection",
      path: "shared-token",
      includeDescendants: false,
    };
    intent.actionIntents[0].scopeRole = "destination";
    const request = resolvedAgentRequest({
      conversationKey: 1,
      mode: "agent",
      libraryID: 1,
      activeItemId: 17,
      userText: "File this paper in destination shared-token",
      classifiedIntent: intent,
    });
    const service = new ActionContractService(
      {
        getItem: () => ({
          id: 17,
          libraryID: 1,
          isRegularItem: () => true,
          getField: () => "Paper",
        }),
        listCollectionSummaries: () => [
          {
            collectionId: 7,
            libraryID: 1,
            name: "Parent shared-token",
            path: "Parent shared-token",
          },
          {
            collectionId: 8,
            libraryID: 1,
            name: "destination shared-token",
            path: "Parent shared-token / destination shared-token",
          },
        ],
      } as never,
      {
        resolve: async () => {
          called = true;
          return { state: "resolved", ids: [7], reason: "guessed parent" };
        },
      },
    );
    try {
      await service.createContract(request);
      assert.fail("Literal reference must remain unresolved");
    } catch (error) {
      assert.include(String(error), "was not found");
    }
    assert.isTrue(called);
  });

  it("recovers a truncated literal reference only with an exact native name quoted from the request", async function () {
    let called = false;
    const intent = actionFixture("move_to_collection");
    intent.actionIntents[0].scope = {
      kind: "collection",
      path: "shared-token",
      includeDescendants: false,
    };
    intent.actionIntents[0].scopeRole = "destination";
    const request = resolvedAgentRequest({
      conversationKey: 1,
      mode: "agent",
      libraryID: 1,
      activeItemId: 17,
      userText: "File this paper in destination shared-token",
      classifiedIntent: intent,
    });
    const service = new ActionContractService(
      {
        getItem: () => ({
          id: 17,
          libraryID: 1,
          isRegularItem: () => true,
          getField: () => "Paper",
        }),
        listCollectionSummaries: () => [
          {
            collectionId: 7,
            libraryID: 1,
            name: "Parent shared-token",
            path: "Parent shared-token",
          },
          {
            collectionId: 8,
            libraryID: 1,
            name: "destination shared-token",
            path: "Parent shared-token / destination shared-token",
          },
        ],
      } as never,
      {
        resolve: async () => {
          called = true;
          return {
            state: "resolved",
            ids: [8],
            reason: "native name occurs in the user request",
            literalEvidence: [{ id: 8, quote: "destination shared-token" }],
          };
        },
      },
    );
    const contract = await service.createContract(request);
    assert.equal(
      contract.obligations[0].parameters?.destinationCollectionId,
      8,
    );
    assert.isUndefined(contract.obligations[0].parameters?.sourceCollectionId);
    assert.isTrue(called);
  });

  it("resolves a descriptive destination only within the applicable library catalog", async function () {
    const collections = [
      { collectionId: 5, libraryID: 1, name: "Bayesian", path: "Bayesian" },
    ];
    const paper = {
      id: 3977,
      libraryID: 1,
      isRegularItem: () => true,
      isAttachment: () => false,
      isNote: () => false,
      getField: () => "Paper",
    };
    const gateway = {
      listCollectionSummaries: () => collections,
      getCollectionSummary: (id: number) =>
        collections.find((c) => c.collectionId === id),
      getItem: () => paper,
    };
    const service = new ActionContractService(
      gateway as never,
      {
        resolve: async (input) => {
          assert.equal(input.entity, "collection");
          assert.equal(input.description, "the folder for Bayesian methods");
          assert.deepEqual(
            input.candidates.map((c) => c.id),
            [5],
          );
          return {
            state: "resolved",
            ids: [5],
            reason: "Folder refers to the existing collection",
          };
        },
      } as any,
    );
    const request = resolvedAgentRequest({
      conversationKey: 1,
      mode: "agent",
      libraryID: 1,
      conversationKind: "paper",
      activeItemId: 3977,
      activePaperContext: {
        itemId: 3977,
        contextItemId: 3977,
        title: "Paper",
        libraryID: 1,
      },
      userText: "move this paper to Bayesian folder",
      classifiedIntent: actionFixture("move_to_collection", {}),
    });
    request.classifiedIntent!.actionIntents[0].scope = {
      kind: "collection",
      referenceKind: "descriptive",
      path: "the folder for Bayesian methods",
      includeDescendants: false,
    };
    request.classifiedIntent!.actionIntents[0].scopeRole = "destination";
    const contract = await service.createContract(request);
    assert.equal(
      contract.obligations[0].parameters?.destinationCollectionId,
      5,
    );
    assert.isUndefined(contract.obligations[0].parameters?.sourceCollectionId);
  });
});
