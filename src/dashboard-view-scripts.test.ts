// The dashboard's view scripts — the issue sheet, repo dropdown, archived runs, live tail and
// host log — run end to end in a happy-dom window (ADR 0012's DOM-shim exception): the real
// project page from renderStatusPage, its real inline script, a stubbed fetch and a stubbed
// EventSource the test pushes frames through. Assertions read the fetch calls, the URL and the
// visible DOM by id, role, label, text or data-* attribute.
import test from "node:test";
import assert from "node:assert/strict";
import type { CampaignStatus } from "./dashboard-status.ts";
import { renderStatusPage, type ArchivedRunView, type StatusPageOptions } from "./dashboard-render-project.ts";
import { dashboardReply, loadDashboardPage, type DashboardDomPage, type DashboardFetchCall } from "./dashboard-dom.test-support.ts";

test("the DOM harness's emit pushes a named frame to the page's stream listener, and a message to its onmessage", async (t) => {
  const html = `<!doctype html><body><script>
    const s = new EventSource("/api/events");
    s.addEventListener("tail", (e) => { document.body.dataset.tail = e.data; });
    s.onmessage = (e) => { document.body.dataset.message = e.data; };
  </script></body>`;
  const page = loadDashboardPage(t, html, () => undefined);
  page.emit("tail", { project: "beta" });
  page.emit("message", { project: null });
  assert.equal(page.document.body.dataset.tail, '{"project":"beta"}');
  assert.equal(page.document.body.dataset.message, '{"project":null}');
});

// A campaign in flight on its second wave: #201 is the running wave member whose row opens the sheet.
const runningCampaign: CampaignStatus = {
  project: "beta",
  name: "checkout revamp",
  waves: [
    { index: 0, status: "completed", issues: [{ issueNumber: "101", status: "completed" }] },
    { index: 1, status: "running", issues: [{ issueNumber: "201", status: "running" }] },
  ],
  parked: [],
};
const runningPage = (opts: StatusPageOptions = {}) => renderStatusPage(runningCampaign, opts);

// The wave member row, not the live tail's agent-menu row that also carries data-issue="201".
const openSheet = (page: DashboardDomPage) => page.document.querySelector<HTMLElement>('[data-issue="201"][data-project="beta"]')!.click();
const issueReply = (detail: object) => (call: DashboardFetchCall) =>
  call.url === "/api/issue?project=beta&issue=201" ? dashboardReply(200, JSON.stringify(detail)) : undefined;

test("issue sheet: clicking a wave member fetches its detail and shows the title, turns and turn summaries", async (t) => {
  const page = loadDashboardPage(
    t,
    runningPage(),
    issueReply({
      project: "beta",
      issueNumber: "201",
      status: "running",
      title: "Add a coupon field",
      turns: 2,
      elapsedMs: 5 * 60_000,
      turnLog: [
        { turn: 1, summary: "wired the coupon input" },
        { turn: 0, summary: "read the checkout form" },
      ],
    }),
  );
  const sheet = page.document.getElementById("issue-detail")!;
  assert.equal(sheet.hidden, true, "the sheet rests hidden");
  openSheet(page);
  await page.settle();
  assert.deepEqual(page.calls.at(-1), { url: "/api/issue?project=beta&issue=201", method: "GET", body: "" });
  assert.equal(sheet.hidden, false);
  assert.equal(sheet.querySelector("h2")!.textContent, "Add a coupon field");
  assert.equal(page.document.getElementById("issue-detail-turns")!.textContent, "2 turns · 5m");
  const turnLog = page.document.getElementById("issue-detail-turnlog")!.textContent!;
  assert.match(turnLog, /wired the coupon input/);
  assert.match(turnLog, /read the checkout form/);
});

test("issue sheet: a failed detail load says it couldn't load the issue", async (t) => {
  const page = loadDashboardPage(t, runningPage(), (call) => (call.url.startsWith("/api/issue?") ? dashboardReply(500) : undefined));
  openSheet(page);
  await page.settle();
  assert.equal(page.document.getElementById("issue-detail")!.hidden, false);
  assert.equal(page.document.querySelector("#issue-detail h2")!.textContent, "Couldn't load issue #201");
});

// #201 parked on a question with two offered answers — the sheet's reply box is its move.
const questionDetail = {
  project: "beta",
  issueNumber: "201",
  status: "parked",
  reason: "question",
  title: "Add a coupon field",
  turns: 1,
  elapsedMs: 60_000,
  turnLog: [],
  parked: { question: "Which currency should the coupon use?", options: ["A: Euros", "B: Dollars"] },
};

test("issue sheet: a parked question shows, an offered option fills the reply, and Reply POSTs it to /answer", async (t) => {
  const page = loadDashboardPage(t, runningPage(), (call) =>
    call.url === "/answer" ? dashboardReply(200, "", "http://dashboard.test/beta?answered") : issueReply(questionDetail)(call),
  );
  openSheet(page);
  await page.settle();
  assert.equal(page.document.getElementById("reply-question")!.textContent, "Which currency should the coupon use?");
  assert.equal(page.document.getElementById("reply-question")!.hidden, false);
  const options = Array.from(page.document.getElementById("reply-options")!.querySelectorAll("button"));
  assert.equal(options.length, 2);
  const replyText = page.document.querySelector<HTMLTextAreaElement>("#reply-text")!;
  options.find((b) => b.textContent!.endsWith("Dollars"))!.click();
  assert.equal(replyText.value, "B: Dollars");
  const send = page.document.querySelector<HTMLButtonElement>("#reply-send")!;
  assert.equal(send.hidden, false);
  send.click();
  await page.settle();
  assert.deepEqual(page.calls.at(-1), { url: "/answer", method: "POST", body: "taskId=201&project=beta&text=B%3A+Dollars" });
  assert.equal(page.window.location.href, "http://dashboard.test/beta?answered");
});

test("issue sheet: a refused reply shows the route's words under the box and keeps the typed text", async (t) => {
  const page = loadDashboardPage(t, runningPage(), (call) =>
    call.url === "/answer" ? dashboardReply(409, "#201 is no longer parked\n") : issueReply(questionDetail)(call),
  );
  openSheet(page);
  await page.settle();
  const replyText = page.document.querySelector<HTMLTextAreaElement>("#reply-text")!;
  replyText.value = "use euros";
  page.document.querySelector<HTMLButtonElement>("#reply-send")!.click();
  await page.settle();
  assert.equal(page.calls.at(-1)?.body, "taskId=201&project=beta&text=use+euros");
  const status = page.document.getElementById("reply-status")!;
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, "#201 is no longer parked");
  assert.equal(replyText.value, "use euros");
  assert.equal(page.window.location.href, "http://dashboard.test/beta");
});

// The repo dropdown on a two-repo page, scoped to beta.
const dropdownPage = (t: test.TestContext) => {
  const page = loadDashboardPage(t, runningPage({ projects: ["alpha", "beta"], selected: "beta" }), () => undefined);
  const trigger = page.document.querySelector<HTMLButtonElement>("#repo-trigger")!;
  const menu = page.document.querySelector<HTMLElement>('#repo-menu[role="listbox"]')!;
  const option = (project: string) => menu.querySelector<HTMLElement>(`[role="option"][data-project="${project}"]`)!;
  return { page, trigger, menu, option };
};

test("repo dropdown: the trigger opens the listbox, and choosing another repo navigates to its page", async (t) => {
  const { page, trigger, menu, option } = dropdownPage(t);
  assert.equal(menu.hidden, true, "the menu rests closed");
  trigger.click();
  assert.equal(menu.hidden, false);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  option("alpha").click();
  await page.settle();
  assert.equal(page.window.location.href, "http://dashboard.test/?project=alpha");
});

test("repo dropdown: Escape in the open menu closes it and returns focus to the trigger", (t) => {
  const { page, trigger, menu } = dropdownPage(t);
  trigger.click();
  assert.notEqual(page.document.activeElement, trigger, "opening moves focus into the menu");
  page.document.activeElement!.dispatchEvent(
    new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event,
  );
  assert.equal(menu.hidden, true);
  assert.equal(page.document.activeElement, trigger);
});

test("repo dropdown: re-choosing the current repo closes the menu without navigating", async (t) => {
  const { page, trigger, menu, option } = dropdownPage(t);
  trigger.click();
  option("beta").click();
  await page.settle();
  assert.equal(menu.hidden, true);
  assert.equal(page.window.location.href, "http://dashboard.test/beta");
});

// Two archived runs under the live one, each a finished one-wave campaign.
const archivedRun = (run: string, name: string, issue: string): ArchivedRunView => ({
  run,
  name,
  state: "complete",
  issues: 1,
  status: {
    project: "beta",
    name,
    waves: [{ index: 0, status: "completed", issues: [{ issueNumber: issue, status: "completed" }] }],
    parked: [],
  },
});
const archivePage = (t: test.TestContext) => {
  const archivedRuns = [archivedRun("20261020-0900", "search tuning", "301"), archivedRun("20261012-1400", "login rework", "401")];
  const page = loadDashboardPage(t, runningPage({ archivedRuns }), () => undefined);
  const row = (run: string) => {
    const li = page.document.querySelector<HTMLElement>(`li[data-run="${run}"]`)!;
    const head = li.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    return { li, head, body: page.document.getElementById(head.getAttribute("aria-controls")!)! };
  };
  return { page, first: row("20261020-0900"), second: row("20261012-1400") };
};

test("archived runs: opening a row shows its body and names its run in the URL", (t) => {
  const { page, first } = archivePage(t);
  assert.equal(first.body.hidden, true, "rows rest collapsed");
  first.head.click();
  assert.equal(first.body.hidden, false);
  assert.equal(first.head.getAttribute("aria-expanded"), "true");
  assert.equal(page.window.location.href, "http://dashboard.test/beta?project=beta&run=20261020-0900");
});

test("archived runs: opening a second row closes the first and names the second run", (t) => {
  const { page, first, second } = archivePage(t);
  first.head.click();
  second.head.click();
  assert.equal(first.body.hidden, true);
  assert.equal(second.body.hidden, false);
  assert.equal(page.window.location.href, "http://dashboard.test/beta?project=beta&run=20261012-1400");
});

test("archived runs: clicking the open row again closes it and drops run= from the URL", (t) => {
  const { page, first } = archivePage(t);
  first.head.click();
  first.head.click();
  assert.equal(first.body.hidden, true);
  assert.doesNotMatch(page.window.location.href, /run=/);
});

test("archived runs: typing part of one run's name hides the other row", (t) => {
  const { page, first, second } = archivePage(t);
  page.typeInto(page.document.querySelector<HTMLInputElement>("[data-archive-filter]")!, "LOGIN");
  assert.equal(first.li.hidden, true);
  assert.equal(second.li.hidden, false);
});

// The live tail, fed by `tail` frames: #201 is the one running agent on the page, so the pane
// rests open and following.
const tailFrame = (project: string, lines: { n: number; raw: string }[], agents = [{ issue: "201", status: "running" }]) => ({
  project,
  tail: { agents, lines: lines.map((line) => ({ issue: "201", ...line })) },
});
const tailParts = (page: DashboardDomPage) => {
  const q = <E extends HTMLElement>(attr: string) => page.document.querySelector<E>(`[data-live-tail] [${attr}]`)!;
  return {
    body: q("data-tail-body"),
    footer: q("data-tail-footer"),
    summary: q("data-tail-summary"),
    play: q<HTMLButtonElement>("data-tail-play"),
    backlog: q<HTMLButtonElement>("data-tail-backlog"),
  };
};
const twoLines = [
  { n: 0, raw: "reading the checkout form" },
  { n: 1, raw: "adding the coupon input" },
];

test("live tail: a frame for this project renders its lines, following", (t) => {
  const page = loadDashboardPage(t, runningPage(), () => undefined);
  const { body, footer } = tailParts(page);
  page.emit("tail", tailFrame("beta", twoLines));
  assert.equal(body.hidden, false);
  assert.equal(body.children.length, 2);
  assert.match(body.textContent!, /reading the checkout form/);
  assert.match(body.textContent!, /adding the coupon input/);
  assert.equal(footer.textContent, "2 of 2 lines · following");
});

test("live tail: a frame for another project changes nothing", (t) => {
  const page = loadDashboardPage(t, runningPage(), () => undefined);
  const { body, footer } = tailParts(page);
  page.emit("tail", tailFrame("beta", twoLines));
  page.emit("tail", tailFrame("alpha", [{ n: 2, raw: "alpha's own line" }]));
  assert.equal(body.children.length, 2);
  assert.doesNotMatch(body.textContent!, /alpha's own line/);
  assert.equal(footer.textContent, "2 of 2 lines · following");
});

test("live tail: paused, a new line waits in the backlog until it is revealed", (t) => {
  const page = loadDashboardPage(t, runningPage(), () => undefined);
  const { body, footer, play, backlog } = tailParts(page);
  page.emit("tail", tailFrame("beta", twoLines));
  play.click();
  assert.equal(play.getAttribute("aria-label"), "Play", "paused, the control offers Play");
  page.emit("tail", tailFrame("beta", [...twoLines, { n: 2, raw: "running the tests" }]));
  assert.equal(backlog.hidden, false);
  assert.equal(backlog.textContent, "↑ 1 new line");
  assert.doesNotMatch(body.textContent!, /running the tests/);
  backlog.click();
  assert.equal(backlog.hidden, true);
  assert.equal(body.children.length, 3);
  assert.match(body.textContent!, /running the tests/);
  assert.equal(footer.textContent, "3 of 3 lines · following", "revealing the backlog resumes following");
});

test("live tail: a frame with no agents folds the pane to read no agents running", (t) => {
  const page = loadDashboardPage(t, runningPage(), () => undefined);
  const { body, summary } = tailParts(page);
  assert.equal(summary.textContent, "1 agent");
  page.emit("tail", tailFrame("beta", [], []));
  assert.equal(summary.textContent, "no agents running");
  assert.equal(body.hidden, true);
});

// The host log behind the top bar's gear: its window comes from /api/host-log, its appends
// from `host` frames.
const hostLine = (event: string, minute: number) =>
  JSON.stringify({ ts: `2026-11-01T03:${String(minute).padStart(2, "0")}:00.000Z`, event });
const hostLogReply = (lines: string[]) => dashboardReply(200, JSON.stringify({ lines }));
const hostLogParts = (page: DashboardDomPage) => {
  const q = <E extends HTMLElement>(attr: string) => page.document.querySelector<E>(`[data-host-log] [${attr}]`)!;
  return {
    gear: q<HTMLButtonElement>("data-host-log-gear"),
    badge: q("data-host-log-badge"),
    panel: q("data-host-log-panel"),
    lines: q("data-host-log-lines"),
  };
};

test("host log: the gear opens the panel on the backfilled window", async (t) => {
  const window = [hostLine("gateway.listening", 2), hostLine("registry.loaded", 1)];
  const page = loadDashboardPage(t, runningPage(), (call) => (call.url === "/api/host-log" ? hostLogReply(window) : undefined));
  await page.settle();
  const { gear, panel, lines } = hostLogParts(page);
  assert.equal(panel.hidden, true, "the panel rests closed");
  gear.click();
  assert.equal(panel.hidden, false);
  assert.equal(gear.getAttribute("aria-expanded"), "true");
  assert.equal(lines.children.length, 2);
  assert.match(lines.textContent!, /gateway\.listening/);
  assert.match(lines.textContent!, /registry\.loaded/);
});

test("host log: with an empty window the panel says there is no host log yet", async (t) => {
  const page = loadDashboardPage(t, runningPage(), () => undefined);
  await page.settle();
  const { gear, lines } = hostLogParts(page);
  gear.click();
  assert.equal(lines.textContent, "No host log yet.");
});

test("host log: a notable host frame badges the closed gear, and opening the panel clears it", async (t) => {
  const page = loadDashboardPage(t, runningPage(), () => undefined);
  await page.settle();
  const { gear, badge, lines } = hostLogParts(page);
  assert.equal(badge.hidden, true);
  page.emit("host", { lines: [hostLine("telegram.send.fail", 5)] });
  assert.equal(badge.hidden, false);
  gear.click();
  assert.equal(badge.hidden, true);
  assert.equal(lines.children.length, 1);
});

test("host log: the connect ring re-reads the window and replaces the panel's lines", async (t) => {
  const pageHtml = runningPage();
  const replies = [[hostLine("gateway.listening", 1)], [hostLine("gateway.reconnected", 9)]];
  const page = loadDashboardPage(t, pageHtml, (call) => {
    if (call.url === "/api/host-log") return hostLogReply(replies.shift() ?? []);
    if (call.url === "http://dashboard.test/beta") return dashboardReply(200, pageHtml);
    return undefined;
  });
  await page.settle();
  const { gear, lines } = hostLogParts(page);
  gear.click();
  assert.match(lines.textContent!, /gateway\.listening/);
  page.emit("message", { project: null });
  await page.settle();
  assert.deepEqual(page.calls.map((c) => c.url).sort(), ["/api/host-log", "/api/host-log", "http://dashboard.test/beta"]);
  assert.equal(lines.children.length, 1);
  assert.doesNotMatch(lines.textContent!, /gateway\.listening/);
  assert.match(lines.textContent!, /gateway\.reconnected/);
});
