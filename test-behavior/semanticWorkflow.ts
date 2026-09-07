import {
  loadPlanDocument,
  loadPlanDocumentOutbox,
  loadDocumentActionState,
} from "../src/agent/documents/store";
import { stripZoteroNoteWrapper } from "../src/modules/contextPanel/notePersistence";
import { assertExact, check } from "./core";
import { snapshot, itemKey, onlyChanges } from "./native";
import type { JourneyContext } from "./journeys";
import {
  enableComposePlanMode,
  getPlanningRuntimeContext,
  stageApprovedPlanExecution,
} from "../src/modules/contextPanel/planModeState";
import {
  loadPlanArtifact,
  loadPlanExecutionLedger,
} from "../src/agent/plans/store";
import { planExecutionCoordinator } from "../src/agent/plans/coordinator";
import { getConversationWriteGeneration } from "../src/shared/conversationWriteFence";

declare const Zotero: any;

/** A real composer-to-native-state journey; no model answers or effects are supplied by the driver. */
export async function semanticWorkflow(id: string, ctx: JourneyContext) {
  const { fixtures: f, harness, driver, write } = ctx;
  const planned = id === "semantic.compound-plan";
  const fixture = await harness.createPaperWithPdfFixture({
    title: `Semantic workflow population coding ${f.marker} ${planned ? "plan" : "direct"}`,
    pdfTitle: "Synthetic semantic workflow acceptance paper",
    pages: [
      "SYNTHETIC TEST PAPER. Hypothesis: a stable population readout can coexist with representational drift. This is a synthetic experiment, not a published biological result.",
      "Methods: simulated neural population recordings across twelve sessions. A linear decoder was fitted on session one and tested on the remaining sessions. The control shuffled neuron identities.",
      "Results: intact decoding accuracy was 0.83, compared with 0.51 after shuffling identities. The intact readout remained stable despite changing individual tuning.",
      "Limitations: only simulated data and linear decoders were studied. The findings do not establish biological causality or invariance for nonlinear readouts.",
    ],
  });
  const paper = Zotero.Items.get(fixture.parentItemId);
  paper.setCollections([f.collections.geometry.id, f.collections.unrelated.id]);
  await paper.saveTx();
  await harness.openStandaloneForItem(paper.id);
  await harness.clickStandaloneTab("paper");
  harness.enableLiveAgentSending();
  const before = await snapshot();
  await write(`${id}/execution-before.json`, before);
  await harness.captureStandaloneScreenshot(
    `${ctx.request.reportDir}/${id}/before.png`,
  );

  await write(`${id}/targets.json`, {
    paperId: paper.id,
    paperKey: paper.key,
    attachmentId: fixture.pdfAttachmentId,
    source: f.collections.geometry.id,
    destination: f.collections.destination.id,
    preserved: f.collections.unrelated.id,
  });
  const prompt = `Move this current paper from folder "${f.collections.geometry.name}" into folder "${f.collections.destination.name}", then summarize this paper, then save the summary as a note attached to that paper. Preserve its membership in "${f.collections.unrelated.name}". Include the methods, quantitative result, and limitations in the summary.`;
  const request = { conversationKey: paper.id, activeItemId: paper.id };
  let executionId: string | undefined;
  let executionPrompt = prompt;
  if (planned) {
    const planning = enableComposePlanMode({
      conversationKey: paper.id,
      provider: "original",
    });
    await driver.turn(
      id,
      prompt,
      "auto",
      { ...request, planContext: getPlanningRuntimeContext(paper.id) },
      "none",
      () => harness.askStandalone(prompt),
    );
    assertExact(
      await snapshot(),
      before,
      "Planning must not mutate native Zotero state",
    );
    const artifact = await loadPlanArtifact(planning.planId, planning.revision);
    check(
      artifact?.status === "awaiting_approval",
      "The complete workflow must produce an approvable plan",
    );
    await write(`${id}/plan.json`, artifact);
    await harness.captureStandaloneScreenshot(
      `${ctx.request.reportDir}/${id}/plan-ready.png`,
    );
    const ledger = await planExecutionCoordinator.approve({
      planId: artifact.planId,
      revision: artifact.revision,
      conversationGeneration: getConversationWriteGeneration(paper.id),
      actionContract: artifact.actionContract,
    });
    executionId = ledger.executionId;
    await write(`${id}/approval.json`, {
      approvedBy: "explicit manual behavior-suite invocation",
      ledger,
    });
    stageApprovedPlanExecution(ledger);
    executionPrompt = "Execute the approved workflow to completion.";
  }
  const startedAt = Date.now();
  const turn = await driver.turn(
    id,
    executionPrompt,
    "auto",
    request,
    "none",
    () => harness.askStandalone(executionPrompt),
  );
  await paper.reload(undefined, true);
  const after = await snapshot();
  const expectedPaper = {
    ...before[itemKey(paper)],
    collections: [
      f.collections.destination.key,
      f.collections.unrelated.key,
    ].sort(),
  };
  assertExact(
    after[itemKey(paper)],
    expectedPaper,
    "The intended paper moved while all other fields and memberships were preserved",
  );
  const newNotes = paper
    .getNotes()
    .map((noteId: number) => Zotero.Items.get(noteId))
    .filter((note: any) => !before[itemKey(note)]);
  assertExact(
    newNotes.length,
    1,
    "Exactly one summary note must be attached to the same paper",
  );
  const note = newNotes[0];
  await note.reload(undefined, true);
  assertExact(note.parentID, paper.id, "Native summary-note parent");
  const text = String(note.getNote()).replace(/<[^>]*>/g, " ");
  check(
    text.trim().length >= 250,
    "The saved summary must contain substantive content",
  );
  check(
    /0\.83|83\s*%/.test(text) && /0\.51|51\s*%/.test(text),
    "The summary must retain the paper's quantitative result",
  );
  check(
    /simulat|synthetic/i.test(text) && /linear/i.test(text),
    "The summary must retain the source's methods and evidence limitations",
  );
  check(
    !/placeholder|insert summary here|content pending/i.test(text),
    "The saved note must be finalized",
  );
  onlyChanges(
    before,
    after,
    (row) =>
      row.key === itemKey(paper) || (row.key === itemKey(note) && !row.before),
  );
  const receipts = turn.events.flatMap((event) =>
    event.type === "tool_result" ? event.actionReceipts || [] : [],
  );
  for (const operation of ["move_to_collection", "note_create"])
    check(
      receipts.some(
        (receipt) =>
          receipt.operation === operation &&
          receipt.verification === "verified" &&
          ["applied", "already_satisfied"].includes(receipt.status),
      ),
      `Missing verified ${operation} receipt`,
    );
  const submissions = turn.events.filter(
    (event) =>
      event.type === "tool_result" &&
      event.name === "submit_document" &&
      event.ok,
  );
  assertExact(submissions.length, 1, "Generate and persist the summary once");
  const submission = submissions[0];
  const documentId =
    submission.type === "tool_result"
      ? String((submission.content as any)?.documentId || "")
      : "";
  check(
    documentId,
    "The generated summary must have a durable document identity",
  );
  const document = await loadPlanDocument(documentId);
  check(
    document?.validation.integrityValidated,
    "The exact summary document must pass integrity validation",
  );
  assertExact(
    stripZoteroNoteWrapper(note.getNote()),
    stripZoteroNoteWrapper(document.visibleHtml),
    "The native note must contain the exact finalized summary",
  );
  assertExact(
    turn.result.text,
    document.visibleMarkdown,
    "The published answer must retain the exact immutable summary",
  );
  const publication = await loadPlanDocumentOutbox(documentId);
  assertExact(
    publication?.status,
    "delivered",
    "The completed document must be published, not left in Publishing document state",
  );
  const association = await loadDocumentActionState(documentId);
  assertExact(
    association?.savedNote?.itemKey,
    note.key,
    "Durable document-to-note association",
  );
  assertExact(
    association?.savedNote?.parentItemId,
    paper.id,
    "Durable exact parent binding",
  );
  assertExact(
    association?.savedNote?.contentHash,
    document.contentHash,
    "Durable content identity",
  );
  const moveIndex = turn.events.findIndex(
    (event) =>
      event.type === "tool_result" &&
      event.ok &&
      event.actionReceipts?.some(
        (receipt) =>
          receipt.operation === "move_to_collection" &&
          receipt.verification === "verified",
      ),
  );
  const submitIndex = turn.events.indexOf(submission);
  const saveIndex = turn.events.findIndex(
    (event) =>
      event.type === "tool_result" &&
      event.ok &&
      event.actionReceipts?.some(
        (receipt) =>
          receipt.operation === "note_create" &&
          receipt.verification === "verified",
      ),
  );
  check(
    moveIndex >= 0 && moveIndex < submitIndex && submitIndex < saveIndex,
    "Native evidence must establish move, generate, and save in the requested order",
  );
  await write(`${id}/material.json`, {
    document,
    association,
    moveIndex,
    submitIndex,
    saveIndex,
  });
  if (executionId) {
    const ledger = await loadPlanExecutionLedger(executionId);
    await write(`${id}/final-ledger.json`, ledger);
    check(
      ledger?.tasks.every((task) => task.status === "completed"),
      "Every required plan task must complete from evidence",
    );
  }
  await write(`${id}/summary-note.html`, note.getNote(), true);
  await write(`${id}/execution-after.json`, after);
  await write(`${id}/timing.json`, {
    executionElapsedMs: Date.now() - startedAt,
    toolCalls: turn.events.filter((event) => event.type === "tool_call").length,
  });
  await harness.captureStandaloneScreenshot(
    `${ctx.request.reportDir}/${id}/completed.png`,
  );
  await write(`${id}/ui.json`, await harness.getStandaloneDiagnostics());
}
