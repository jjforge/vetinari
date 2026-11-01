import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
import type { MountSpec, ResolvedConfig } from "./config.ts";
import type { SandboxProvider } from "@ai-hero/sandcastle";
import { withEnv } from "./test-support.ts";

// agentFor only reads `cfg.agent` and the VETINARI_AGENT env var — a bare object
// with an `agent` field structurally satisfies what it touches.
const cfgWith = (agent?: ResolvedConfig["agent"]): ResolvedConfig => ({ agent }) as ResolvedConfig;

const withAgentEnv = <T>(value: string | undefined, fn: () => T): T => withEnv({ [AGENT_ENV_VAR]: value }, fn);

test("agentFor dispatches to Claude Code by default — the config's/CLI's absence is today's behavior", () => {
  withAgentEnv(undefined, () => {
    assert.equal(agentFor(cfgWith(), "42").name, "claude-code");
  });
});

test("agentFor dispatches on cfg.agent.provider to the matching sandcastle provider", () => {
  withAgentEnv(undefined, () => {
    assert.equal(agentFor(cfgWith({ provider: "pi" }), "42").name, "pi");
    assert.equal(agentFor(cfgWith({ provider: "codex" }), "42").name, "codex");
    assert.equal(agentFor(cfgWith({ provider: "claude" }), "42").name, "claude-code");
  });
});

test("agentFor reads a VETINARI_AGENT override back, winning over the cfg default — the child-propagation path", () => {
  // cfg says claude, but the parent invocation stamped `--agent pi` onto the env.
  withAgentEnv(JSON.stringify({ provider: "pi" }), () => {
    assert.equal(agentFor(cfgWith({ provider: "claude" }), "42").name, "pi");
  });
});

test("agentFor fails fast on an invalid effort for the selected provider (validated before any container)", () => {
  withAgentEnv(undefined, () => {
    assert.throws(() => agentFor(cfgWith({ provider: "codex", effort: "max" }), "42"), /effort/);
  });
});

test("agentFor dispatches to the non-resumable providers too — the loop drives them by fresh re-runs (#212)", () => {
  withAgentEnv(undefined, () => {
    assert.equal(agentFor(cfgWith({ provider: "cursor" }), "42").name, "cursor");
    assert.equal(agentFor(cfgWith({ provider: "opencode" }), "42").name, "opencode");
  });
});

// The Copilot provider for task 42 under an absolute stateDir (ADR 0024).
const copilotFor = (stateDir = mkdtempSync(join(tmpdir(), "vetinari-copilot-"))) =>
  withAgentEnv(undefined, () => agentFor({ agent: { provider: "copilot" }, stateDir } as ResolvedConfig, "42"));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sessionIdArg = (command: string): string | undefined => / --session-id '([^']*)'$/.exec(command)?.[1];

test("agentFor makes copilot resumable: it captures sessions and carries a sessionStorage (ADR 0024)", () => {
  const agent = copilotFor();
  assert.equal(agent.name, "copilot");
  assert.equal(agent.captureSessions, true);
  assert.ok(agent.sessionStorage);
});

test("a fresh copilot turn starts a new session under a fresh --session-id uuid, never a reused one", () => {
  const agent = copilotFor();
  const base = "copilot -p 'do it' --output-format json --model 'auto' --allow-all-tools";
  const a = agent.buildPrintCommand({ prompt: "do it", dangerouslySkipPermissions: true }).command;
  const b = agent.buildPrintCommand({ prompt: "do it", dangerouslySkipPermissions: true }).command;
  assert.match(sessionIdArg(a) ?? "", UUID);
  assert.match(sessionIdArg(b) ?? "", UUID);
  assert.notEqual(sessionIdArg(a), sessionIdArg(b));
  assert.equal(a, `${base} --session-id '${sessionIdArg(a)}'`);
  assert.doesNotMatch(a, /--resume/);
});

test("a resumed copilot turn continues the session with --resume and passes no --session-id", () => {
  const command = copilotFor().buildPrintCommand({ prompt: "do it", dangerouslySkipPermissions: true, resumeSession: "abc" }).command;
  assert.equal(command, "copilot -p 'do it' --output-format json --model 'auto' --allow-all-tools --resume 'abc'");
  assert.doesNotMatch(command, /--session-id/);
});

test("a copilot provider reports the session id of the turn it last built, even after the stream announced it", () => {
  const agent = copilotFor();
  assert.equal(agent.turnSessionId?.(), undefined, "no turn built yet");
  const fresh = sessionIdArg(agent.buildPrintCommand({ prompt: "do it", dangerouslySkipPermissions: true }).command);
  agent.parseStreamLine(JSON.stringify({ type: "assistant.message_delta", data: { deltaContent: "hi" } }));
  assert.equal(agent.turnSessionId?.(), fresh);
  agent.buildPrintCommand({ prompt: "do it", dangerouslySkipPermissions: true, resumeSession: "abc" });
  assert.equal(agent.turnSessionId?.(), "abc");
});

test("copilot's stream parser is sandcastle's: a result line yields its session id", () => {
  const agent = copilotFor();
  assert.deepEqual(agent.parseStreamLine(JSON.stringify({ type: "result", sessionId: "abc", exitCode: 0 })), [
    { type: "session_id", sessionId: "abc" },
  ]);
});

test("copilot's sessionStorage finds a session only once its session-state dir exists in .vetinari.local/copilot/<task-id>/", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "vetinari-copilot-"));
  const storage = copilotFor(stateDir).sessionStorage!;
  const dir = join(stateDir, "copilot", "42", "session-state", "abc");
  assert.equal(await storage.existsOnHost("/elsewhere", "abc"), false);
  assert.equal(storage.hostSessionFilePath("/elsewhere", "abc"), dir);
  assert.equal((await storage.findByIdOnHost("abc")).path, undefined);
  mkdirSync(dir, { recursive: true });
  assert.equal(await storage.existsOnHost("/elsewhere", "abc"), true);
  assert.equal((await storage.findByIdOnHost("abc")).path, dir);
});

test("agentFor reads a non-resumable provider back from the env override", () => {
  withAgentEnv(JSON.stringify({ provider: "cursor" }), () => {
    assert.equal(agentFor(cfgWith(), "42").name, "cursor");
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

test("with no sandbox factory configured, makeSandboxOptions uses the Docker provider", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "vetinari-state-"));
  mkdirSync(join(stateDir, "worktrees"));
  assert.equal(makeSandboxOptions(sandboxCfg({ stateDir }), "436").sandbox.name, "docker");
});

test("a configured sandbox factory builds the provider, given the config and this run's mounts", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "vetinari-state-"));
  const fake = { name: "fake", env: {} } as unknown as SandboxProvider;
  const calls: [ResolvedConfig, { mounts: MountSpec[] }][] = [];
  const sandbox = (cfg: ResolvedConfig, ctx: { mounts: MountSpec[] }) => (calls.push([cfg, ctx]), fake);
  const cfg = sandboxCfg({ stateDir, agent: { provider: "copilot" }, sandbox });
  withAgentEnv(undefined, () => {
    // An agent run of a copilot provider: its Copilot mount reaches the factory.
    assert.equal(makeSandboxOptions(cfg, "42", "42").sandbox, fake);
    // A gate or baseline sandbox names no issue, so no Copilot mount.
    assert.equal(makeSandboxOptions(cfg, "42").sandbox, fake);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], cfg);
    assert.deepEqual(calls[0][1], { mounts: sandboxMounts(cfg, process.cwd(), "42") });
    assert.ok(calls[0][1].mounts.some((m) => m.sandboxPath === "/home/agent/.copilot"));
    assert.equal(calls[1][0], cfg);
    assert.deepEqual(calls[1][1], { mounts: sandboxMounts(cfg, process.cwd()) });
    assert.ok(!calls[1][1].mounts.some((m) => m.sandboxPath === "/home/agent/.copilot"));
  });
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

test("a copilot agent run mounts the issue's Copilot directory read-write at ~/.copilot, and creates it first (ADR 0024)", () => {
  const root = mkdtempSync(join(tmpdir(), "vetinari-mounts-"));
  const cfg = sandboxCfg({ stateDir: "/s", agent: { provider: "copilot" } });
  assert.deepEqual(
    withAgentEnv(undefined, () => sandboxMounts(cfg, "/r", "42")),
    [
      { hostPath: "/s/worktrees", sandboxPath: "/s/worktrees", readonly: true },
      { hostPath: "/s/copilot/42", sandboxPath: "/home/agent/.copilot" },
    ],
  );
  // A relative stateDir resolves against the project root, as the worktrees mount does.
  const rel = sandboxCfg({ stateDir: ".vetinari.local", agent: { provider: "copilot" } });
  withAgentEnv(undefined, () => ensureMountSources(rel, root, "42"));
  assert.ok(existsSync(join(root, ".vetinari.local", "copilot", "42")));
});

test("only a copilot agent run gets a Copilot directory: not a claude run, nor a gate or baseline sandbox", () => {
  const root = mkdtempSync(join(tmpdir(), "vetinari-mounts-"));
  const claude = sandboxCfg({ stateDir: ".vetinari.local", agent: { provider: "claude" } });
  const copilot = sandboxCfg({ stateDir: ".vetinari.local", agent: { provider: "copilot" } });
  withAgentEnv(undefined, () => {
    assert.ok(!sandboxMounts(claude, root, "42").some((m) => m.sandboxPath === "/home/agent/.copilot"));
    // The gate and baseline sandboxes are not agent runs, so they name no issue.
    assert.ok(!sandboxMounts(copilot, root).some((m) => m.sandboxPath === "/home/agent/.copilot"));
    ensureMountSources(claude, root, "42");
    ensureMountSources(copilot, root);
  });
  assert.ok(!existsSync(join(root, ".vetinari.local", "copilot")));
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
  // Resolved: git lists worktrees by real path, and macOS's tmpdir sits behind a /var symlink.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "vetinari-wt-")));
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
  // --pull never: a locally missing image fails the probe rather than pulling it from a registry.
  assert.deepEqual(readFileSync(argvFile, "utf8").trim().split("\n"), [
    "run",
    "--rm",
    "--pull",
    "never",
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

test("readMountParentOwners returns undefined, never hanging, when docker does not answer in time", () => {
  const started = Date.now();
  assert.equal(readMountParentOwners("img", ["/home/agent/go"], fakeDocker("sleep 5").bin, 200), undefined);
  assert.ok(Date.now() - started < 2000, `probe took ${Date.now() - started} ms`);
});

test("readMountParentOwners returns undefined within about its timeout even when docker ignores SIGTERM", () => {
  // The timeout is a hard kill: a child that traps TERM must not hold the probe past it.
  const started = Date.now();
  assert.equal(readMountParentOwners("img", ["/home/agent/go"], fakeDocker('trap "" TERM; sleep 5').bin, 200), undefined);
  assert.ok(Date.now() - started < 2000, `probe took ${Date.now() - started} ms`);
});

test("readMountParentOwners returns undefined when docker itself fails (no image, no stat in it)", () => {
  // docker run exits 125 for a daemon/image error (an image missing under --pull never), 127 when
  // the entrypoint is not found.
  assert.equal(readMountParentOwners("img", ["/home/agent/go"], fakeDocker("exit 125").bin), undefined);
  assert.equal(readMountParentOwners("img", ["/home/agent/go"], fakeDocker("exit 127").bin), undefined);
});
