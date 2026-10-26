/** A run that can't start or stopped for a reason the user can act on. `fix` is plain language. */
export class RunnerError extends Error {
  constructor(
    public readonly code: "no_api_key" | "sdk_missing" | "budget" | "unknown_job" | "invalid_input" | "wrong_auth" | "timeout",
    message: string,
    public readonly fix?: string,
  ) {
    super(message);
    this.name = "RunnerError";
  }
}
