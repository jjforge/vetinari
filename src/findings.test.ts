import test from "node:test";
import assert from "node:assert/strict";
import { parseFindings, reportFindings } from "./findings.ts";

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
