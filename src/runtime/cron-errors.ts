export class CronAccessDeniedError extends Error {
  constructor(message = "cron access denied") {
    super(message);
    this.name = "CronAccessDeniedError";
  }
}

export function isCronAccessDeniedError(error: unknown): error is CronAccessDeniedError {
  return error instanceof Error && error.name === "CronAccessDeniedError";
}
