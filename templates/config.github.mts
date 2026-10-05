// vetinari project config — committed to your repo, versioned here.
//
// This is a skeleton: fill in your toolchain (in vetinari/Dockerfile) and the
// gates below, then prove the image runs them green:
//   vetinari baseline
//
// Machine-local state (logs, parked tasks, secrets) lives in .vetinari.local/,
// which is gitignored — never committed. `stateDir` below points run state there.
import { defineConfig, githubTracker } from "vetinari";

export default defineConfig({
  // Name shown in notifications.
  project: "my-project",
  // Docker image carrying your toolchain AND the Claude Code CLI.
  image: "vetinari-my-project",
  // Branch work is cut from and merged into.
  baseBranch: "main",

  // Run state, logs, and parked tasks — kept in the excluded machine-local dir.
  stateDir: ".vetinari.local",

  // The gate the orchestrator runs after every agent turn. REPLACE these with
  // your project's real build/test commands; each must exit non-zero on failure.
  // Both must pass green on baseBranch before you trust them here.
  // Order them cheapest first — generate/format, then lint, then tests. Gates run
  // in order and the first failing command stops the gate and sends its output
  // back to the agent, so a seconds-long check should not wait behind a test run.
  gates: [{ cmd: "echo 'replace me with your test command' && false", label: "test" }],

  // Commands run once per sandbox before the agent starts (install deps, etc.).
  setup: [],

  // How long (seconds) a drained wave waits at its boundary for an answer to a
  // parked member before declaring the wave parked. An answer within the window
  // re-admits the member so it re-runs and merges in the same wave. Default 0 —
  // no grace; park at once and recover with `answer` + `vetinari redrive`.
  parkGraceSeconds: 0,

  // Optional: the agent provider driving each run — `claude` (default), `pi`, or
  // `codex`. Selects which credential key the container reads from .env and the
  // provider's default model/effort. Override per run with `--agent`.
  // agent: { provider: "claude" },

  // Every GitHub tracker seam — fetchTask, blockedBy, listByLabel, postComment,
  // onIssueMerged, reportFinding — with the repo derived from this project's git
  // `origin`. Pass { repo: "owner/repo" } only when your tracker is NOT `origin`;
  // a field set after the spread overrides that one seam.
  ...githubTracker(),
});
