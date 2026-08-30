// vetinari project config — committed to your repo, versioned here.
//
// This is a skeleton: fill in your toolchain (in vetinari/Dockerfile) and the
// gates below, then prove the image runs them green:
//   vetinari baseline
//
// Machine-local state (logs, parked tasks, secrets) lives in .vetinari.local/,
// which is gitignored — never committed. `stateDir` below points run state there.
import { defineConfig } from "vetinari";

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
  gates: [
    { cmd: "echo 'replace me with your test command' && false", label: "test" },
  ],

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

  // Fetch the task text for an id — a GitHub issue body, a spec file, anything.
  fetchTask: (id) => `TODO: fetch the task text for ${id}`,

  // Optional: wire your tracker's blocked-by edges to enable prune / campaign planning.
  // import { githubBlockedBy } from "vetinari";
  // blockedBy: githubBlockedBy("owner/repo"),

  // Optional: list open issues by label, so `campaign <label>` (e.g.
  // `campaign ready-for-agent`) selects its issue set from the tracker.
  // import { githubIssuesByLabel } from "vetinari";
  // listByLabel: githubIssuesByLabel("owner/repo"),
});
