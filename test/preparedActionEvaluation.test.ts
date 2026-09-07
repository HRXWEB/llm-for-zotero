import { assert } from "chai";
import { evaluatePreparedActionContract } from "../src/agent/contracts/actionEvaluation";
import {
  semanticContractFixture,
  classifiedFixture,
} from "./helpers/semanticIntent";

describe("prepared action completion", function () {
  it("accepts an explicitly interpreted answer with no requested actions", function () {
    assert.equal(
      evaluatePreparedActionContract(
        {
          classifiedIntent: classifiedFixture(),
          actionPreparation: { state: "ready", issues: [] },
        },
        [],
      ).state,
      "satisfied",
    );
  });

  it("does not accept prose completion without a current semantic contract", function () {
    const decision = evaluatePreparedActionContract({}, []);
    assert.equal(decision.state, "failed");
    assert.isUndefined(decision.correction);
  });
  it("does not accept an unresolved reference even when a prior contract exists", function () {
    const contract = semanticContractFixture({
      id: "old",
      obligations: [],
      writeDisposition: "none",
    });
    const decision = evaluatePreparedActionContract(
      {
        actionContract: contract,
        actionPreparation: {
          state: "needs_input",
          issues: ["Choose an exact destination"],
        },
      },
      [],
    );
    assert.equal(decision.state, "failed");
    assert.include(decision.failure!, "Choose an exact destination");
  });
  it("accepts a valid semantic answer contract without inventing mutation evidence", function () {
    const intent = classifiedFixture();
    const contract = semanticContractFixture({
      id: "answer",
      intent,
      obligations: [],
      writeDisposition: "none",
    });
    assert.equal(
      evaluatePreparedActionContract(
        {
          actionContract: contract,
          actionPreparation: { state: "ready", issues: [] },
        },
        [],
      ).state,
      "satisfied",
    );
  });
  it("requires verified evidence for an unresolved concrete effect", function () {
    const contract = semanticContractFixture({
      id: "filing",
      writeDisposition: "required",
      obligations: [
        {
          id: "filing:0",
          operation: "move_to_collection",
          capability: "zotero.collections",
          proofDomain: "zotero_state",
          coverage: "one",
          targetKind: "papers",
          parameters: { destinationCollectionId: 5 },
        },
      ],
    });
    const decision = evaluatePreparedActionContract(
      {
        actionContract: contract,
        actionPreparation: { state: "ready", issues: [] },
      },
      [],
    );
    assert.equal(decision.state, "pending");
    assert.isString(decision.correction);
  });
});
