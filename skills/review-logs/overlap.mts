// The config lens's entry: `overlap.mts <projectRoot>` prints the overlap replay report.
// Kept trivial — the logic and its tests live in vetinari's src/overlap-replay.ts.
import { resolve } from "node:path";
import { runOverlapReplay } from "../../src/overlap-replay.ts";

const root = process.argv[2];
if (!root) {
  console.error("usage: overlap.mts <projectRoot>");
  process.exit(2);
}
// Run from the project root, as vetinari does, so a config resolver that reads the cwd sees the project.
process.chdir(resolve(root));
console.log(await runOverlapReplay(process.cwd()));
