import type {
  AgentToolArtifact,
  AgentActionEvidence,
  AgentToolExecutionOutput,
  PreparedToolExecutionOptions,
  AgentRuntimeRequest,
  AgentInvocationPlan,
  AgentToolCall,
  AgentToolContext,
  AgentToolDefinition,
  AgentToolContinuationCheckpoint,
  AgentToolEffect,
  PreparedToolExecution,
  PreparedToolExecutionResult,
  ToolSpec,
} from "../types";
import { isAgentChangeJournalAvailable } from "../store/changeJournal";
import { isMalformedToolArgumentsDiagnostic } from "../toolArgumentDiagnostics";
import { getOriginalAgentPermissionMode } from "../originalAgentPermissionMode";
import {
  ActionContractService,
  type PreparedActionExecution,
  type ScopeValidationFailure,
} from "../contracts/actionContract";
import {
  createFallbackToolReceipts,
  createUnverifiedReceipt,
} from "../contracts/actionEvaluation";
import {
  hasExplicitNoWriteConstraint,
  normalizeStoredActionConstraints,
  parseActionConstraints,
} from "../authorization/policy";
import { authorizeOriginalAction } from "../authorization/policy";
import {
  buildActionCallDigest,
  buildActionProposal,
} from "../authorization/proposal";
import type { ActionProposal } from "../authorization/types";
import { validateConfirmationResolution } from "./confirmationValidation";
import { prepareActionExecution } from "../contracts/actionOperationEvidence";
import { defaultInvocationPlan } from "../authorization/invocationPlan";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";

type PreparedInvocationState = {
  input: unknown;
  plan: AgentInvocationPlan;
  preparedAction?: PreparedActionExecution;
  proposal: ActionProposal;
};

function scopeMatchedExplicitActionIntent(params: {
  request: AgentRuntimeRequest;
  prepared: PreparedActionExecution | undefined;
  scopeValidated: boolean;
  scopeFailure: ScopeValidationFailure | null;
}): boolean {
  return Boolean(
    params.scopeValidated &&
    !params.scopeFailure &&
    params.prepared?.proposals.length &&
    params.request.actionContract?.obligations.length,
  );
}

function isCompleteInvocationPlan(
  value: unknown,
): value is AgentInvocationPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Record<string, unknown>;
  return (
    ["none", "shell", "zotero_script"].includes(String(plan.mechanism)) &&
    ["read_only", "state_change", "ambiguous", "prohibited"].includes(
      String(plan.impact),
    ) &&
    ["runtime_enforced", "statically_recognized", "unknown"].includes(
      String(plan.assurance),
    ) &&
    Array.isArray(plan.domains) &&
    Array.isArray(plan.effects) &&
    Array.isArray(plan.targets) &&
    Array.isArray(plan.riskSignals) &&
    ["full", "partial", "none"].includes(String(plan.reversibility)) &&
    typeof plan.reason === "string" &&
    plan.reason.trim().length > 0
  );
}

function invocationExpands(
  displayed: AgentInvocationPlan,
  candidate: AgentInvocationPlan,
): boolean {
  const impactRank = {
    read_only: 0,
    state_change: 1,
    ambiguous: 2,
    prohibited: 3,
  } as const;
  const assuranceRank = {
    runtime_enforced: 0,
    statically_recognized: 1,
    unknown: 2,
  } as const;
  const reversibilityRank = { full: 0, partial: 1, none: 2 } as const;
  const adds = <T>(before: readonly T[], after: readonly T[]) =>
    after.some((entry) => !before.includes(entry));
  return (
    impactRank[candidate.impact] > impactRank[displayed.impact] ||
    assuranceRank[candidate.assurance] > assuranceRank[displayed.assurance] ||
    reversibilityRank[candidate.reversibility] >
      reversibilityRank[displayed.reversibility] ||
    candidate.mechanism !== displayed.mechanism ||
    adds(displayed.domains, candidate.domains) ||
    adds(displayed.effects, candidate.effects) ||
    adds(displayed.targets, candidate.targets) ||
    adds(displayed.riskSignals, candidate.riskSignals)
  );
}

function createSyntheticErrorResult(
  call: AgentToolCall,
  message: string,
): PreparedToolExecution {
  const syntheticTool: AgentToolDefinition<any, any> = {
    spec: {
      name: call.name,
      description: message,
      inputSchema: { type: "object" },
      executionClass: "read",
      requiresConfirmation: false,
    },
    validate: () => ({ ok: true, value: {} }),
    execute: async () => ({ error: message }),
  };
  return {
    kind: "result",
    execution: {
      tool: syntheticTool,
      input: call.arguments,
      result: {
        callId: call.id,
        name: call.name,
        ok: false,
        actionReceipts: [createUnverifiedReceipt({ reason: message })],
        content: { error: message },
      },
    },
  };
}

function createRequestId(): string {
  return `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createProposalConfirmationAction(
  proposal: ActionProposal,
): import("../types").AgentPendingAction {
  return {
    toolName: proposal.toolName,
    title: `Review ${proposal.toolName.replace(/_/g, " ")}`,
    description: proposal.summary,
    confirmLabel: "Allow once",
    cancelLabel: "Cancel",
    fields: [
      {
        type: "text",
        id: "operation",
        label: "Operation",
        value: proposal.operation,
      },
      ...(proposal.targets.length
        ? [
            {
              type: "text" as const,
              id: "targets",
              label: "Exact targets",
              value: proposal.targets.join("\n"),
            },
          ]
        : []),
      {
        type: "text",
        id: "invocationImpact",
        label: "Impact and assurance",
        value: `${proposal.invocationPlan.impact} (${proposal.invocationPlan.assurance})`,
      },
      ...(proposal.invocationPlan.mechanism !== "none"
        ? [
            {
              type: "text" as const,
              id: "invocationMechanism",
              label: "Execution mechanism",
              value: proposal.invocationPlan.mechanism,
            },
          ]
        : []),
      {
        type: "text",
        id: "invocationEffects",
        label: "Effects",
        value: proposal.effects.join(", ") || "none",
      },
      {
        type: "text",
        id: "invocationReversibility",
        label: "Reversibility",
        value: proposal.reversibility,
      },
      ...(proposal.riskSignals.length
        ? [
            {
              type: "text" as const,
              id: "invocationRisks",
              label: "Risk signals",
              value: proposal.riskSignals.join(", "),
            },
          ]
        : []),
    ],
  };
}

function attachInvocationPlanFields(
  action: import("../types").AgentPendingAction,
  proposal: ActionProposal,
): import("../types").AgentPendingAction {
  const planAction = createProposalConfirmationAction(proposal);
  const existingIds = new Set((action.fields || []).map((field) => field.id));
  const planFields = planAction.fields.filter(
    (field) => field.id.startsWith("invocation") && !existingIds.has(field.id),
  );
  return planFields.length
    ? { ...action, fields: [...(action.fields || []), ...planFields] }
    : action;
}

function withRecoveryWarning(
  action: import("../types").AgentPendingAction,
  reason: string,
): import("../types").AgentPendingAction {
  const warning = `Recovery warning: ${reason}`;
  return {
    ...action,
    description: `${action.description}\n\n${warning}`,
    fields: [
      ...(action.fields || []),
      {
        type: "text" as const,
        id: "journalRecoveryWarning",
        label: "Recovery warning",
        value: warning,
      },
    ],
  };
}

function normalizeExecutionOutput(value: AgentToolExecutionOutput<any>): {
  content: unknown;
  artifacts?: AgentToolArtifact[];
  effect?: AgentToolEffect;
  actionEvidence?: AgentActionEvidence[];
  continuationCheckpoint?: AgentToolContinuationCheckpoint;
} {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as {
      content?: unknown;
      artifacts?: unknown;
      effect?: unknown;
      actionEvidence?: unknown;
      continuationCheckpoint?: unknown;
    };
    if (Object.prototype.hasOwnProperty.call(record, "content")) {
      return {
        content: record.content,
        artifacts: Array.isArray(record.artifacts)
          ? (record.artifacts as AgentToolArtifact[])
          : undefined,
        effect:
          record.effect === "applied" ||
          record.effect === "partial" ||
          record.effect === "none"
            ? record.effect
            : undefined,
        actionEvidence: Array.isArray(record.actionEvidence)
          ? (record.actionEvidence as AgentActionEvidence[])
          : undefined,
        continuationCheckpoint:
          record.continuationCheckpoint &&
          typeof record.continuationCheckpoint === "object" &&
          !Array.isArray(record.continuationCheckpoint) &&
          typeof (record.continuationCheckpoint as Record<string, unknown>)
            .reason === "string" &&
          typeof (record.continuationCheckpoint as Record<string, unknown>)
            .instruction === "string"
            ? (record.continuationCheckpoint as AgentToolContinuationCheckpoint)
            : undefined,
      };
    }
  }
  return {
    content: value,
  };
}

function assertPortableModelToolSchema(spec: ToolSpec): void {
  if (spec.exposure === "internal") return;

  const schema = spec.inputSchema;
  if (
    !schema ||
    typeof schema !== "object" ||
    Array.isArray(schema) ||
    (schema as Record<string, unknown>).type !== "object"
  ) {
    throw new Error(
      `Tool "${spec.name}" has an incompatible model-visible inputSchema: the schema root must be a non-array object with type: "object".`,
    );
  }

  for (const keyword of ["oneOf", "allOf", "anyOf"] as const) {
    if (Object.prototype.hasOwnProperty.call(schema, keyword)) {
      throw new Error(
        `Tool "${spec.name}" has an incompatible model-visible inputSchema: root-level "${keyword}" is not portable across providers. Move alternatives into properties and enforce cross-field rules in validate().`,
      );
    }
  }
}

export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentToolDefinition<any, any>>();

  constructor(private readonly actionContracts?: ActionContractService) {}

  async createActionContract(
    request: AgentRuntimeRequest,
  ): Promise<NonNullable<AgentRuntimeRequest["actionContract"]> | null> {
    if (this.actionContracts) {
      return this.actionContracts.createContract(request);
    }
    const intents = request.classifiedIntent?.actionIntents || [];
    if (intents.some((intent) => intent.scope)) {
      throw new Error(
        "A collection-scoped action requires the Zotero scope resolver.",
      );
    }
    const id = `action-contract:${request.conversationKey}:${Date.now()}`;
    return {
      version: 3,
      id,
      hardConstraints: parseActionConstraints(request.userText || ""),
      writeDisposition:
        request.classifiedIntent?.writeDisposition ||
        (intents.length ? "required" : "none"),
      interpretationSource:
        request.classifiedIntent?.actionInterpretationSource ||
        "deterministic_fallback",
      obligations: intents.map((intent, index) => {
        const { scope: _scope, ...unscoped } = intent;
        return {
          ...unscoped,
          id: `${id}:obligation:${index}`,
        };
      }),
    };
  }

  createActionProgress(
    contract: NonNullable<AgentRuntimeRequest["actionContract"]>,
  ): NonNullable<AgentRuntimeRequest["actionProgress"]> {
    if (this.actionContracts)
      return this.actionContracts.createProgress(contract);
    return {
      version: 1,
      contractId: contract.id,
      state: "pending",
      correctionCount: 0,
      obligations: contract.obligations.map((obligation) => ({
        obligationId: obligation.id,
        status: "open",
        verifiedTargetIds: [],
        unresolvedTargetIds: [],
        journalStepIds: [],
        failureReasons: [],
      })),
      appliedReceiptKeys: [],
      authorizationGrants: [],
      updatedAt: Date.now(),
    };
  }

  private isModelVisibleTool(tool: AgentToolDefinition<any, any>): boolean {
    return tool.spec.exposure !== "internal";
  }

  private filterToolsForRequest(
    request: AgentRuntimeRequest,
  ): AgentToolDefinition<any, any>[] {
    return Array.from(this.tools.values()).filter(
      (tool) =>
        this.isModelVisibleTool(tool) && tool.isAvailable?.(request) !== false,
    );
  }

  register<TInput, TResult>(tool: AgentToolDefinition<TInput, TResult>): void {
    assertPortableModelToolSchema(tool.spec);
    const registered = tool.planInvocation
      ? tool
      : {
          ...tool,
          planInvocation: () => defaultInvocationPlan(tool.spec.executionClass),
        };
    this.tools.set(tool.spec.name, registered);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  listTools(): ToolSpec[] {
    return Array.from(this.tools.values())
      .filter(
        (tool) =>
          this.isModelVisibleTool(tool) && tool.spec.localAgentOnly !== true,
      )
      .map((tool) => tool.spec);
  }

  listToolDefinitions(): AgentToolDefinition<any, any>[] {
    return Array.from(this.tools.values());
  }

  listToolsForRequest(request: AgentRuntimeRequest): ToolSpec[] {
    return this.filterToolsForRequest(request).map((tool) => tool.spec);
  }

  listToolDefinitionsForRequest(
    request: AgentRuntimeRequest,
  ): AgentToolDefinition<any, any>[] {
    return this.filterToolsForRequest(request);
  }

  getTool(name: string): AgentToolDefinition<any, any> | undefined {
    return this.tools.get(name);
  }

  async prepareExecution(
    call: AgentToolCall,
    context: AgentToolContext,
    options: PreparedToolExecutionOptions = {},
  ): Promise<PreparedToolExecution> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return createSyntheticErrorResult(call, `Unknown tool: ${call.name}`);
    }
    if (tool.isAvailable?.(context.request) === false) {
      return createSyntheticErrorResult(
        call,
        `${call.name} is not available for this request`,
      );
    }
    // Authorization happens after input validation and exact effect
    // assessment. A coarse tool label is never the authorization boundary.
    if (isMalformedToolArgumentsDiagnostic(call.arguments)) {
      return createSyntheticErrorResult(
        call,
        `Invalid tool input for ${call.name}: ${call.name} received malformed tool arguments from the model. Retry with valid JSON.`,
      );
    }
    const validation = tool.validate(call.arguments);
    if (!validation.ok) {
      const validationError =
        call.name === "library_search" &&
        (context.request.turnPaperScope.collections.length ||
          context.request.turnPaperScope.tags.length) &&
        validation.error.includes("entity and mode are required")
          ? `${validation.error} For selected collection/tag scopes, use ` +
            "{ entity:'items', mode:'list', filters:{ collectionId:<collectionId> } } or " +
            "{ entity:'items', mode:'list', filters:{ tag:'<tag>' } }."
          : validation.error;
      return createSyntheticErrorResult(
        call,
        `Invalid tool input for ${call.name}: ${validationError}`,
      );
    }

    const prepareInvocationState = async (
      input: typeof validation.value,
      invocationContext: AgentToolContext,
    ): Promise<PreparedInvocationState> => {
      const plan = await (
        tool.planInvocation ||
        (() => defaultInvocationPlan(tool.spec.executionClass))
      )(input, invocationContext);
      if (!isCompleteInvocationPlan(plan)) {
        throw new Error(
          `${call.name} returned an incomplete AgentInvocationPlan. Execution was refused.`,
        );
      }
      const preparedAction =
        tool.spec.executionClass === "external_effect"
          ? this.actionContracts
            ? await this.actionContracts.prepare(tool, input, invocationContext)
            : await prepareActionExecution(tool, input, invocationContext)
          : undefined;
      const proposal = buildActionProposal({
        tool,
        input,
        plan,
        typedProposals: preparedAction?.proposals,
        intentBinding: {
          conversationKey: context.request.conversationKey,
          conversationGeneration: context.request.conversationGeneration,
          actionContractId: context.request.actionContract?.id,
          userText: context.request.userText,
        },
      });
      return { input, plan, preparedAction, proposal };
    };
    let preparedInvocation: PreparedInvocationState;
    try {
      preparedInvocation = await prepareInvocationState(
        validation.value,
        context,
      );
    } catch (error) {
      return createSyntheticErrorResult(
        call,
        error instanceof Error ? error.message : String(error),
      );
    }
    const {
      plan: invocationPlan,
      preparedAction,
      proposal,
    } = preparedInvocation;
    if (options.inheritedApproval) {
      const expectedDigest = buildActionCallDigest(call.name, call.arguments);
      const accepted =
        options.inheritedApproval.approvedCallDigest === expectedDigest &&
        Boolean(
          await tool.acceptInheritedApproval?.(
            validation.value,
            options.inheritedApproval,
            context,
          ),
        );
      if (!accepted) {
        return createSyntheticErrorResult(
          call,
          `Inherited approval for ${call.name} was refused because it was not bound to this exact invocation.`,
        );
      }
    }
    const callerKind = options.inheritedApproval
      ? "action"
      : options.callerKind || "model";
    const enforceActionContract =
      callerKind === "model" || Boolean(context.journalActionScope);
    const hasExternalEffect =
      tool.spec.executionClass === "external_effect" &&
      invocationPlan.impact !== "read_only";
    if (
      hasExternalEffect &&
      (!preparedAction?.hasExplicitAdapter || !preparedAction.proposals.length)
    ) {
      return createSyntheticErrorResult(
        call,
        `External effect blocked for ${call.name}: no typed action adapter describes its exact operation, capability, proof domain, and targets.`,
      );
    }
    if (
      context.request.planContext?.phase === "planning" &&
      hasExternalEffect
    ) {
      return createSyntheticErrorResult(
        call,
        `Plan mode blocked ${call.name}: no mutations, commands, scripts, imports, uploads, settings changes, or file writes may run before plan approval.`,
      );
    }
    if (
      context.request.planContext?.phase === "executing" &&
      hasExternalEffect &&
      !context.request.actionContract
    ) {
      return createSyntheticErrorResult(
        call,
        `Approved Plan execution blocked ${call.name}: the frozen action contract is unavailable. Revise and approve a new plan instead of inferring a new mutation scope.`,
      );
    }
    if (
      hasExternalEffect &&
      (options.callerKind || "model") === "model" &&
      Boolean(this.actionContracts) &&
      !context.request.actionContract
    ) {
      return createSyntheticErrorResult(
        call,
        `Mutation blocked for ${call.name}: no validated action contract exists for this request. Reclassify the requested action and obtain normal confirmation before retrying.`,
      );
    }

    if (
      enforceActionContract &&
      context.request.actionContract &&
      invocationPlan.impact !== "read_only" &&
      !this.actionContracts
    ) {
      return createSyntheticErrorResult(
        call,
        `Write blocked: ${call.name} has no configured Action Contract verifier.`,
      );
    }
    let planScopeFailure: ScopeValidationFailure | null = null;
    let initialScopeValidated = false;
    let approvedPlanScopeProposalDigest: string | undefined;
    if (
      preparedAction &&
      context.request.actionContract &&
      this.actionContracts
    ) {
      initialScopeValidated = true;
      const scopeFailure = await this.actionContracts!.validateScope(
        context.request.actionContract,
        preparedAction,
        {
          allowPartialCoverage: Boolean(
            options.callerKind === "action" && context.journalActionScope,
          ),
          progress: context.request.actionProgress,
        },
      );
      if (scopeFailure) {
        const canRequestOneOffPlanApproval =
          context.request.planContext?.phase === "executing" &&
          !normalizeStoredActionConstraints(
            context.request.actionContract.hardConstraints,
          ).length &&
          !/did not produce a typed action proposal/i.test(
            scopeFailure.message,
          );
        if (canRequestOneOffPlanApproval) {
          planScopeFailure = scopeFailure;
        } else
          return {
            kind: "result",
            execution: {
              tool,
              input: validation.value,
              result: {
                callId: call.id,
                name: call.name,
                ok: false,
                actionReceipts: this.actionContracts!.rejectionReceipts(
                  context.request.actionContract,
                  preparedAction,
                  scopeFailure,
                ),
                content: {
                  error: scopeFailure.message,
                  retryable: true,
                  expectedCount: scopeFailure.expectedCount,
                  proposedCount: scopeFailure.proposedCount,
                  rejectedTargets: scopeFailure.rejectedTargets,
                  missingTargets: scopeFailure.missingTargets,
                },
              },
            },
          };
      }
    }

    const finalizeReceipts = (
      params: {
        ok: boolean;
        effect?: AgentToolEffect;
        cancelled?: boolean;
        reason?: string;
        content?: unknown;
        actionEvidence?: AgentActionEvidence[];
      },
      prepared: PreparedActionExecution | undefined = preparedAction,
      receiptInput: unknown = validation.value,
    ) => {
      let receipts =
        prepared && this.actionContracts
          ? this.actionContracts.finalize(
              context.request.actionContract,
              prepared,
              params,
              context.request.actionProgress,
            )
          : createFallbackToolReceipts({
              toolName: call.name,
              executionClass: tool.spec.executionClass,
              input: receiptInput,
              actionContract: context.request.actionContract,
              ...params,
            });
      if (
        tool.spec.executionClass === "external_effect" &&
        !receipts.some((receipt) => receipt.operation !== "read_full")
      ) {
        receipts = [
          ...receipts,
          ...createFallbackToolReceipts({
            toolName: call.name,
            executionClass: tool.spec.executionClass,
            input: receiptInput,
            actionContract: context.request.actionContract,
            ...params,
          }),
        ];
      }
      if (context.request.actionProgress && this.actionContracts) {
        this.actionContracts.applyReceipts(
          context.request.actionProgress,
          receipts,
        );
      }
      return receipts;
    };

    const runWithInput = async (
      resolvedInput: typeof validation.value,
      executionContext: AgentToolContext = context,
      preparedState?: PreparedInvocationState,
    ) => {
      let executionInvocation = preparedState;
      const lifecycleError = () => ({
        tool,
        input: resolvedInput,
        result: {
          callId: call.id,
          name: call.name,
          ok: false,
          actionReceipts: finalizeReceipts(
            {
              ok: false,
              reason: "Conversation lifecycle changed before execution.",
            },
            executionInvocation?.preparedAction,
            resolvedInput,
          ),
          content: {
            error:
              "Conversation lifecycle changed before this tool could execute.",
          },
        },
      });
      if (options.isExecutionAllowed && !options.isExecutionAllowed()) {
        return lifecycleError();
      }
      try {
        if (!executionInvocation) {
          const reusesPreparedInvocation =
            executionContext === context &&
            canonicalJson(resolvedInput) === canonicalJson(validation.value);
          executionInvocation = reusesPreparedInvocation
            ? preparedInvocation
            : await prepareInvocationState(resolvedInput, executionContext);
        }
      } catch (error) {
        return {
          tool,
          input: resolvedInput,
          result: {
            callId: call.id,
            name: call.name,
            ok: false,
            actionReceipts: finalizeReceipts({
              ok: false,
              reason: error instanceof Error ? error.message : String(error),
            }),
            content: {
              error: error instanceof Error ? error.message : String(error),
            },
          },
        };
      }
      const executionInvocationPlan = executionInvocation.plan;
      const executionPrepared = executionInvocation.preparedAction;
      const executionProposal = executionInvocation.proposal;
      const finalizeExecutionReceipts = (
        params: Parameters<typeof finalizeReceipts>[0],
      ) => finalizeReceipts(params, executionPrepared, resolvedInput);
      const hasExternalEffect =
        tool.spec.executionClass === "external_effect" &&
        executionInvocationPlan.impact !== "read_only";
      let executionScopeValidated = false;
      let executionScopeFailure: ScopeValidationFailure | null = null;
      if (hasExternalEffect && !isAgentChangeJournalAvailable()) {
        return {
          tool,
          input: resolvedInput,
          result: {
            callId: call.id,
            name: call.name,
            ok: false,
            actionReceipts: finalizeExecutionReceipts({
              ok: false,
              reason:
                "The confirmed invocation requires effects, but the durable change journal is unavailable.",
            }),
            content: {
              error: `${call.name} was refused because the durable change journal is unavailable. Effects cannot run without restart-safe authorization and recovery.`,
            },
          },
        };
      }
      if (
        hasExternalEffect &&
        (!executionPrepared?.hasExplicitAdapter ||
          !executionPrepared.proposals.length)
      ) {
        return {
          tool,
          input: resolvedInput,
          result: {
            callId: call.id,
            name: call.name,
            ok: false,
            actionReceipts: [],
            content: {
              error: `External effect blocked for ${call.name}: no typed action adapter describes its exact operation, capability, proof domain, and targets.`,
            },
          },
        };
      }
      if (
        context.request.planContext?.phase === "planning" &&
        hasExternalEffect
      ) {
        return {
          tool,
          input: resolvedInput,
          result: {
            callId: call.id,
            name: call.name,
            ok: false,
            actionReceipts: finalizeExecutionReceipts({
              ok: false,
              reason: `Plan mode blocked ${call.name} after confirmation input changed.`,
            }),
            content: {
              error: `Plan mode blocked ${call.name}: the confirmed input has an external effect.`,
            },
          },
        };
      }
      if (
        context.request.planContext?.phase === "executing" &&
        hasExternalEffect &&
        !context.request.actionContract
      ) {
        return {
          tool,
          input: resolvedInput,
          result: {
            callId: call.id,
            name: call.name,
            ok: false,
            actionReceipts: finalizeExecutionReceipts({
              ok: false,
              reason: "The frozen action contract is unavailable.",
            }),
            content: {
              error: `Approved Plan execution blocked ${call.name}: the frozen action contract is unavailable.`,
            },
          },
        };
      }
      if (
        executionPrepared &&
        context.request.actionContract &&
        this.actionContracts
      ) {
        executionScopeValidated = true;
        executionScopeFailure = await this.actionContracts.validateScope(
          context.request.actionContract,
          executionPrepared,
          {
            allowPartialCoverage: Boolean(
              options.callerKind === "action" &&
              executionContext.journalActionScope,
            ),
            concreteWrite: executionInvocationPlan.impact !== "read_only",
            progress: context.request.actionProgress,
          },
        );
        if (
          executionScopeFailure &&
          approvedPlanScopeProposalDigest !== executionProposal.payloadDigest
        ) {
          return {
            tool,
            input: resolvedInput,
            result: {
              callId: call.id,
              name: call.name,
              ok: false,
              actionReceipts: this.actionContracts.rejectionReceipts(
                context.request.actionContract,
                executionPrepared,
                executionScopeFailure,
              ),
              content: {
                error: executionScopeFailure.message,
                retryable: true,
                expectedCount: executionScopeFailure.expectedCount,
                proposedCount: executionScopeFailure.proposedCount,
                rejectedTargets: executionScopeFailure.rejectedTargets,
                missingTargets: executionScopeFailure.missingTargets,
              },
            },
          };
        }
      }
      const executionAuthorization =
        callerKind === "model" &&
        context.request.planContext?.phase === "executing" &&
        !normalizeStoredActionConstraints(
          context.request.actionContract?.hardConstraints,
        ).length
          ? ({ kind: "execute", authority: "plan_approval" } as const)
          : callerKind === "model"
            ? authorizeOriginalAction(executionProposal, {
                mode: writeMode,
                userText: context.request.userText || "",
                hasExplicitNoWrite: hasExplicitNoWriteConstraint(
                  context.request.userText || "",
                ),
                constraints: [
                  ...normalizeStoredActionConstraints(
                    context.request.actionContract?.hardConstraints,
                  ),
                  ...parseActionConstraints(context.request.userText || ""),
                ],
                hasMatchingActionIntent: scopeMatchedExplicitActionIntent({
                  request: context.request,
                  prepared: executionPrepared,
                  scopeValidated: executionScopeValidated,
                  scopeFailure: executionScopeFailure,
                }),
              })
            : ({ kind: "execute", authority: "auto_policy" } as const);
      if (executionAuthorization.kind === "block") {
        return {
          tool,
          input: resolvedInput,
          result: {
            callId: call.id,
            name: call.name,
            ok: false,
            actionReceipts: finalizeExecutionReceipts({
              ok: false,
              reason: executionAuthorization.reason,
            }),
            content: { error: executionAuthorization.reason },
          },
        };
      }
      let stagedGrant:
        | NonNullable<
            NonNullable<
              AgentToolContext["request"]["actionProgress"]
            >["authorizationGrants"]
          >[number]
        | undefined;
      if (callerKind === "model" && hasExternalEffect && context.runId) {
        const progress = context.request.actionProgress;
        if (!progress || !context.checkpointActionProgress) {
          return {
            tool,
            input: resolvedInput,
            result: {
              callId: call.id,
              name: call.name,
              ok: false,
              actionReceipts: finalizeExecutionReceipts({
                ok: false,
                reason:
                  "Action authorization could not be persisted before execution.",
              }),
              content: {
                error:
                  "Action authorization could not be persisted before execution.",
              },
            },
          };
        }
        const grants = (progress.authorizationGrants ||= []);
        stagedGrant = {
          proposalDigest: executionProposal.payloadDigest,
          toolName: call.name,
          authority:
            context.request.planContext?.phase === "executing" &&
            !planScopeFailure
              ? "plan_approval"
              : executionAuthorization.kind === "confirm"
                ? "safe_confirmation"
                : executionAuthorization.kind === "execute" &&
                    executionAuthorization.authority === "yolo"
                  ? "yolo"
                  : "auto_policy",
          status: "staged",
          createdAt: Date.now(),
        };
        grants.push(stagedGrant);
        try {
          await context.checkpointActionProgress();
        } catch (error) {
          grants.splice(grants.indexOf(stagedGrant), 1);
          return {
            tool,
            input: resolvedInput,
            result: {
              callId: call.id,
              name: call.name,
              ok: false,
              actionReceipts: finalizeExecutionReceipts({
                ok: false,
                reason: error instanceof Error ? error.message : String(error),
              }),
              content: {
                error: `Action authorization persistence failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              },
            },
          };
        }
      }
      const execute = async () => {
        if (options.isExecutionAllowed && !options.isExecutionAllowed()) {
          return lifecycleError();
        }
        try {
          const plannedExecutionContext = {
            ...executionContext,
            invocationPlan: executionInvocationPlan,
          };
          const executionOutput = normalizeExecutionOutput(
            await tool.execute(resolvedInput, plannedExecutionContext),
          );
          if (stagedGrant) stagedGrant.status = "executed";
          if (options.isExecutionAllowed && !options.isExecutionAllowed()) {
            return lifecycleError();
          }
          if (
            tool.spec.executionClass === "external_effect" &&
            executionOutput.effect === undefined
          ) {
            return {
              tool,
              input: resolvedInput,
              result: {
                callId: call.id,
                name: call.name,
                ok: false,
                actionReceipts: finalizeExecutionReceipts({
                  ok: false,
                  reason: "Tool completed without an explicit write effect.",
                }),
                content: {
                  error: `${call.name} completed without the required explicit write effect. Its outcome is unknown; inspect current state before retrying.`,
                },
              },
            };
          }
          return {
            tool,
            input: resolvedInput,
            result: {
              callId: call.id,
              name: call.name,
              // `ok` reports that the tool ran, not that it changed anything.
              // See AgentToolResult: flipping this on a zero-effect write
              // would disable the result-review loop and trip the
              // consecutive-error breaker.
              ok: true,
              effect:
                tool.spec.executionClass === "external_effect"
                  ? executionOutput.effect
                  : undefined,
              actionReceipts: finalizeExecutionReceipts({
                ok: true,
                effect:
                  tool.spec.executionClass === "external_effect"
                    ? executionOutput.effect
                    : undefined,
                content: executionOutput.content,
                actionEvidence: executionOutput.actionEvidence,
              }),
              content: executionOutput.content,
              artifacts: executionOutput.artifacts,
              continuationCheckpoint: executionOutput.continuationCheckpoint,
            },
          };
        } catch (error) {
          if (stagedGrant) stagedGrant.status = "failed";
          if (options.isExecutionAllowed && !options.isExecutionAllowed()) {
            return lifecycleError();
          }
          return {
            tool,
            input: resolvedInput,
            result: {
              callId: call.id,
              name: call.name,
              ok: false,
              actionReceipts: finalizeExecutionReceipts({
                ok: false,
                reason: error instanceof Error ? error.message : String(error),
              }),
              content: {
                error: error instanceof Error ? error.message : String(error),
              },
            },
          };
        }
      };
      return executionInvocationPlan.impact !== "read_only" &&
        options.executeWithLock
        ? options.executeWithLock(execute)
        : execute();
    };

    const runConfirmedExecution = async (
      resolution: import("../types").AgentConfirmationResolution,
      pendingAction: import("../types").AgentPendingAction,
      displayedInvocation: PreparedInvocationState = preparedInvocation,
      applyToolResolution = true,
    ): Promise<PreparedToolExecutionResult | PreparedToolExecution> => {
      const confirmation = validateConfirmationResolution(
        pendingAction,
        resolution,
      );
      if (!confirmation.ok) {
        return {
          tool,
          input: displayedInvocation.input,
          result: {
            callId: call.id,
            name: call.name,
            ok: false,
            actionReceipts: finalizeReceipts(
              {
                ok: false,
                reason: `Invalid confirmation for ${call.name}: ${confirmation.error}`,
              },
              displayedInvocation.preparedAction,
              displayedInvocation.input,
            ),
            content: {
              error: `Invalid confirmation for ${call.name}: ${confirmation.error}`,
            },
          },
        };
      }
      const cancelActionId =
        pendingAction.cancelActionId ||
        (pendingAction.actions?.length ? undefined : "cancel");
      if (
        (confirmation.actionId && confirmation.actionId === cancelActionId) ||
        (!confirmation.actionId && !resolution.approved)
      ) {
        return {
          tool,
          input: displayedInvocation.input,
          result: {
            callId: call.id,
            name: call.name,
            ok: false,
            actionReceipts: finalizeReceipts(
              {
                ok: false,
                cancelled: true,
                reason: "User denied action",
              },
              displayedInvocation.preparedAction,
              displayedInvocation.input,
            ),
            content: { error: "User denied action" },
          },
        };
      }
      let resolvedInput = displayedInvocation.input as typeof validation.value;
      if (tool.applyConfirmation && applyToolResolution) {
        const resolved = tool.applyConfirmation(
          resolvedInput,
          confirmation.data,
          context,
        );
        if (!resolved.ok) {
          return {
            tool,
            input: displayedInvocation.input,
            result: {
              callId: call.id,
              name: call.name,
              ok: false,
              actionReceipts: finalizeReceipts(
                {
                  ok: false,
                  reason: `Invalid confirmation input for ${call.name}: ${resolved.error}`,
                },
                displayedInvocation.preparedAction,
                displayedInvocation.input,
              ),
              content: {
                error: `Invalid confirmation input for ${call.name}: ${resolved.error}`,
              },
            },
          };
        }
        resolvedInput = resolved.value;
      }
      const executionContext = journalUnavailable
        ? { ...context, journalFallbackApproved: true }
        : context;
      let confirmedInvocation: PreparedInvocationState;
      try {
        confirmedInvocation =
          executionContext === context &&
          canonicalJson(resolvedInput) ===
            canonicalJson(displayedInvocation.input)
            ? displayedInvocation
            : await prepareInvocationState(resolvedInput, executionContext);
      } catch (error) {
        return {
          tool,
          input: resolvedInput,
          result: {
            callId: call.id,
            name: call.name,
            ok: false,
            actionReceipts: finalizeReceipts(
              {
                ok: false,
                reason: error instanceof Error ? error.message : String(error),
              },
              displayedInvocation.preparedAction,
              resolvedInput,
            ),
            content: {
              error: error instanceof Error ? error.message : String(error),
            },
          },
        };
      }
      const confirmedHasExternalEffect =
        tool.spec.executionClass === "external_effect" &&
        confirmedInvocation.plan.impact !== "read_only";
      if (confirmedHasExternalEffect && !isAgentChangeJournalAvailable()) {
        return {
          tool,
          input: resolvedInput,
          result: {
            callId: call.id,
            name: call.name,
            ok: false,
            actionReceipts: finalizeReceipts(
              {
                ok: false,
                reason:
                  "The confirmed invocation requires effects, but the durable change journal is unavailable.",
              },
              confirmedInvocation.preparedAction,
              resolvedInput,
            ),
            content: {
              error: `${call.name} was refused because the durable change journal is unavailable. Effects cannot run without restart-safe authorization and recovery.`,
            },
          },
        };
      }
      let confirmedScopeFailure: ScopeValidationFailure | null = null;
      let confirmedScopeValidated = false;
      if (
        confirmedInvocation.preparedAction &&
        context.request.actionContract &&
        this.actionContracts
      ) {
        confirmedScopeValidated = true;
        confirmedScopeFailure = await this.actionContracts.validateScope(
          context.request.actionContract,
          confirmedInvocation.preparedAction,
          {
            allowPartialCoverage: Boolean(
              options.callerKind === "action" && context.journalActionScope,
            ),
            concreteWrite: confirmedInvocation.plan.impact !== "read_only",
            progress: context.request.actionProgress,
          },
        );
        if (confirmedScopeFailure) {
          const canRequestOneOffPlanApproval =
            context.request.planContext?.phase === "executing" &&
            !normalizeStoredActionConstraints(
              context.request.actionContract.hardConstraints,
            ).length &&
            !/did not produce a typed action proposal/i.test(
              confirmedScopeFailure.message,
            );
          if (!canRequestOneOffPlanApproval) {
            return {
              tool,
              input: resolvedInput,
              result: {
                callId: call.id,
                name: call.name,
                ok: false,
                actionReceipts: this.actionContracts.rejectionReceipts(
                  context.request.actionContract,
                  confirmedInvocation.preparedAction,
                  confirmedScopeFailure,
                ),
                content: {
                  error: confirmedScopeFailure.message,
                  retryable: true,
                  expectedCount: confirmedScopeFailure.expectedCount,
                  proposedCount: confirmedScopeFailure.proposedCount,
                  rejectedTargets: confirmedScopeFailure.rejectedTargets,
                  missingTargets: confirmedScopeFailure.missingTargets,
                },
              },
            };
          }
        }
      }
      const confirmedAuthorization =
        callerKind === "model" &&
        context.request.planContext?.phase === "executing" &&
        !normalizeStoredActionConstraints(
          context.request.actionContract?.hardConstraints,
        ).length
          ? ({ kind: "execute", authority: "plan_approval" } as const)
          : callerKind === "model"
            ? authorizeOriginalAction(confirmedInvocation.proposal, {
                mode: writeMode,
                userText: context.request.userText || "",
                hasExplicitNoWrite: hasExplicitNoWriteConstraint(
                  context.request.userText || "",
                ),
                constraints: [
                  ...normalizeStoredActionConstraints(
                    context.request.actionContract?.hardConstraints,
                  ),
                  ...parseActionConstraints(context.request.userText || ""),
                ],
                hasMatchingActionIntent: scopeMatchedExplicitActionIntent({
                  request: context.request,
                  prepared: confirmedInvocation.preparedAction,
                  scopeValidated: confirmedScopeValidated,
                  scopeFailure: confirmedScopeFailure,
                }),
              })
            : ({ kind: "execute", authority: "auto_policy" } as const);
      if (confirmedAuthorization.kind === "block") {
        return {
          tool,
          input: resolvedInput,
          result: {
            callId: call.id,
            name: call.name,
            ok: false,
            actionReceipts: finalizeReceipts(
              {
                ok: false,
                reason: confirmedAuthorization.reason,
              },
              confirmedInvocation.preparedAction,
              resolvedInput,
            ),
            content: { error: confirmedAuthorization.reason },
          },
        };
      }
      if (
        invocationExpands(displayedInvocation.plan, confirmedInvocation.plan) ||
        (confirmedScopeFailure !== null &&
          confirmedInvocation.proposal.payloadDigest !==
            displayedInvocation.proposal.payloadDigest)
      ) {
        const expandedAction = createProposalConfirmationAction({
          ...confirmedInvocation.proposal,
          summary: `${confirmedInvocation.proposal.summary}\n\nThe edited input expands the previously displayed targets, impact, or risk and requires a new confirmation.`,
        });
        return {
          kind: "confirmation",
          requestId: createRequestId(),
          action: expandedAction,
          execute: async (nextResolution) => {
            const next = await runConfirmedExecution(
              nextResolution,
              expandedAction,
              confirmedInvocation,
              false,
            );
            return "kind" in next ? next : { kind: "result", execution: next };
          },
          deny: () => ({
            tool,
            input: confirmedInvocation.input,
            result: {
              callId: call.id,
              name: call.name,
              ok: false,
              actionReceipts: finalizeReceipts(
                {
                  ok: false,
                  cancelled: true,
                  reason: "User denied action",
                },
                confirmedInvocation.preparedAction,
                confirmedInvocation.input,
              ),
              content: { error: "User denied action" },
            },
          }),
        };
      }
      if (confirmedScopeFailure) {
        approvedPlanScopeProposalDigest =
          confirmedInvocation.proposal.payloadDigest;
      }
      return runWithInput(resolvedInput, executionContext, confirmedInvocation);
    };

    const toolWantsConfirmation =
      tool.spec.interaction === "user_input"
        ? ((await tool.shouldRequireConfirmation?.(
            validation.value,
            context,
          )) ?? tool.spec.requiresConfirmation)
        : false;
    const writeMode = getOriginalAgentPermissionMode();
    const journalUnavailable =
      invocationPlan.impact !== "read_only" && !isAgentChangeJournalAvailable();
    if (journalUnavailable) {
      return createSyntheticErrorResult(
        call,
        `${call.name} was refused because the durable change journal is unavailable. Effects cannot run without restart-safe authorization and recovery.`,
      );
    }
    const authorization =
      callerKind === "model" &&
      context.request.planContext?.phase === "executing" &&
      !normalizeStoredActionConstraints(
        context.request.actionContract?.hardConstraints,
      ).length
        ? ({ kind: "execute", authority: "plan_approval" } as const)
        : callerKind === "model"
          ? authorizeOriginalAction(proposal, {
              mode: writeMode,
              userText: context.request.userText || "",
              hasExplicitNoWrite: hasExplicitNoWriteConstraint(
                context.request.userText || "",
              ),
              constraints: [
                ...normalizeStoredActionConstraints(
                  context.request.actionContract?.hardConstraints,
                ),
                ...parseActionConstraints(context.request.userText || ""),
              ],
              hasMatchingActionIntent: scopeMatchedExplicitActionIntent({
                request: context.request,
                prepared: preparedAction,
                scopeValidated: initialScopeValidated,
                scopeFailure: planScopeFailure,
              }),
            })
          : { kind: "execute" as const, authority: "auto_policy" as const };
    if (authorization.kind === "block") {
      return createSyntheticErrorResult(call, authorization.reason);
    }
    const planRequiresConfirmation = authorization.kind === "confirm";
    const shouldRequireConfirmation =
      callerKind !== "mcp" &&
      options.forceConfirmation &&
      tool.createPendingAction
        ? true
        : callerKind === "model"
          ? Boolean(planScopeFailure) ||
            planRequiresConfirmation ||
            (tool.spec.interaction === "user_input" && toolWantsConfirmation)
          : callerKind === "mcp"
            ? false
            : toolWantsConfirmation;
    if (shouldRequireConfirmation) {
      const requestId = createRequestId();
      const pendingAction = planScopeFailure
        ? createProposalConfirmationAction({
            ...proposal,
            summary: `${proposal.summary}\n\nThis operation is outside the approved plan scope: ${planScopeFailure.message}`,
          })
        : tool.createPendingAction
          ? await tool.createPendingAction(validation.value, context)
          : createProposalConfirmationAction(proposal);
      const plannedAction = attachInvocationPlanFields(pendingAction, proposal);
      const renderedAction = journalUnavailable
        ? withRecoveryWarning(
            plannedAction,
            "Zotero's durable journal is unavailable. If you continue, this change may not be recoverable after a restart.",
          )
        : plannedAction;
      return {
        kind: "confirmation",
        requestId,
        action: renderedAction,
        execute: async (resolution) => {
          const executed = await runConfirmedExecution(
            resolution,
            renderedAction,
          );
          return "kind" in executed
            ? executed
            : { kind: "result", execution: executed };
        },
        deny: () => ({
          tool,
          input: validation.value,
          result: {
            callId: call.id,
            name: call.name,
            ok: false,
            actionReceipts: finalizeReceipts({
              ok: false,
              cancelled: true,
              reason: "User denied action",
            }),
            content: { error: "User denied action" },
          },
        }),
      };
    }
    return {
      kind: "result",
      execution: await runWithInput(validation.value),
    };
  }
}
