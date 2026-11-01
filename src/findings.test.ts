import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bestFindingMatch,
  FINDING_MATCH_THRESHOLD,
  findingKey,
  findingSimilarity,
  parseFindings,
  reportFindings,
  scrubFinding,
  triageFindings,
  type Finding,
} from "./findings.ts";

test("parseFindings extracts each finding block with its sub-fields", () => {
  const stdout = `working... here is what I noticed.
<finding>
  <summary>Race in the merge queue</summary>
  <location>src/merge.ts</location>
  <repro>run two campaigns at once</repro>
</finding>
noise
<finding>
  <summary>Typo in the CLI usage</summary>
  <location>src/cli.mts</location>
</finding>
<promise>COMPLETE</promise>`;

  const findings = parseFindings(stdout);

  assert.equal(findings.length, 2);
  assert.deepEqual(findings[0], { summary: "Race in the merge queue", location: "src/merge.ts", repro: "run two campaigns at once" });
  assert.equal(findings[1].summary, "Typo in the CLI usage");
  assert.equal(findings[1].repro, undefined);
});

test("parseFindings treats an explicit none as zero findings", () => {
  assert.deepEqual(parseFindings("all clear\n<finding>none</finding>\n<promise>COMPLETE</promise>"), []);
  assert.deepEqual(parseFindings("nothing tagged here at all"), []);
});

test("parseFindings falls back to the block text when there is no summary tag", () => {
  const findings = parseFindings("<finding>the sidecar leaks a file handle on shutdown</finding>");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].summary, "the sidecar leaks a file handle on shutdown");
});

test("reportFindings files every finding and isolates a failure to its own finding", async () => {
  const calls: string[] = [];
  const reporter = async (finding: { summary: string }) => {
    calls.push(finding.summary);
    if (finding.summary === "boom") throw new Error("gh exploded");
    return `https://example/issues/${calls.length}`;
  };

  const results = await reportFindings(reporter, [{ summary: "one" }, { summary: "boom" }, { summary: "three" }], {
    taskId: "640",
    project: "demo",
  });

  assert.deepEqual(calls, ["one", "boom", "three"]); // all three attempted despite the middle failure
  assert.equal(results[0].url, "https://example/issues/1");
  assert.equal(results[1].error, "gh exploded");
  assert.equal(results[1].url, undefined);
  assert.equal(results[2].url, "https://example/issues/3");
});

test("reportFindings marks the finding handed to the reporter with the non-green exit its context carries", async () => {
  const received: Finding[] = [];
  const reporter = (finding: Finding) => {
    received.push(finding);
    return "https://example/issues/1";
  };

  const results = await reportFindings(
    reporter,
    [{ summary: "Sidecar leaks a file handle", location: "src/db.rs", repro: "start then SIGTERM" }],
    { taskId: "640", project: "demo", source: "budget:6" },
  );

  // The reporter (whatever it is) sees the source folded into the filed finding, so the
  // issue a triager reads is marked as weaker evidence — the agent never went green.
  assert.match(received[0].summary, /budget:6/);
  assert.match(received[0].summary, /Sidecar leaks a file handle/);
  // location and repro pass through untouched — only the summary carries the mark.
  assert.equal(received[0].location, "src/db.rs");
  assert.equal(received[0].repro, "start then SIGTERM");
  // The returned result records the original finding, unmarked — the mark is a filing concern.
  assert.equal(results[0].finding.summary, "Sidecar leaks a file handle");
});

test("reportFindings leaves a green-run finding untouched — no source in context, filed form unchanged", async () => {
  const received: Finding[] = [];
  const reporter = (finding: Finding) => {
    received.push(finding);
    return "https://example/issues/1";
  };
  const original = { summary: "Sidecar leaks a file handle", location: "src/db.rs", repro: "start then SIGTERM" };

  await reportFindings(reporter, [original], { taskId: "640", project: "demo" });

  assert.deepEqual(received[0], original);
});

test("parseFindings reads an agent-rated severity (P0–P3) and omits it when absent or unrecognised", () => {
  const [rated, unrated, junk] = parseFindings(
    "<finding><summary>a</summary><severity>p1 — blocks a gate</severity></finding>" +
      "<finding><summary>b</summary></finding>" +
      "<finding><summary>c</summary><severity>high</severity></finding>",
  );
  assert.equal(rated.severity, "P1");
  assert.equal("severity" in unrated, false);
  assert.equal("severity" in junk, false);
});

test("findingKey matches the same finding across case, punctuation and the unverified mark", () => {
  assert.equal(findingKey("[unverified: budget:2] `make fmt` fails: gofumpt sumdb!"), findingKey("make fmt fails — gofumpt sumdb"));
  assert.notEqual(findingKey("make fmt fails"), findingKey("make lint fails"));
});

test("findingSimilarity scores two rewordings of one finding as a match, and unrelated findings as not", () => {
  const a = "make fmt fails in the agent container: gofumpt sumdb check";
  const b = "make fmt fails: gofumpt sumdb verification error in container";
  // {make fmt agent container gofumpt sumdb check} vs {make fmt gofumpt sumdb verification error container}: 5 shared of 9.
  assert.equal(findingSimilarity(a, b), 5 / 9);
  assert.ok(findingSimilarity(a, "README links to a removed flag") < FINDING_MATCH_THRESHOLD);
  assert.equal(findingSimilarity(a, a), 1);
  assert.equal(findingSimilarity(`[unverified: idle] ${a}`, a), 1, "the unverified mark is not part of the finding");
});

test("bestFindingMatch matches a rewording scoring between 0.35 and 0.5", () => {
  // Real filings of one defect, worded by two agents.
  const title = "The gateway poll loop's error row writes the full bot token into the host log";
  const candidate =
    "The full Telegram bot token is written to the host log on a poll-loop error, and the unauthenticated dashboard serves that log as-is";
  const score = findingSimilarity(title, candidate);
  assert.ok(score >= 0.35 && score < 0.5, `scored ${score}`);
  assert.equal(
    bestFindingMatch(title, [candidate], (c) => c),
    candidate,
  );
});

test("triageFindings resolves with every finding's result when only the digest comment throws, handing the error to digestFailed", async () => {
  const failures: { error: string; digested: string[] }[] = [];
  const findings: Finding[] = [
    { summary: "stale doc line", severity: "P3" },
    { summary: "merge queue drops a commit", severity: "P0" },
  ];

  const results = await triageFindings(
    findings,
    { taskId: "T-1", project: "vetinari" },
    {
      reporter: () => "https://example/issues/1",
      postComment: async () => {
        throw new Error("gh: comment rejected");
      },
      filedSoFar: () => new Map(),
      record: () => {},
      digestFailed: (error, digested) => failures.push({ error, digested: digested.map((f) => f.summary) }),
      maxPerRun: 1,
      severityFloor: "P2",
      lockFile: join(mkdtempSync(join(tmpdir(), "vetinari-triage-")), "findings.lock"),
    },
  );

  assert.deepEqual(
    results.map((r) => [r.finding.summary, r.action, r.url]),
    [
      ["merge queue drops a commit", "filed", "https://example/issues/1"],
      ["stale doc line", "digest", undefined],
    ],
  );
  assert.deepEqual(failures, [{ error: "gh: comment rejected", digested: ["stale doc line"] }]);
});

test("triageFindings' 'seen again' comment quotes the finding, with its location backticked after a dash when it has one", async () => {
  const comments: string[] = [];
  const findings: Finding[] = [
    { summary: "make fmt fails: gofumpt sumdb", location: "vendor/forgejo/Makefile", severity: "P1" },
    { summary: "make lint fails: golangci timeout", severity: "P1" },
  ];

  await triageFindings(
    findings,
    { taskId: "T-7", project: "vetinari" },
    {
      reporter: () => assert.fail("a seen-again finding is not filed"),
      postComment: (_ref, body) => void comments.push(body),
      filedSoFar: () =>
        new Map([
          [findingKey("make fmt fails: gofumpt sumdb"), "https://example/issues/1"],
          [findingKey("make lint fails: golangci timeout"), "https://example/issues/2"],
        ]),
      record: () => {},
      digestFailed: () => {},
      maxPerRun: 5,
      severityFloor: "P2",
      lockFile: join(mkdtempSync(join(tmpdir(), "vetinari-triage-")), "findings.lock"),
    },
  );

  assert.deepEqual(comments, [
    "Seen again while working on #T-7: make fmt fails: gofumpt sumdb — `vendor/forgejo/Makefile`",
    "Seen again while working on #T-7: make lint fails: golangci timeout",
  ]);
});

test("scrubFinding redacts a known secret's exact value in every text field, by its env key, and counts it", () => {
  const value = "sk-ant-abc123-the-provider-credential-xyz";
  const secrets = [
    { name: "ANTHROPIC_API_KEY", value },
    { name: "SHORT", value: "hello" },
  ];
  const { finding, redactions } = scrubFinding(
    { summary: `leaked ${value} in a hello log`, location: `config/${value}`, repro: `echo ${value}; echo hello`, severity: "P2" },
    secrets,
  );
  assert.deepEqual(finding, {
    summary: "leaked [redacted ANTHROPIC_API_KEY] in a hello log",
    location: "config/[redacted ANTHROPIC_API_KEY]",
    repro: "echo [redacted ANTHROPIC_API_KEY]; echo hello",
    severity: "P2",
  });
  assert.deepEqual(redactions, { ANTHROPIC_API_KEY: 3 });
});

test("scrubFinding redacts each common token shape by kind, an Anthropic key as anthropic-key only, and a private-key block whole", () => {
  const tail = "A1b2C3d4E5f6G7h8I9j0K1l2";
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabc/def+ghi==\n-----END RSA PRIVATE KEY-----";
  const { finding, redactions } = scrubFinding(
    {
      summary: `keys: sk-ant-${tail} sk-${tail} ghp_${tail} github_pat_${tail}_x xoxb-123456-abcdef AKIAIOSFODNN7EXAMPLE`,
      repro: `cat id_rsa:\n${pem}\ndone`,
    },
    [],
  );
  assert.equal(
    finding.summary,
    "keys: [redacted: anthropic-key] [redacted: openai-key] [redacted: github-token] [redacted: github-token] [redacted: slack-token] [redacted: aws-key]",
  );
  assert.equal(finding.repro, "cat id_rsa:\n[redacted: private-key]\ndone");
  assert.deepEqual(redactions, {
    "anthropic-key": 1,
    "openai-key": 1,
    "github-token": 2,
    "slack-token": 1,
    "aws-key": 1,
    "private-key": 1,
  });
});

test("scrubFinding leaves ordinary text alone but still catches a key after a space or a quote", () => {
  const ordinary: Finding = {
    summary: "the sk- prefix and a bare ghp_ prefix are documented",
    location: "src/loop.ts",
    repro: "open src/task-management-and-scheduling.ts",
  };
  assert.deepEqual(scrubFinding(ordinary, []), { finding: ordinary, redactions: {} });

  const tail = "Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2";
  const { finding, redactions } = scrubFinding({ summary: `key sk-proj-${tail}`, repro: `const k = "sk-${tail}";` }, []);
  assert.equal(finding.summary, "key [redacted: openai-key]");
  assert.equal(finding.repro, 'const k = "[redacted: openai-key]";');
  assert.deepEqual(redactions, { "openai-key": 2 });
});

test("scrubFinding redacts a known value that contains another known value whole", () => {
  const inner = "inner-secret-123";
  const outer = `prefix-${inner}-suffix`;
  const { finding, redactions } = scrubFinding({ summary: `saw ${outer} and ${inner}` }, [
    { name: "INNER", value: inner },
    { name: "OUTER", value: outer },
  ]);
  assert.equal(finding.summary, "saw [redacted OUTER] and [redacted INNER]");
  assert.deepEqual(redactions, { OUTER: 1, INNER: 1 });
});
