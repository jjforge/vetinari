#!/usr/bin/env -S npx tsx
/**
 * Static assertion of the upstream surface this orchestrator is built on.
 *
 * Most of our sandbox handling is deliberately loosely typed (the library's
 * result objects carry optional members we probe at runtime), so `tsc` will NOT
 * catch a renamed export or a dropped method. This will, in about a second and
 * without Docker — run it first after bumping @ai-hero/sandcastle, then
 * `baseline`, then one real `run`.
 *
 * It cannot check BEHAVIOUR. The four behaviours we depend on that no static
 * check can see are printed on success; re-read them against the upstream
 * changelog on any minor bump, because pre-1.0 minors are where they change.
 */
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

const problems: string[] = [];

const wantFunction = (name: string, v: unknown) => {
  if (typeof v !== "function") problems.push(`missing or non-function export: ${name}`);
};

wantFunction("createSandbox", (sandcastle as any).createSandbox);
wantFunction("claudeCode", (sandcastle as any).claudeCode);
wantFunction("sandboxes/docker:docker", docker);

// The provider factory must still accept the options we pass it.
try {
  const provider: any = docker({ imageName: "contract-check", mounts: [{ hostPath: ".", sandboxPath: "/tmp/x" }] } as any);
  if (!provider) problems.push("docker() returned nothing for {imageName, mounts}");
} catch (err: any) {
  problems.push(`docker({imageName, mounts}) threw: ${err?.message ?? err}`);
}

// The agent factory must still accept a model id plus an effort option.
try {
  const agent: any = (sandcastle as any).claudeCode("claude-opus-4-8", { effort: "high" });
  if (!agent) problems.push("claudeCode() returned nothing");
} catch (err: any) {
  problems.push(`claudeCode(model, {effort}) threw: ${err?.message ?? err}`);
}

if (problems.length) {
  console.error("sandcastle contract check FAILED:\n  - " + problems.join("\n  - "));
  process.exit(1);
}

console.log(`sandcastle contract check OK (@ai-hero/sandcastle surface intact)

Not checkable statically — verify these against the upstream changelog on any
minor bump, then prove them with \`baseline\` and one real \`run\`:
  1. A sandbox command RETURNS a non-zero exit code rather than throwing. If
     that inverts, every red gate reads as a pass.
  2. resumeSession stays incompatible with maxIterations > 1 (we always drive
     iterations ourselves, so this only matters if it silently starts working).
  3. An idle agent still THROWS a timeout error we can catch and convert to a
     park — a change to a returned result would strand blocked work.
  4. Session capture still writes host-side JSONL, and re-creating a sandbox on
     an existing branch still reuses that worktree. Together those are what make
     park then answer survive a fresh process.`);
