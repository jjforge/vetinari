/**
 * A **refusal**: a deliberate "no" from a command, caused by the operator's input or
 * state, whose message names the fix (CONTEXT.md). It is distinct from a **defect** — a
 * broken invariant, a "can't happen" — which keeps its stack trace, and from a **no-op**
 * — a request already satisfied, or one someone else will carry out — which reports on
 * stdout and exits clean. A `Refusal` extends `Error` so the throw stays throwable from
 * deep in `config.ts`/`sandbox.ts` and every existing `catch` keeps working; it is the
 * ONLY marker the process-wide handler checks.
 */
export class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refusal";
  }
}

/** The stderr-write and process-exit effects the handler drives, injected so it is unit-testable. */
export interface CliErrorIO {
  writeStderr: (chunk: string) => void;
  exit: (code: number) => void;
}

/**
 * The one error handler registered for the whole CLI process (`cli.mts`), including code
 * that runs before command dispatch. A `Refusal` prints its message **exactly as written,
 * with no stack frames**, on **stderr**, and exits **4** (CLI exit codes: 0 green/no-op/help,
 * 1 failed, 2 parked, 4 refused). Any other error surfaces as before — its stack trace, exit
 * 1 — so a genuine defect is never mistaken for a refusal. Pure over the injected IO.
 */
export function handleCliError(err: unknown, io: CliErrorIO): void {
  if (err instanceof Refusal) {
    io.writeStderr(err.message + "\n");
    io.exit(4);
    return;
  }
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  io.writeStderr(detail + "\n");
  io.exit(1);
}
