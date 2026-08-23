import { spawn } from "node:child_process";

/**
 * Preview a carve by shelling the project's own `carve <issue> --dry-run` via the
 * shared install in its root (ADR 0003): it computes the closure against that
 * project's real `blockedBy` graph and prints it, changing nothing. Returns the
 * printed closure, or null when the child fails. Mirrors the Telegram gateway's
 * `carvePreview` — the same dumb-router routing the aggregated dashboard uses.
 */
export function shellCarvePreview(projectRoot: string, taskId: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "carve", taskId, "--dry-run"], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code === 0 ? out.trim() || null : null));
  });
}

/** The carve closure — the target plus its transitive dependents — that the
 * inline panel discloses before a carve. */
export interface CarveClosure {
  target: string;
  removed: string[];
}

/**
 * Pull the closure out of the project's own `carve <issue> --dry-run` text: its
 * target and every issue the dry-run reports it would drop or keep-banked (both
 * are members of the closure `computeCarve` produced). Pure so the brittle bit —
 * coupling to the CLI's human output — is isolated and unit-tested; the live
 * shell (`shellCarveClosure`) is the only caller.
 */
export function parseCarveClosure(taskId: string, previewText: string): CarveClosure {
  const target = taskId.replace(/^#/, "").trim();
  // The closure is named on the "carve #x → …" line; the "remaining campaign"
  // line lists what stays, so it is deliberately excluded.
  const arrowLine = previewText.split("\n").find((line) => line.includes("→")) ?? "";
  const after = arrowLine.split("→")[1] ?? "";
  const mentioned = [...after.matchAll(/#(\d+)/g)].map((m) => m[1]);
  const removed = [target, ...mentioned.filter((id) => id !== target)].filter((id, i, all) => all.indexOf(id) === i);
  return { target, removed };
}

/**
 * The default `carveClosure`: shell the selected project's own `carve --dry-run`
 * (the same dumb-router routing `shellCarvePreview` uses) and parse the closure
 * out of it. Returns null when the child fails (e.g. no campaign running), which
 * the route surfaces as a 502 for the panel to report.
 */
export async function shellCarveClosure(projectRoot: string, taskId: string): Promise<CarveClosure | null> {
  const previewText = await shellCarvePreview(projectRoot, taskId);
  return previewText == null ? null : parseCarveClosure(taskId, previewText);
}
