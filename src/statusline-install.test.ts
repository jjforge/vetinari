import test from "node:test";
import assert from "node:assert/strict";
import { buildInstalledCommand, composeStatusLine, computeInstall, computeUninstall, DEFAULT_RUN_COMMAND, parseInstalledCommand, describeInstall, describeUninstall, type Settings } from "./statusline-install.ts";

test("buildInstalledCommand + parseInstalledCommand round-trips a wrapped base command", () => {
  const cmd = buildInstalledCommand("npx vetinari statusline", "my-fancy-bar --color");
  const parsed = parseInstalledCommand(cmd);
  assert.deepEqual(parsed, { runCommand: "npx vetinari statusline", base: "my-fancy-bar --color" });
});

test("buildInstalledCommand omits the base marker when there is no base to wrap", () => {
  const cmd = buildInstalledCommand("npx vetinari statusline");
  assert.equal(cmd, "npx vetinari statusline");
  assert.deepEqual(parseInstalledCommand(cmd), { runCommand: "npx vetinari statusline", base: undefined });
});

test("parseInstalledCommand recognizes a project's own vetinari invocation as ours", () => {
  const parsed = parseInstalledCommand(".vetinari.local/run statusline");
  assert.deepEqual(parsed, { runCommand: ".vetinari.local/run statusline", base: undefined });
});

test("parseInstalledCommand returns null for a command that is not a vetinari statusline", () => {
  assert.equal(parseInstalledCommand("my-fancy-bar --color"), null);
});

test("the encoded base survives shell metacharacters (so uninstall restores it verbatim)", () => {
  const gnarly = `sh -c 'echo "$USER · $(git branch --show-current)"'`;
  const parsed = parseInstalledCommand(buildInstalledCommand("npx vetinari statusline", gnarly));
  assert.equal(parsed?.base, gnarly);
});

test("computeInstall on a project with no status line configures vetinari's, no base to wrap", () => {
  const { settings, base, alreadyInstalled } = computeInstall({}, { runCommand: DEFAULT_RUN_COMMAND });
  assert.equal(alreadyInstalled, false);
  assert.equal(base, undefined);
  assert.equal(settings.statusLine?.type, "command");
  assert.equal(settings.statusLine?.command, DEFAULT_RUN_COMMAND);
  assert.equal(typeof settings.statusLine?.refreshInterval, "number");
});

test("computeInstall preserves an existing custom status line as the wrapped base", () => {
  const before: Settings = { statusLine: { type: "command", command: "my-fancy-bar --color", refreshInterval: 2 } };
  const { settings, base, alreadyInstalled } = computeInstall(before, { runCommand: DEFAULT_RUN_COMMAND });
  assert.equal(alreadyInstalled, false);
  assert.equal(base, "my-fancy-bar --color");
  // The user's command is recoverable from what we wrote, and their refreshInterval is kept.
  assert.deepEqual(parseInstalledCommand(settings.statusLine!.command!), { runCommand: DEFAULT_RUN_COMMAND, base: "my-fancy-bar --color" });
  assert.equal(settings.statusLine?.refreshInterval, 2);
});

test("computeInstall is idempotent — re-installing does not nest the wrapper", () => {
  const first = computeInstall({ statusLine: { type: "command", command: "my-fancy-bar" } }, { runCommand: DEFAULT_RUN_COMMAND });
  const second = computeInstall(first.settings, { runCommand: DEFAULT_RUN_COMMAND });
  assert.equal(second.alreadyInstalled, true);
  assert.deepEqual(second.settings.statusLine, first.settings.statusLine);
  assert.equal(second.base, "my-fancy-bar"); // still reports the wrapped base, unchanged
});

test("computeInstall leaves unrelated settings keys untouched", () => {
  const before: Settings = { model: "opus", permissions: { allow: ["Bash"] } };
  const { settings } = computeInstall(before, { runCommand: DEFAULT_RUN_COMMAND });
  assert.equal(settings.model, "opus");
  assert.deepEqual(settings.permissions, { allow: ["Bash"] });
});

test("computeInstall does not mutate the settings it was given", () => {
  const before: Settings = { statusLine: { type: "command", command: "my-fancy-bar" } };
  const snapshot = JSON.parse(JSON.stringify(before));
  computeInstall(before, { runCommand: DEFAULT_RUN_COMMAND });
  assert.deepEqual(before, snapshot);
});

test("install then uninstall restores a wrapped custom line exactly (round-trip)", () => {
  const original: Settings = { statusLine: { type: "command", command: "my-fancy-bar --color", refreshInterval: 2 } };
  const installed = computeInstall(original, { runCommand: DEFAULT_RUN_COMMAND }).settings;
  const { settings, restored, wasInstalled } = computeUninstall(installed);
  assert.equal(wasInstalled, true);
  assert.equal(restored, "my-fancy-bar --color");
  assert.deepEqual(settings.statusLine, original.statusLine);
});

test("uninstall drops statusLine entirely when vetinari wrapped nothing", () => {
  const installed = computeInstall({}, { runCommand: DEFAULT_RUN_COMMAND }).settings;
  const { settings, restored, wasInstalled } = computeUninstall(installed);
  assert.equal(wasInstalled, true);
  assert.equal(restored, undefined);
  assert.equal("statusLine" in settings, false);
});

test("uninstall is a no-op on a status line that is not vetinari's", () => {
  const before: Settings = { statusLine: { type: "command", command: "my-fancy-bar" } };
  const { settings, wasInstalled } = computeUninstall(before);
  assert.equal(wasInstalled, false);
  assert.deepEqual(settings.statusLine, before.statusLine);
});

test("uninstall is a no-op when no status line is configured at all", () => {
  const { settings, wasInstalled } = computeUninstall({ model: "opus" });
  assert.equal(wasInstalled, false);
  assert.deepEqual(settings, { model: "opus" });
});

test("uninstall does not mutate the settings it was given", () => {
  const installed = computeInstall({ statusLine: { type: "command", command: "my-fancy-bar" } }, { runCommand: DEFAULT_RUN_COMMAND }).settings;
  const snapshot = JSON.parse(JSON.stringify(installed));
  computeUninstall(installed);
  assert.deepEqual(installed, snapshot);
});

test("composeStatusLine puts a wrapped base line on top and the campaign line under it", () => {
  const out = composeStatusLine("MyBar · main · 12%", "Opus · vetinari · main · 5%", "🏰 wave 1/2 · ✅1");
  assert.equal(out, "MyBar · main · 12%\n🏰 wave 1/2 · ✅1");
});

test("composeStatusLine falls back to vetinari's own line when the base produced nothing", () => {
  const out = composeStatusLine("", "Opus · vetinari · main · 5%", "🏰 idle");
  assert.equal(out, "Opus · vetinari · main · 5%\n🏰 idle");
  assert.equal(composeStatusLine(undefined, "Opus · vetinari", "🏰 idle"), "Opus · vetinari\n🏰 idle");
});

test("composeStatusLine preserves a multi-line base status line verbatim", () => {
  const out = composeStatusLine("row one\nrow two", "own", "🏰 idle");
  assert.equal(out, "row one\nrow two\n🏰 idle");
});

test("composeStatusLine drops an empty campaign line (outside a vetinari project)", () => {
  assert.equal(composeStatusLine("MyBar", "own", ""), "MyBar");
});

test("describeInstall distinguishes a fresh install, a wrapping install, and a no-op", () => {
  assert.match(describeInstall({ base: undefined, alreadyInstalled: false }, ".claude/settings.json"), /Installed/);
  const wrapping = describeInstall({ base: "my-fancy-bar", alreadyInstalled: false }, ".claude/settings.json");
  assert.match(wrapping, /Installed/);
  assert.match(wrapping, /wrapp|kept as line 1/i); // says the existing line was preserved
  assert.match(describeInstall({ base: "my-fancy-bar", alreadyInstalled: true }, ".claude/settings.json"), /already/i);
});

test("describeInstall warns and names settings.local.json when the local layer shadows", () => {
  const msg = describeInstall({ base: undefined, alreadyInstalled: false, shadowedByLocal: true }, ".claude/settings.json");
  assert.match(msg, /settings\.local\.json/); // names the shadowing layer
  assert.doesNotMatch(msg, /^Installed/); // did not claim to install
});

test("describeUninstall warns and names settings.local.json when the local layer shadows", () => {
  const msg = describeUninstall({ restored: undefined, wasInstalled: false, shadowedByLocal: true }, ".claude/settings.json");
  assert.match(msg, /settings\.local\.json/);
});

test("describeUninstall distinguishes a restore, a plain removal, and a no-op", () => {
  assert.match(describeUninstall({ restored: "my-fancy-bar", wasInstalled: true }, ".claude/settings.json"), /restor/i);
  assert.match(describeUninstall({ restored: undefined, wasInstalled: true }, ".claude/settings.json"), /Uninstalled|removed/i);
  assert.match(describeUninstall({ restored: undefined, wasInstalled: false }, ".claude/settings.json"), /No Vetinari status line|nothing/i);
});

test("computeUninstall reports a shadow and changes nothing when settings.local.json owns a statusLine", () => {
  // Uninstalling from settings.json is inert while the local layer shadows it, so
  // report the shadow rather than a change that would not be visible.
  const installed = computeInstall({}, { runCommand: DEFAULT_RUN_COMMAND }).settings;
  const { settings, wasInstalled, shadowedByLocal } = computeUninstall(installed, { shadowedByLocal: true });
  assert.equal(shadowedByLocal, true);
  assert.equal(wasInstalled, false);
  assert.deepEqual(settings, installed); // unchanged
});

test("computeInstall wraps a status line inherited from user settings when the project has none", () => {
  // Reproduces the 'colors vanish on line 1' bug: the user's colored status line
  // lives in ~/.claude/settings.json; installing at project level must wrap it
  // (not shadow it with vetinari's plain line).
  const { settings, base } = computeInstall({}, { runCommand: DEFAULT_RUN_COMMAND, inheritedBase: "bash '/home/me/.claude/statusline.sh'" });
  assert.equal(base, "bash '/home/me/.claude/statusline.sh'");
  assert.deepEqual(parseInstalledCommand(settings.statusLine!.command!), { runCommand: DEFAULT_RUN_COMMAND, base: "bash '/home/me/.claude/statusline.sh'" });
});

test("a project's own status line takes precedence over an inherited one as the base", () => {
  const { base } = computeInstall({ statusLine: { type: "command", command: "proj-bar" } }, { runCommand: DEFAULT_RUN_COMMAND, inheritedBase: "user-bar" });
  assert.equal(base, "proj-bar");
});

test("computeInstall does not write a shadowed line when settings.local.json owns a statusLine", () => {
  // A statusLine in the higher-precedence settings.local.json makes any write to
  // settings.json inert — Claude Code renders the local layer's whole block.
  const before: Settings = { model: "opus" };
  const { settings, shadowedByLocal, alreadyInstalled } = computeInstall(before, { runCommand: DEFAULT_RUN_COMMAND, shadowedByLocal: true });
  assert.equal(shadowedByLocal, true);
  assert.equal(alreadyInstalled, false);
  assert.equal("statusLine" in settings, false); // no shadowed write planned
  assert.deepEqual(settings, before);
});

test("uninstall drops the project status line when it wrapped an inherited one (restores inheritance)", () => {
  const installed = computeInstall({}, { runCommand: DEFAULT_RUN_COMMAND, inheritedBase: "user-bar" }).settings;
  const { settings, wasInstalled } = computeUninstall(installed, { inheritedBase: "user-bar" });
  assert.equal(wasInstalled, true);
  assert.equal("statusLine" in settings, false); // dropped → the user-level line applies again
});

test("uninstall restores a project-owned wrapped line rather than dropping it", () => {
  const installed = computeInstall({ statusLine: { type: "command", command: "proj-bar" } }, { runCommand: DEFAULT_RUN_COMMAND, inheritedBase: "user-bar" }).settings;
  const { settings } = computeUninstall(installed, { inheritedBase: "user-bar" });
  assert.equal(settings.statusLine?.command, "proj-bar");
});
