// Dogfood config: run vetinari against its OWN GitHub backlog.
// The package name self-resolves to this repo (package.json "exports"), so the
// same import a consuming project uses works here too.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { defineConfig, githubBlockedBy, githubMarkPendingVerify } from "vetinari";

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

  fetchTask: (id) =>
    execFileSync("gh", ["issue", "view", id, "--repo", "jjforge/vetinari", "--json", "title,body,comments,labels"], { encoding: "utf8" }),

  // Powers carve/campaign: reads GitHub's native blocked_by edges — the ones set
  // on #31–#35.
  blockedBy: githubBlockedBy("jjforge/vetinari"),

  // After a wave merges an issue's green and the merged-base gate passes, advance it
  // to the first hop of merge→pending-verify→close: add `pending-verify`, drop
  // `ready-for-agent`. Best-effort (a failed label write never fails the run).
  onIssueMerged: githubMarkPendingVerify("jjforge/vetinari"),

  // No `fileSet` override: the shipped `defaultFileSet` reads the explicit
  // "Touches (existing files): `a.ts`, `b.ts`" marker line each ticket body
  // carries (falling back to a whole-body scan when absent), normalizes cites to
  // their basename, and validates them against the tree — so this repo runs on the
  // one shared resolver rather than a second one that can drift from it.

  toolchainProbe: "node --version && npm --version && claude --version && git --version",

  // safe.directory host-side write needs a writable global git config; the real
  // one is a read-only nix symlink. Kept OUT of .env (which is injected into the
  // container). Mirrors jjforge's setup.
  hostEnv: { GIT_CONFIG_GLOBAL: resolve(".vetinari.local/gitconfig") },
});
