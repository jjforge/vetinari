import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { applyInit, computeInit, describeInit, isGithubComRemote, scanInit } from "./init.ts";
import { AGENT_PROVIDERS, DEFAULT_PROVIDER } from "./config.ts";

const TEMPLATES = {
  configTemplate: "CONFIG SKELETON\n",
  githubConfigTemplate: "GITHUB CONFIG\n",
  // The non-GitHub default; the GitHub-origin tests override it.
  githubOrigin: false,
  dockerfileTemplate: "FROM node:22-bookworm\n",
  tsconfigTemplate: "TSCONFIG\n",
};

let counter = 0;
const tmpProject = () => {
  const dir = join(tmpdir(), `vetinari-init-${Date.now()}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

test("computeInit plans the full scaffold for a fresh directory", () => {
  const plan = computeInit({ hasConfig: false, hasTsconfig: false, hasLocalDir: false, gitignore: undefined, ...TEMPLATES });

  // Not a refusal — greenfield project, so the committed scaffold is laid down.
  assert.equal(plan.refused, false);
  // The committed vetinari/ scaffold: a defineConfig skeleton and a Dockerfile.
  assert.deepEqual(
    plan.creates.find((c) => c.path === "vetinari/config.mts"),
    { path: "vetinari/config.mts", content: "CONFIG SKELETON\n" },
  );
  assert.deepEqual(
    plan.creates.find((c) => c.path === "vetinari/Dockerfile"),
    { path: "vetinari/Dockerfile", content: "FROM node:22-bookworm\n" },
  );
  // ...and the committed tsconfig that gives the config its editor and tsc types.
  assert.deepEqual(
    plan.creates.find((c) => c.path === "vetinari/tsconfig.json"),
    { path: "vetinari/tsconfig.json", content: "TSCONFIG\n" },
  );
  // The excluded machine-local dir is created...
  assert.ok(plan.dirs.includes(".vetinari.local"));
  // ...and .gitignore gains its entry (the file was absent, so it is created).
  assert.match(plan.gitignore!, /^\.vetinari\.local\/$/m);
});

test("computeInit writes the githubTracker config when origin is a GitHub remote", () => {
  const plan = computeInit({
    hasConfig: false,
    hasTsconfig: false,
    hasLocalDir: false,
    gitignore: undefined,
    ...TEMPLATES,
    githubOrigin: true,
  });

  assert.deepEqual(
    plan.creates.find((c) => c.path === "vetinari/config.mts"),
    { path: "vetinari/config.mts", content: "GITHUB CONFIG\n" },
  );
});

test("computeInit yields an empty plan for an already-initialized directory", () => {
  const plan = computeInit({
    // Config present, local dir present, and .gitignore already excludes it.
    hasConfig: true,
    hasTsconfig: true,
    hasLocalDir: true,
    gitignore: "node_modules/\n.vetinari.local/\n*.log\n",
    ...TEMPLATES,
  });

  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.dirs, []);
  assert.equal(plan.gitignore, undefined);
});

test("computeInit refuses to overwrite an existing config but still fills missing pieces", () => {
  const plan = computeInit({
    // A config the maintainer already wrote — never to be clobbered — but no tsconfig yet.
    hasConfig: true,
    hasTsconfig: false,
    // ...but the machine-local dir and the gitignore entry are still missing.
    hasLocalDir: false,
    gitignore: "node_modules/\n",
    ...TEMPLATES,
  });

  // The committed scaffold is withheld — no config, no Dockerfile write; only the missing tsconfig.
  assert.equal(plan.refused, true);
  assert.deepEqual(plan.creates, [{ path: "vetinari/tsconfig.json", content: "TSCONFIG\n" }]);
  // The missing machine-local pieces are still planned, without disturbing config.
  assert.ok(plan.dirs.includes(".vetinari.local"));
  assert.match(plan.gitignore!, /^\.vetinari\.local\/$/m);
});

test("computeInit plans no tsconfig for an existing config that already has one", () => {
  const plan = computeInit({ hasConfig: true, hasTsconfig: true, hasLocalDir: false, gitignore: undefined, ...TEMPLATES });

  assert.equal(plan.refused, true);
  assert.deepEqual(plan.creates, []);
});

test("computeInit plans only the gitignore edit when that is the sole missing piece", () => {
  const plan = computeInit({
    hasConfig: true,
    hasTsconfig: true,
    hasLocalDir: true,
    // Everything is in place except the .gitignore entry.
    gitignore: "node_modules/\n*.log\n",
    ...TEMPLATES,
  });

  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.dirs, []);
  // The excluded dir is appended; the pre-existing lines survive.
  assert.match(plan.gitignore!, /^\.vetinari\.local\/$/m);
  assert.match(plan.gitignore!, /^node_modules\/$/m);
});

test("computeInit adds nothing to a .gitignore that already lists the entry without a trailing slash", () => {
  const plan = computeInit({ hasConfig: true, hasTsconfig: true, hasLocalDir: true, gitignore: ".vetinari.local\n", ...TEMPLATES });
  assert.equal(plan.gitignore, undefined);
});

test("applyInit lays the scaffold down where the plan says, against a tmp dir", () => {
  const dir = tmpProject();
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");

  const plan = computeInit({
    hasConfig: false,
    hasTsconfig: false,
    hasLocalDir: false,
    gitignore: readFileSync(join(dir, ".gitignore"), "utf8"),
    ...TEMPLATES,
  });
  const result = applyInit(dir, plan);

  // Committed scaffold files land with the template content.
  assert.equal(readFileSync(join(dir, "vetinari", "config.mts"), "utf8"), "CONFIG SKELETON\n");
  assert.equal(readFileSync(join(dir, "vetinari", "Dockerfile"), "utf8"), "FROM node:22-bookworm\n");
  // The excluded machine-local dir exists.
  assert.ok(statSync(join(dir, ".vetinari.local")).isDirectory());
  // .gitignore now excludes it, keeping the pre-existing entry.
  const gi = readFileSync(join(dir, ".gitignore"), "utf8");
  assert.match(gi, /^\.vetinari\.local\/$/m);
  assert.match(gi, /^node_modules\/$/m);

  assert.deepEqual(result.created.sort(), ["vetinari/Dockerfile", "vetinari/config.mts", "vetinari/tsconfig.json"]);
  assert.deepEqual(result.dirsCreated, [".vetinari.local"]);
  assert.equal(result.gitignoreUpdated, true);
});

test("applyInit refuses to clobber a committed scaffold file that appeared since the scan", () => {
  const dir = tmpProject();
  mkdirSync(join(dir, "vetinari"), { recursive: true });
  writeFileSync(join(dir, "vetinari", "config.mts"), "MINE — do not touch\n");

  // A stale plan (scanned when the config was absent) must not overwrite it.
  const stalePlan = computeInit({ hasConfig: false, hasTsconfig: false, hasLocalDir: false, gitignore: undefined, ...TEMPLATES });
  assert.throws(() => applyInit(dir, stalePlan), /already exists/i);
  assert.equal(readFileSync(join(dir, "vetinari", "config.mts"), "utf8"), "MINE — do not touch\n");
});

test("applyInit adds vetinari/tsconfig.json to a project that already has a config, leaving the config byte-for-byte", () => {
  const dir = tmpProject();
  mkdirSync(join(dir, "vetinari"), { recursive: true });
  writeFileSync(join(dir, "vetinari", "config.mts"), "MINE — do not touch\n");

  const result = applyInit(
    dir,
    computeInit({ hasConfig: true, hasTsconfig: false, hasLocalDir: true, gitignore: ".vetinari.local/\n", ...TEMPLATES }),
  );

  assert.deepEqual(result.created, ["vetinari/tsconfig.json"]);
  assert.equal(readFileSync(join(dir, "vetinari", "tsconfig.json"), "utf8"), "TSCONFIG\n");
  assert.equal(readFileSync(join(dir, "vetinari", "config.mts"), "utf8"), "MINE — do not touch\n");
});

test("applyInit fills only the gitignore when that is all the plan carries", () => {
  const dir = tmpProject();
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");

  const plan = computeInit({ hasConfig: true, hasTsconfig: true, hasLocalDir: true, gitignore: "node_modules/\n", ...TEMPLATES });
  const result = applyInit(dir, plan);

  assert.deepEqual(result.created, []);
  assert.deepEqual(result.dirsCreated, []);
  assert.equal(result.gitignoreUpdated, true);
  assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /^\.vetinari\.local\/$/m);
});

test("describeInit reports nothing to do for an empty plan", () => {
  const text = describeInit(
    computeInit({ hasConfig: true, hasTsconfig: true, hasLocalDir: true, gitignore: ".vetinari.local/\n", ...TEMPLATES }),
  );
  assert.match(text, /nothing to do/i);
});

test("describeInit summarizes the full scaffold and the next steps", () => {
  const text = describeInit(computeInit({ hasConfig: false, hasTsconfig: false, hasLocalDir: false, gitignore: undefined, ...TEMPLATES }));

  assert.match(text, /vetinari\/config\.mts/);
  assert.match(text, /vetinari\/Dockerfile/);
  assert.match(text, /\.vetinari\.local/);
  assert.match(text, /\.gitignore/);
  // The next steps: fill Dockerfile/gates, build the image, run baseline.
  assert.match(text, /baseline/);
  assert.match(text, /build/i);
});

test("describeInit's next steps name the agent credential file and every key of the default provider", () => {
  const text = describeInit(computeInit({ hasConfig: false, hasTsconfig: false, hasLocalDir: false, gitignore: undefined, ...TEMPLATES }));

  // The credential the first real `run` needs — named where a new project will look.
  assert.match(text, /\.vetinari\.local\/\.env/);
  // Both of the default provider's credential keys are printed from AGENT_PROVIDERS (any one
  // satisfies the preflight), not one hard-coded key — so `init` tracks the provider table (§13.1).
  for (const key of AGENT_PROVIDERS[DEFAULT_PROVIDER].credentialKeys) assert.match(text, new RegExp(key));
  // The next-steps name the `agent` config option, so a project picking another provider knows what to set.
  assert.match(text, /`agent`/);
});

test("describeInit's next steps name the Telegram bot connection step and the tg-connect mode", () => {
  const text = describeInit(computeInit({ hasConfig: false, hasTsconfig: false, hasLocalDir: false, gitignore: undefined, ...TEMPLATES }));

  // The bot connection is called out as a next step, naming the mode that collects it —
  // in our vocabulary ("bot connection"), and pointing at host.env, not the container gate.
  assert.match(text, /bot connection/i);
  assert.match(text, /tg-connect/);
  assert.match(text, /host\.env/);
});

test("describeInit says which config it writes, and why", () => {
  const fresh = { hasConfig: false, hasTsconfig: false, hasLocalDir: false, gitignore: undefined, ...TEMPLATES };

  const github = describeInit(computeInit({ ...fresh, githubOrigin: true }));
  assert.match(github, /\+ vetinari\/config\.mts — the githubTracker\(\) config, because origin is a github\.com remote/);

  const skeleton = describeInit(computeInit(fresh));
  assert.match(skeleton, /\+ vetinari\/config\.mts — the skeleton with TODO stubs, because origin is missing or not a github\.com remote/);
});

test("describeInit leads with a clear refusal when a config already exists", () => {
  const text = describeInit(
    computeInit({ hasConfig: true, hasTsconfig: true, hasLocalDir: false, gitignore: "node_modules/\n", ...TEMPLATES }),
  );

  // The config is called out as untouched...
  assert.match(text, /vetinari\/config\.mts/);
  assert.match(text, /already exists|untouched/i);
  // ...and the still-missing pieces it filled are listed.
  assert.match(text, /\.vetinari\.local/);
});

test("describeInit lists a tsconfig added to an existing project, with no next steps", () => {
  const text = describeInit(
    computeInit({ hasConfig: true, hasTsconfig: false, hasLocalDir: true, gitignore: ".vetinari.local/\n", ...TEMPLATES }),
  );

  assert.match(text, /\+ vetinari\/tsconfig\.json/);
  assert.doesNotMatch(text, /Next steps/);
});

test("scanInit reads a fresh directory and the install templates into a scan the planner can use", () => {
  const dir = tmpProject();

  const scan = scanInit(dir);

  assert.equal(scan.hasConfig, false);
  assert.equal(scan.hasLocalDir, false);
  assert.equal(scan.gitignore, undefined);
  // Templates come from the shared install, not the project.
  assert.match(scan.configTemplate, /defineConfig/);
  assert.match(scan.dockerfileTemplate, /^FROM /m);
  assert.equal(scan.hasTsconfig, false);
  assert.match(scan.tsconfigTemplate, /"extends": "\.\.\/\.vetinari\.local\/tsconfig\.json"/);

  // Fed to the planner it produces the full scaffold.
  const plan = computeInit(scan);
  assert.equal(plan.refused, false);
  assert.ok(plan.creates.some((c) => c.path === "vetinari/config.mts"));
});

test("scanInit detects an existing canonical config and the excluded dir off disk", () => {
  const dir = tmpProject();
  mkdirSync(join(dir, "vetinari"), { recursive: true });
  writeFileSync(join(dir, "vetinari", "config.mts"), "export default {}\n");
  writeFileSync(join(dir, "vetinari", "tsconfig.json"), "{}\n");
  mkdirSync(join(dir, ".vetinari.local"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n");

  const scan = scanInit(dir);

  assert.equal(scan.hasConfig, true);
  assert.equal(scan.hasTsconfig, true);
  assert.equal(scan.hasLocalDir, true);
  assert.equal(scan.gitignore, "node_modules/\n");

  // The planner refuses the committed scaffold but plans the gitignore entry.
  const plan = computeInit(scan);
  assert.equal(plan.refused, true);
  assert.match(plan.gitignore!, /^\.vetinari\.local\/$/m);
});

test("isGithubComRemote accepts only an origin whose host is exactly github.com, over SSH or HTTPS", () => {
  assert.equal(isGithubComRemote("git@github.com:acme/widgets.git"), true);
  assert.equal(isGithubComRemote("https://github.com/acme/widgets.git"), true);
  assert.equal(isGithubComRemote("https://github.com/acme/widgets\n"), true);
  // An SSH host alias and a GitHub Enterprise host are not github.com.
  assert.equal(isGithubComRemote("git@github.com-work:acme/widgets.git"), false);
  assert.equal(isGithubComRemote("https://github.acme.corp/acme/widgets.git"), false);
  assert.equal(isGithubComRemote("git@github.acme.corp:acme/widgets.git"), false);
  assert.equal(isGithubComRemote("https://github.com.evil.example/acme/widgets"), false);
  // A non-GitHub host, and a github.com URL with no owner/name, get the skeleton.
  assert.equal(isGithubComRemote("git@gitlab.com:acme/widgets.git"), false);
  assert.equal(isGithubComRemote("https://github.com/"), false);
});

const gitProject = (origin?: string) => {
  const dir = tmpProject();
  execFileSync("git", ["init", "-q", dir]);
  if (origin) execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
  return dir;
};

test("scanInit plans the githubTracker config from the install for a project whose origin is on github.com", () => {
  const scan = scanInit(gitProject("git@github.com:acme/widgets.git"));

  assert.equal(scan.githubOrigin, true);
  const config = computeInit(scan).creates.find((c) => c.path === "vetinari/config.mts")!.content;
  assert.match(config, /import \{ defineConfig, githubTracker \} from "vetinari";/);
  assert.match(config, /^\s*\.\.\.githubTracker\(\),/m);
  // No fetchTask stub and no commented-out github* resolver lines.
  assert.doesNotMatch(config, /fetchTask:/);
  assert.doesNotMatch(config, /^\s*\/\/.*github(BlockedBy|IssuesByLabel)/m);
});

test("scanInit plans today's skeleton for a project with no origin, or a non-GitHub one", () => {
  for (const dir of [
    tmpProject(),
    gitProject(),
    gitProject("git@github.com-work:acme/widgets.git"),
    gitProject("https://gitlab.com/acme/widgets.git"),
  ]) {
    const scan = scanInit(dir);

    assert.equal(scan.githubOrigin, false);
    const config = computeInit(scan).creates.find((c) => c.path === "vetinari/config.mts")!.content;
    assert.match(config, /fetchTask: \(id\) => `TODO/);
    assert.doesNotMatch(config, /^\s*\.\.\.githubTracker\(\)/m);
  }
});
