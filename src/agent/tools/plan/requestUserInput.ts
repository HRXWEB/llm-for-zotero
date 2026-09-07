import { detectTurnIntent } from "../../model/semanticIntentService";
import { getAllSkills } from "../../skills";
import { ActionReferenceResolutionError } from "../../contracts/actionScope";
import { isConversationWriteGenerationCurrent } from "../../../shared/conversationWriteFence";
import type {
  AgentPendingChoiceValue,
  AgentPendingField,
  AgentToolDefinition,
  AgentToolInputValidation,
} from "../../types";
import { fail, ok, validateObject } from "../shared";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";

type PlanQuestion = {
  id: string;
  question: string;
  options: Array<{ id: string; label: string; description?: string }>;
  answer?: string;
};

type RequestUserInput = { questions: PlanQuestion[] };

function readQuestionAnswer(value: unknown): string | undefined {
  if (!validateObject<Record<string, unknown>>(value)) return undefined;
  if (value.kind === "option" && typeof value.optionId === "string") {
    return value.optionId;
  }
  if (value.kind === "custom" && typeof value.text === "string") {
    return value.text.trim() || undefined;
  }
  return undefined;
}

function validateInput(
  args: unknown,
): AgentToolInputValidation<RequestUserInput> {
  if (
    !validateObject<Record<string, unknown>>(args) ||
    !Array.isArray(args.questions)
  ) {
    return fail("request_user_input expects questions");
  }
  if (args.questions.length < 1 || args.questions.length > 3) {
    return fail("request_user_input supports one to three questions");
  }
  const questions: PlanQuestion[] = [];
  for (const raw of args.questions) {
    if (!validateObject<Record<string, unknown>>(raw))
      return fail("Invalid question");
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const question =
      typeof raw.question === "string" ? raw.question.trim() : "";
    const options = Array.isArray(raw.options)
      ? raw.options.flatMap((entry) => {
          if (!validateObject<Record<string, unknown>>(entry)) return [];
          const optionId = typeof entry.id === "string" ? entry.id.trim() : "";
          const label =
            typeof entry.label === "string" ? entry.label.trim() : "";
          return optionId && label
            ? [
                {
                  id: optionId,
                  label,
                  description:
                    typeof entry.description === "string" &&
                    entry.description.trim()
                      ? entry.description.trim()
                      : undefined,
                },
              ]
            : [];
        })
      : [];
    if (!id || !question || options.length < 2 || options.length > 3) {
      return fail(
        "Each question requires an id, prompt, and two or three options",
      );
    }
    questions.push({ id, question, options });
  }
  return ok({ questions });
}

export function createRequestUserInputTool(
  prepare?: (
    request: import("../../types").AgentRuntimeRequest,
  ) => Promise<import("../../types").AgentActionContract | null>,
): AgentToolDefinition<RequestUserInput, unknown> {
  return {
    spec: {
      name: "request_user_input",
      description:
        "Ask one to three concise multiple-choice questions when a material reference or workflow decision cannot be discovered from context.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["questions"],
        properties: {
          questions: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: {
              type: "object",
              required: ["id", "question", "options"],
              properties: {
                id: { type: "string" },
                question: { type: "string" },
                options: {
                  type: "array",
                  minItems: 2,
                  maxItems: 3,
                  items: {
                    type: "object",
                    required: ["id", "label"],
                    properties: {
                      id: { type: "string" },
                      label: { type: "string" },
                      description: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      executionClass: "control",
      requiresConfirmation: true,
      interaction: "user_input",
    },
    isAvailable: (request) =>
      request.planContext?.phase === "planning" ||
      Boolean(request.classifiedIntent?.semantic),
    validate: validateInput,
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: [],
        reason:
          "This interaction records user input in the active workflow only.",
      }),
    createPendingAction: (input) => ({
      toolName: "request_user_input",
      title: "Agent needs your input",
      mode: "review",
      confirmLabel: "Continue",
      cancelLabel: "Cancel",
      fields: input.questions.map<AgentPendingField>((question) => ({
        type: "choice",
        id: question.id,
        label: question.question,
        requiredForActionIds: ["continue"],
        options: question.options.map((option) => ({ ...option })),
        allowCustom: true,
        customPlaceholder: "Something else…",
      })),
      actions: [
        { id: "continue", label: "Continue", approved: true },
        { id: "cancel", label: "Cancel", approved: false },
      ],
      defaultActionId: "continue",
      cancelActionId: "cancel",
    }),
    applyConfirmation: (input, data) => {
      const record = validateObject<Record<string, unknown>>(data) ? data : {};
      return ok({
        questions: input.questions.map((question) => ({
          ...question,
          answer: readQuestionAnswer(
            record[question.id] as AgentPendingChoiceValue | undefined,
          ),
        })),
      });
    },
    execute: async (input, context) => {
      const publicAnswers = input.questions.map((question) => ({
        id: question.id,
        answer: question.answer,
      }));
      if (
        !prepare ||
        context.request.actionPreparation?.state !== "needs_input"
      )
        return { answers: publicAnswers };
      const answers = input.questions.map((question) => ({
        question: question.question,
        answer:
          question.options.find((option) => option.id === question.answer)
            ?.label ||
          question.answer ||
          "",
      }));
      if (answers.some((entry) => !entry.answer))
        throw new Error("The requested clarification has not been answered.");
      const revised = {
        ...context.request,
        clarificationHistory: [
          ...(context.request.clarificationHistory || []),
          ...answers,
        ],
      };
      const result = await detectTurnIntent(revised, getAllSkills(), {
        signal: context.signal,
      });
      if (!result.classifiedIntent)
        throw new Error(
          "Semantic interpretation of the clarification is unavailable. Actions remain paused.",
        );
      revised.classifiedIntent = result.classifiedIntent;
      let contract: import("../../types").AgentActionContract | undefined;
      let issues: string[] = [];
      try {
        contract = (await prepare(revised)) || undefined;
      } catch (error) {
        if (!(error instanceof ActionReferenceResolutionError)) throw error;
        issues = [error.message];
      }
      if (
        context.signal?.aborted ||
        (context.request.conversationGeneration !== undefined &&
          !isConversationWriteGenerationCurrent(
            context.request.conversationKey,
            context.request.conversationGeneration,
          ))
      ) {
        throw new Error(
          "The conversation changed while resolving the request.",
        );
      }
      context.request.clarificationHistory = revised.clarificationHistory;
      context.request.classifiedIntent = revised.classifiedIntent;
      context.request.actionContract = contract;
      context.request.actionProgress = undefined;
      context.request.actionPreparation = {
        state: issues.length ? "needs_input" : "ready",
        issues,
      };
      await context.checkpointActionProgress?.();
      return {
        answers: publicAnswers,
        preparation: context.request.actionPreparation,
        contract,
      };
    },
  };
}
