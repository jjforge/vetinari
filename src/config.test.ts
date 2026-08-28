import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AGENT_PROVIDERS,
  containerShareWeight,
  encodeAgentOverride,
  loadConfig,
  parseAgentFlags,
  missingCredentials,
  parseAgentOverride,
  resolveAgentSelection,
  resolveConfigPath,
  resolveDestination,
} from "./config.ts";

const CONFIG_BODY = `export default {
  project: "demo",
  image: "img",
  baseBranch: "main",
  gates: [{ cmd: "true" }],
  fetchTask: (id) => id,
};
`;

const writeConfig = (baseDir: string, rel: string, body = CONFIG_BODY) => {
  const full = join(baseDir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
  return full;
};

const scratch = () => mkdtempSync(join(tmpdir(), "vetinari-config-"));

const touch = (baseDir: string, rel: string) => {
  const full = join(baseDir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "export default {}\n");
  return full;
};

test("resolveConfigPath prefers committed vetinari/config.mts over every legacy location", () => {
  const dir = scratch();
  touch(dir, "vetinari/config.mts");
  touch(dir, ".sandcastle/config.mts");

  const res = resolveConfigPath(dir);

  assert.equal(res?.path, join(dir, "vetinari/config.mts"));
  assert.equal(res?.deprecatedFrom, undefined);
});

for (const legacy of [".sandcastle/config.mts"]) {
  test(`resolveConfigPath reports ${legacy} as a deprecated origin when it is the only config`, () => {
    const dir = scratch();
    touch(dir, legacy);

    const res = resolveConfigPath(dir);

    assert.equal(res?.path, join(dir, legacy));
    assert.equal(res?.deprecatedFrom, legacy);
  });
}

test("resolveConfigPath returns undefined when no candidate exists", () => {
  assert.equal(resolveConfigPath(scratch()), undefined);
});

test("loadConfig defaults state under .vetinari.local, with parkedDir and logFile following", async () => {
  const cfgPath = writeConfig(scratch(), "vetinari/config.mts");

  const cfg = await loadConfig(cfgPath);

  assert.equal(cfg.stateDir, ".vetinari.local");
  assert.equal(cfg.parkedDir, ".vetinari.local/parked");
  assert.equal(cfg.logFile, ".vetinari.local/logs/orchestrator.jsonl");
});

test("containerShareWeight maps the three tiers to internal fair-share weights (~7:2:1)", () => {
  assert.equal(containerShareWeight("high"), 7);
  assert.equal(containerShareWeight("medium"), 2);
  assert.equal(containerShareWeight("low"), 1);
});

test("loadConfig defaults containerShare to medium, and honors an explicit tier", async () => {
  const dflt = await loadConfig(writeConfig(scratch(), "vetinari/config.mts"));
  assert.equal(dflt.containerShare, "medium");

  const shared = `export default {
  project: "demo",
  image: "img",
  baseBranch: "main",
  gates: [{ cmd: "true" }],
  fetchTask: (id) => id,
  containerShare: "high",
};
`;
  const cfg = await loadConfig(writeConfig(scratch(), "vetinari/config.mts", shared));
  assert.equal(cfg.containerShare, "high");
});

test("loadConfig's not-found error leads with the canonical path and mentions --config", async () => {
  const cwd = process.cwd();
  process.chdir(scratch());
  try {
    await assert.rejects(loadConfig(), (err: Error) => {
      const msg = err.message;
      assert.match(msg, /--config <path>/);
      assert.match(msg, /vetinari\/config\.mts/);
      return true;
    });
  } finally {
    process.chdir(cwd);
  }
});

test("loadConfig warns naming the canonical location when it resolves from a legacy config", async () => {
  const dir = scratch();
  writeConfig(dir, ".sandcastle/config.mts");
  const cwd = process.cwd();
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  process.chdir(dir);
  try {
    await loadConfig();
  } finally {
    process.chdir(cwd);
    console.warn = origWarn;
  }

  const warning = warnings.join("\n");
  assert.match(warning, /deprecated/i);
  assert.match(warning, /\.sandcastle\/config\.mts/);
  assert.match(warning, /vetinari\/config\.mts/);
});

test("loadConfig does not warn when resolving from the canonical location", async () => {
  const dir = scratch();
  writeConfig(dir, "vetinari/config.mts");
  const cwd = process.cwd();
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  process.chdir(dir);
  try {
    await loadConfig();
  } finally {
    process.chdir(cwd);
    console.warn = origWarn;
  }

  assert.deepEqual(warnings, []);
});

test("resolveDestination prefers a bare category entry over the wildcard default", () => {
  const notify = { "*": "ops", failure: "alerts" };

  assert.equal(resolveDestination(notify, "failure"), "alerts");
  assert.equal(resolveDestination(notify, "success"), "ops");
});

test("resolveDestination lets an exact category:event entry win over the bare category and wildcard", () => {
  const notify = { "*": "ops", progress: "chatter", "progress:prune": "alerts" };

  assert.equal(resolveDestination(notify, "progress", "prune"), "alerts");
  // An event with no exact entry falls back to the bare category, not the wildcard.
  assert.equal(resolveDestination(notify, "progress", "wave-start"), "chatter");
});

test("resolveDestination returns undefined for an unmapped category with no wildcard", () => {
  const notify = { failure: "alerts" };

  assert.equal(resolveDestination(notify, "success"), undefined);
  assert.equal(resolveDestination(notify, "progress", "prune"), undefined);
});

const withNotify = (notify: string) =>
  CONFIG_BODY.replace("fetchTask:", `notify: ${notify},\n  fetchTask:`);

test("loadConfig rejects a notify map that fans the interactive question category out to two destinations", async () => {
  const cfgPath = writeConfig(
    scratch(),
    "vetinari/config.mts",
    withNotify(`{ question: "alerts", "question:urgent": "ops" }`),
  );

  await assert.rejects(loadConfig(cfgPath), (err: Error) => {
    assert.match(err.message, /question/);
    assert.match(err.message, /alerts/);
    assert.match(err.message, /ops/);
    return true;
  });
});

test("loadConfig rejects question fan-out that comes via the wildcard catching unlisted question events", async () => {
  // `question:urgent` -> ops, but every other question event falls to `*` -> alerts.
  const cfgPath = writeConfig(
    scratch(),
    "vetinari/config.mts",
    withNotify(`{ "question:urgent": "ops", "*": "alerts" }`),
  );

  await assert.rejects(loadConfig(cfgPath), /question/);
});

test("loadConfig accepts a notify map where question resolves to one destination while broadcasts fan freely", async () => {
  const cfgPath = writeConfig(
    scratch(),
    "vetinari/config.mts",
    withNotify(`{ "*": "ops", question: "alerts", "question:urgent": "alerts", failure: "pager", "progress:prune": "chatter" }`),
  );

  const cfg = await loadConfig(cfgPath);

  assert.equal(cfg.notify?.question, "alerts");
});

test("resolveAgentSelection defaults to claude, its default model, and effort high when nothing is set (today's behavior)", () => {
  assert.deepEqual(resolveAgentSelection(undefined), {
    provider: "claude",
    model: "claude-opus-4-8",
    effort: "high",
  });
});

test("resolveAgentSelection takes the provider default from cfg.agent, falling back to that provider's default model", () => {
  assert.deepEqual(resolveAgentSelection({ provider: "codex" }), {
    provider: "codex",
    model: AGENT_PROVIDERS.codex.defaultModel,
    effort: "high",
  });
});

test("resolveAgentSelection honors an explicit model/effort on cfg.agent", () => {
  assert.deepEqual(
    resolveAgentSelection({ provider: "pi", model: "claude-sonnet-4-6", effort: "xhigh" }),
    { provider: "pi", model: "claude-sonnet-4-6", effort: "xhigh" },
  );
});

test("resolveAgentSelection lets a CLI override win over the cfg default (precedence: override > cfg > default)", () => {
  assert.deepEqual(
    resolveAgentSelection({ provider: "claude", effort: "low" }, { provider: "codex", effort: "high" }),
    { provider: "codex", model: AGENT_PROVIDERS.codex.defaultModel, effort: "high" },
  );
});

test("resolveAgentSelection does not leak the cfg's model/effort across a provider switch — they belonged to the other provider", () => {
  // cfg is claude with a claude model + a claude-only effort; overriding to codex must
  // fall to codex's own defaults, not carry the claude model or the (invalid-for-codex) effort.
  assert.deepEqual(
    resolveAgentSelection({ provider: "claude", model: "claude-opus-4-8", effort: "max" }, { provider: "codex" }),
    { provider: "codex", model: AGENT_PROVIDERS.codex.defaultModel, effort: "high" },
  );
});

test("resolveAgentSelection validates effort against the SELECTED provider's own vocabulary, failing fast with the valid set", () => {
  // "max" is a claude effort but not a codex one.
  assert.throws(
    () => resolveAgentSelection({ provider: "codex", effort: "max" }),
    (e: Error) => {
      assert.match(e.message, /effort/);
      assert.match(e.message, /codex/);
      assert.match(e.message, /max/);
      // lists the valid set for the provider
      assert.match(e.message, /low.*xhigh|xhigh/);
      return true;
    },
  );
  // pi has its own richer set (off..xhigh) — "off" is valid for pi.
  assert.equal(resolveAgentSelection({ provider: "pi", effort: "off" }).effort, "off");
});

test("resolveAgentSelection rejects a non-resumable provider with a clear message pointing at the follow-up", () => {
  assert.throws(
    () => resolveAgentSelection(undefined, { provider: "copilot" }),
    (e: Error) => {
      assert.match(e.message, /copilot/);
      assert.match(e.message, /claude, pi, codex/);
      assert.match(e.message, /#212/);
      return true;
    },
  );
});

test("resolveAgentSelection rejects an unknown provider naming the supported set", () => {
  assert.throws(
    () => resolveAgentSelection(undefined, { provider: "gpt" }),
    (e: Error) => {
      assert.match(e.message, /gpt/);
      assert.match(e.message, /claude, pi, codex/);
      return true;
    },
  );
});

test("parseAgentFlags pulls --agent/--model/--effort out of the args, leaving the rest untouched and in order", () => {
  const { override, rest } = parseAgentFlags([
    "623",
    "--agent",
    "pi",
    "--effort",
    "xhigh",
    "--model",
    "claude-sonnet-4-6",
  ]);
  assert.deepEqual(override, { provider: "pi", effort: "xhigh", model: "claude-sonnet-4-6" });
  assert.deepEqual(rest, ["623"]);
});

test("parseAgentFlags accepts the --flag=value form and preserves other flags/positionals", () => {
  const { override, rest } = parseAgentFlags([
    "--name",
    "gateway work",
    "--agent=codex",
    "436 611",
    "--auto-prune",
  ]);
  assert.deepEqual(override, { provider: "codex" });
  assert.deepEqual(rest, ["--name", "gateway work", "436 611", "--auto-prune"]);
});

test("parseAgentFlags returns an empty override when no agent flags are present", () => {
  const { override, rest } = parseAgentFlags(["623", "--resume"]);
  assert.deepEqual(override, {});
  assert.deepEqual(rest, ["623", "--resume"]);
});

test("encodeAgentOverride/parseAgentOverride round-trip a partial CLI override for child propagation", () => {
  const over = { provider: "pi", effort: "xhigh" };
  assert.deepEqual(parseAgentOverride(encodeAgentOverride(over)), over);
});

test("parseAgentOverride reads an unset or junk env var as an empty override (no crash)", () => {
  assert.deepEqual(parseAgentOverride(undefined), {});
  assert.deepEqual(parseAgentOverride(""), {});
  assert.deepEqual(parseAgentOverride("not json"), {});
});

test("missingCredentials reports the provider's keys when none are present in the .env, and none when one is", () => {
  const dir = scratch();
  // No .env at all → claude's keys are all missing.
  assert.deepEqual(missingCredentials("claude", join(dir, ".env")), AGENT_PROVIDERS.claude.credentialKeys);

  // codex needs OPENAI_API_KEY.
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "OPENAI_API_KEY=sk-abc\n");
  assert.deepEqual(missingCredentials("codex", envPath), []);
  // …but claude's keys are still absent from that same file.
  assert.deepEqual(missingCredentials("claude", envPath), AGENT_PROVIDERS.claude.credentialKeys);

  // Any one of claude's alternative keys present satisfies it (OAuth token OR API key).
  writeFileSync(envPath, "ANTHROPIC_API_KEY=sk-ant\n");
  assert.deepEqual(missingCredentials("claude", envPath), []);
});

test("missingCredentials treats a present-but-empty assignment as absent", () => {
  const dir = scratch();
  const envPath = join(dir, ".env");
  writeFileSync(envPath, "OPENAI_API_KEY=\n");
  assert.deepEqual(missingCredentials("codex", envPath), AGENT_PROVIDERS.codex.credentialKeys);
});

test("loadConfig honors an explicit stateDir over the flipped default", async () => {
  const cfgPath = writeConfig(
    scratch(),
    "vetinari/config.mts",
    CONFIG_BODY.replace("fetchTask:", 'stateDir: "custom-state",\n  fetchTask:'),
  );

  const cfg = await loadConfig(cfgPath);

  assert.equal(cfg.stateDir, "custom-state");
  assert.equal(cfg.parkedDir, "custom-state/parked");
  assert.equal(cfg.logFile, "custom-state/logs/orchestrator.jsonl");
});
