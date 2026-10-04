import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ServerResponse } from "node:http";
import type { DashboardDeps } from "./dashboard-http.ts";
import type { ProjectPointer } from "./registry.ts";

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
export function runChild(projectRoot: string, args: string[], opts: { timeoutMs: number }): Promise<ChildResult> {
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

/**
 * The outcome of `startChild`: `running` when the child outlived the startup window (left
 * running); otherwise its exit code (null on a spawn error) and the last non-empty line of
 * its log file ("" if none).
 */
export interface StartedChild {
  code: number | null;
  lastLine: string;
  running: boolean;
}

/**
 * Shell the project's own CLI in its root the way `runChild` does, but for a long-lived
 * child (`redrive`, `answer`) that may run for hours (#369): both its stdout and stderr go
 * to `logFile` (file descriptors, not pipes — nothing grows in the dashboard's memory), and
 * the wait is only a short startup window. A child that exits inside it resolves with its
 * code and the log's last non-empty line; one still running at `startupMs` resolves
 * `running: true` and is left running, never killed.
 */
export function startChild(projectRoot: string, args: string[], opts: { logFile: string; startupMs: number }): Promise<StartedChild> {
  mkdirSync(dirname(opts.logFile), { recursive: true });
  const fd = openSync(opts.logFile, "a");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], ...args], {
      cwd: projectRoot,
      stdio: ["ignore", fd, fd],
    });
    // The child holds its own copy of the descriptor; the dashboard needs none.
    closeSync(fd);

    let settled = false;
    const done = (result: StartedChild) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const lastLine = () =>
      readFileSync(opts.logFile, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .at(-1) ?? "";
    const timer = setTimeout(() => done({ code: null, lastLine: "", running: true }), opts.startupMs);

    child.on("error", () => done({ code: null, lastLine: lastLine(), running: false }));
    child.on("exit", (code) => done({ code, lastLine: lastLine(), running: false }));
  });
}

/**
 * The shared tail of the `/redrive` and `/answer` routes (#369): start `args` in the project's
 * root through `deps.startChild`, its output in `<baseLocation>/logs/dashboard/<verb>-<ts>.log`
 * (a subdirectory, so the live-update watcher on `logs/` is not fired by every child write),
 * and answer with what the startup window saw. Exit 0 or 2 (green or parked) redirects to the
 * board; exit 4 (a refusal) is a 409 carrying its sentence; any other exit or a spawn error is
 * a 502 carrying the child's last line; a child still running is a 202 naming its log file.
 */
export async function respondWithStartedChild(
  res: ServerResponse,
  deps: DashboardDeps,
  pointer: ProjectPointer,
  args: string[],
): Promise<void> {
  const verb = args[0];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(pointer.baseLocation, "logs", "dashboard", `${verb}-${stamp}.log`);
  const { code, lastLine, running } = await (deps.startChild ?? startChild)(pointer.projectRoot, args, {
    logFile,
    startupMs: deps.childStartupMs ?? 5_000,
  });
  const text = { "content-type": "text/plain; charset=utf-8" };
  if (running) res.writeHead(202, text).end(`${verb} started — output in ${logFile}`);
  else if (code === 0 || code === 2) res.writeHead(303, { location: `/?project=${encodeURIComponent(pointer.project)}` }).end();
  else if (code === 4) res.writeHead(409, text).end(lastLine);
  else res.writeHead(502, text).end(lastLine || `${verb} did not start — no output`);
}
