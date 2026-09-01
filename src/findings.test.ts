import test from "node:test";
import assert from "node:assert/strict";
import { parseFindings, reportFindings, type Finding } from "./findings.ts";

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

  const results = await reportFindings(reporter, [{ summary: "one" }, { summary: "boom" }, { summary: "three" }], { taskId: "640", project: "demo" });

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
