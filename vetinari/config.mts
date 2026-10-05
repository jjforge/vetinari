// Dogfood config: run vetinari against its OWN GitHub backlog.
// The package name self-resolves to this repo (package.json "exports"), so the
// same import a consuming project uses works here too.
import { defineConfig, githubTracker } from "vetinari";

export default defineConfig({
  project: "vetinari",
  image: "vetinari",
  baseBranch: "main",

  // The gate. Both proven green on main before wiring them here: tsc --noEmit,
  // then node's test runner over every src/*.test.ts via tsx. New test files a
  // ticket adds land in src/ and are picked up by the glob.
  gates: [
    { cmd: "npm run typecheck", label: "typecheck" },
    { cmd: "npx tsx --test src/*.test.ts", label: "test" },
  ],

  // Install devDeps (tsx, typescript) into the worktree before the agent runs,
  // so both gates have their toolchain. Runs as an onSandboxReady hook.
  setup: ["npm ci"],

  // The GitHub tracker preset: fetchTask, blockedBy, listByLabel, postComment,
  // onIssueMerged and reportFinding, all against this repo's `origin`. Findings an agent
  // noticed but did not fix are filed with this repo's issue conventions: `needs-triage`
  // plus a priority (`P2`); issue type is a native field, so there is no `bug` label.
  ...githubTracker({ findingLabels: ["needs-triage", "P2"] }),

  // No `fileSet` override: the shipped `defaultFileSet` reads the explicit
  // "Touches (existing files): `a.ts`, `b.ts`" marker line each ticket body
  // carries (falling back to a whole-body scan when absent), normalizes cites to
  // their basename, and validates them against the tree — so this repo runs on the
  // one shared resolver rather than a second one that can drift from it.

  toolchainProbe: "node --version && npm --version && claude --version && git --version",
});
