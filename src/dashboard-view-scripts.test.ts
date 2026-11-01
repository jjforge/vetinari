// The dashboard's view scripts — the issue sheet, repo dropdown, archived runs, live tail and
// host log — run end to end in a happy-dom window (ADR 0012's DOM-shim exception): the real
// project page from renderStatusPage, its real inline script, a stubbed fetch and a stubbed
// EventSource the test pushes frames through. Assertions read the fetch calls, the URL and the
// visible DOM by id, role, label, text or data-* attribute.
import test from "node:test";
import assert from "node:assert/strict";
import type { CampaignStatus } from "./dashboard-status.ts";
import { renderStatusPage, type StatusPageOptions } from "./dashboard-render-project.ts";
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
  assert.match(sheet.querySelector("h2")!.textContent!, /^Add a coupon field$/);
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
