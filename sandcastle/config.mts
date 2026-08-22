// Dogfood config: run sandcastle-tdd against its OWN GitHub backlog.
// The package name self-resolves to this repo (package.json "exports"), so the
// same import a consuming project uses works here too.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { defineConfig, githubBlockedBy } from "sandcastle-tdd";

export default defineConfig({
  project: "sandcastle-tdd",
  image: "sandcastle-sandcastle-tdd",
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
    execFileSync("gh", ["issue", "view", id, "--repo", "jjforge/sandcastle-tdd", "--json", "title,body,comments,labels"], { encoding: "utf8" }),

  // Powers carve/campaign: reads GitHub's native blocked_by edges — the ones set
  // on #31–#35.
  blockedBy: githubBlockedBy("jjforge/sandcastle-tdd"),

  // File-set for campaign-plan (axis 2 — keep co-wave tickets file-disjoint).
  // The shipped cites-from-body default is all-or-nothing over EVERY
  // filename-shaped token in the body, so one incidental token (an env file, a
  // spec link) poisons confidence. Instead we read only the explicit
  // "Touches (existing files): `a.ts`, `b.ts`" line each ticket body carries —
  // the file data still lives on the ticket, just parsed deterministically.
  fileSet: (ticket: string) => {
    const i = ticket.indexOf("Touches (existing files):");
    if (i === -1) return { files: [], confident: false };
    const files = [...ticket.slice(i, i + 240).matchAll(/`([\w.\-]+\.[A-Za-z]\w*)`/g)].map((m) => m[1]);
    return { files: [...new Set(files)], confident: files.length > 0 };
  },

  toolchainProbe: "node --version && npm --version && claude --version && git --version",

  // safe.directory host-side write needs a writable global git config; the real
  // one is a read-only nix symlink. Kept OUT of .env (which is injected into the
  // container). Mirrors jjforge's setup.
  hostEnv: { GIT_CONFIG_GLOBAL: resolve(".sandcastle.local/gitconfig") },
});
