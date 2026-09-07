/** A tool-owned failure may retain verified diagnostic content for its result card. */
export class ToolExecutionFailure extends Error {
  constructor(
    error: unknown,
    readonly content: Record<string, unknown>,
  ) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "ToolExecutionFailure";
  }
}
