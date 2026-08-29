import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_ENV_VAR } from "./config.ts";
import { agentFor } from "./sandbox.ts";
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
