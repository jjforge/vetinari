// The start barrier the multi-process tests hold their children behind: each child writes a
// `ready.*` file into a shared dir and spins until a `go` file appears there.
import type { ChildProcess } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Resolve once `dir` holds one `ready.*` file per child, then write `dir/go`. If any child
 * exits (or fails to spawn) first, reject at once naming it, never write `go`, and stop the
 * children still waiting — left alone they would spin on `go` forever. */
export async function awaitReadyBarrier(dir: string, children: ChildProcess[]): Promise<void> {
  const spawnErrors = new Map<number, Error>();
  children.forEach((child, i) => child.on("error", (err) => spawnErrors.set(i, err)));
  for (;;) {
    const i = children.findIndex((c, j) => spawnErrors.has(j) || c.exitCode !== null || c.signalCode !== null);
    if (i !== -1) {
      for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill();
      const c = children[i];
      const err = spawnErrors.get(i);
      throw new Error(
        err
          ? `child ${i} failed to start: ${err.message}`
          : `child ${i} exited before ready: ${c.signalCode ? `signal ${c.signalCode}` : `code ${c.exitCode}`}`,
      );
    }
    if (readdirSync(dir).filter((f) => f.startsWith("ready.")).length >= children.length) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  writeFileSync(join(dir, "go"), "");
}
