import test from "node:test";
import assert from "node:assert/strict";
import { humanizedRow } from "./dashboard-render.ts";
import { humanizeLogLine } from "./log-view.ts";
import { event } from "./event-log.ts";

// A minimal DOM stub: enough of `document`/`Element` for the pure `.lv-row` factory. Each
// node records its tag, className, textContent and children so a test can read the structure
// back without a browser. `humanizedRow` only ever uses createElement/className/textContent/
// append, so this stub is a faithful stand-in.
interface StubNode {
  tag: string;
  className: string;
  textContent: string;
  children: StubNode[];
  append(...kids: StubNode[]): void;
}
const stubDoc = () =>
  ({
    createElement(tag: string): StubNode {
      const node: StubNode = {
        tag,
        className: "",
        textContent: "",
        children: [],
        append(...kids: StubNode[]) {
          this.children.push(...kids);
        },
      };
      return node;
    },
  }) as unknown as Document;

const build = (e: object) => humanizedRow(humanizeLogLine(JSON.stringify(e)), stubDoc()) as unknown as StubNode;
const cls = (n: StubNode) => n.children.map((c) => c.className);

// The shared `.lv-row` component (#216, mockup 1a): the three-tier grid `time · dot · message`,
// the actor leading the message as `.lv-lead`, a dim `.lv-verb`, and `code`/`strong` spans in
// `.lv-msg`. Built from a HumanizedRow's structured parts, all text set via textContent.

test("a lv-row is the three-tier grid: time, dot, then the message cell in that order", () => {
  const row = build(event("tool", { taskId: "204", name: "Edit", path: "src/x.ts", ts: "2026-08-28T14:01:23.000Z" }));
  assert.equal(row.className, "lv-row");
  assert.deepEqual(cls(row), ["lv-t", "lv-dot running", "lv-msg"]);
  const [t, dot] = row.children;
  assert.equal(t.textContent, "14:01:23");
  assert.ok(dot.className.includes("running"), "the dot carries the state colour class");
});

test("the actor leads the message as .lv-lead, then the dim .lv-verb, then the spans", () => {
  const row = build(event("commit", { taskId: "204", branch: "agent/204", sha: "abcdef1234567", files: ["a"], ts: "2026-08-28T00:00:00.000Z" }));
  const msg = row.children[2];
  assert.equal(msg.className, "lv-msg");
  assert.deepEqual(
    msg.children.map((c) => [c.tag, c.className, c.textContent]),
    [
      ["span", "lv-lead", "#204"],
      ["span", "lv-verb", "committed"],
      ["code", "", "abcdef1"],
      ["span", "", " · 1 file"],
    ],
  );
});

test("a strong span renders as <strong>, a code span as <code>; plain spans stay <span>", () => {
  const row = build(event("turn", { taskId: "204", turn: 3, summary: "Wired it", ts: "2026-08-28T00:00:00.000Z" }));
  const msg = row.children[2];
  assert.deepEqual(
    msg.children.map((c) => [c.tag, c.textContent]),
    [
      ["span", "#204"],
      ["span", "turn 3"],
      ["strong", "Wired it"],
    ],
  );
});

test("a run-level row (no actor, no verb) is just the message spans — no empty lead/verb cells", () => {
  const row = build(event("campaign-done", { batches: 2, ts: "2026-08-28T00:00:00.000Z" }));
  const msg = row.children[2];
  // Exactly one span (the describeEvent narration); no .lv-lead and no .lv-verb.
  assert.equal(msg.children.length, 1);
  assert.ok(!msg.children.some((c) => c.className === "lv-lead" || c.className === "lv-verb"));
});
