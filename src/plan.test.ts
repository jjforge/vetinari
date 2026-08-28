import test from "node:test";
import assert from "node:assert/strict";
import {
  applyGraft,
  validateGraftTargets,
  describePlan,
  labelsFromTask,
  layerWaves,
  partitionWaves,
  planCampaign,
  runCampaignPlan,
  runFilesetCheck,
  describeFilesetCheck,
  suggestCampaignName,
  underspecifiedPromptFor,
  waveArgs,
} from "./plan.ts";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultFileSet } from "./fileset.ts";
import type { FileSet } from "./fileset.ts";

// A fake OPEN-blocked-by resolver from a plain edge map: id -> its open blockers.
// (Closed blockers never reach the resolver — they are filtered at the edge — so
// anything listed here is, by contract, an open prerequisite still in flight.)
const openBlockedByFrom = (edges: Record<string, string[]>) => (id: string) =>
  edges[id] ?? [];

test("layerWaves orders the set by its in-set blockedBy graph", async () => {
  // 701 is blocked by 640; 640 is blocked by 611; 623 is free.
  const plan = await layerWaves(
    ["611", "623", "640", "701"],
    openBlockedByFrom({ "701": ["640"], "640": ["611"] }),
  );

  assert.deepEqual(plan.waves, [
    ["611", "623"], // wave 0: nothing open in the set blocks them
    ["640"], // wave 1: after 611
    ["701"], // wave 2: after 640
  ]);
  assert.deepEqual(plan.unreachable, []);
});

test("layerWaves puts a ticket whose blockers are all closed on the frontier", async () => {
  // 640's blocker already merged, so the resolver returns no open blocker for it:
  // it belongs in wave 0 next to the unblocked 611, not held back.
  const plan = await layerWaves(
    ["611", "640"],
    openBlockedByFrom({ "640": [] }),
  );

  assert.deepEqual(plan.waves, [["611", "640"]]);
  assert.deepEqual(plan.unreachable, []);
});

test("layerWaves drops a ticket held by an open blocker outside the set, and reports why", async () => {
  // 701's open blocker 555 is not in the selected set, so 701 cannot run here.
  const plan = await layerWaves(
    ["611", "701"],
    openBlockedByFrom({ "701": ["555"] }),
  );

  assert.deepEqual(plan.waves, [["611"]]);
  assert.deepEqual(plan.unreachable, [
    { id: "701", external: ["555"], via: [] },
  ]);
});

test("layerWaves carries unreachability down the dependent chain", async () => {
  // 701 is unreachable (open out-of-set blocker 555); 712 is blocked by 701, so
  // it cannot run either — it is dropped as a dependent, not silently scheduled.
  const plan = await layerWaves(
    ["611", "701", "712"],
    openBlockedByFrom({ "701": ["555"], "712": ["701"] }),
  );

  assert.deepEqual(plan.waves, [["611"]]);
  assert.deepEqual(plan.unreachable, [
    { id: "701", external: ["555"], via: [] },
    { id: "712", external: [], via: ["701"] },
  ]);
});

// id -> the basenames it touches, for the file-disjoint partition.
const basenamesFrom = (files: Record<string, string[]>) =>
  new Map(Object.entries(files).map(([id, names]) => [id, new Set(names)]));

test("partitionWaves spills a basename-colliding ticket into a later sub-wave", async () => {
  // One dependency layer of three; 'a' and 'c' both touch x, so they cannot share
  // a wave. Greedy first-fit packs a+b (disjoint), then spills c past them.
  const layered = await layerWaves(["a", "b", "c"], openBlockedByFrom({}));
  const plan = partitionWaves(
    layered,
    basenamesFrom({ a: ["x"], b: ["y"], c: ["x"] }),
  );

  assert.deepEqual(plan.waves, [["a", "b"], ["c"]]);
  // c is placed in wave 1 and records the collision that spilled it.
  const c = plan.placements.find((p) => p.id === "c")!;
  assert.equal(c.wave, 1);
  assert.deepEqual(c.sharesFilesWith, ["a"]);
});

test("Creates-cited new files feed wave-disjointness: two tickets creating one file spill apart", async () => {
  // Both tickets create `event-log.ts` — a new file in neither's tree — so the
  // resolver's basenames must still keep them out of one wave. Resolve through the
  // shipped defaultFileSet (an empty tree: the file does not exist yet) to prove
  // Creates cites reach the partition, not just a hand-built basename map.
  const emptyRoot = join(tmpdir(), `vetinari-noexist-${Date.now()}`);
  mkdirSync(emptyRoot, { recursive: true });
  const fileSet = defaultFileSet(emptyRoot);
  const a = fileSet("Creates: `event-log.ts`");
  const b = fileSet("Creates: `src/event-log.ts`"); // same basename via a path
  assert.equal(a.confident, true);
  assert.equal(b.confident, true);

  const layered = await layerWaves(["a", "b"], openBlockedByFrom({}));
  const plan = partitionWaves(
    layered,
    new Map([
      ["a", new Set(a.files)],
      ["b", new Set(b.files)],
    ]),
  );

  assert.deepEqual(plan.waves, [["a"], ["b"]]);
});

// Regression: the 2026-08-19 campaign (~41 issues). The spec fixes the invariant,
// not the raw graph, so this reconstructs its shape: #461 has NO blockedBy edge yet
// shares `stack_strip.tmpl` with #378/#688/#400, so a pure-DAG planner drops all
// four into wave 0 and collides. The file partition must spill #461 clear of them.
// Around that cluster sit a dependency chain, a diamond, a second wave-0 file pair,
// a deeper-layer file pair, and unique-file filler to reach campaign scale.
type Issue = { id: string; blockedBy?: string[]; files: string[] };
const FIXTURE_2026_08_19: Issue[] = [
  // The template-crossover cluster — all on the frontier, all touching stack_strip.tmpl.
  { id: "378", files: ["stack_strip.tmpl", "view_378.rs"] },
  { id: "688", files: ["stack_strip.tmpl", "view_688.rs"] },
  { id: "400", files: ["stack_strip.tmpl", "view_400.rs"] },
  { id: "461", files: ["stack_strip.tmpl", "view_461.rs"] }, // no blockedBy edge
  // A linear dependency chain.
  { id: "611", files: ["a.ts"] },
  { id: "640", blockedBy: ["611"], files: ["b.ts"] },
  { id: "701", blockedBy: ["640"], files: ["c.ts"] },
  { id: "712", blockedBy: ["701"], files: ["d.ts"] },
  { id: "730", blockedBy: ["712"], files: ["e.ts"] },
  // A diamond.
  { id: "500", files: ["f.ts"] },
  { id: "501", blockedBy: ["500"], files: ["g.ts"] },
  { id: "502", blockedBy: ["500"], files: ["h.ts"] },
  { id: "503", blockedBy: ["501", "502"], files: ["i.ts"] },
  // A second frontier file pair — both touch shared_db.rs, so one must spill.
  { id: "900", files: ["shared_db.rs"] },
  { id: "901", files: ["shared_db.rs"] },
  // A file collision one layer deep: both enter layer 1 behind 910 and share a file.
  { id: "910", files: ["x1.ts"] },
  { id: "911", blockedBy: ["910"], files: ["dup_layer.tmpl"] },
  { id: "912", blockedBy: ["910"], files: ["dup_layer.tmpl"] },
  // Unique-file filler, to campaign scale.
  ...Array.from({ length: 23 }, (_, i) => ({
    id: `${100 + i}`,
    files: [`u${i}.ts`],
  })),
];

test("2026-08-19 fixture: the partition is DAG-consistent and crossover-safe", async () => {
  const ids = FIXTURE_2026_08_19.map((i) => i.id);
  const edges = Object.fromEntries(
    FIXTURE_2026_08_19.map((i) => [i.id, i.blockedBy ?? []]),
  );
  const files = new Map(
    FIXTURE_2026_08_19.map((i) => [i.id, new Set(i.files)]),
  );

  const layered = await layerWaves(ids, openBlockedByFrom(edges));
  const plan = partitionWaves(layered, files);

  assert.equal(ids.length, 41, "fixture is at campaign scale");
  assert.deepEqual(
    plan.unreachable,
    [],
    "every blocker is in-set, so nothing is dropped",
  );

  // Crossover-safe: no basename appears twice within any wave.
  for (const [w, wave] of plan.waves.entries()) {
    const names = wave.flatMap((id) => [...files.get(id)!]);
    assert.equal(
      new Set(names).size,
      names.length,
      `wave ${w} shares a file: ${wave.join(", ")}`,
    );
  }

  // DAG-consistent: every in-set blocker sits in a strictly earlier wave.
  const waveOf = new Map(plan.placements.map((p) => [p.id, p.wave]));
  for (const issue of FIXTURE_2026_08_19) {
    for (const b of issue.blockedBy ?? []) {
      assert.ok(
        waveOf.get(b)! < waveOf.get(issue.id)!,
        `#${issue.id} must run after its blocker #${b}`,
      );
    }
  }

  // The named regression: #461 must not share a wave with any template sibling —
  // and since all four touch the file, the partition puts them in four waves.
  const cluster = ["378", "688", "400", "461"];
  assert.equal(
    new Set(cluster.map((id) => waveOf.get(id))).size,
    4,
    "the four stack_strip.tmpl tickets are all separated",
  );

  // The pure-DAG planner (layering alone) really does collide: all four share the
  // one dependency layer that the partition then has to break apart.
  const layerOf = new Map(layered.placements.map((p) => [p.id, p.wave]));
  assert.equal(
    new Set(cluster.map((id) => layerOf.get(id))).size,
    1,
    "pre-partition, all four sit in one layer and collide",
  );

  // Spilling works past the frontier too: the deeper-layer pair is separated.
  assert.notEqual(
    waveOf.get("911"),
    waveOf.get("912"),
    "the layer-1 dup_layer.tmpl pair is separated",
  );
});

test("partitionWaves only blames earlier sub-waves — a frontier ticket is never marked spilled", async () => {
  // a,b,c all touch x so they fan out across three sub-waves; c also touches z.
  // d touches only z: it collides with c, but c was itself spilled to a later
  // sub-wave, so d still fits the frontier and must NOT be reported as spilled.
  const layered = await layerWaves(["a", "b", "c", "d"], openBlockedByFrom({}));
  const plan = partitionWaves(
    layered,
    basenamesFrom({ a: ["x"], b: ["x"], c: ["x", "z"], d: ["z"] }),
  );

  const d = plan.placements.find((p) => p.id === "d")!;
  assert.equal(
    d.wave,
    0,
    "d shares nothing with sub-wave 0, so it stays on the frontier",
  );
  assert.deepEqual(
    d.sharesFilesWith,
    [],
    "the collider c sits in a later sub-wave, so it is not a spill reason",
  );
});

// id -> its resolved file-set, for the under-specified halt tests. A missing id
// is treated as under-specified so an unlisted ticket can never sneak past.
const fileSetFrom =
  (sets: Record<string, FileSet>) =>
  (id: string): FileSet =>
    sets[id] ?? { files: [], confident: false };

test("planCampaign plans a confident set without ever prompting", async () => {
  // Every ticket has a confident file-set, so the requestor is never consulted.
  const plan = await planCampaign(["611", "623", "640"], {
    blockedBy: openBlockedByFrom({ "640": ["611"] }),
    fileSet: fileSetFrom({
      "611": { files: ["a.ts"], confident: true },
      "623": { files: ["b.ts"], confident: true },
      "640": { files: ["c.ts"], confident: true },
    }),
    onUnderspecified: () => {
      throw new Error("must not prompt a confident set");
    },
  });

  assert.deepEqual(plan.waves, [["611", "623"], ["640"]]);
  assert.deepEqual(plan.underspecified, []);
  assert.deepEqual(plan.pruned, []);
});

test("planCampaign drops an under-specified ticket and its dependents, then plans the rest", async () => {
  // 640's file-set is not confident; 701 is blocked by 640, so it falls with it.
  // 611 and 623 are confident and unrelated — they must still be planned.
  const asked: string[][] = [];
  const plan = await planCampaign(["611", "623", "640", "701"], {
    blockedBy: openBlockedByFrom({ "701": ["640"] }),
    fileSet: fileSetFrom({
      "611": { files: ["a.ts"], confident: true },
      "623": { files: ["b.ts"], confident: true },
      "640": { files: [], confident: false },
      "701": { files: ["c.ts"], confident: true },
    }),
    onUnderspecified: (u) => {
      asked.push(u);
      return "drop";
    },
  });

  assert.deepEqual(
    asked,
    [["640"]],
    "asked once, in bulk, about the under-specified ticket",
  );
  assert.deepEqual(plan.underspecified, ["640"]);
  assert.deepEqual(
    plan.pruned,
    ["640", "701"],
    "the ticket and its dependent are pruned",
  );
  assert.deepEqual(
    plan.waves,
    [["611", "623"]],
    "the confident remainder is planned",
  );
});

test("planCampaign errors when the decision is to fail, naming the under-specified ticket", async () => {
  await assert.rejects(
    () =>
      planCampaign(["611", "640"], {
        blockedBy: openBlockedByFrom({}),
        fileSet: fileSetFrom({
          "611": { files: ["a.ts"], confident: true },
          "640": { files: [], confident: false },
        }),
        onUnderspecified: () => "fail",
      }),
    /#640.*confident/i,
  );
});

test("planCampaign does not ask about a ticket that is already unreachable", async () => {
  // 640's only open blocker 555 is outside the set, so 640 is dropped as
  // unreachable before file-sets matter — its missing file-set never halts the plan.
  const plan = await planCampaign(["611", "640"], {
    blockedBy: openBlockedByFrom({ "640": ["555"] }),
    fileSet: fileSetFrom({ "611": { files: ["a.ts"], confident: true } }),
    onUnderspecified: () => {
      throw new Error("must not ask about an already-unreachable ticket");
    },
  });

  assert.deepEqual(plan.waves, [["611"]]);
  assert.deepEqual(plan.underspecified, []);
  assert.deepEqual(plan.unreachable, [
    { id: "640", external: ["555"], via: [] },
  ]);
});

test("underspecifiedPromptFor: --on-underspecified=drop pre-decides without asking", async () => {
  const prompt = underspecifiedPromptFor({
    flag: "drop",
    isTTY: true,
    ask: () => {
      throw new Error("a flag must pre-decide, never ask");
    },
  });
  assert.equal(await prompt(["640"]), "drop");
});

test("underspecifiedPromptFor: --on-underspecified=fail pre-decides without asking", async () => {
  const prompt = underspecifiedPromptFor({
    flag: "fail",
    isTTY: false,
    ask: () => {
      throw new Error("a flag must pre-decide, never ask");
    },
  });
  assert.equal(await prompt(["640"]), "fail");
});

test("underspecifiedPromptFor: no flag on a terminal asks the requestor", async () => {
  const prompt = underspecifiedPromptFor({
    flag: undefined,
    isTTY: true,
    ask: () => "drop",
  });
  assert.equal(await prompt(["640"]), "drop");
});

test("underspecifiedPromptFor: no flag and no terminal defaults to fail, never asking", async () => {
  const prompt = underspecifiedPromptFor({
    flag: undefined,
    isTTY: false,
    ask: () => {
      throw new Error("must not ask without a terminal");
    },
  });
  assert.equal(await prompt(["640"]), "fail");
});

test("underspecifiedPromptFor: an unknown flag value is rejected", () => {
  assert.throws(
    () =>
      underspecifiedPromptFor({
        flag: "maybe",
        isTTY: true,
        ask: () => "drop",
      }),
    /on-underspecified/i,
  );
});

test("describePlan reports exactly what an under-specified drop pruned", async () => {
  const plan = await planCampaign(["611", "640", "701"], {
    blockedBy: openBlockedByFrom({ "701": ["640"] }),
    fileSet: fileSetFrom({
      "611": { files: ["a.ts"], confident: true },
      "640": { files: [], confident: false },
      "701": { files: ["c.ts"], confident: true },
    }),
    onUnderspecified: () => "drop",
  });
  const report = describePlan(plan);

  // The under-specified root and its carried-down dependent are both named, each
  // with its reason — never silently omitted.
  assert.match(report, /#640.*(under-specified|no confident file-set)/i);
  assert.match(report, /#701.*depend/i);
  // The confident survivor is still scheduled.
  assert.match(report, /wave 0.*#611/);
});

// id -> the labels on it, for the campaign-name suggestion.
const labelsFrom = (labels: Record<string, string[]>) => (id: string) =>
  labels[id] ?? [];

test("suggestCampaignName joins the distinct area labels the selected issues span", async () => {
  // Three issues span gateway, comms and dashboard; non-area labels (bug, P2) are
  // ignored, and the repeated 'gateway' is not doubled.
  const name = await suggestCampaignName(
    ["22", "25", "27"],
    labelsFrom({
      "22": ["gateway", "bug"],
      "25": ["comms", "gateway"],
      "27": ["dashboard", "P2"],
    }),
  );

  assert.equal(name, "gateway + comms + dashboard");
});

test("suggestCampaignName lists areas in a stable order regardless of input order", async () => {
  // Same three areas, encountered in a different order — the suggestion is stable.
  const name = await suggestCampaignName(
    ["27", "22", "25"],
    labelsFrom({
      "22": ["gateway"],
      "25": ["comms"],
      "27": ["dashboard"],
    }),
  );

  assert.equal(name, "gateway + comms + dashboard");
});

test("suggestCampaignName returns undefined when the set spans no area label", async () => {
  const name = await suggestCampaignName(
    ["22", "25"],
    labelsFrom({ "22": ["bug"], "25": [] }),
  );
  assert.equal(name, undefined);
});

test("waveArgs emits the bare quoted wave args, ready to paste after `campaign`", async () => {
  const plan = await layerWaves(
    ["611", "623", "640", "701"],
    openBlockedByFrom({ "701": ["640"], "640": ["611"] }),
  );

  assert.equal(waveArgs(plan), '"611 623" "640" "701"');
});

test("describePlan explains each ticket's wave and lists what was dropped", async () => {
  const plan = await layerWaves(
    ["611", "640", "701", "712"],
    openBlockedByFrom({ "640": ["611"], "701": ["555"], "712": ["701"] }),
  );
  const report = describePlan(plan);

  // Each scheduled ticket names its wave and why it is there.
  assert.match(report, /wave 0.*#611/);
  assert.match(report, /wave 1.*#640.*611/); // after its in-set blocker
  // Dropped tickets are reported with their reason, never silently omitted.
  assert.match(report, /#701.*555.*outside/i); // held by an out-of-set open blocker
  assert.match(report, /#712.*701/); // dropped as a dependent of 701
  // A dropped ticket is never presented as scheduled.
  assert.doesNotMatch(report, /wave \d+\s+#701/);
});

test("describePlan explains why a ticket was spilled to a later sub-wave", async () => {
  const layered = await layerWaves(["a", "b", "c"], openBlockedByFrom({}));
  const plan = partitionWaves(
    layered,
    basenamesFrom({ a: ["x"], b: ["y"], c: ["x"] }),
  );
  const report = describePlan(plan);

  // c spilled because it shares a file with a — the report must say so.
  assert.match(report, /wave 1\s+#c.*spill.*#a/i);
});

// A reduced campaign's outcomes as a plain map: id -> its current status.
const graftOutcomes = (o: Record<string, string>) => new Map(Object.entries(o));

test("applyGraft drops a no-dep issue into the earliest later wave, never the in-flight one", () => {
  const res = applyGraft(
    { waves: [["101"], ["201"]], outcomes: graftOutcomes({}), currentWave: 0 },
    { ids: ["301"], blockedBy: {}, basenames: {} },
  );
  // 301 has no blocker, so it fills wave 1 (the earliest wave after the in-flight
  // wave 0) rather than opening a new one.
  assert.deepEqual(res.remaining, [["101"], ["201", "301"]]);
  assert.deepEqual(res.grafted, ["301"]);
});

test("applyGraft layers a grafted issue after an unrun in-campaign blocker", () => {
  const res = applyGraft(
    { waves: [["101"], ["201"]], outcomes: graftOutcomes({}), currentWave: 0 },
    { ids: ["301"], blockedBy: { "301": ["201"] }, basenames: {} },
  );
  // 301 is blocked by 201 (wave 1), so it cannot share 201's wave — it opens wave 2.
  assert.deepEqual(res.remaining, [["101"], ["201"], ["301"]]);
});

test("applyGraft makes an issue blocked only by a merged issue eligible in the next wave", () => {
  const res = applyGraft(
    { waves: [["101"], ["201"]], outcomes: graftOutcomes({ "101": "completed" }), currentWave: 1 },
    { ids: ["301"], blockedBy: { "301": ["101"] }, basenames: {} },
  );
  // 101 is merged (not in the remaining waves' unrun set); its wave is behind the
  // firstFree boundary, so 301 is eligible in the next later wave (wave 2, since
  // the in-flight wave is 1).
  assert.deepEqual(res.remaining, [["101"], ["201"], ["301"]]);
});

test("applyGraft spills a basename-colliding graft into a new later wave", () => {
  const res = applyGraft(
    { waves: [["101"], ["201"]], outcomes: graftOutcomes({}), currentWave: 0 },
    { ids: ["301"], blockedBy: {}, basenames: { "301": ["a.ts"], "201": ["a.ts"] } },
  );
  // 301 and 201 both touch a.ts, so 301 cannot join wave 1 — it spills to wave 2.
  assert.deepEqual(res.remaining, [["101"], ["201"], ["301"]]);
});

test("applyGraft layers a grafted issue after another issue grafted in the same call", () => {
  const res = applyGraft(
    { waves: [["101"]], outcomes: graftOutcomes({}), currentWave: 0 },
    { ids: ["301", "302"], blockedBy: { "302": ["301"] }, basenames: {} },
  );
  // 302 is blocked by 301 (also grafted), so it must land in a strictly later wave.
  assert.deepEqual(res.remaining, [["101"], ["301"], ["302"]]);
  assert.deepEqual(res.grafted, ["301", "302"]);
});

test("applyGraft packs file-disjoint grafts into the same later wave", () => {
  const res = applyGraft(
    { waves: [["101"]], outcomes: graftOutcomes({}), currentWave: 0 },
    { ids: ["301", "302"], blockedBy: {}, basenames: { "301": ["a.ts"], "302": ["b.ts"] } },
  );
  // No deps and disjoint files, so both fill the same earliest later wave.
  assert.deepEqual(res.remaining, [["101"], ["301", "302"]]);
});

test("validateGraftTargets rejects unknown, closed and already-in-campaign ids, in input order (#166)", () => {
  const rejections = validateGraftTargets(["301", "302", "303", "101"], {
    inCampaign: new Set(["101"]),
    state: (id) => (id === "302" ? "closed" : id === "303" ? "unknown" : "open"),
  });
  assert.deepEqual(rejections, [
    { id: "302", reason: "closed" },
    { id: "303", reason: "unknown" },
    { id: "101", reason: "already-in-campaign" },
  ]);
});

test("validateGraftTargets returns nothing when every id is open and new (#166)", () => {
  assert.deepEqual(
    validateGraftTargets(["301", "302"], { inCampaign: new Set(["101"]), state: () => "open" }),
    [],
  );
});

// A fake config for `runCampaignPlan`: `fetchTask` yields per-id GitHub-style JSON,
// and `fileSet` reads the `Touches:` marker off the *ticketProse'd* text — so a
// resolver that got the wrong text (composition broken) would resolve differently.
const cfgFrom = (tasks: Record<string, string>, blockers: Record<string, string[]> = {}) => ({
  blockedBy: openBlockedByFrom(blockers),
  fetchTask: (id: string) => tasks[id] ?? "",
  fileSet: (ticket: string): FileSet => {
    const m = ticket.match(/Touches: (\S+)/);
    return { files: m ? [m[1]] : [], confident: Boolean(m) };
  },
});

test("runCampaignPlan composes fetchTask→ticketProse→fileSet and returns the confident plan", async () => {
  // 640 is blocked by 611; both cite a distinct file in their body marker, so the
  // fileSet resolver — fed the ticketProse'd body — reads both as confident.
  const report = await runCampaignPlan(
    cfgFrom(
      {
        "611": JSON.stringify({ body: "Touches: a.ts", labels: [{ name: "gateway" }] }),
        "640": JSON.stringify({ body: "Touches: b.ts", labels: [{ name: "comms" }] }),
      },
      { "640": ["611"] },
    ),
    ["611", "640"],
    {},
    { isTTY: false, ask: () => "fail" },
  );

  assert.equal(report.waveArgs, '"611" "640"');
  assert.match(report.report, /wave 0.*#611/);
  assert.match(report.report, /wave 1.*#640/);
  // The suggested name pairs labelsFromTask with suggestCampaignName over the labels.
  assert.equal(report.suggestedName, "gateway + comms");
});

test("runCampaignPlan: --on-underspecified=drop prunes the not-confident ticket and plans the rest", async () => {
  // 640 cites no file (no marker), so the resolver reads it not-confident; the flag
  // pre-decides drop, so it (and its dependent 701) is pruned and the rest planned.
  const report = await runCampaignPlan(
    cfgFrom(
      {
        "611": JSON.stringify({ body: "Touches: a.ts" }),
        "640": JSON.stringify({ body: "no files named here" }),
        "701": JSON.stringify({ body: "Touches: c.ts" }),
      },
      { "701": ["640"] },
    ),
    ["611", "640", "701"],
    { onUnderspecified: "drop" },
    {
      isTTY: true,
      ask: () => {
        throw new Error("a flag must pre-decide, never ask");
      },
    },
  );

  assert.equal(report.waveArgs, '"611"');
  assert.match(report.report, /#640.*(under-specified|no confident file-set)/i);
  assert.match(report.report, /#701.*depend/i);
});

test("runCampaignPlan: no flag on a non-terminal fails rather than plan around a not-confident ticket", async () => {
  await assert.rejects(
    () =>
      runCampaignPlan(
        cfgFrom({
          "611": JSON.stringify({ body: "Touches: a.ts" }),
          "640": JSON.stringify({ body: "no files named here" }),
        }),
        ["611", "640"],
        {},
        {
          isTTY: false,
          ask: () => {
            throw new Error("must not ask without a terminal");
          },
        },
      ),
    /#640.*confident/i,
  );
});

test("runCampaignPlan: no flag on a terminal asks the requestor, whose drop prunes the rest", async () => {
  const asked: string[][] = [];
  const report = await runCampaignPlan(
    cfgFrom({
      "611": JSON.stringify({ body: "Touches: a.ts" }),
      "640": JSON.stringify({ body: "no files named here" }),
    }),
    ["611", "640"],
    {},
    {
      isTTY: true,
      ask: (u) => {
        asked.push(u);
        return "drop";
      },
    },
  );

  assert.deepEqual(asked, [["640"]]);
  assert.equal(report.waveArgs, '"611"');
});

test("runCampaignPlan rejects an empty id set", async () => {
  await assert.rejects(
    () => runCampaignPlan(cfgFrom({}), [], {}, { isTTY: false, ask: () => "fail" }),
    /at least one ticket id/,
  );
});

test("runCampaignPlan requires a blockedBy resolver", async () => {
  await assert.rejects(
    () =>
      runCampaignPlan(
        { fetchTask: () => "" },
        ["611"],
        {},
        { isTTY: false, ask: () => "fail" },
      ),
    /blockedBy/,
  );
});

test("runCampaignPlan suggests no name when the set spans no area label", async () => {
  const report = await runCampaignPlan(
    cfgFrom({ "611": JSON.stringify({ body: "Touches: a.ts", labels: [{ name: "bug" }] }) }),
    ["611"],
    {},
    { isTTY: false, ask: () => "fail" },
  );
  assert.equal(report.suggestedName, undefined);
});

test("runFilesetCheck runs the same resolver campaign-plan uses, reporting confident + basenames per id", async () => {
  // The confident/not-confident verdict comes from the exact fetchTask→ticketProse→
  // fileSet path runCampaignPlan composes, so the check and the planner agree by
  // construction: 611 names a file on its marker, 640 names none.
  const results = await runFilesetCheck(
    cfgFrom({
      "611": JSON.stringify({ body: "Touches: a.ts" }),
      "640": JSON.stringify({ body: "no files named here" }),
    }),
    ["611", "640"],
  );

  assert.deepEqual(results, [
    { id: "611", confident: true, files: ["a.ts"] },
    { id: "640", confident: false, files: [] },
  ]);
});

test("runFilesetCheck rejects an empty id set", async () => {
  await assert.rejects(() => runFilesetCheck(cfgFrom({}), []), /at least one ticket id/);
});

test("describeFilesetCheck renders a confident line and a would-halt line per id", () => {
  const out = describeFilesetCheck([
    { id: "611", confident: true, files: ["a.ts"] },
    { id: "640", confident: false, files: [] },
  ]);
  assert.match(out, /#611.*confident.*a\.ts/);
  assert.match(out, /#640.*(not confident|halt)/i);
});

test("labelsFromTask reads GitHub label objects and is best-effort on non-JSON", () => {
  assert.deepEqual(
    labelsFromTask(JSON.stringify({ labels: [{ name: "gateway" }, { name: "P2" }] })),
    ["gateway", "P2"],
  );
  assert.deepEqual(labelsFromTask("not json at all"), []);
});
