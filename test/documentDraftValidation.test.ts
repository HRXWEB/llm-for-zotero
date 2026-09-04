import { assert } from "chai";
import {
  collectDocumentDraftIssues,
  stripHandwrittenReferences,
} from "../src/agent/documents/draftValidation";

describe("document draft validation", function () {
  it("accepts natural scope and limitation headings while reporting quote issues together", function () {
    const issues = collectDocumentDraftIssues({
      markdown: [
        "# Review",
        "",
        "## Introduction and Scope",
        "",
        'The literature calls this "representational drift".',
        "",
        "## Evidence Limitations and Open Questions",
        "",
        "> An unmapped quotation is not publishable.",
      ].join("\n"),
      requiredSections: ["Scope and limitations"],
      requiresCoverageSection: true,
    });

    assert.deepEqual(issues, [
      "Direct quotations must use internal [[quote:Q1]] tokens and host-verifiable quote mappings",
    ]);
  });

  it("reports all independently detectable structural defects in one pass", function () {
    const issues = collectDocumentDraftIssues({
      markdown: "# Review\n\n> Unmapped source language.",
      requiredSections: ["Methods"],
      requiresCoverageSection: true,
    });

    assert.deepEqual(issues, [
      "Document is missing required sections: methods, scope and limitations",
      "Direct quotations must use internal [[quote:Q1]] tokens and host-verifiable quote mappings",
    ]);
  });

  it("removes a model-authored bibliography without discarding later sections", function () {
    const draft = [
      "# Review",
      "",
      "Evidence [[cite:C1]].",
      "",
      "## References",
      "",
      "- Hand-written entry",
      "",
      "## Appendix",
      "",
      "Retained appendix.",
    ].join("\n");

    assert.equal(
      stripHandwrittenReferences(draft),
      [
        "# Review",
        "",
        "Evidence [[cite:C1]].",
        "",
        "## Appendix",
        "",
        "Retained appendix.",
      ].join("\n"),
    );
  });
});
