import type {
  AgentToolArtifact,
  AgentActionEvidence,
  AgentToolExecutionOutput,
  PreparedToolExecutionOptions,
  AgentRuntimeRequest,
  AgentToolCall,
  AgentToolContext,
  AgentToolDefinition,
  AgentToolEffect,
  PreparedToolExecution,
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
import { buildActionProposal } from "../authorization/proposal";
import type { ActionProposal } from "../authorization/types";
import { validateConfirmationResolution } from "./confirmationValidation";
import { prepareActionExecution } from "../contracts/actionOperationEvidence";

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
    ],
  };
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
} {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as {
      content?: unknown;
      artifacts?: unknown;
      effect?: unknown;
      actionEvidence?: unknown;
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
      };
    }
  }
  return {
    content: value,
  };
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
    this.tools.set(tool.spec.name, tool);
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

    const mutationPlan =
      tool.spec.executionClass === "external_effect"
        ? ((await tool.planMutation?.(validation.value, context)) ?? {
            effect: "write" as const,
            reversibility: "none" as const,
            reason:
              "This external-effect tool did not provide a durable operation-specific inverse plan.",
          })
        : {
            effect: "none" as const,
            reversibility: "none" as const,
          };
    const callerKind = options.callerKind || "model";
    const enforceActionContract =
      callerKind === "model" || Boolean(context.journalActionScope);
    let preparedAction: PreparedActionExecution | undefined;
    try {
      if (tool.spec.executionClass === "external_effect") {
        preparedAction = this.actionContracts
          ? await this.actionContracts.prepare(tool, validation.value, context)
          : await prepareActionExecution(tool, validation.value, context);
      }
    } catch (error) {
      return createSyntheticErrorResult(
        call,
        error instanceof Error ? error.message : String(error),
      );
    }
    const proposal = buildActionProposal({
      tool,
      input: validation.value,
      plan: mutationPlan,
      typedProposals: preparedAction?.proposals,
      intentBinding: {
        conversationKey: context.request.conversationKey,
        conversationGeneration: context.request.conversationGeneration,
        actionContractId: context.request.actionContract?.id,
        userText: context.request.userText,
      },
    });
    const hasExternalEffect =
      tool.spec.executionClass === "external_effect" &&
      proposal.effects.some((effect) =>
        ["create", "modify", "delete", "execute", "egress"].includes(effect),
      );
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
      mutationPlan.effect === "write" &&
      !this.actionContracts
    ) {
      return createSyntheticErrorResult(
        call,
        `Write blocked: ${call.name} has no configured Action Contract verifier.`,
      );
    }
    let planScopeFailure: ScopeValidationFailure | null = null;
    let approvedPlanScopeProposalDigest: string | undefined;
    if (
      preparedAction &&
      context.request.actionContract &&
      this.actionContracts
    ) {
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
              input: validation.value,
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
            input: validation.value,
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
    ) => {
      const lifecycleError = () => ({
        tool,
        input: resolvedInput,
        result: {
          callId: call.id,
          name: call.name,
          ok: false,
          actionReceipts: finalizeReceipts({
            ok: false,
            reason: "Conversation lifecycle changed before execution.",
          }),
          content: {
            error:
              "Conversation lifecycle changed before this tool could execute.",
          },
        },
      });
      if (options.isExecutionAllowed && !options.isExecutionAllowed()) {
        return lifecycleError();
      }
      const executionMutationPlan =
        tool.spec.executionClass === "external_effect"
          ? ((await tool.planMutation?.(resolvedInput, executionContext)) ?? {
              effect: "write" as const,
              reversibility: "none" as const,
              reason:
                "This external-effect tool did not provide a durable operation-specific inverse plan.",
            })
          : {
              effect: "none" as const,
              reversibility: "none" as const,
            };
      let executionPrepared = preparedAction;
      try {
        if (preparedAction) {
          executionPrepared = this.actionContracts
            ? await this.actionContracts.prepare(
                tool,
                resolvedInput,
                executionContext,
              )
            : await prepareActionExecution(
                tool,
                resolvedInput,
                executionContext,
              );
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
      const executionProposal = buildActionProposal({
        tool,
        input: resolvedInput,
        plan: executionMutationPlan,
        typedProposals: executionPrepared?.proposals,
        intentBinding: {
          conversationKey: context.request.conversationKey,
          conversationGeneration: context.request.conversationGeneration,
          actionContractId: context.request.actionContract?.id,
          userText: context.request.userText,
        },
      });
      const hasExternalEffect =
        tool.spec.executionClass === "external_effect" &&
        executionProposal.effects.some((effect) =>
          ["create", "modify", "delete", "execute", "egress"].includes(effect),
        );
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
            actionReceipts: finalizeReceipts({
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
            actionReceipts: finalizeReceipts({
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
        const scopeFailure = await this.actionContracts.validateScope(
          context.request.actionContract,
          executionPrepared,
          {
            allowPartialCoverage: Boolean(
              options.callerKind === "action" &&
              executionContext.journalActionScope,
            ),
            concreteWrite: executionMutationPlan.effect === "write",
            progress: context.request.actionProgress,
          },
        );
        if (
          scopeFailure &&
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
            actionReceipts: finalizeReceipts({
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
              actionReceipts: finalizeReceipts({
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
              actionReceipts: finalizeReceipts({
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
          const executionOutput = normalizeExecutionOutput(
            await tool.execute(resolvedInput, executionContext),
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
                actionReceipts: finalizeReceipts(
                  {
                    ok: false,
                    reason: "Tool completed without an explicit write effect.",
                  },
                  executionPrepared,
                ),
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
              actionReceipts: finalizeReceipts(
                {
                  ok: true,
                  effect:
                    tool.spec.executionClass === "external_effect"
                      ? executionOutput.effect
                      : undefined,
                  content: executionOutput.content,
                  actionEvidence: executionOutput.actionEvidence,
                },
                executionPrepared,
              ),
              content: executionOutput.content,
              artifacts: executionOutput.artifacts,
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
              actionReceipts: finalizeReceipts(
                {
                  ok: false,
                  reason:
                    error instanceof Error ? error.message : String(error),
                },
                executionPrepared,
              ),
              content: {
                error: error instanceof Error ? error.message : String(error),
              },
            },
          };
        }
      };
      return executionMutationPlan.effect === "write" && options.executeWithLock
        ? options.executeWithLock(execute)
        : execute();
    };

    const runConfirmedExecution = async (
      resolution: import("../types").AgentConfirmationResolution,
      pendingAction: import("../types").AgentPendingAction,
    ) => {
      const confirmation = validateConfirmationResolution(
        pendingAction,
        resolution,
      );
      if (!confirmation.ok) {
        return {
          tool,
          input: validation.value,
          result: {
            callId: call.id,
            name: call.name,
            ok: false,
            actionReceipts: finalizeReceipts({
              ok: false,
              reason: `Invalid confirmation for ${call.name}: ${confirmation.error}`,
            }),
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
        };
      }
      if (planScopeFailure) {
        approvedPlanScopeProposalDigest = proposal.payloadDigest;
      }
      if (tool.applyConfirmation) {
        const resolved = tool.applyConfirmation(
          validation.value,
          confirmation.data,
          context,
        );
        if (!resolved.ok) {
          return {
            tool,
            input: validation.value,
            result: {
              callId: call.id,
              name: call.name,
              ok: false,
              actionReceipts: finalizeReceipts({
                ok: false,
                reason: `Invalid confirmation input for ${call.name}: ${resolved.error}`,
              }),
              content: {
                error: `Invalid confirmation input for ${call.name}: ${resolved.error}`,
              },
            },
          };
        }
        return runWithInput(
          resolved.value,
          journalUnavailable
            ? { ...context, journalFallbackApproved: true }
            : context,
        );
      }
      return runWithInput(
        validation.value,
        journalUnavailable
          ? { ...context, journalFallbackApproved: true }
          : context,
      );
    };

    const toolWantsConfirmation =
      (await tool.shouldRequireConfirmation?.(validation.value, context)) ??
      tool.spec.requiresConfirmation;
    const writeMode = getOriginalAgentPermissionMode();
    const journalUnavailable =
      mutationPlan.effect === "write" && !isAgentChangeJournalAvailable();
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
    const acceptsInheritedApproval =
      shouldRequireConfirmation &&
      !journalUnavailable &&
      options.inheritedApproval &&
      Boolean(
        await tool.acceptInheritedApproval?.(
          validation.value,
          options.inheritedApproval,
          context,
        ),
      );
    if (acceptsInheritedApproval) {
      return {
        kind: "result",
        execution: await runWithInput(
          validation.value,
          journalUnavailable
            ? { ...context, journalFallbackApproved: true }
            : context,
        ),
      };
    }
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
      const renderedAction = journalUnavailable
        ? withRecoveryWarning(
            pendingAction,
            "Zotero's durable journal is unavailable. If you continue, this change may not be recoverable after a restart.",
          )
        : pendingAction;
      return {
        kind: "confirmation",
        requestId,
        action: renderedAction,
        execute: (resolution) =>
          runConfirmedExecution(resolution, renderedAction),
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
