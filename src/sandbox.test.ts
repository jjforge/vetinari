import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_ENV_VAR } from "./config.ts";
import { agentFor, foreignWorktreeFor, makeSandboxOptions, parseForeignWorktree } from "./sandbox.ts";
import type { ResolvedConfig } from "./config.ts";

// agentFor only reads `cfg.agent` and the VETINARI_AGENT env var — a bare object
// with an `agent` field structurally satisfies what it touches.
const cfgWith = (agent?: ResolvedConfig["agent"]): ResolvedConfig =>
  ({ agent }) as ResolvedConfig;

const withAgentEnv = <T>(value: string | undefined, fn: () => T): T => {
  const prev = process.env[AGENT_ENV_VAR];
  if (value === undefined) delete process.env[AGENT_ENV_VAR];
  else process.env[AGENT_ENV_VAR] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[AGENT_ENV_VAR];
    else process.env[AGENT_ENV_VAR] = prev;
  }
};

test("agentFor dispatches to Claude Code by default — the config's/CLI's absence is today's behavior", () => {
  withAgentEnv(undefined, () => {
    assert.equal(agentFor(cfgWith()).name, "claude-code");
  });
});

test("agentFor dispatches on cfg.agent.provider to the matching sandcastle provider", () => {
  withAgentEnv(undefined, () => {
    assert.equal(agentFor(cfgWith({ provider: "pi" })).name, "pi");
    assert.equal(agentFor(cfgWith({ provider: "codex" })).name, "codex");
    assert.equal(agentFor(cfgWith({ provider: "claude" })).name, "claude-code");
  });
});

test("agentFor reads a VETINARI_AGENT override back, winning over the cfg default — the child-propagation path", () => {
  // cfg says claude, but the parent invocation stamped `--agent pi` onto the env.
  withAgentEnv(JSON.stringify({ provider: "pi" }), () => {
    assert.equal(agentFor(cfgWith({ provider: "claude" })).name, "pi");
  });
});

test("agentFor fails fast on an invalid effort for the selected provider (validated before any container)", () => {
  withAgentEnv(undefined, () => {
    assert.throws(() => agentFor(cfgWith({ provider: "codex", effort: "max" })), /effort/);
  });
});

test("agentFor dispatches to the non-resumable providers too — the loop drives them by fresh re-runs (#212)", () => {
  withAgentEnv(undefined, () => {
    assert.equal(agentFor(cfgWith({ provider: "copilot" })).name, "copilot");
    assert.equal(agentFor(cfgWith({ provider: "cursor" })).name, "cursor");
    assert.equal(agentFor(cfgWith({ provider: "opencode" })).name, "opencode");
  });
});

test("agentFor reads a non-resumable provider back from the env override", () => {
  withAgentEnv(JSON.stringify({ provider: "cursor" }), () => {
    assert.equal(agentFor(cfgWith()).name, "cursor");
  });
});

// The sandbox options only read a handful of scalar config fields; a bare object with
// those satisfies what makeSandboxOptions touches (docker() is pure construction).
const sandboxCfg = (over: Partial<ResolvedConfig> = {}): ResolvedConfig =>
  ({ branchPrefix: "agent/", baseBranch: "main", stateDir: ".vetinari.local", image: "img", mounts: [], ...over }) as unknown as ResolvedConfig;

test("makeSandboxOptions forks agent/<id> from cfg.baseBranch, not the checked-out HEAD (design §3 step 2)", () => {
  const opts = makeSandboxOptions(sandboxCfg({ baseBranch: "release" }), "436");
  assert.equal(opts.branch, "agent/436");
  // baseBranch is the fork point sandcastle uses only for a NEW branch (ignored on reuse),
  // so a fresh agent/436 follows `release` regardless of what is currently checked out.
  assert.equal(opts.baseBranch, "release");
});

// `git worktree list --porcelain` blocks: a `worktree <path>` line then a `branch <ref>`
// line (or `detached`), separated by blank lines.
const porcelain = (entries: Array<[path: string, ref: string]>): string =>
  entries.map(([path, ref]) => `worktree ${path}\nHEAD abc123\nbranch ${ref}\n`).join("\n");

test("parseForeignWorktree names a foreign worktree holding agent/<id> so preflight can refuse (design §3 step 1)", () => {
  const out = porcelain([
    ["/repo", "refs/heads/main"],
    ["/home/reviewer/agent-436", "refs/heads/agent/436"],
  ]);
  assert.equal(parseForeignWorktree(out, "agent/436", "/repo/.vetinari.local"), "/home/reviewer/agent-436");
});

test("parseForeignWorktree ignores sandcastle's own worktree under stateDir — a resume must not be refused", () => {
  const out = porcelain([
    ["/repo", "refs/heads/main"],
    ["/repo/.vetinari.local/worktrees/436", "refs/heads/agent/436"],
  ]);
  assert.equal(parseForeignWorktree(out, "agent/436", "/repo/.vetinari.local"), undefined);
});

test("parseForeignWorktree returns undefined when the branch is checked out nowhere", () => {
  const out = porcelain([["/repo", "refs/heads/main"]]);
  assert.equal(parseForeignWorktree(out, "agent/436", "/repo/.vetinari.local"), undefined);
});

test("foreignWorktreeFor reads the real git worktree list, naming a checkout of agent/<id> outside stateDir", () => {
  const repo = mkdtempSync(join(tmpdir(), "vetinari-wt-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root");
  // No worktree on agent/436 yet — the branch is free.
  assert.equal(foreignWorktreeFor("agent/436", ".vetinari.local", repo), undefined);
  // A review worktree outside stateDir now holds agent/436 — preflight must see it.
  const review = join(repo, "review-436");
  git("worktree", "add", "-q", "-b", "agent/436", review, "main");
  assert.equal(foreignWorktreeFor("agent/436", ".vetinari.local", repo), review);
});
