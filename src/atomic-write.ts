import { renameSync, writeFileSync } from "node:fs";

/**
 * Write `data` to `path` atomically: to a temp file in the SAME directory (so the
 * final step is a rename within one filesystem, which is atomic), then
 * `renameSync` into place. A writer killed mid-write leaves the untouched
 * destination or a stray `*.tmp` — never the truncated, zero-byte target a plain
 * `writeFileSync` leaves between its truncate and its write. The temp carries the
 * writer's pid so concurrent registrations (a gateway shelling several children)
 * don't collide on one temp name, and a `.tmp` suffix keeps it out of the
 * `*.json` listing (`listProjects`) even if a crash strands it.
 */
export function writeFileAtomic(path: string, data: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, data);
  renameSync(temp, path);
}
