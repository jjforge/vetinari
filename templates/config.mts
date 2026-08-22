// sandcastle-tdd project config — committed to your repo, versioned here.
//
// This is a skeleton: fill in your toolchain (in sandcastle/Dockerfile) and the
// gates below, then prove the image runs them green:
//   sandcastle-tdd baseline
//
// Machine-local state (logs, parked tasks, secrets) lives in .sandcastle.local/,
// which is gitignored — never committed. `stateDir` below points run state there.
import { defineConfig } from "sandcastle-tdd";

export default defineConfig({
  // Name shown in notifications.
  project: "my-project",
  // Docker image carrying your toolchain AND the Claude Code CLI.
  image: "sandcastle-my-project",
  // Branch work is cut from and merged into.
  baseBranch: "main",

  // Run state, logs, and parked tasks — kept in the excluded machine-local dir.
  stateDir: ".sandcastle.local",

  // The gate the orchestrator runs after every agent turn. REPLACE these with
  // your project's real build/test commands; each must exit non-zero on failure.
  // Both must pass green on baseBranch before you trust them here.
  gates: [
    { cmd: "echo 'replace me with your test command' && false", label: "test" },
  ],

  // Commands run once per sandbox before the agent starts (install deps, etc.).
  setup: [],

  // Fetch the task text for an id — a GitHub issue body, a spec file, anything.
  fetchTask: (id) => `TODO: fetch the task text for ${id}`,

  // Optional: wire your tracker's blocked-by edges to enable carve / campaign-plan.
  // import { githubBlockedBy } from "sandcastle-tdd";
  // blockedBy: githubBlockedBy("owner/repo"),
});
