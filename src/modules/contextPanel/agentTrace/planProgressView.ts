import type { AgentRunEventRecord } from "../../../agent/types";
import type { PlanExecutionLedger } from "../../../agent/plans/types";
import { loadPlanExecutionLedger } from "../../../agent/plans/store";
import { applyStableAnimationPhase } from "../stableAnimationPhase";
import {
  stageApprovedPlanExecution,
  PLAN_APPROVED_EVENT,
} from "../planModeState";

const PLAN_STATUS_SYMBOLS: Record<string, string> = {
  pending: "",
  in_progress: "",
  waiting_for_user: "!",
  interrupted: "↻",
  completed: "✓",
  blocked: "!",
  failed: "×",
  skipped: "–",
  cancelled: "×",
};

export function isFloatingPlanExecutionStatus(
  status: string | undefined,
): boolean {
  return [
    "pending",
    "running",
    "waiting_for_user",
    "interrupted",
    "blocked",
  ].includes(status || "");
}

type ProgressView = {
  root: HTMLElement;
  update: (ledger: PlanExecutionLedger, events: AgentRunEventRecord[]) => void;
  dispose: () => void;
};
const views = new WeakMap<HTMLElement, ProgressView>();

/** Only presentation nodes are patched here; interactive controls keep their own listeners. */
function patchPresentation(target: HTMLElement, source: HTMLElement): void {
  for (const attr of Array.from(target.attributes)) {
    if (attr.name !== "open" && !source.hasAttribute(attr.name))
      target.removeAttribute(attr.name);
  }
  for (const attr of Array.from(source.attributes)) {
    if (attr.name !== "open" && target.getAttribute(attr.name) !== attr.value)
      target.setAttribute(attr.name, attr.value);
  }
  let cursor = target.firstChild;
  for (const next of Array.from(source.childNodes)) {
    if (!next) continue;
    const taskId = (next as HTMLElement).dataset?.taskId;
    if (taskId) {
      const match = Array.from(target.children).find(
        (child) => (child as HTMLElement).dataset.taskId === taskId,
      );
      if (match && match !== cursor) target.insertBefore(match, cursor);
      if (match) cursor = match;
      else {
        target.insertBefore(next, cursor);
        continue;
      }
    }
    if (
      cursor &&
      cursor.nodeType === next.nodeType &&
      cursor.nodeName === next.nodeName
    ) {
      if (cursor.nodeType === 3) {
        if (cursor.nodeValue !== next.nodeValue)
          cursor.nodeValue = next.nodeValue;
      } else patchPresentation(cursor as HTMLElement, next as HTMLElement);
      cursor = cursor.nextSibling;
    } else target.insertBefore(next, cursor);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    target.removeChild(cursor);
    cursor = next;
  }
}

export function disposePlanProgress(root: HTMLElement): void {
  views.get(root)?.dispose();
}

export function renderPlanProgress(
  doc: Document,
  ledger: PlanExecutionLedger,
  events: AgentRunEventRecord[],
  previous?: HTMLElement,
): HTMLElement {
  const existing = previous && views.get(previous);
  if (existing && previous.dataset.llmPlanExecutionId === ledger.executionId) {
    existing.update(ledger, events);
    return previous;
  }
  const root = doc.createElement("section");
  root.className = "llm-plan-container llm-plan-container-execution";
  root.setAttribute("aria-label", "Task progress");
  const trigger = doc.createElement("button");
  trigger.type = "button";
  trigger.className = "llm-plan-progress-trigger";
  const dot = doc.createElement("span");
  dot.className = "llm-plan-progress-trigger-dot";
  dot.setAttribute("aria-hidden", "true");
  const label = doc.createElement("strong");
  label.className = "llm-plan-progress-trigger-label";
  label.textContent = "Task progress";
  const count = doc.createElement("span");
  count.className = "llm-plan-progress-trigger-count";
  const chevron = doc.createElement("span");
  chevron.className = "llm-plan-progress-trigger-chevron";
  chevron.textContent = "⌃";
  chevron.setAttribute("aria-hidden", "true");
  trigger.append(dot, label, count, chevron);
  const popover = doc.createElement("div");
  popover.className = "llm-plan-progress-popover";
  popover.setAttribute("aria-label", "Task progress details");
  const presentation = doc.createElement("div");
  presentation.style.display = "contents";
  const actions = doc.createElement("div");
  actions.className = "llm-plan-actions";
  const resume = doc.createElement("button");
  resume.className = "llm-plan-action llm-plan-approve";
  resume.textContent = "Resume execution";
  actions.appendChild(resume);
  popover.append(presentation, actions);
  const live = doc.createElement("div");
  live.className = "llm-plan-live-region";
  live.setAttribute("aria-live", "polite");
  root.append(trigger, popover, live);
  let current = ledger;
  let currentEvents = events;
  let pinned = false;
  let disposed = false;
  let summary = "";
  const syncOpen = () => {
    root.classList.toggle("llm-plan-progress-open", pinned);
    trigger.setAttribute("aria-expanded", pinned ? "true" : "false");
    trigger.setAttribute(
      "aria-label",
      `${pinned ? "Hide" : "Show"} task progress details, ${summary}`,
    );
  };
  const position = () => {
    if (
      disposed ||
      !root.isConnected ||
      !root.classList.contains("llm-plan-progress-floating")
    )
      return;
    const anchor = trigger.getBoundingClientRect();
    const boundary = root.parentElement!.getBoundingClientRect();
    const width = Math.min(420, Math.max(0, boundary.width - 16));
    const height = doc.documentElement.clientHeight;
    popover.style.position = "fixed";
    popover.style.right = "auto";
    popover.style.left = `${Math.max(boundary.left + 8, Math.min(anchor.left + anchor.width / 2 - width / 2, boundary.right - width - 8))}px`;
    popover.style.bottom = `${Math.max(8, height - anchor.top + 7)}px`;
    popover.style.width = `${width}px`;
    popover.style.maxHeight = `${Math.max(96, Math.min(360, height * 0.5, anchor.top - 24))}px`;
  };
  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    pinned = !pinned;
    syncOpen();
    if (pinned) position();
  });
  root.addEventListener("mouseenter", () => {
    position();
    root.classList.add("llm-plan-progress-hover");
  });
  root.addEventListener("mouseleave", () =>
    root.classList.remove("llm-plan-progress-hover"),
  );
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      pinned = false;
      syncOpen();
      trigger.focus({ preventScroll: true });
    }
  });
  resume.addEventListener("click", () => {
    stageApprovedPlanExecution(current);
    const EventCtor = doc.defaultView?.CustomEvent;
    if (EventCtor)
      root.dispatchEvent(
        new EventCtor(PLAN_APPROVED_EVENT, {
          bubbles: true,
          detail: {
            planId: current.planId,
            revision: current.revision,
            executionId: current.executionId,
            recovery: true,
          },
        }),
      );
  });
  const executionStatusLabel = (
    status: PlanExecutionLedger["status"],
  ): string => {
    switch (status) {
      case "pending":
        return "Starting";
      case "running":
        return "In progress";
      case "waiting_for_user":
        return "Needs input";
      case "interrupted":
        return "Interrupted";
      case "completed":
        return "Completed";
      case "completed_with_exceptions":
        return "Completed with exceptions";
      case "blocked":
        return "Blocked";
      case "failed":
        return "Failed";
      case "cancelled":
        return "Cancelled";
      case "superseded":
        return "Superseded";
    }
    return status;
  };

  const renderExecutionTasks = (ledger: PlanExecutionLedger): HTMLElement => {
    const tasks = doc.createElement("div");
    tasks.className = "llm-plan-task-list";
    ledger.tasks.forEach((entry, index) => {
      const hasDetails = Boolean(
        entry.acceptanceCriteria.length ||
        entry.evidenceIds.length ||
        entry.failureReasons.length ||
        entry.parentTaskId,
      );
      const row = doc.createElement(hasDetails ? "details" : "div") as
        | HTMLDetailsElement
        | HTMLDivElement;
      row.dataset.taskId = entry.taskId;
      row.className = `llm-plan-task llm-plan-task-${entry.status}`;
      if (hasDetails) {
        (row as HTMLDetailsElement).open = [
          "waiting_for_user",
          "interrupted",
          "blocked",
          "failed",
        ].includes(entry.status);
      }

      const line = doc.createElement(hasDetails ? "summary" : "div");
      line.className = "llm-plan-task-line";
      const badge = doc.createElement("span");
      badge.className = `llm-plan-task-badge llm-plan-task-badge-${entry.status}`;
      badge.setAttribute("aria-hidden", "true");
      applyStableAnimationPhase(badge, entry.startedAt || ledger.createdAt);
      const symbol = PLAN_STATUS_SYMBOLS[entry.status] || "";
      badge.textContent = symbol || `${index + 1}`;

      const content = doc.createElement("span");
      content.className = "llm-plan-task-content";
      const label = doc.createElement("span");
      label.className = "llm-plan-task-label";
      label.textContent =
        entry.status === "in_progress" ? entry.activeForm : entry.content;
      content.appendChild(label);
      if (
        entry.status === "in_progress" &&
        entry.activeForm !== entry.content
      ) {
        const original = doc.createElement("span");
        original.className = "llm-plan-task-original";
        original.textContent = entry.content;
        content.appendChild(original);
      } else if (entry.parentTaskId) {
        const supporting = doc.createElement("span");
        supporting.className = "llm-plan-task-original";
        supporting.textContent = "Supporting step";
        content.appendChild(supporting);
      }

      const pill = doc.createElement("span");
      pill.className = `llm-plan-task-pill llm-plan-task-pill-${entry.status}`;
      pill.textContent =
        entry.status === "completed"
          ? "Done"
          : entry.status === "failed"
            ? "Failed"
            : entry.status === "blocked"
              ? "Blocked"
              : entry.status === "waiting_for_user"
                ? "Needs input"
                : entry.status === "interrupted"
                  ? "Interrupted"
                  : entry.status === "skipped"
                    ? "Skipped"
                    : entry.status === "cancelled"
                      ? "Cancelled"
                      : "";
      if (!pill.textContent) pill.hidden = true;

      line.append(badge, content, pill);
      row.appendChild(line);

      if (hasDetails) {
        const detail = doc.createElement("div");
        detail.className = "llm-plan-task-details";
        if (entry.acceptanceCriteria.length) {
          const criteria = doc.createElement("p");
          criteria.className = "llm-plan-task-criteria";
          criteria.textContent = `Done when: ${entry.acceptanceCriteria
            .map((criterion) =>
              typeof criterion === "string" ? criterion : criterion.description,
            )
            .join(" · ")}`;
          detail.appendChild(criteria);
        }
        if (entry.evidenceIds.length) {
          const evidence = doc.createElement("p");
          evidence.className = "llm-plan-task-evidence";
          evidence.textContent = `${entry.evidenceIds.length} evidence record${
            entry.evidenceIds.length === 1 ? "" : "s"
          } attached`;
          detail.appendChild(evidence);
        }
        if (entry.failureReasons.length) {
          const failure = doc.createElement("p");
          failure.className = "llm-plan-task-failure";
          failure.textContent = entry.failureReasons.join(" · ");
          detail.appendChild(failure);
        }
        row.appendChild(detail);
      }
      tasks.appendChild(row);
    });
    return tasks;
  };

  const update = (next: PlanExecutionLedger, trace: AgentRunEventRecord[]) => {
    if (disposed || next.updatedAt < current.updatedAt) return;
    current = next;
    currentEvents = trace;
    root.dataset.llmPlanId = next.planId;
    root.dataset.llmPlanRevision = `${next.revision}`;
    root.dataset.llmPlanExecutionId = next.executionId;
    root.dataset.llmPlanExecutionStatus = next.status;
    applyStableAnimationPhase(root, next.createdAt);
    dot.dataset.status = next.status;
    const required = next.tasks.filter((task) => task.kind === "required_step");
    const completed = required.filter(
      (task) => task.status === "completed",
    ).length;
    summary = `${completed} of ${required.length} required steps complete`;
    const countText = `${completed}/${required.length}`;
    if (count.textContent !== countText) count.textContent = countText;
    if (!isFloatingPlanExecutionStatus(next.status)) {
      pinned = false;
      root.classList.remove(
        "llm-plan-progress-floating",
        "llm-plan-progress-hover",
      );
    }
    syncOpen();
    const content = doc.createElement("div");
    content.style.display = "contents";
    const header = doc.createElement("div");
    header.className = "llm-plan-header";
    const heading = doc.createElement("div");
    heading.className = "llm-plan-heading";
    const title = doc.createElement("strong");
    title.className = "llm-plan-title";
    title.textContent = "Task progress";
    heading.appendChild(title);
    if (next.revision > 1) {
      const version = doc.createElement("span");
      version.className = "llm-plan-version";
      version.textContent = `Revision ${next.revision}`;
      heading.appendChild(version);
    }
    const status = doc.createElement("span");
    status.className = "llm-plan-status";
    status.textContent = executionStatusLabel(next.status);
    status.dataset.status = next.status;
    header.append(heading, status);
    const progress = doc.createElement("div");
    progress.className = "llm-plan-progress";
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-label", "Required task completion");
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", `${required.length}`);
    progress.setAttribute("aria-valuenow", `${completed}`);
    const track = doc.createElement("span");
    track.className = "llm-plan-progress-track";
    track.setAttribute("aria-hidden", "true");
    const fill = doc.createElement("span");
    fill.className = "llm-plan-progress-fill";
    fill.style.width = `${required.length ? Math.round((completed / required.length) * 100) : 0}%`;
    track.appendChild(fill);
    progress.appendChild(track);
    content.append(header, progress, renderExecutionTasks(next));
    const research = [...trace]
      .reverse()
      .find(
        (entry) =>
          entry.payload.type === "plan_research_progress" &&
          entry.payload.progress.executionId === next.executionId,
      )?.payload;
    if (research?.type === "plan_research_progress") {
      const text = doc.createElement("div");
      text.className = "llm-plan-research-progress";
      text.textContent = `Screened ${research.progress.screenedItems.toLocaleString()}/${research.progress.totalItems.toLocaleString()}; deep-read ${research.progress.deepReadCompleted.toLocaleString()}/${research.progress.candidateItems.toLocaleString()}`;
      content.appendChild(text);
    }
    if (presentation.childNodes.length)
      patchPresentation(presentation, content);
    else
      for (const child of Array.from(content.childNodes)) {
        if (child) presentation.appendChild(child);
      }
    actions.hidden = next.status !== "interrupted";
    actions.style.display = actions.hidden ? "none" : "";
    const announcement =
      next.tasks.find((task) => task.status === "in_progress")?.activeForm ||
      status.textContent ||
      "";
    if (live.textContent !== announcement) live.textContent = announcement;
    if (pinned) position();
  };
  const resize = () => {
    if (pinned || root.classList.contains("llm-plan-progress-hover"))
      position();
  };
  doc.defaultView?.addEventListener("resize", resize);
  const ResizeObserverCtor = doc.defaultView?.ResizeObserver;
  const observer = ResizeObserverCtor ? new ResizeObserverCtor(resize) : null;
  observer?.observe(root);
  const view = {
    root,
    update,
    dispose: () => {
      disposed = true;
      observer?.disconnect();
      doc.defaultView?.removeEventListener("resize", resize);
      views.delete(root);
    },
  };
  views.set(root, view);
  update(ledger, events);
  // Hydrate once per mounted execution, never once per streamed chunk.
  void loadPlanExecutionLedger(ledger.executionId)
    .then((stored) => {
      if (
        !disposed &&
        root.isConnected &&
        stored &&
        stored.updatedAt > current.updatedAt
      )
        update(stored, currentEvents);
    })
    .catch((error) =>
      ztoolkit.log("LLM: Failed to hydrate execution progress:", error),
    );
  return root;
}
