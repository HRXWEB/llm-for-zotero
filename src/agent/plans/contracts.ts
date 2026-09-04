import type {
  AgentActionCapability,
  AgentActionContract,
  AgentActionIntent,
  AgentActionOperation,
  AgentActionParameters,
  AgentActionProofDomain,
  AgentActionReceipt,
} from "../contracts/types";
import {
  ACTION_CAPABILITIES,
  operationCatalogEntry,
} from "../contracts/operationCatalog";
import type {
  ActionConstraint,
  ActionDomain,
  ActionEffect,
} from "../authorization/types";
import type { DocumentSpec } from "../documents/types";
import {
  decodeResearchPolicySnapshot,
  resolveResearchPolicy,
} from "../research/policy";
import type {
  ResearchContract,
  ResearchCriterion,
  ResearchScopeSpec,
  ResearchSubquestion,
} from "../research/types";
import type {
  PlanContract,
  PlanStep,
  ResearchDerivedMutationIntent,
} from "./types";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function positiveInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return number;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => text(entry, `${label}[${index}]`));
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return text(value, label);
}

function decodeActionParameters(
  value: unknown,
  label: string,
): AgentActionParameters | undefined {
  if (value === undefined) return undefined;
  const input = record(value, label);
  const allowed = new Set<keyof AgentActionParameters>([
    "semanticAction",
    "tags",
    "metadataFields",
    "tag",
    "newTag",
    "collectionName",
    "collectionId",
    "collectionIds",
    "savedSearchId",
    "savedSearchName",
    "sourceCollectionId",
    "destinationCollectionId",
    "parentCollectionId",
    "noteMode",
    "targetNoteId",
    "targetItemId",
    "pageIndex",
    "revertCount",
    "expectedText",
    "newName",
    "newPath",
    "identifiers",
    "filePaths",
    "parentItemIds",
    "deleteItems",
    "permanent",
    "filePath",
    "contentHash",
    "commandFingerprint",
    "settingsKey",
    "settingsValue",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key as keyof AgentActionParameters)) {
      throw new Error(`${label}.${key} is not supported`);
    }
  }
  const stringList = (key: keyof AgentActionParameters) =>
    input[key] === undefined
      ? undefined
      : stringArray(input[key], `${label}.${String(key)}`);
  const integerList = (key: keyof AgentActionParameters) => {
    if (input[key] === undefined) return undefined;
    if (!Array.isArray(input[key])) {
      throw new Error(`${label}.${String(key)} must be an array`);
    }
    return (input[key] as unknown[]).map((entry, index) =>
      positiveInteger(entry, `${label}.${String(key)}[${index}]`),
    );
  };
  const positive = (key: keyof AgentActionParameters) =>
    input[key] === undefined
      ? undefined
      : positiveInteger(input[key], `${label}.${String(key)}`);
  const boolean = (key: keyof AgentActionParameters) => {
    if (input[key] === undefined) return undefined;
    if (typeof input[key] !== "boolean") {
      throw new Error(`${label}.${String(key)} must be boolean`);
    }
    return input[key] as boolean;
  };
  const semanticAction = input.semanticAction;
  if (
    semanticAction !== undefined &&
    !["add", "remove", "rename", "merge", "delete", "setColor"].includes(
      String(semanticAction),
    )
  ) {
    throw new Error(`${label}.semanticAction is invalid`);
  }
  const noteMode = input.noteMode;
  if (
    noteMode !== undefined &&
    !["create", "edit", "append"].includes(String(noteMode))
  ) {
    throw new Error(`${label}.noteMode is invalid`);
  }
  const sourceCollectionId =
    input.sourceCollectionId === undefined
      ? undefined
      : input.sourceCollectionId === "all"
        ? "all"
        : positiveInteger(
            input.sourceCollectionId,
            `${label}.sourceCollectionId`,
          );
  const parentCollectionId =
    input.parentCollectionId === undefined
      ? undefined
      : input.parentCollectionId === null
        ? null
        : positiveInteger(
            input.parentCollectionId,
            `${label}.parentCollectionId`,
          );
  let parentItemIds: Array<number | null> | undefined;
  if (input.parentItemIds !== undefined) {
    if (!Array.isArray(input.parentItemIds)) {
      throw new Error(`${label}.parentItemIds must be an array`);
    }
    parentItemIds = input.parentItemIds.map((entry, index) =>
      entry === null
        ? null
        : positiveInteger(entry, `${label}.parentItemIds[${index}]`),
    );
  }
  return {
    semanticAction: semanticAction as AgentActionParameters["semanticAction"],
    tags: stringList("tags"),
    metadataFields: stringList("metadataFields"),
    tag: optionalText(input.tag, `${label}.tag`),
    newTag: optionalText(input.newTag, `${label}.newTag`),
    collectionName: optionalText(
      input.collectionName,
      `${label}.collectionName`,
    ),
    collectionId: positive("collectionId"),
    collectionIds: integerList("collectionIds"),
    savedSearchId: positive("savedSearchId"),
    savedSearchName: optionalText(
      input.savedSearchName,
      `${label}.savedSearchName`,
    ),
    sourceCollectionId,
    destinationCollectionId: positive("destinationCollectionId"),
    parentCollectionId,
    noteMode: noteMode as AgentActionParameters["noteMode"],
    targetNoteId: positive("targetNoteId"),
    targetItemId: positive("targetItemId"),
    pageIndex:
      input.pageIndex === undefined
        ? undefined
        : nonNegativeInteger(input.pageIndex, `${label}.pageIndex`),
    revertCount: positive("revertCount"),
    expectedText: optionalText(input.expectedText, `${label}.expectedText`),
    newName: optionalText(input.newName, `${label}.newName`),
    newPath: optionalText(input.newPath, `${label}.newPath`),
    identifiers: stringList("identifiers"),
    filePaths: stringList("filePaths"),
    parentItemIds,
    deleteItems: boolean("deleteItems"),
    permanent: boolean("permanent"),
    filePath: optionalText(input.filePath, `${label}.filePath`),
    contentHash: optionalText(input.contentHash, `${label}.contentHash`),
    commandFingerprint: optionalText(
      input.commandFingerprint,
      `${label}.commandFingerprint`,
    ),
    settingsKey: optionalText(input.settingsKey, `${label}.settingsKey`),
    settingsValue: optionalText(input.settingsValue, `${label}.settingsValue`),
  };
}

export function decodeActionReceipt(
  value: unknown,
  label = "action receipt",
): AgentActionReceipt {
  const input = record(value, label);
  if (input.version !== 2) throw new Error(`${label}.version is unsupported`);
  const capability = input.capability as AgentActionCapability;
  const operation = input.operation as AgentActionOperation;
  const proofDomain = input.proofDomain as AgentActionProofDomain;
  if (!ACTION_CAPABILITIES.has(capability)) {
    throw new Error(`${label}.capability is invalid`);
  }
  const operationDetails = operationCatalogEntry(String(operation));
  if (
    !operationDetails ||
    operationDetails.capability !== capability ||
    operationDetails.proofDomain !== proofDomain
  ) {
    throw new Error(`${label} operation authority is inconsistent`);
  }
  const verification = String(input.verification);
  if (
    !["verified", "execution_only", "not_applicable", "unverified"].includes(
      verification,
    )
  ) {
    throw new Error(`${label}.verification is invalid`);
  }
  const status = String(input.status);
  if (
    ![
      "applied",
      "already_satisfied",
      "partial",
      "cancelled",
      "failed",
      "observed",
      "unverified",
    ].includes(status)
  ) {
    throw new Error(`${label}.status is invalid`);
  }
  return {
    version: 2,
    id: text(input.id, `${label}.id`),
    obligationId: optionalText(input.obligationId, `${label}.obligationId`),
    proposalId: text(input.proposalId, `${label}.proposalId`),
    proofDomain,
    capability,
    operation,
    verification: verification as AgentActionReceipt["verification"],
    status: status as AgentActionReceipt["status"],
    requestedTargets: stringArray(
      input.requestedTargets,
      `${label}.requestedTargets`,
    ),
    appliedTargets: stringArray(
      input.appliedTargets,
      `${label}.appliedTargets`,
    ),
    alreadySatisfiedTargets: stringArray(
      input.alreadySatisfiedTargets,
      `${label}.alreadySatisfiedTargets`,
    ),
    rejectedTargets: stringArray(
      input.rejectedTargets,
      `${label}.rejectedTargets`,
    ),
    normalizedParameters: decodeActionParameters(
      input.normalizedParameters,
      `${label}.normalizedParameters`,
    ),
    reasons: stringArray(input.reasons, `${label}.reasons`),
    verifiedFacts: stringArray(input.verifiedFacts, `${label}.verifiedFacts`),
    evidenceRef: optionalText(input.evidenceRef, `${label}.evidenceRef`),
  };
}

function decodeActionIntent(
  value: unknown,
  label: string,
  options: { obligation: boolean },
): AgentActionIntent & { id?: string } {
  const input = record(value, label);
  const capability = input.capability as AgentActionCapability;
  const operation = input.operation as AgentActionOperation;
  const proofDomain = input.proofDomain as AgentActionProofDomain;
  if (!ACTION_CAPABILITIES.has(capability)) {
    throw new Error(`${label}.capability is invalid`);
  }
  const operationDetails = operationCatalogEntry(String(operation));
  if (!operationDetails) throw new Error(`${label}.operation is invalid`);
  if (
    operationDetails.capability !== capability ||
    operationDetails.proofDomain !== proofDomain
  ) {
    throw new Error(`${label} operation authority is inconsistent`);
  }
  if (!new Set(["one", "some", "all"]).has(String(input.coverage))) {
    throw new Error(`${label}.coverage is invalid`);
  }
  if (input.targetKind !== "papers" && input.targetKind !== "items") {
    throw new Error(`${label}.targetKind is invalid`);
  }
  const scopeInput =
    input.scope === undefined
      ? undefined
      : record(input.scope, `${label}.scope`);
  if (scopeInput && scopeInput.kind !== "collection") {
    throw new Error(`${label}.scope.kind is invalid`);
  }
  if (scopeInput && typeof scopeInput.includeDescendants !== "boolean") {
    throw new Error(`${label}.scope.includeDescendants must be boolean`);
  }
  const constraintInput =
    input.constraints === undefined
      ? undefined
      : record(input.constraints, `${label}.constraints`);
  if (
    constraintInput?.readMode !== undefined &&
    constraintInput.readMode !== "full"
  ) {
    throw new Error(`${label}.constraints.readMode is invalid`);
  }
  if (
    constraintInput?.collectionMode !== undefined &&
    constraintInput.collectionMode !== "move"
  ) {
    throw new Error(`${label}.constraints.collectionMode is invalid`);
  }
  if (
    input.scopeRole !== undefined &&
    input.scopeRole !== "source" &&
    input.scopeRole !== "destination"
  ) {
    throw new Error(`${label}.scopeRole is invalid`);
  }
  const result: AgentActionIntent & { id?: string } = {
    capability,
    operation,
    proofDomain,
    coverage: input.coverage as AgentActionIntent["coverage"],
    targetKind: input.targetKind,
    parameters: decodeActionParameters(input.parameters, `${label}.parameters`),
    scope: scopeInput
      ? {
          kind: "collection",
          path: optionalText(scopeInput.path, `${label}.scope.path`),
          includeDescendants: scopeInput.includeDescendants as boolean,
        }
      : undefined,
    scopeRole: input.scopeRole as AgentActionIntent["scopeRole"],
    constraints: constraintInput
      ? {
          tagPrefix: optionalText(
            constraintInput.tagPrefix,
            `${label}.constraints.tagPrefix`,
          ),
          readMode: constraintInput.readMode as "full" | undefined,
          collectionMode: constraintInput.collectionMode as "move" | undefined,
        }
      : undefined,
  };
  if (options.obligation) {
    result.id = text(input.id, `${label}.id`);
    if (scopeInput) {
      result.scope = {
        ...result.scope!,
        libraryID: positiveInteger(
          scopeInput.libraryID,
          `${label}.scope.libraryID`,
        ),
        collectionId: positiveInteger(
          scopeInput.collectionId,
          `${label}.scope.collectionId`,
        ),
        collectionPath: text(
          scopeInput.collectionPath,
          `${label}.scope.collectionPath`,
        ),
      } as AgentActionContract["obligations"][number]["scope"];
    }
    if (input.targetBoundary !== undefined) {
      const boundary = record(input.targetBoundary, `${label}.targetBoundary`);
      if (
        !new Set(["collection", "library", "selection"]).has(
          String(boundary.kind),
        )
      ) {
        throw new Error(`${label}.targetBoundary.kind is invalid`);
      }
      if (!Array.isArray(boundary.frozenTargetIds)) {
        throw new Error(
          `${label}.targetBoundary.frozenTargetIds must be an array`,
        );
      }
      (result as AgentActionContract["obligations"][number]).targetBoundary = {
        kind: boundary.kind as "collection" | "library" | "selection",
        libraryID: positiveInteger(
          boundary.libraryID,
          `${label}.targetBoundary.libraryID`,
        ),
        frozenTargetIds: boundary.frozenTargetIds.map((entry, index) =>
          positiveInteger(
            entry,
            `${label}.targetBoundary.frozenTargetIds[${index}]`,
          ),
        ),
        scopeDigest: text(
          boundary.scopeDigest,
          `${label}.targetBoundary.scopeDigest`,
        ),
      };
    }
  }
  return result;
}

function uniqueIds(values: readonly { id: string }[], label: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id))
      throw new Error(`${label} contains duplicate ID ${value.id}`);
    ids.add(value.id);
  }
}

function decodeScope(value: unknown): ResearchScopeSpec {
  const input = record(value, "investigation.scope");
  const kind = input.kind;
  if (
    kind !== "library" &&
    kind !== "collections" &&
    kind !== "tags" &&
    kind !== "items" &&
    kind !== "mixed"
  ) {
    throw new Error("investigation.scope.kind is invalid");
  }
  const libraryID = positiveInteger(
    input.libraryID,
    "investigation.scope.libraryID",
  );
  const collectionIds = Array.isArray(input.collectionIds)
    ? input.collectionIds.map((entry, index) =>
        positiveInteger(entry, `investigation.scope.collectionIds[${index}]`),
      )
    : undefined;
  const tagNames = Array.isArray(input.tagNames)
    ? stringArray(input.tagNames, "investigation.scope.tagNames")
    : undefined;
  const itemKeys = Array.isArray(input.itemKeys)
    ? stringArray(input.itemKeys, "investigation.scope.itemKeys")
    : undefined;
  if (kind === "collections" && !collectionIds?.length) {
    throw new Error("Collection research requires collectionIds");
  }
  if (kind === "tags" && !tagNames?.length) {
    throw new Error("Tag research requires tagNames");
  }
  if (kind === "items" && !itemKeys?.length) {
    throw new Error("Item research requires itemKeys");
  }
  if (
    kind === "library" &&
    (input.collectionIds !== undefined ||
      input.tagNames !== undefined ||
      input.itemKeys !== undefined ||
      input.includeAutomaticTags !== undefined)
  ) {
    throw new Error("Whole-library research scope does not accept filters");
  }
  if (
    kind === "collections" &&
    (input.tagNames !== undefined ||
      input.itemKeys !== undefined ||
      input.includeAutomaticTags !== undefined)
  ) {
    throw new Error("Collection research scope accepts only collectionIds");
  }
  if (
    kind === "tags" &&
    (input.collectionIds !== undefined || input.itemKeys !== undefined)
  ) {
    throw new Error("Tag research scope accepts only tagNames");
  }
  if (
    kind === "items" &&
    (input.collectionIds !== undefined ||
      input.tagNames !== undefined ||
      input.includeAutomaticTags !== undefined)
  ) {
    throw new Error("Item research scope accepts only itemKeys");
  }
  if (
    kind === "mixed" &&
    !collectionIds?.length &&
    !tagNames?.length &&
    !itemKeys?.length
  ) {
    throw new Error("Mixed research scope requires at least one filter");
  }
  if (kind === "library") return { libraryID, kind };
  if (kind === "collections")
    return { libraryID, kind, collectionIds: collectionIds! };
  if (kind === "tags") {
    return {
      libraryID,
      kind,
      tagNames: tagNames!,
      includeAutomaticTags: input.includeAutomaticTags === true,
    };
  }
  if (kind === "items") return { libraryID, kind, itemKeys: itemKeys! };
  return {
    libraryID,
    kind,
    collectionIds,
    tagNames,
    includeAutomaticTags: input.includeAutomaticTags === true,
    itemKeys,
  };
}

function decodeSubquestions(value: unknown): ResearchSubquestion[] {
  if (!Array.isArray(value) || !value.length) {
    throw new Error("investigation.subquestions requires at least one entry");
  }
  const result = value.map((entry, index) => {
    const input = record(entry, `investigation.subquestions[${index}]`);
    return {
      id: text(input.id, `investigation.subquestions[${index}].id`),
      question: text(
        input.question,
        `investigation.subquestions[${index}].question`,
      ),
    };
  });
  uniqueIds(result, "investigation.subquestions");
  return result;
}

function decodeCriteria(value: unknown): ResearchCriterion[] {
  if (!Array.isArray(value)) {
    throw new Error("investigation.criteria must be an array");
  }
  const result = value.map((entry, index) => {
    const input = record(entry, `investigation.criteria[${index}]`);
    if (input.kind !== "include" && input.kind !== "exclude") {
      throw new Error(`investigation.criteria[${index}].kind is invalid`);
    }
    return {
      id: text(input.id, `investigation.criteria[${index}].id`),
      description: text(
        input.description,
        `investigation.criteria[${index}].description`,
      ),
      kind: input.kind as "include" | "exclude",
    };
  });
  uniqueIds(result, "investigation.criteria");
  return result;
}

function decodeResearchContract(
  value: unknown,
  options: { requireSnapshot: boolean },
): ResearchContract {
  const input = record(value, "investigation");
  const requiredEvidenceDepth = input.requiredEvidenceDepth;
  if (
    requiredEvidenceDepth !== "metadata" &&
    requiredEvidenceDepth !== "abstract" &&
    requiredEvidenceDepth !== "body"
  ) {
    throw new Error("investigation.requiredEvidenceDepth is invalid");
  }
  let scopeSnapshot: ResearchContract["scopeSnapshot"];
  if (input.scopeSnapshot !== undefined) {
    const snapshot = record(input.scopeSnapshot, "investigation.scopeSnapshot");
    scopeSnapshot = {
      snapshotId: text(
        snapshot.snapshotId,
        "investigation.scopeSnapshot.snapshotId",
      ),
      digest: text(snapshot.digest, "investigation.scopeSnapshot.digest"),
      itemCount: nonNegativeInteger(
        snapshot.itemCount,
        "investigation.scopeSnapshot.itemCount",
      ),
      createdAt: nonNegativeInteger(
        snapshot.createdAt,
        "investigation.scopeSnapshot.createdAt",
      ),
      policyVersion: positiveInteger(
        snapshot.policyVersion,
        "investigation.scopeSnapshot.policyVersion",
      ),
    };
  } else if (options.requireSnapshot) {
    throw new Error("A ready research plan requires a frozen scope snapshot");
  }
  const criteria = decodeCriteria(input.criteria);
  const reviewMode =
    input.reviewMode === "narrative" ||
    input.reviewMode === "scoping" ||
    input.reviewMode === "systematic"
      ? input.reviewMode
      : criteria.length
        ? "systematic"
        : "narrative";
  const estimatedDeepReadPapers = nonNegativeInteger(
    input.estimatedDeepReadPapers,
    "investigation.estimatedDeepReadPapers",
  );
  const readingStrategy =
    input.readingStrategy === "adaptive" || input.readingStrategy === "selected"
      ? input.readingStrategy
      : estimatedDeepReadPapers > 0
        ? "selected"
        : "adaptive";
  return {
    question: text(input.question, "investigation.question"),
    subquestions: decodeSubquestions(input.subquestions),
    criteria,
    reviewMode,
    readingStrategy,
    scope: decodeScope(input.scope),
    scopeSnapshot,
    queryVariants: Array.isArray(input.queryVariants)
      ? stringArray(input.queryVariants, "investigation.queryVariants")
      : undefined,
    requiredEvidenceDepth,
    estimatedDeepReadPapers,
    approvedLargeCorpus: input.approvedLargeCorpus === true,
  };
}

function decodeDocumentSpec(value: unknown): DocumentSpec {
  const input = record(value, "deliverable.spec");
  const kind = input.kind;
  if (
    kind !== "research_brief" &&
    kind !== "literature_review" &&
    kind !== "comparison" &&
    kind !== "report" &&
    kind !== "guide" &&
    kind !== "custom"
  ) {
    throw new Error("deliverable.spec.kind is invalid");
  }
  const citation = record(
    input.citationStyle,
    "deliverable.spec.citationStyle",
  );
  const requiredSections = stringArray(
    input.requiredSections,
    "deliverable.spec.requiredSections",
  );
  if (!requiredSections.length) {
    throw new Error("A document requires at least one required section");
  }
  return {
    kind,
    title: text(input.title, "deliverable.spec.title"),
    requiredSections,
    requiresReferences: input.requiresReferences !== false,
    requiresCoverageSection: input.requiresCoverageSection !== false,
    allowFigures: input.allowFigures === true,
    citationStyle: {
      styleId: text(citation.styleId, "deliverable.spec.citationStyle.styleId"),
      styleTitle: text(
        citation.styleTitle,
        "deliverable.spec.citationStyle.styleTitle",
      ),
      locale: text(citation.locale, "deliverable.spec.citationStyle.locale"),
    },
  };
}

export function decodeActionContract(value: unknown): AgentActionContract {
  const input = record(value, "effects.libraryMutation.contract");
  if (
    (input.version !== 2 && input.version !== 3) ||
    !Array.isArray(input.obligations)
  ) {
    throw new Error("effects.libraryMutation.contract is invalid");
  }
  const id = text(input.id, "effects.libraryMutation.contract.id");
  if (
    input.writeDisposition !== "none" &&
    input.writeDisposition !== "required" &&
    input.writeDisposition !== "uncertain"
  ) {
    throw new Error(
      "effects.libraryMutation.contract.writeDisposition is invalid",
    );
  }
  if (
    input.interpretationSource !== "classifier" &&
    input.interpretationSource !== "deterministic_fallback"
  ) {
    throw new Error(
      "effects.libraryMutation.contract.interpretationSource is invalid",
    );
  }
  const hardConstraints =
    input.hardConstraints === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(input.hardConstraints)) {
            throw new Error(
              "effects.libraryMutation.contract.hardConstraints must be an array",
            );
          }
          return input.hardConstraints.map((entry, index) => {
            const constraint = record(
              entry,
              `effects.libraryMutation.contract.hardConstraints[${index}]`,
            );
            const description = text(
              constraint.description,
              `effects.libraryMutation.contract.hardConstraints[${index}].description`,
            );
            if (constraint.kind === "no_write") {
              return { kind: "no_write" as const, description };
            }
            if (constraint.kind !== "deny_effects") {
              throw new Error("Unsupported action hard constraint");
            }
            const validEffects = new Set<ActionEffect>([
              "read",
              "create",
              "modify",
              "delete",
              "execute",
              "egress",
            ]);
            const validDomains = new Set<ActionDomain>([
              "zotero_library",
              "filesystem",
              "local_execution",
              "network",
              "privileged_zotero",
            ]);
            const effects = stringArray(
              constraint.effects,
              `effects.libraryMutation.contract.hardConstraints[${index}].effects`,
            ) as ActionEffect[];
            const domains = stringArray(
              constraint.domains,
              `effects.libraryMutation.contract.hardConstraints[${index}].domains`,
            ) as ActionDomain[];
            if (
              !effects.length ||
              effects.some((effect) => !validEffects.has(effect))
            ) {
              throw new Error(
                "Invalid denied effect in action hard constraint",
              );
            }
            if (
              !domains.length ||
              domains.some((domain) => !validDomains.has(domain))
            ) {
              throw new Error(
                "Invalid denied domain in action hard constraint",
              );
            }
            return {
              kind: "deny_effects",
              effects,
              domains,
              description,
            } satisfies ActionConstraint;
          });
        })();
  const obligations = input.obligations.map((entry, index) =>
    decodeActionIntent(
      entry,
      `effects.libraryMutation.contract.obligations[${index}]`,
      { obligation: true },
    ),
  ) as AgentActionContract["obligations"];
  uniqueIds(obligations, "effects.libraryMutation.contract.obligations");
  return {
    version: input.version as 2 | 3,
    id,
    hardConstraints,
    writeDisposition: input.writeDisposition,
    interpretationSource: input.interpretationSource,
    obligations,
  };
}

function decodeMutationIntent(value: unknown): ResearchDerivedMutationIntent {
  const input = record(value, "effects.libraryMutation.intent");
  if (!Array.isArray(input.intents) || !input.intents.length) {
    throw new Error("Research-derived mutation intent requires action intents");
  }
  return {
    summary: text(input.summary, "effects.libraryMutation.intent.summary"),
    intents: input.intents.map((entry, index) =>
      decodeActionIntent(
        entry,
        `effects.libraryMutation.intent.intents[${index}]`,
        { obligation: false },
      ),
    ),
    targetSelectionDescription: text(
      input.targetSelectionDescription,
      "effects.libraryMutation.intent.targetSelectionDescription",
    ),
  };
}

export function decodePlanContract(
  value: unknown,
  options: { requireSnapshot?: boolean } = {},
): PlanContract {
  const input = record(value, "contract");
  const deliverableInput = record(input.deliverable, "deliverable");
  let deliverable: PlanContract["deliverable"];
  if (deliverableInput.kind === "answer") {
    deliverable = { kind: "answer" };
  } else if (deliverableInput.kind === "completion_report") {
    deliverable = { kind: "completion_report" };
  } else if (deliverableInput.kind === "document") {
    deliverable = {
      kind: "document",
      spec: decodeDocumentSpec(deliverableInput.spec),
    };
  } else {
    throw new Error("deliverable.kind is invalid");
  }

  const investigation =
    input.investigation === undefined
      ? undefined
      : decodeResearchContract(input.investigation, {
          requireSnapshot: options.requireSnapshot === true,
        });
  let effects: PlanContract["effects"];
  if (input.effects !== undefined) {
    const effectsInput = record(input.effects, "effects");
    const mutation = record(
      effectsInput.libraryMutation,
      "effects.libraryMutation",
    );
    if (mutation.approval === "initial") {
      effects = {
        libraryMutation: {
          approval: "initial",
          contract: decodeActionContract(mutation.contract),
        },
      };
    } else if (mutation.approval === "after_research") {
      if (!investigation) {
        throw new Error(
          "Research-derived mutations require an investigation contract",
        );
      }
      effects = {
        libraryMutation: {
          approval: "after_research",
          intent: decodeMutationIntent(mutation.intent),
        },
      };
    } else {
      throw new Error("effects.libraryMutation.approval is invalid");
    }
  }

  const researchPolicy = investigation
    ? input.researchPolicy === undefined
      ? resolveResearchPolicy("plan_research")
      : decodeResearchPolicySnapshot(input.researchPolicy)
    : undefined;
  if (researchPolicy && researchPolicy.profile !== "plan_research") {
    throw new Error(
      "Plan investigations require the plan_research policy profile",
    );
  }
  if (
    investigation?.scopeSnapshot &&
    researchPolicy &&
    investigation.scopeSnapshot.policyVersion !== researchPolicy.version
  ) {
    throw new Error("Scope snapshot and research policy versions do not match");
  }
  return {
    investigation,
    deliverable,
    effects,
    researchPolicy,
  };
}

export function buildDefaultPlanContract(params: {
  actionContract?: AgentActionContract;
  steps: readonly Pick<PlanStep, "expectedEffect">[];
}): PlanContract {
  const hasMutation = params.steps.some(
    (step) => step.expectedEffect === "mutation",
  );
  return {
    deliverable: hasMutation
      ? { kind: "completion_report" }
      : { kind: "answer" },
    effects: params.actionContract
      ? {
          libraryMutation: {
            approval: "initial",
            contract: params.actionContract,
          },
        }
      : undefined,
  };
}
