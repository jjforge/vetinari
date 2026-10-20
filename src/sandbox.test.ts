import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_ENV_VAR } from "./config.ts";
import {
  agentFor,
  ensureMountSources,
  foreignWorktreeFor,
  makeSandboxOptions,
  mountParentProblems,
  parseForeignWorktree,
  parseStatOwners,
  readMountParentOwners,
  sandboxMounts,
} from "./sandbox.ts";
import type { ResolvedConfig } from "./config.ts";

// agentFor only reads `cfg.agent` and the VETINARI_AGENT env var — a bare object
// with an `agent` field structurally satisfies what it touches.
const cfgWith = (agent?: ResolvedConfig["agent"]): ResolvedConfig => ({ agent }) as ResolvedConfig;

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
// those satisfies what makeSandboxOptions touches. docker() also checks every mount source
// exists, so a test that builds options needs `<stateDir>/worktrees` on disk.
const sandboxCfg = (over: Partial<ResolvedConfig> = {}): ResolvedConfig =>
  ({
    branchPrefix: "agent/",
    baseBranch: "main",
    stateDir: ".vetinari.local",
    image: "img",
    mounts: [],
    ...over,
  }) as unknown as ResolvedConfig;

test("makeSandboxOptions forks agent/<id> from cfg.baseBranch, not the checked-out HEAD (design §3 step 2)", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "vetinari-state-"));
  mkdirSync(join(stateDir, "worktrees"));
  const opts = makeSandboxOptions(sandboxCfg({ baseBranch: "release", stateDir }), "436");
  assert.equal(opts.branch, "agent/436");
  // baseBranch is the fork point sandcastle uses only for a NEW branch (ignored on reuse),
  // so a fresh agent/436 follows `release` regardless of what is currently checked out.
  assert.equal(opts.baseBranch, "release");
});

test("sandboxMounts appends the host worktrees dir, read-only at its own host path, so an in-container prune sees live worktrees", () => {
  const m = { hostPath: "/cache/go", sandboxPath: "/home/agent/go/pkg/mod" };
  assert.deepEqual(sandboxMounts(sandboxCfg({ stateDir: ".vetinari.local", mounts: [m] }), "/r"), [
    m,
    { hostPath: "/r/.vetinari.local/worktrees", sandboxPath: "/r/.vetinari.local/worktrees", readonly: true },
  ]);
  // An absolute stateDir is taken as-is, as sandcastle does.
  assert.deepEqual(sandboxMounts(sandboxCfg({ stateDir: "/s" }), "/r"), [
    { hostPath: "/s/worktrees", sandboxPath: "/s/worktrees", readonly: true },
  ]);
});

test("ensureMountSources creates every mount source, the worktrees dir included, before docker() checks they exist", () => {
  const root = mkdtempSync(join(tmpdir(), "vetinari-mounts-"));
  const cache = join(root, "cache", "go");
  const cfg = sandboxCfg({ stateDir: ".vetinari.local", mounts: [{ hostPath: cache, sandboxPath: "/home/agent/go" }] });
  ensureMountSources(cfg, root);
  assert.ok(existsSync(join(root, ".vetinari.local", "worktrees")));
  assert.ok(existsSync(cache));
  // A second run finds them already there and still succeeds.
  ensureMountSources(cfg, root);
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

// Docker creates a bind mount's missing parents as root, so the agent cannot write beside the
// mount (#512). `owners` maps each ancestor that exists in the image to its owning uid.
const AGENT_UID = 1000;
const mount = (sandboxPath: string) => ({ hostPath: "/cache", sandboxPath });

test("mountParentProblems names a parent missing from the image", () => {
  assert.deepEqual(mountParentProblems([mount("/home/agent/.npm/_cacache")], new Map(), AGENT_UID), [
    { mount: "/home/agent/.npm/_cacache", parent: "/home/agent/.npm" },
  ]);
});

test("mountParentProblems accepts parents that exist and are agent-owned", () => {
  const owners = new Map([
    ["/home/agent/go", AGENT_UID],
    ["/home/agent/go/pkg", AGENT_UID],
  ]);
  assert.deepEqual(mountParentProblems([mount("/home/agent/go/pkg/mod")], owners, AGENT_UID), []);
});

test("mountParentProblems names a parent that exists but is root-owned", () => {
  const owners = new Map([
    ["/home/agent/go", AGENT_UID],
    ["/home/agent/go/pkg", 0],
  ]);
  assert.deepEqual(mountParentProblems([mount("/home/agent/go/pkg/mod")], owners, AGENT_UID), [
    { mount: "/home/agent/go/pkg/mod", parent: "/home/agent/go/pkg" },
  ]);
});

test("mountParentProblems expands ~ to /home/agent, as sandcastle does", () => {
  assert.deepEqual(mountParentProblems([mount("~/go/pkg/mod")], new Map([["/home/agent/go", AGENT_UID]]), AGENT_UID), [
    { mount: "~/go/pkg/mod", parent: "/home/agent/go/pkg" },
  ]);
});

test("mountParentProblems skips a mount outside /home/agent — the worktrees mount's parents are root-owned by design", () => {
  assert.deepEqual(mountParentProblems([mount("/r/.vetinari.local/worktrees")], new Map(), AGENT_UID), []);
});

test("parseStatOwners turns `stat -c '%u %n'` stdout into a path → uid map", () => {
  assert.deepEqual(
    parseStatOwners("1000 /home/agent/go\n0 /home/agent/go/pkg\n1000 /home/agent/my cache\n"),
    new Map([
      ["/home/agent/go", 1000],
      ["/home/agent/go/pkg", 0],
      ["/home/agent/my cache", 1000],
    ]),
  );
});

// A stand-in `docker` that records its argv and answers like `stat` with one path missing:
// the found path on stdout, the missing one on stderr, and a non-zero exit.
const fakeDocker = (script: string): { bin: string; argvFile: string } => {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-docker-"));
  const bin = join(dir, "docker");
  const argvFile = join(dir, "argv");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > ${argvFile}\n${script}\n`);
  chmodSync(bin, 0o755);
  return { bin, argvFile };
};

test("readMountParentOwners probes the image with stat and reads stdout despite a missing path's non-zero exit", () => {
  const { bin, argvFile } = fakeDocker(
    "echo '1000 /home/agent/go'; echo \"stat: cannot statx '/home/agent/go/pkg': No such file or directory\" >&2; exit 1",
  );
  assert.deepEqual(readMountParentOwners("img", ["/home/agent/go", "/home/agent/go/pkg"], bin), new Map([["/home/agent/go", 1000]]));
  // --entrypoint: the shipped Dockerfiles' ENTRYPOINT is `sleep infinity`, which would ignore stat.
  assert.deepEqual(readFileSync(argvFile, "utf8").trim().split("\n"), [
    "run",
    "--rm",
    "--entrypoint",
    "stat",
    "img",
    "-c",
    "%u %n",
    "/home/agent/go",
    "/home/agent/go/pkg",
  ]);
});

test("readMountParentOwners returns undefined, never throwing, when docker cannot be spawned", () => {
  assert.equal(readMountParentOwners("img", ["/home/agent/go"], "/nonexistent/docker"), undefined);
});

test("readMountParentOwners returns undefined when docker itself fails (no image, no stat in it)", () => {
  // docker run exits 125 for a daemon/image error, 127 when the entrypoint is not found.
  assert.equal(readMountParentOwners("img", ["/home/agent/go"], fakeDocker("exit 125").bin), undefined);
  assert.equal(readMountParentOwners("img", ["/home/agent/go"], fakeDocker("exit 127").bin), undefined);
});
