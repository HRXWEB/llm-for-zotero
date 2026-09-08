import { ToolExecutionFailure } from "./failure";
import { buildActionCallDigest } from "../../authorization/proposal";
import type {
  ActionContractService,
  ScopeValidationFailure,
} from "../../contracts/actionContract";
import { createFallbackToolReceipts } from "../../contracts/actionEvaluation";
import { getOriginalAgentPermissionMode } from "../../originalAgentPermissionMode";
import type { PlanAmendmentService } from "../../plans/amendments";
import type { PlanAmendmentGrant } from "../../plans/planAmendmentTypes";
import { canonicalJson } from "../../services/libraryMutation/canonicalJson";
import type {
  AgentActionEvidence,
  AgentConfirmationResolution,
  AgentPendingAction,
  AgentToolCall,
  AgentToolContext,
  AgentToolDefinition,
  AgentToolEffect,
  PreparedToolExecution,
  PreparedToolExecutionOptions,
  PreparedToolExecutionResult,
} from "../../types";
import { validateConfirmationResolution } from "../confirmationValidation";
import { InvocationAssessor, type AssessedInvocation } from "./assessment";
import {
  createProposalConfirmationAction,
  createRequestId,
  invocationExpands,
  normalizeExecutionOutput,
} from "./results";

type ReceiptOutcome = {
  ok: boolean;
  effect?: AgentToolEffect;
  cancelled?: boolean;
  reason?: string;
  content?: unknown;
  actionEvidence?: AgentActionEvidence[];
};
type AuthorizedAmendment = {
  grant: PlanAmendmentGrant;
  failure: ScopeValidationFailure;
};

/** Owns the lifetime of one invocation; authority is bound to exact assessed payloads. */
export class InvocationController {
  private readonly assessor: InvocationAssessor;
  private readonly frozenContract: string;
  private amendment?: AuthorizedAmendment;
  private readonly childResults = new Map<
    string,
    import("../../types").AgentToolResult
  >();

  constructor(
    private readonly call: AgentToolCall,
    private readonly tool: AgentToolDefinition<any, any>,
    private readonly context: AgentToolContext,
    private readonly options: PreparedToolExecutionOptions,
    private readonly contracts?: ActionContractService,
    private readonly amendments?: PlanAmendmentService,
  ) {
    this.assessor = new InvocationAssessor(tool, context, options, contracts);
    this.frozenContract = canonicalJson(context.request.actionContract || null);
  }

  async prepare(input: unknown): Promise<PreparedToolExecution> {
    try {
      if (this.options.inheritedApproval) {
        const inherited = this.options.inheritedApproval;
        if (
          inherited.approvedCallDigest !==
            buildActionCallDigest(this.call.name, this.call.arguments) ||
          !(await this.tool.acceptInheritedApproval?.(
            input,
            inherited,
            this.context,
          ))
        )
          throw new Error(
            `Inherited approval for ${this.call.name} was refused because it was not bound to this exact invocation.`,
          );
      }
      const assessed = await this.assessor.assess(input, false);
      if (
        this.options.inheritedApproval?.sourceMode === "approval" &&
        !assessed.scopeFailure &&
        assessed.authorization.kind !== "block"
      )
        return this.execute(assessed, assessed.proposal.payloadDigest);
      return await this.dispatch(assessed);
    } catch (error) {
      return this.result(this.failure(input, error));
    }
  }

  private result(
    execution: PreparedToolExecutionResult,
  ): PreparedToolExecution {
    return { kind: "result", execution };
  }

  private receipts(
    outcome: ReceiptOutcome,
    assessed?: AssessedInvocation,
    input?: unknown,
  ) {
    const prepared = assessed?.preparedAction;
    if (prepared?.hasExplicitAdapter && !prepared.proposals.length) return [];
    const details = this.amendment?.failure.amendableObligation;
    const receipts =
      prepared && this.contracts
        ? this.contracts.finalize(
            this.context.request.actionContract,
            prepared,
            outcome,
            this.context.request.actionProgress,
            details
              ? {
                  obligationId: details.obligationId,
                  addedTargetIds: details.addedTargetIds,
                }
              : undefined,
          )
        : createFallbackToolReceipts({
            toolName: this.call.name,
            executionClass: this.tool.spec.executionClass,
            input: assessed?.input ?? input,
            actionContract: this.context.request.actionContract,
            ...outcome,
          });
    if (this.context.request.actionProgress && this.contracts)
      this.contracts.applyReceipts(
        this.context.request.actionProgress,
        receipts,
      );
    return [
      ...receipts,
      ...[...this.childResults.values()].flatMap(
        (result) => result.actionReceipts || [],
      ),
    ];
  }

  private failure(
    input: unknown,
    error: unknown,
    assessed?: AssessedInvocation,
    cancelled = false,
  ): PreparedToolExecutionResult {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      tool: this.tool,
      input,
      result: {
        callId: this.call.id,
        name: this.call.name,
        ok: false,
        actionReceipts: this.receipts(
          {
            ok: false,
            reason,
            cancelled,
            content:
              error instanceof ToolExecutionFailure ? error.content : undefined,
          },
          assessed,
          input,
        ),
        content:
          error instanceof ToolExecutionFailure
            ? error.content
            : { error: reason },
      },
    };
  }

  private scopeFailure(
    assessed: AssessedInvocation,
  ): PreparedToolExecutionResult {
    const failure = assessed.scopeFailure!;
    return {
      tool: this.tool,
      input: assessed.input,
      result: {
        callId: this.call.id,
        name: this.call.name,
        ok: false,
        actionReceipts: this.contracts!.rejectionReceipts(
          this.context.request.actionContract!,
          assessed.preparedAction!,
          failure,
        ),
        content: {
          code: failure.code,
          error: failure.message,
          requiresPlanRevision:
            this.context.request.planContext?.phase === "executing",
          retryable: false,
          expectedCount: failure.expectedCount,
          proposedCount: failure.proposedCount,
          rejectedTargets: failure.rejectedTargets,
          missingTargets: failure.missingTargets,
        },
      },
    };
  }

  private amendmentDecision(assessed: AssessedInvocation) {
    return (
      this.amendments?.decideActionScopeAmendment({
        planContext: this.context.request.planContext,
        originalMode: getOriginalAgentPermissionMode(),
        failure: assessed.scopeFailure!,
        actionImpact: assessed.plan.impact,
        riskSignals: assessed.plan.riskSignals,
        hasHardConstraints: Boolean(
          (
            this.context.request.actionContract?.intent?.semantic
              ?.constraints ||
            this.context.request.classifiedIntent?.semantic?.constraints ||
            []
          ).length,
        ),
      }) || {
        kind: "block" as const,
        reason: "Plan amendment authority is unavailable.",
      }
    );
  }

  private async authorizeAmendment(
    assessed: AssessedInvocation,
    authority: "user" | "auto_policy" | "yolo",
  ) {
    const plan = this.context.request.planContext;
    if (
      !this.amendments ||
      plan?.phase !== "executing" ||
      !assessed.scopeFailure
    )
      throw new Error("Plan amendment authority is unavailable");
    const grant = await this.amendments.authorizeActionScopeAmendment({
      plan,
      conversationKey: this.context.request.conversationKey,
      failure: assessed.scopeFailure,
      actionProposal: assessed.proposal,
      authority,
    });
    this.amendment = { grant, failure: assessed.scopeFailure };
  }

  private async amendmentMatches(
    assessed: AssessedInvocation,
  ): Promise<boolean> {
    return Boolean(
      assessed.scopeFailure &&
      this.amendment &&
      this.amendments &&
      (await this.amendments.actionScopeGrantMatches({
        grant: this.amendment.grant,
        failure: assessed.scopeFailure,
        actionProposal: assessed.proposal,
      })),
    );
  }

  private async failAmendment(reason: unknown) {
    if (this.amendment && this.amendments)
      this.amendment = {
        ...this.amendment,
        grant: await this.amendments.markFailed(this.amendment.grant, reason),
      };
  }

  private async dispatch(
    assessed: AssessedInvocation,
  ): Promise<PreparedToolExecution> {
    const scopeDecision = assessed.scopeFailure
      ? this.amendmentDecision(assessed)
      : undefined;
    if (scopeDecision?.kind === "block")
      return this.result(this.scopeFailure(assessed));
    if (assessed.authorization.kind === "block")
      return this.result(
        this.failure(assessed.input, assessed.authorization.reason, assessed),
      );
    const toolReview =
      this.tool.spec.interaction === "user_input" &&
      ((await this.tool.shouldRequireConfirmation?.(
        assessed.input,
        this.context,
      )) ??
        this.tool.spec.requiresConfirmation);
    const needsReview =
      assessed.authorization.kind === "confirm" ||
      scopeDecision?.kind === "confirm" ||
      toolReview ||
      (this.options.forceConfirmation &&
        this.options.callerKind !== "mcp" &&
        Boolean(this.tool.createPendingAction));
    if (needsReview) {
      const action = assessed.scopeFailure
        ? createProposalConfirmationAction({
            ...assessed.proposal,
            summary: `${assessed.proposal.summary}\n\nNew targets now qualify inside the approved source: ${assessed.scopeFailure.message}`,
          })
        : this.tool.createPendingAction
          ? await this.tool.createPendingAction(assessed.input, this.context)
          : createProposalConfirmationAction(assessed.proposal);
      return this.review(assessed, action);
    }
    if (scopeDecision?.kind === "execute")
      await this.authorizeAmendment(assessed, scopeDecision.authority);
    return this.execute(assessed);
  }

  private review(
    assessed: AssessedInvocation,
    action: AgentPendingAction,
    applyToolResolution = true,
  ): PreparedToolExecution {
    return {
      kind: "confirmation",
      requestId: createRequestId(),
      action,
      execute: (resolution) =>
        this.resolveReview(assessed, action, resolution, applyToolResolution),
      deny: () =>
        this.failure(assessed.input, "User denied action", assessed, true),
    };
  }

  private async resolveReview(
    displayed: AssessedInvocation,
    action: AgentPendingAction,
    resolution: AgentConfirmationResolution,
    applyToolResolution: boolean,
  ): Promise<PreparedToolExecution> {
    let input = displayed.input;
    try {
      const confirmation = validateConfirmationResolution(action, resolution);
      if (!confirmation.ok)
        throw new Error(
          `Invalid confirmation for ${this.call.name}: ${confirmation.error}`,
        );
      const cancelActionId =
        action.cancelActionId ||
        (action.actions?.length ? undefined : "cancel");
      if (
        (confirmation.actionId && confirmation.actionId === cancelActionId) ||
        (!confirmation.actionId && !resolution.approved)
      )
        return this.result(
          this.failure(input, "User denied action", displayed, true),
        );
      if (applyToolResolution && this.tool.applyConfirmation) {
        const resolved = this.tool.applyConfirmation(
          input,
          confirmation.data,
          this.context,
        );
        if (!resolved.ok)
          throw new Error(
            `Invalid confirmation input for ${this.call.name}: ${resolved.error}`,
          );
        input = resolved.value;
      }
      const assessed = await this.assessor.assess(input);
      if (
        assessed.scopeFailure &&
        this.amendmentDecision(assessed).kind === "block"
      )
        return this.result(this.scopeFailure(assessed));
      if (assessed.authorization.kind === "block")
        throw new Error(assessed.authorization.reason);
      if (
        invocationExpands(displayed.plan, assessed.plan) ||
        (assessed.scopeFailure &&
          assessed.proposal.payloadDigest !== displayed.proposal.payloadDigest)
      )
        return this.review(
          assessed,
          createProposalConfirmationAction({
            ...assessed.proposal,
            summary: `${assessed.proposal.summary}\n\nThe edited input expands the previously displayed targets, impact, or risk and requires a new confirmation.`,
          }),
          false,
        );
      if (assessed.scopeFailure)
        await this.authorizeAmendment(assessed, "user");
      // This digest exists only after a validated, real review resolution.
      return this.execute(assessed, assessed.proposal.payloadDigest);
    } catch (error) {
      await this.failAmendment(error);
      return this.result(this.failure(input, error, displayed));
    }
  }

  private lifecycleValid(checkContract = true): boolean {
    return (
      !this.context.signal?.aborted &&
      (!this.options.isExecutionAllowed || this.options.isExecutionAllowed()) &&
      (!checkContract ||
        canonicalJson(this.context.request.actionContract || null) ===
          this.frozenContract)
    );
  }

  private async stageAuthority(
    assessed: AssessedInvocation,
    userApproval?: string,
  ) {
    if (
      !(
        ["model", "mcp"].includes(this.options.callerKind || "model") &&
        this.tool.spec.executionClass === "external_effect" &&
        assessed.plan.impact !== "read_only" &&
        this.context.runId
      )
    )
      return undefined;
    const progress = this.context.request.actionProgress;
    if (!progress || !this.context.checkpointActionProgress)
      throw new Error(
        "Action authorization could not be persisted before execution.",
      );
    const authority:
      | "safe_confirmation"
      | "auto_policy"
      | "yolo"
      | "plan_approval" = userApproval
      ? "safe_confirmation"
      : this.amendment?.grant.authority === "user"
        ? "safe_confirmation"
        : this.amendment?.grant.authority ||
          (assessed.authorization.kind === "execute" &&
          assessed.authorization.authority === "plan_approval"
            ? "plan_approval"
            : assessed.authorization.kind === "execute" &&
                assessed.authorization.authority === "yolo"
              ? "yolo"
              : "auto_policy");
    const grant = {
      version: 2 as const,
      interaction: assessed.interaction,
      proposalDigest: assessed.proposal.payloadDigest,
      toolName: this.call.name,
      authority,
      status: "staged" as "staged" | "executed" | "failed",
      createdAt: Date.now(),
    };
    const grants = (progress.authorizationGrants ||= []);
    grants.push(grant);
    try {
      await this.context.checkpointActionProgress();
    } catch (error) {
      grants.splice(grants.indexOf(grant), 1);
      throw new Error(
        `Action authorization persistence failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return grant;
  }

  private async completeAmendment() {
    if (!this.amendment || !this.amendments) return;
    const grant = await this.amendments.markApplied(this.amendment.grant);
    this.amendment = { ...this.amendment, grant };
    const details = this.amendment.failure.amendableObligation;
    if (details)
      await this.context.publishPlanEvent?.({
        type: "plan_scope_amended",
        amendmentId: grant.proposal.amendmentId,
        executionId: grant.proposal.executionId,
        mode:
          this.context.request.planContext?.provider !== "original"
            ? "native"
            : grant.authority === "user"
              ? "safe"
              : grant.authority === "yolo"
                ? "yolo"
                : "auto",
        rationale: grant.proposal.rationale,
        previousItemCount: details.previousTargetIds.length,
        newItemCount: details.currentTargetIds.length,
        authority: grant.authority,
      });
  }

  private async execute(
    prepared: AssessedInvocation,
    userApproval?: string,
  ): Promise<PreparedToolExecution> {
    let grant: Awaited<ReturnType<InvocationController["stageAuthority"]>>;
    try {
      if (!this.lifecycleValid())
        throw new Error(
          "Conversation lifecycle changed before this tool could execute.",
        );
      grant = await this.stageAuthority(prepared, userApproval);
    } catch (error) {
      await this.failAmendment(error);
      return this.result(this.failure(prepared.input, error, prepared));
    }
    const run = async (): Promise<PreparedToolExecution> => {
      let assessed = prepared;
      try {
        if (!this.lifecycleValid())
          throw new Error(
            "Conversation lifecycle changed before this tool could execute.",
          );
        assessed = await this.assessor.assess(prepared.input);
        if (assessed.scopeFailure && !(await this.amendmentMatches(assessed))) {
          await this.failAmendment(
            "The action targets or payload changed after amendment authorization.",
          );
          if (grant) grant.status = "failed";
          return this.result(this.scopeFailure(assessed));
        }
        if (assessed.authorization.kind === "block")
          throw new Error(assessed.authorization.reason);
        if (
          !userApproval &&
          grant &&
          assessed.proposal.payloadDigest !== grant.proposalDigest
        )
          throw new Error(
            "The prepared action changed after authorization was persisted. Prepare the current exact action again before executing.",
          );
        if (
          userApproval &&
          (assessed.proposal.payloadDigest !== userApproval ||
            invocationExpands(prepared.plan, assessed.plan))
        ) {
          if (grant) grant.status = "failed";
          return this.review(
            assessed,
            createProposalConfirmationAction(assessed.proposal),
            false,
          );
        }
        if (assessed.authorization.kind === "confirm" && !userApproval) {
          if (grant) grant.status = "failed";
          return this.review(
            assessed,
            createProposalConfirmationAction(assessed.proposal),
            false,
          );
        }
        if (!this.lifecycleValid())
          throw new Error(
            "Conversation lifecycle changed before this tool could execute.",
          );
        const output = normalizeExecutionOutput(
          await this.tool.execute(assessed.input, {
            ...this.context,
            invocationPlan: assessed.plan,
            recordChildExecution: (result) =>
              this.childResults.set(result.callId, result),
            nestedExecutionOptions: {
              isExecutionAllowed: this.options.isExecutionAllowed,
              executeWithLock: this.options.executeWithLock,
            },
            executionAuthority: userApproval
              ? "user"
              : assessed.authorization.kind === "execute"
                ? assessed.authorization.authority
                : undefined,
          }),
        );
        if (grant) grant.status = "executed";
        if (!this.lifecycleValid(false))
          throw new Error("Conversation lifecycle changed during execution.");
        if (
          this.tool.spec.executionClass === "external_effect" &&
          output.effect === undefined
        )
          throw new Error(
            `${this.call.name} completed without the required explicit write effect. Its outcome is unknown; inspect current state before retrying.`,
          );
        await this.completeAmendment();
        const effect =
          this.tool.spec.executionClass === "external_effect"
            ? output.effect
            : [...this.childResults.values()].some(
                  (result) => result.effect === "partial",
                )
              ? "partial"
              : [...this.childResults.values()].some(
                    (result) => result.effect === "applied",
                  )
                ? "applied"
                : undefined;
        return this.result({
          tool: this.tool,
          input: assessed.input,
          result: {
            callId: this.call.id,
            name: this.call.name,
            ok: true,
            effect,
            actionReceipts: this.receipts(
              {
                ok: true,
                effect,
                content: output.content,
                actionEvidence: output.actionEvidence,
              },
              assessed,
            ),
            content: output.content,
            artifacts: output.artifacts,
            continuationCheckpoint: output.continuationCheckpoint,
          },
        });
      } catch (error) {
        if (grant) grant.status = "failed";
        await this.failAmendment(error);
        return this.result(this.failure(assessed.input, error, assessed));
      }
    };
    return prepared.plan.impact !== "read_only" && this.options.executeWithLock
      ? this.options.executeWithLock(run)
      : run();
  }
}
