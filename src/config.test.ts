import test from "node:test";
import assert from "node:assert/strict";
import { Refusal } from "./refusal.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { githubFetchTask } from "./index.ts";
import {
  AGENT_PROVIDERS,
  assertProjectQualifier,
  containerShareWeight,
  encodeAgentOverride,
  loadConfig,
  localTsconfig,
  ownerRepoFromRemote,
  parseAgentFlags,
  missingCredentials,
  missingCredentialsRefusal,
  VETINARI_SECRET_KEYS,
  refuseVetinariSecretsInEnv,
  nonResumableAnswerWarning,
  parseAgentOverride,
  registerVetinariResolve,
  repoForProject,
  resolveAgentSelection,
  isResumableProvider,
  resolveConfigPath,
  resolveDestination,
  resolveProjectRoot,
  type Destination,
} from "./config.ts";
import { withEnv } from "./test-support.ts";

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

test("loadConfig over vetinari's own committed config wires reportFinding as a function so campaign findings get filed", async () => {
  // The real dogfood config, not a fixture: tsc's `include` does not cover vetinari/,
  // so a type on ProjectConfig cannot pin this — loading the actual file is the only check.
  const cfgPath = new URL("../vetinari/config.mts", import.meta.url).pathname;

  const cfg = await loadConfig(cfgPath);

  assert.equal(typeof cfg.reportFinding, "function");
  // The labels live inside the reporter's closure, so the loaded config cannot expose
  // them — pin them on the config's source text instead.
  const source = readFileSync(cfgPath, "utf8").replace(/\s+/g, "");
  assert.ok(
    source.includes('...githubTracker({findingLabels:["needs-triage","P2"]})'),
    "vetinari's config no longer files findings with the needs-triage and P2 labels",
  );
});

test("vetinari's own config spreads the githubTracker preset rather than hand-wiring the github factories", () => {
  // A loaded config cannot tell preset-built functions from hand-wired ones, so pin the source text.
  const source = readFileSync(new URL("../vetinari/config.mts", import.meta.url), "utf8");

  assert.ok(source.includes("...githubTracker("), "vetinari's config does not spread githubTracker()");
  for (const factory of [
    "githubFetchTask(",
    "githubBlockedBy(",
    "githubIssuesByLabel(",
    "githubIssueComment(",
    "githubMarkPendingVerify(",
    "githubFindingReporter(",
  ])
    assert.ok(!source.includes(factory), `vetinari's config still hand-wires ${factory}…)`);
});

test("vetinari's own config gates on lint and format:check between typecheck and test, so a campaign cannot merge unlinted or unformatted code", async () => {
  const cfg = await loadConfig(new URL("../vetinari/config.mts", import.meta.url).pathname);

  assert.deepEqual(
    cfg.gates.map(({ cmd, label }) => ({ cmd, label })),
    [
      { cmd: "npm run typecheck", label: "typecheck" },
      { cmd: "npm run lint", label: "lint" },
      { cmd: "npm run format:check", label: "format" },
      { cmd: "npx tsx --test src/*.test.ts", label: "test" },
    ],
  );
  assert.equal(cfg.gates.find((g) => g.label === "format")?.when, undefined, "the format gate is scoped by `when`");
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

test("loadConfig sets GIT_TERMINAL_PROMPT=0 so host-side git fails fast instead of prompting", async () => {
  await withEnv({ GIT_TERMINAL_PROMPT: undefined }, async () => {
    await loadConfig(writeConfig(scratch(), "vetinari/config.mts"));
    assert.equal(process.env.GIT_TERMINAL_PROMPT, "0");
  });
});

test("loadConfig lets hostEnv override GIT_TERMINAL_PROMPT", async () => {
  const withPrompt = `export default {
  project: "demo",
  image: "img",
  baseBranch: "main",
  gates: [{ cmd: "true" }],
  fetchTask: (id) => id,
  hostEnv: { GIT_TERMINAL_PROMPT: "1" },
};
`;
  // Names the key only to restore it — loadConfig itself writes GIT_TERMINAL_PROMPT.
  await withEnv({ GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT }, async () => {
    await loadConfig(writeConfig(scratch(), "vetinari/config.mts", withPrompt));
    assert.equal(process.env.GIT_TERMINAL_PROMPT, "1");
  });
});

test("loadConfig defaults parkGraceSeconds to 0, and honors an explicit window", async () => {
  const dflt = await loadConfig(writeConfig(scratch(), "vetinari/config.mts"));
  assert.equal(dflt.parkGraceSeconds, 0);

  const withGrace = `export default {
  project: "demo",
  image: "img",
  baseBranch: "main",
  gates: [{ cmd: "true" }],
  fetchTask: (id) => id,
  parkGraceSeconds: 45,
};
`;
  const cfg = await loadConfig(writeConfig(scratch(), "vetinari/config.mts", withGrace));
  assert.equal(cfg.parkGraceSeconds, 45);
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

test("a Destination is { chat, thread? } — the bot field is gone (one bot per project, design §10)", () => {
  // A destination names no bot: one bot per project, its token read from host.env,
  // so a destination only picks where on that bot a message lands.
  const chatOnly: Destination = { chat: "-100" };
  const withThread: Destination = { chat: "-100", thread: "42" };
  assert.equal(chatOnly.chat, "-100");
  assert.equal(withThread.thread, "42");
  // @ts-expect-error `bot` was removed from Destination — a destination carries no bot.
  const withBot: Destination = { chat: "-100", bot: "mybot" };
  assert.equal(withBot.chat, "-100");
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

const withNotify = (notify: string) => CONFIG_BODY.replace("fetchTask:", `notify: ${notify},\n  fetchTask:`);

test("loadConfig rejects a notify map that fans the interactive question category out to two destinations", async () => {
  const cfgPath = writeConfig(scratch(), "vetinari/config.mts", withNotify(`{ question: "alerts", "question:urgent": "ops" }`));

  await assert.rejects(loadConfig(cfgPath), (err: Error) => {
    assert.match(err.message, /question/);
    assert.match(err.message, /alerts/);
    assert.match(err.message, /ops/);
    return true;
  });
});

test("loadConfig rejects question fan-out that comes via the wildcard catching unlisted question events", async () => {
  // `question:urgent` -> ops, but every other question event falls to `*` -> alerts.
  const cfgPath = writeConfig(scratch(), "vetinari/config.mts", withNotify(`{ "question:urgent": "ops", "*": "alerts" }`));

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
    model: "claude-opus-5-5",
    effort: "high",
    resumable: true,
  });
});

test("resolveAgentSelection takes pi's default model (claude-sonnet-5-5) when cfg names the provider but no model", () => {
  assert.deepEqual(resolveAgentSelection({ provider: "pi" }), {
    provider: "pi",
    model: "claude-sonnet-5-5",
    effort: "high",
    resumable: true,
  });
});

test("resolveAgentSelection takes the provider default from cfg.agent, falling back to that provider's default model", () => {
  assert.deepEqual(resolveAgentSelection({ provider: "codex" }), {
    provider: "codex",
    model: AGENT_PROVIDERS.codex.defaultModel,
    effort: "high",
    resumable: true,
  });
});

test("resolveAgentSelection honors an explicit model/effort on cfg.agent", () => {
  assert.deepEqual(resolveAgentSelection({ provider: "pi", model: "claude-sonnet-5-5", effort: "xhigh" }), {
    provider: "pi",
    model: "claude-sonnet-5-5",
    effort: "xhigh",
    resumable: true,
  });
});

test("resolveAgentSelection lets a CLI override win over the cfg default (precedence: override > cfg > default)", () => {
  assert.deepEqual(resolveAgentSelection({ provider: "claude", effort: "low" }, { provider: "codex", effort: "high" }), {
    provider: "codex",
    model: AGENT_PROVIDERS.codex.defaultModel,
    effort: "high",
    resumable: true,
  });
});

test("resolveAgentSelection does not leak the cfg's model/effort across a provider switch — they belonged to the other provider", () => {
  // cfg is claude with a claude model + a claude-only effort; overriding to codex must
  // fall to codex's own defaults, not carry the claude model or the (invalid-for-codex) effort.
  assert.deepEqual(resolveAgentSelection({ provider: "claude", model: "claude-opus-5-5", effort: "max" }, { provider: "codex" }), {
    provider: "codex",
    model: AGENT_PROVIDERS.codex.defaultModel,
    effort: "high",
    resumable: true,
  });
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

test("resolveAgentSelection accepts the non-resumable providers, flagging them resumable:false (they drive the loop by fresh re-runs)", () => {
  // opencode maps effort onto its `variant`; high is a valid variant.
  assert.equal(resolveAgentSelection(undefined, { provider: "opencode" }).resumable, false);
  assert.equal(resolveAgentSelection(undefined, { provider: "cursor" }).resumable, false);
  assert.equal(isResumableProvider("cursor"), false);
  assert.equal(isResumableProvider("opencode"), false);
});

test("copilot is resumable: it keeps its session in the issue's mounted Copilot directory (ADR 0024)", () => {
  assert.equal(isResumableProvider("copilot"), true);
  // copilot's default model is `auto`, which takes no effort setting, so none is defaulted.
  assert.deepEqual(resolveAgentSelection(undefined, { provider: "copilot" }), {
    provider: "copilot",
    model: AGENT_PROVIDERS.copilot.defaultModel,
    effort: undefined,
    resumable: true,
  });
});

test("resolveAgentSelection defaults copilot's model to auto, so Copilot picks among the models the org allows", () => {
  assert.equal(resolveAgentSelection({ provider: "copilot" }).model, "auto");
  // A configured model still wins.
  assert.equal(resolveAgentSelection({ provider: "copilot", model: "gpt-5.4" }).model, "gpt-5.4");
});

test("resolveAgentSelection gives copilot's auto model no default effort, which Copilot would refuse", () => {
  assert.equal(resolveAgentSelection({ provider: "copilot" }).effort, undefined);
  assert.equal(resolveAgentSelection({ provider: "copilot", effort: "none" }).effort, "none");
  // A named model keeps the default effort.
  assert.equal(resolveAgentSelection({ provider: "copilot", model: "gpt-5.4" }).effort, "high");
});

test("resolveAgentSelection accepts the Copilot CLI's full effort list and refuses one outside it, listing all seven", () => {
  assert.equal(resolveAgentSelection({ provider: "copilot", model: "gpt-5.4", effort: "xhigh" }).effort, "xhigh");
  assert.equal(resolveAgentSelection({ provider: "copilot", effort: "none" }).effort, "none");
  assert.throws(
    () => resolveAgentSelection({ provider: "copilot", effort: "ultra" }),
    (e: Error) => {
      assert.equal(
        e.message,
        'agent effort "ultra" is not valid for provider "copilot". Valid: none, minimal, low, medium, high, xhigh, max.',
      );
      return true;
    },
  );
});

test("resolveAgentSelection refuses an effort other than none with copilot's auto model, naming the fix", () => {
  for (const effort of ["high", "low", "max"]) {
    assert.throws(
      () => resolveAgentSelection({ provider: "copilot", effort }),
      (e: Error) => {
        assert.ok(e instanceof Refusal);
        assert.equal(
          e.message,
          `agent effort "${effort}" can't be used with copilot's "auto" model (Copilot refuses it). Set agent.model to a named model, or drop the effort.`,
        );
        return true;
      },
    );
  }
  // An explicit override of the model to auto refuses too.
  assert.throws(() => resolveAgentSelection({ provider: "copilot", model: "gpt-5.4" }, { model: "auto", effort: "high" }), Refusal);
  assert.equal(resolveAgentSelection({ provider: "copilot", effort: "none" }).effort, "none");
  assert.equal(resolveAgentSelection({ provider: "copilot" }).effort, undefined);
  assert.equal(resolveAgentSelection({ provider: "copilot", model: "gpt-5.4", effort: "high" }).effort, "high");
});

test("resolveAgentSelection flags the resumable providers resumable:true", () => {
  for (const provider of ["claude", "pi", "codex"] as const) assert.equal(resolveAgentSelection({ provider }).resumable, true);
});

test("nonResumableAnswerWarning names the provider as experimental, what happens on a park, and postComment as the fix", () => {
  const line = nonResumableAnswerWarning("cursor");
  // One line: no embedded newline splitting it into paragraphs.
  assert.ok(!line.includes("\n"), "the warning is a single line");
  assert.match(line, /cursor/); // the selected provider
  assert.match(line, /experimental/); // §12 marks the three experimental
  assert.match(line, /park/); // what will happen on a park
  assert.match(line, /postComment/); // what to configure
});

test("resolveAgentSelection carries no effort for a provider with no effort dial (cursor), and rejects one passed explicitly", () => {
  // The Cursor CLI exposes no reasoning-effort level, so the default carries no effort at all…
  assert.deepEqual(resolveAgentSelection({ provider: "cursor" }), {
    provider: "cursor",
    model: AGENT_PROVIDERS.cursor.defaultModel,
    effort: undefined,
    resumable: false,
  });
  // …and asking for one fails fast rather than silently doing nothing.
  assert.throws(
    () => resolveAgentSelection({ provider: "cursor", effort: "high" }),
    (e: Error) => {
      assert.match(e.message, /cursor/);
      assert.match(e.message, /effort/);
      return true;
    },
  );
});

test("resolveAgentSelection rejects an unknown provider naming the supported set", () => {
  assert.throws(
    () => resolveAgentSelection(undefined, { provider: "gpt" }),
    (e: Error) => {
      assert.ok(e instanceof Refusal, "an unknown provider is a refusal");
      assert.match(e.message, /gpt/);
      assert.match(e.message, /claude, pi, codex/);
      return true;
    },
  );
});

test("parseAgentFlags pulls --agent/--model/--effort out of the args, leaving the rest untouched and in order", () => {
  const { override, rest } = parseAgentFlags(["623", "--agent", "pi", "--effort", "xhigh", "--model", "claude-sonnet-5-5"]);
  assert.deepEqual(override, { provider: "pi", effort: "xhigh", model: "claude-sonnet-5-5" });
  assert.deepEqual(rest, ["623"]);
});

test("parseAgentFlags accepts the --flag=value form and preserves other flags/positionals", () => {
  const { override, rest } = parseAgentFlags(["--name", "gateway work", "--agent=codex", "436 611", "--auto-prune"]);
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

test("missingCredentials reads keys as the container does: a spaced key counts, an exported one does not", () => {
  const envPath = join(scratch(), ".env");
  writeFileSync(envPath, "CLAUDE_CODE_OAUTH_TOKEN = x\n");
  assert.deepEqual(missingCredentials("claude", envPath), []);
  writeFileSync(envPath, "export CLAUDE_CODE_OAUTH_TOKEN=x\n");
  assert.deepEqual(missingCredentials("claude", envPath), AGENT_PROVIDERS.claude.credentialKeys);
  writeFileSync(envPath, "CLAUDE_CODE_OAUTH_TOKEN=\n");
  assert.deepEqual(missingCredentials("claude", envPath), AGENT_PROVIDERS.claude.credentialKeys);
});

test("missingCredentialsRefusal names the provider's keys and the .env path", () => {
  assert.equal(
    missingCredentialsRefusal("claude", "/w/.vetinari.local/.env", "OPENAI_API_KEY=sk\n"),
    `agent provider "claude" has no credentials in /w/.vetinari.local/.env — ` +
      `set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY there before launching (preflight, ADR 0016).`,
  );
});

test("missingCredentialsRefusal tells the user to drop `export` from a credential the container reads as a different key", () => {
  assert.equal(
    missingCredentialsRefusal("claude", "/w/.vetinari.local/.env", "export CLAUDE_CODE_OAUTH_TOKEN=x\n"),
    `agent provider "claude" has no credentials in /w/.vetinari.local/.env — ` +
      `set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY there before launching (preflight, ADR 0016). ` +
      "`.env` writes CLAUDE_CODE_OAUTH_TOKEN with `export`, which the container reads as a different key — drop `export`.",
  );
});

test("refuseVetinariSecretsInEnv refuses a .env naming the bot token, even with an empty value", () => {
  const envPath = join(scratch(), ".env");
  writeFileSync(envPath, "CLAUDE_CODE_OAUTH_TOKEN=x\nVETINARI_TELEGRAM_BOT_TOKEN=\n");
  assert.throws(
    () => refuseVetinariSecretsInEnv(envPath),
    (e: unknown) =>
      e instanceof Refusal &&
      e.message ===
        `${envPath} names vetinari's own secret VETINARI_TELEGRAM_BOT_TOKEN — remove it: ` +
          `the container gate must never carry it (it belongs in host.env) (preflight).`,
  );
});

test("refuseVetinariSecretsInEnv refuses an exported, quoted chat id", () => {
  const envPath = join(scratch(), ".env");
  writeFileSync(envPath, 'export VETINARI_TELEGRAM_CHAT_ID="-100123"\n');
  assert.throws(
    () => refuseVetinariSecretsInEnv(envPath),
    (e: unknown) => e instanceof Refusal && e.message.includes("secret VETINARI_TELEGRAM_CHAT_ID —"),
  );
});

test("refuseVetinariSecretsInEnv refuses a secret key written with a space or tab before =", () => {
  const envPath = join(scratch(), ".env");
  for (const body of ["VETINARI_TELEGRAM_BOT_TOKEN =\n", "VETINARI_TELEGRAM_BOT_TOKEN\t=x\n"]) {
    writeFileSync(envPath, body);
    assert.throws(
      () => refuseVetinariSecretsInEnv(envPath),
      (e: unknown) => e instanceof Refusal && e.message.includes("secret VETINARI_TELEGRAM_BOT_TOKEN —"),
      JSON.stringify(body),
    );
  }
});

test("refuseVetinariSecretsInEnv names every secret in one refusal, in file order", () => {
  const envPath = join(scratch(), ".env");
  writeFileSync(envPath, "VETINARI_TELEGRAM_CHAT_ID=1\nCLAUDE_CODE_OAUTH_TOKEN=x\nVETINARI_TELEGRAM_BOT_TOKEN=t\n");
  assert.throws(
    () => refuseVetinariSecretsInEnv(envPath),
    (e: unknown) =>
      e instanceof Refusal &&
      e.message.startsWith(`${envPath} names vetinari's own secret VETINARI_TELEGRAM_CHAT_ID, VETINARI_TELEGRAM_BOT_TOKEN — `),
  );
});

test("refuseVetinariSecretsInEnv passes a credential-only, commented-out, thread-id-only, or missing .env", () => {
  const dir = scratch();
  const envPath = join(dir, ".env");
  refuseVetinariSecretsInEnv(envPath); // missing file
  for (const body of ["CLAUDE_CODE_OAUTH_TOKEN=x\n", "# VETINARI_TELEGRAM_BOT_TOKEN=x\n", "VETINARI_TELEGRAM_THREAD_ID=42\n"]) {
    writeFileSync(envPath, body);
    refuseVetinariSecretsInEnv(envPath);
  }
});

test("VETINARI_SECRET_KEYS is exactly the bot connection", () => {
  assert.deepEqual(VETINARI_SECRET_KEYS, ["VETINARI_TELEGRAM_BOT_TOKEN", "VETINARI_TELEGRAM_CHAT_ID"]);
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

const git = (dir: string, args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

// A temp git repo whose realpathed root is returned, so comparisons hold on
// platforms (macOS) where tmpdir is itself a symlink.
const initRepo = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vetinari-root-")));
  git(dir, ["init", "-q"]);
  return dir;
};

test("resolveProjectRoot resolves the main repo root from cwd", () => {
  const root = initRepo();
  assert.equal(resolveProjectRoot(root), root);
});

test("resolveProjectRoot resolves a linked worktree back to the main root, not the worktree", () => {
  const root = initRepo();
  // A commit is needed before a worktree can be added.
  git(root, ["-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  // Mirror the real agent layout: the worktree lives INSIDE the project root, and
  // is its own toplevel — `--show-toplevel` there would resolve to it, not the root.
  const worktree = join(root, ".vetinari.local", "worktrees", "task-1");
  git(root, ["worktree", "add", "-q", worktree, "-b", "agent/task-1"]);

  assert.equal(resolveProjectRoot(worktree), root);
  assert.notEqual(realpathSync(git(worktree, ["rev-parse", "--show-toplevel"]).trim()), root);
});

test("resolveProjectRoot refuses outside a git repo, naming the directory", () => {
  const notARepo = realpathSync(mkdtempSync(join(tmpdir(), "vetinari-norepo-")));
  assert.throws(
    () => resolveProjectRoot(notARepo),
    (e: Error) => e instanceof Refusal && e.message.includes("not a git repository") && e.message.includes(notARepo),
  );
});

test("repoForProject derives owner/name from origin, and degrades to undefined without one", () => {
  const root = initRepo();
  assert.equal(repoForProject(root), undefined); // a repo with no origin degrades
  git(root, ["remote", "add", "origin", "git@github.com:jjforge/vetinari.git"]);
  assert.equal(repoForProject(root), "jjforge/vetinari");
});

test("ownerRepoFromRemote parses SSH and HTTPS GitHub remotes, and rejects garbage", () => {
  assert.equal(ownerRepoFromRemote("git@github.com:jjforge/vetinari.git"), "jjforge/vetinari");
  assert.equal(ownerRepoFromRemote("https://github.com/acme/tidepool"), "acme/tidepool");
  assert.equal(ownerRepoFromRemote("not-a-remote"), undefined);
});

test("assertProjectQualifier allows a matching qualifier and the bare (no-qualifier) form", () => {
  assert.doesNotThrow(() => assertProjectQualifier(undefined, "jjforge", undefined));
  assert.doesNotThrow(() => assertProjectQualifier("jjforge", "jjforge", "jjforge/vetinari"));
});

test("assertProjectQualifier refuses a qualifier naming a different project", () => {
  assert.throws(
    () => assertProjectQualifier("vetinari", "jjforge", "jjforge/vetinari"),
    (e: Error) => e instanceof Refusal && /refusing: this project is "jjforge", but the qualifier names "vetinari"/.test(e.message),
  );
});

test("assertProjectQualifier refuses when the repo identity cannot verify the qualifier", () => {
  assert.throws(
    () => assertProjectQualifier("jjforge", "jjforge", undefined),
    /cannot derive this project's repo to verify the "jjforge" qualifier/,
  );
});

// A project config written as the `init` template writes it: importing from
// "vetinari". A scratch() dir sits outside this checkout, so only the CLI's
// resolve hook — not package self-reference or a node_modules link — can find it.
const VETINARI_CONFIG_BODY = `import { defineConfig } from "vetinari";
export default defineConfig({
  project: "demo",
  image: "img",
  baseBranch: "main",
  gates: [{ cmd: "true" }],
  fetchTask: (id) => id,
});
`;

test('loadConfig resolves a config\'s import from "vetinari" with no node_modules in the project', async () => {
  const cfg = await loadConfig(writeConfig(scratch(), "vetinari/config.mts", VETINARI_CONFIG_BODY));

  assert.equal(cfg.project, "demo");
});

test('a config\'s "vetinari" import is the same module instance the CLI runs', async () => {
  // githubFetchTask is a factory; it is left uncalled and used only as an identity probe.
  const body = VETINARI_CONFIG_BODY.replace("{ defineConfig }", "{ defineConfig, githubFetchTask }").replace(
    "fetchTask: (id) => id",
    "fetchTask: githubFetchTask",
  );

  const cfg = await loadConfig(writeConfig(scratch(), "vetinari/config.mts", body));

  assert.equal(cfg.fetchTask, githubFetchTask);
});

test("a config's \"vetinari/<subpath>\" resolves through the running install's exports map", async () => {
  // import.meta.resolve, never import: importing vetinari/cli would run the CLI.
  const body = `const probe = { cli: import.meta.resolve("vetinari/cli") };
try {
  import.meta.resolve("vetinari/src/loop.ts");
} catch (err) {
  probe.unexportedCode = err.code;
}
globalThis.__vetinariSubpathProbe = probe;
${VETINARI_CONFIG_BODY}`;

  await loadConfig(writeConfig(scratch(), "vetinari/config.mts", body));

  const probe = (globalThis as { __vetinariSubpathProbe?: { cli: string; unexportedCode?: string } }).__vetinariSubpathProbe;
  assert.equal(probe?.cli, new URL("./cli.mts", import.meta.url).href);
  assert.equal(probe?.unexportedCode, "ERR_PACKAGE_PATH_NOT_EXPORTED");
});

test("the running install wins over a project's own node_modules/vetinari", async () => {
  const dir = scratch();
  const decoy = join(dir, "node_modules/vetinari");
  mkdirSync(decoy, { recursive: true });
  writeFileSync(join(decoy, "package.json"), JSON.stringify({ name: "vetinari", type: "module", exports: "./index.js" }));
  writeFileSync(join(decoy, "index.js"), 'export const defineConfig = (c) => ({ ...c, project: "decoy" });\n');

  const cfg = await loadConfig(writeConfig(dir, "vetinari/config.mts", VETINARI_CONFIG_BODY));

  assert.equal(cfg.project, "demo");
});

test("loadConfig registers the vetinari resolve hook only once per process", async () => {
  await loadConfig(writeConfig(scratch(), "vetinari/config.mts", VETINARI_CONFIG_BODY));
  await loadConfig(writeConfig(scratch(), "vetinari/config.mts", VETINARI_CONFIG_BODY));

  assert.equal(registerVetinariResolve(), false);
});

test("localTsconfig points the type checker at an install's source and its @types/node", () => {
  const { compilerOptions } = JSON.parse(localTsconfig("/x"));

  assert.deepEqual(compilerOptions.paths.vetinari, ["/x/src/index.ts"]);
  assert.deepEqual(compilerOptions.typeRoots, ["/x/node_modules/@types"]);
  assert.deepEqual(compilerOptions.types, ["node"]);
});

// This install's root as a filesystem path, and the committed tsconfig `init` writes.
const THIS_INSTALL = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const TSCONFIG_TEMPLATE = readFileSync(new URL("../templates/tsconfig.json", import.meta.url), "utf8");

/** A scratch project with `vetinari/config.mts` and, unless opted out, the committed `vetinari/tsconfig.json`. */
const typedProject = (body = VETINARI_CONFIG_BODY, withTsconfig = true) => {
  const dir = scratch();
  const cfgPath = writeConfig(dir, "vetinari/config.mts", body);
  if (withTsconfig) writeFileSync(join(dir, "vetinari/tsconfig.json"), TSCONFIG_TEMPLATE);
  return { dir, cfgPath, local: join(dir, ".vetinari.local/tsconfig.json") };
};

test("loadConfig writes .vetinari.local/tsconfig.json pointing at this install, and rewrites it only when it differs", async () => {
  const { cfgPath, local } = typedProject();

  await loadConfig(cfgPath);
  assert.equal(readFileSync(local, "utf8"), localTsconfig(THIS_INSTALL));

  const written = statSync(local).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  await loadConfig(cfgPath);
  assert.equal(statSync(local).mtimeMs, written);

  writeFileSync(local, localTsconfig("/moved/install"));
  await loadConfig(cfgPath);
  assert.equal(readFileSync(local, "utf8"), localTsconfig(THIS_INSTALL));
});

test("loadConfig writes no .vetinari.local/tsconfig.json for a project without vetinari/tsconfig.json", async () => {
  const { cfgPath, local } = typedProject(VETINARI_CONFIG_BODY, false);

  await loadConfig(cfgPath);

  assert.equal(existsSync(local), false);
});

test("loadConfig still loads when .vetinari.local/tsconfig.json cannot be written", async () => {
  const { dir, cfgPath } = typedProject();
  writeFileSync(join(dir, ".vetinari.local"), "a file where the dir should be\n");

  const cfg = await loadConfig(cfgPath);

  assert.equal(cfg.project, "demo");
});

test("after a load, tsc -p vetinari type-checks a project's config against this install and catches a misspelled field", async () => {
  const { dir, cfgPath } = typedProject();
  await loadConfig(cfgPath);
  const tsc = () =>
    spawnSync(fileURLToPath(new URL("../node_modules/.bin/tsc", import.meta.url)), ["-p", join(dir, "vetinari")], { encoding: "utf8" });

  const clean = tsc();
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);

  writeFileSync(cfgPath, VETINARI_CONFIG_BODY.replace("baseBranch", "baseBrnch"));
  const misspelled = tsc();
  assert.notEqual(misspelled.status, 0);
  assert.match(misspelled.stdout, /TS2561/);
});

// A bind mount whose sandboxPath's parents are missing from the image makes docker create them
// root-owned, so the agent cannot write beside the mount (Go's ~/go/pkg/sumdb beside a mounted
// ~/go/pkg/mod). All three shipped Dockerfiles must pre-create the cache roots as the agent user.
for (const dockerfile of ["../templates/Dockerfile", "../vetinari/Dockerfile", "../examples/jjforge/vetinari/Dockerfile"]) {
  test(`${dockerfile} pre-creates the agent's home cache roots as the agent user`, () => {
    const text = readFileSync(new URL(dockerfile, import.meta.url), "utf8");
    const afterUser = text.slice(text.indexOf("USER ${AGENT_UID}"));
    const mkdir = afterUser.split("\n").find((l) => /^RUN mkdir -p /.test(l)) ?? "";
    for (const root of ["/home/agent/go/pkg", "/home/agent/.cache", "/home/agent/.cargo"]) {
      assert.ok(mkdir.split(/\s+/).includes(root), `${dockerfile}: no agent-user mkdir of ${root}`);
    }
  });
}

// `provider: "copilot"` needs the Copilot CLI in the image: every shipped Dockerfile installs it
// globally as root, before the drop to the agent user, and names its credential key.
for (const dockerfile of ["../templates/Dockerfile", "../vetinari/Dockerfile", "../examples/jjforge/vetinari/Dockerfile"]) {
  test(`${dockerfile} installs the Copilot CLI as root and names COPILOT_GITHUB_TOKEN`, () => {
    const text = readFileSync(new URL(dockerfile, import.meta.url), "utf8");
    const lines = text.split("\n");
    const install = lines.findIndex((l) => /^RUN npm install -g /.test(l) && l.split(/\s+/).includes("@github/copilot"));
    const user = lines.findIndex((l) => l.startsWith("USER ${AGENT_UID}"));
    assert.ok(install >= 0, `${dockerfile}: no RUN npm install -g of @github/copilot`);
    assert.ok(user >= 0 && install < user, `${dockerfile}: the Copilot CLI is not installed before the USER line`);
    assert.match(text, /COPILOT_GITHUB_TOKEN/);
  });
}

// `cursor` and `opencode` are selectable but their CLIs are not shipped (#521): the comment above
// the agent-CLI install says so, naming both binaries, so a project knows to add the one it uses.
for (const dockerfile of ["../templates/Dockerfile", "../vetinari/Dockerfile"]) {
  test(`${dockerfile}'s agent-CLI comment says cursor-agent and opencode are not installed`, () => {
    const lines = readFileSync(new URL(dockerfile, import.meta.url), "utf8").split("\n");
    const install = lines.findIndex((l) => /^RUN npm install -g /.test(l) && l.includes("@github/copilot"));
    let start = install;
    while (start > 0 && lines[start - 1].startsWith("#")) start--;
    const comment = lines.slice(start, install).join("\n");
    assert.match(comment, /`cursor-agent`/, `${dockerfile}: the agent-CLI comment does not name cursor-agent`);
    assert.match(comment, /`opencode`/, `${dockerfile}: the agent-CLI comment does not name opencode`);
    assert.match(comment, /not installed/, `${dockerfile}: the agent-CLI comment does not say they are not installed`);
  });
}

for (const template of ["../templates/config.mts", "../templates/config.github.mts"]) {
  test(`${template}'s agent: comment names copilot among the providers`, () => {
    const text = readFileSync(new URL(template, import.meta.url), "utf8");
    const comment = /\/\/ Optional: the agent provider[\s\S]*?\/\/ agent: \{/.exec(text)?.[0] ?? "";
    assert.match(comment, /`copilot`/, `${template}: the agent: comment does not name copilot`);
  });
}

test("loadConfig refuses a waivedFiles that is not a string[], and accepts any string[] — even a directory", async () => {
  const withWaived = (value: string) => CONFIG_BODY.replace("fetchTask: (id) => id,", `fetchTask: (id) => id,\n  waivedFiles: ${value},`);
  await assert.rejects(loadConfig(writeConfig(scratch(), "vetinari/config.mts", withWaived(`"DESIGN.md"`))), (err: unknown) => {
    assert.ok(err instanceof Refusal);
    assert.match(err.message, /"waivedFiles" must be an array of repo-relative paths/);
    return true;
  });
  await assert.rejects(loadConfig(writeConfig(scratch(), "vetinari/config.mts", withWaived(`["DESIGN.md", 3]`))), Refusal);
  // Shape only: config load has no tree to check against, so a directory entry loads.
  const cfg = await loadConfig(writeConfig(scratch(), "vetinari/config.mts", withWaived(`["DESIGN.md", "src"]`)));
  assert.deepEqual(cfg.waivedFiles, ["DESIGN.md", "src"]);
});

test("loadConfig needs an image only for the Docker default: a sandbox factory loads without one", async () => {
  const noImage = CONFIG_BODY.replace(`  image: "img",\n`, "");
  const withSandbox = noImage.replace("fetchTask: (id) => id,", `fetchTask: (id) => id,\n  sandbox: () => ({ name: "fake", env: {} }),`);
  const cfg = await loadConfig(writeConfig(scratch(), "vetinari/config.mts", withSandbox));
  assert.equal(cfg.image, undefined);
  assert.equal(typeof cfg.sandbox, "function");
  await assert.rejects(loadConfig(writeConfig(scratch(), "vetinari/config.mts", noImage)), (err: unknown) => {
    assert.ok(err instanceof Refusal);
    assert.match(err.message, /missing required field "image"/);
    return true;
  });
});

test("loadConfig refuses a ./-prefixed waivedFiles entry, naming it and suggesting the file key (#627)", async () => {
  const body = CONFIG_BODY.replace("fetchTask: (id) => id,", `fetchTask: (id) => id,\n  waivedFiles: ["README.md", "./docs/x.md"],`);
  await assert.rejects(loadConfig(writeConfig(scratch(), "vetinari/config.mts", body)), (err: unknown) => {
    assert.ok(err instanceof Refusal);
    assert.match(err.message, /"waivedFiles" entry \.\/docs\/x\.md: entries are file keys, write docs\/x\.md/);
    return true;
  });
});

test("loadConfig refuses a non-boolean perMerge on a gate, naming the gate, and accepts a boolean (#617)", async () => {
  const withGates = (gates: string) => CONFIG_BODY.replace(`gates: [{ cmd: "true" }],`, `gates: ${gates},`);
  const cfgPath = writeConfig(
    scratch(),
    "vetinari/config.mts",
    withGates(`[{ cmd: "true" }, { cmd: "make lint", label: "lint", perMerge: "yes" }]`),
  );
  await assert.rejects(loadConfig(cfgPath), (err: Error) => {
    assert.ok(err instanceof Refusal);
    assert.equal(err.message, `${cfgPath}: gate "lint": "perMerge" must be true or false, got "yes"`);
    return true;
  });
  const cfg = await loadConfig(writeConfig(scratch(), "vetinari/config.mts", withGates(`[{ cmd: "make lint", perMerge: true }]`)));
  assert.equal(cfg.gates[0].perMerge, true);
});

test("loadConfig refuses a timeoutSeconds that is not a positive whole number, naming the gate, and accepts one (#531)", async () => {
  const withGates = (gates: string) => CONFIG_BODY.replace(`gates: [{ cmd: "true" }],`, `gates: ${gates},`);
  for (const [bad, shown] of [
    ["0", "0"],
    ["-5", "-5"],
    ["1.5", "1.5"],
    [`"60"`, `"60"`],
  ]) {
    const cfgPath = writeConfig(
      scratch(),
      "vetinari/config.mts",
      withGates(`[{ cmd: "true" }, { cmd: "make test", label: "test", timeoutSeconds: ${bad} }]`),
    );
    await assert.rejects(loadConfig(cfgPath), (err: Error) => {
      assert.ok(err instanceof Refusal);
      assert.equal(err.message, `${cfgPath}: gate "test": "timeoutSeconds" must be a positive whole number of seconds, got ${shown}`);
      return true;
    });
  }
  const cfg = await loadConfig(writeConfig(scratch(), "vetinari/config.mts", withGates(`[{ cmd: "make test", timeoutSeconds: 60 }]`)));
  assert.equal(cfg.gates[0].timeoutSeconds, 60);
});

const withContainerShare = (share: string) => CONFIG_BODY.replace("fetchTask:", `containerShare: ${share},\n  fetchTask:`);

test("loadConfig refuses an unknown containerShare tier, naming the field and the value", async () => {
  const cfgPath = writeConfig(scratch(), "vetinari/config.mts", withContainerShare(`"hgih"`));
  await assert.rejects(loadConfig(cfgPath), (err: Error) => {
    assert.ok(err instanceof Refusal);
    assert.ok(err.message.endsWith(`"containerShare" must be "high", "medium" or "low", got "hgih"`), err.message);
    return true;
  });
  const numPath = writeConfig(scratch(), "vetinari/config.mts", withContainerShare("3"));
  await assert.rejects(
    loadConfig(numPath),
    (err: Error) => err.message === `${numPath}: "containerShare" must be "high", "medium" or "low", got 3`,
  );
});

test("loadConfig accepts each containerShare tier, and defaults an absent one to medium", async () => {
  for (const share of ["high", "medium", "low"]) {
    const cfg = await loadConfig(writeConfig(scratch(), "vetinari/config.mts", withContainerShare(`"${share}"`)));
    assert.equal(cfg.containerShare, share);
  }
  const cfg = await loadConfig(writeConfig(scratch(), "vetinari/config.mts"));
  assert.equal(cfg.containerShare, "medium");
});

const withFileOverlap = (mode: string) => CONFIG_BODY.replace("fetchTask:", `fileOverlap: ${mode},\n  fetchTask:`);

test("loadConfig resolves an absent fileOverlap to strict, accepts allow, and refuses any other mode (#623)", async () => {
  assert.equal((await loadConfig(writeConfig(scratch(), "vetinari/config.mts"))).fileOverlap, "strict");
  assert.equal((await loadConfig(writeConfig(scratch(), "vetinari/config.mts", withFileOverlap(`"allow"`)))).fileOverlap, "allow");
  const cfgPath = writeConfig(scratch(), "vetinari/config.mts", withFileOverlap(`"loose"`));
  await assert.rejects(loadConfig(cfgPath), (err: Error) => {
    assert.ok(err instanceof Refusal);
    assert.equal(err.message, `${cfgPath}: "fileOverlap" must be "strict" or "allow", got "loose"`);
    return true;
  });
});
