import { spawn } from "node:child_process";

/**
 * The outcome of shelling a project's own CLI through `runChild`: its exit code (null
 * when it never exited — an error before spawn or the timeout firing), the captured
 * stdout and stderr, and whether the wait hit the cap. The route reads the outcome off
 * this rather than from a new exit-code vocabulary (decision 4).
 */
export interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Shell the project's own CLI (`process.argv[1]`, the dumb-router routing every dashboard
 * child uses — ADR 0002) in its root, await it, and return its outcome. The shared seam a
 * route injects and awaits `beside` the fire-and-forget `deps.spawn`: it owns the two
 * things every awaiting adopter needs — stderr capture (piped, not inherited, so a broken
 * child's own words reach the operator, decision 5) and a hard cap on the wait (decision 6).
 *
 * On the cap it resolves `{ timedOut: true }` but does **not** kill the child — a killed
 * child could die between reading the log and appending its event, so the wait gives up
 * while the child runs on. `shellGraftPreview` folds into this (it was a second copy of the
 * same spawn-collect-resolve); `shellPrunePreview` adopts it separately under its own ticket.
 */
export function runChild(
  projectRoot: string,
  args: string[],
  opts: { timeoutMs: number },
): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], ...args], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));

    let settled = false;
    const done = (result: ChildResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // Cap the wait — but leave the child running (decision 6): killing it could lose the
    // event it is about to append. Whoever adopts this reads `timedOut` as "not refused".
    const timer = setTimeout(() => done({ code: null, stdout, stderr, timedOut: true }), opts.timeoutMs);

    child.on("error", () => done({ code: null, stdout, stderr, timedOut: false }));
    child.on("exit", (code) => done({ code, stdout, stderr, timedOut: false }));
  });
}
