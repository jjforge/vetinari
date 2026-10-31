import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The CI workflow is the only place the gates run outside a campaign worktree, so these
// pin its shape as source text — no YAML parser dependency. Whether it runs green is
// confirmed on GitHub, not here.
const CI_WORKFLOW = join(dirname(fileURLToPath(import.meta.url)), "../.github/workflows/ci.yml");
const ciWorkflowText = () => readFileSync(CI_WORKFLOW, "utf8");

test("CI runs on every push to main and every pull request targeting main (#530)", () => {
  const text = ciWorkflowText();
  assert.match(text, /^on:\n  push:\n    branches: \[main\]\n  pull_request:\n    branches: \[main\]\n/m);
});

// Each job's text, split on its key — so a per-job assertion can't see another job's steps.
const jobText = (job: "gates" | "gates-macos") => {
  const text = ciWorkflowText();
  const linux = text.indexOf("\n  gates:\n");
  const macos = text.indexOf("\n  gates-macos:\n");
  assert.ok(linux >= 0 && macos > linux, "ci.yml has a gates job followed by a gates-macos job");
  return job === "gates" ? text.slice(linux, macos) : text.slice(macos);
};
const runSteps = (jobBody: string) => [...jobBody.matchAll(/^\s+- run: (.+)$/gm)].map((m) => m[1]);
const GATE_STEPS = ["npm ci", "npm run typecheck", "npm run format:check", "npm test"];

test("CI installs and then runs typecheck, format check and the suite, in that order (#530)", () => {
  assert.deepEqual(runSteps(jobText("gates")), GATE_STEPS);
});

// One extra job, not the full version matrix, so host-side breakage on a Mac (paths,
// file modes, process.getuid) is caught. Hosted macOS runners have no Docker.
test("CI runs the same gates on macOS, on Node 22 only (#647)", () => {
  const macos = jobText("gates-macos");
  assert.match(macos, /^\s+runs-on: macos-latest$/m);
  assert.match(macos, /^\s+node-version: (\[22\.x\]|22\.x)$/m);
  assert.deepEqual(runSteps(macos), GATE_STEPS);
});

test("the Linux job still runs on ubuntu-latest (#647)", () => {
  assert.match(jobText("gates"), /^\s+runs-on: ubuntu-latest$/m);
});

// 22.x is the README's floor and the agent image's (node:22-bookworm); 26.x is what the
// host's gateway unit runs. fail-fast off so one version's red does not hide the others.
test("CI runs on every supported Node version, without one failure cancelling the rest (#530)", () => {
  const text = jobText("gates");
  assert.match(text, /^\s+fail-fast: false$/m);
  assert.match(text, /^\s+node-version: \[22\.x, 24\.x, 26\.x\]$/m);
  assert.match(text, /- uses: actions\/setup-node@v4\n\s+with:\n\s+node-version: \$\{\{ matrix\.node-version \}\}\n\s+cache: npm\n/);
});
