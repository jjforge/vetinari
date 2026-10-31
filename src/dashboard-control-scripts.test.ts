// The dashboard's state-changing client controls — graft, redrive and stop — run end to end
// in a happy-dom window (ADR 0012's DOM-shim exception): the real project page from
// renderStatusPage, its real inline script, a stubbed fetch. Assertions read the fetch calls,
// the navigation and the visible DOM by role, label, text or data-* attribute.
import test from "node:test";
import assert from "node:assert/strict";
import type { CampaignStatus } from "./dashboard-status.ts";
import { renderStatusPage } from "./dashboard-render-project.ts";
import { dashboardReply, loadDashboardPage, type DashboardDomPage } from "./dashboard-dom.test-support.ts";

// A campaign in flight on its second wave — the Stop control enables while the lease is live.
const runningCampaign: CampaignStatus = {
  project: "beta",
  name: "checkout revamp",
  waves: [
    { index: 0, status: "completed", issues: [{ issueNumber: "101", status: "completed" }] },
    { index: 1, status: "running", issues: [{ issueNumber: "201", status: "running" }] },
  ],
  parked: [],
};
const runningPage = () => renderStatusPage(runningCampaign, { graft: true, leaseLive: true });

test("the DOM harness runs the page script against the stubbed fetch, answering the host-log backfill itself", async (t) => {
  const page = loadDashboardPage(t, runningPage(), () => undefined);
  await page.settle();
  // The host-log pane backfills on load; the harness answers it, so it is not unhandled.
  assert.deepEqual(
    page.calls.map((c) => c.url),
    ["/api/host-log"],
  );
});

test("the DOM harness fails close() on a fetch nothing handled, though the page swallows it", async (t) => {
  const page = loadDashboardPage(t, runningPage(), () => undefined);
  await page.settle();
  page.window.fetch("/nowhere").catch(() => {});
  await page.settle();
  await assert.rejects(page.close(), /unhandled fetch: GET \/nowhere/);
});

// The graft form lives on every unsettled campaign's summary line; its input is labelled.
const graftParts = (page: DashboardDomPage) => {
  const input = page.document.querySelector<HTMLInputElement>('[aria-label="Graft issue ids"]')!;
  const form = input.closest("form")!;
  return {
    input,
    form,
    button: form.querySelector<HTMLButtonElement>("button[type=submit]")!,
    message: form.querySelector<HTMLElement>("[data-graft-error]")!,
  };
};

test("graft: blurring typed ids previews them, and a rejected id names its verdict and disables the button", async (t) => {
  const page = loadDashboardPage(t, runningPage(), (call) =>
    call.url.startsWith("/graft?preview")
      ? dashboardReply(200, JSON.stringify({ ids: ["7", "8"], rejected: [{ id: "8", reason: "closed" }] }))
      : undefined,
  );
  const { input, button, message } = graftParts(page);
  assert.equal(button.disabled, true, "at rest the graft button is disabled");
  page.typeInto(input, "7 8");
  assert.equal(button.disabled, false, "typing ids enables it");
  input.focus();
  input.blur();
  await page.settle();
  assert.deepEqual(page.calls.at(-1), { url: "/graft?preview&ids=7%208&project=beta", method: "GET", body: "" });
  assert.equal(message.hidden, false);
  assert.equal(message.textContent, "#7 — would graft  ·  #8 — closed on GitHub");
  assert.equal(button.disabled, true);
});

test("graft: a clean preview shows nothing and leaves the button enabled", async (t) => {
  const page = loadDashboardPage(t, runningPage(), (call) =>
    call.url.startsWith("/graft?preview") ? dashboardReply(200, JSON.stringify({ ids: ["7"], rejected: [] })) : undefined,
  );
  const { input, button, message } = graftParts(page);
  page.typeInto(input, "7");
  input.focus();
  input.blur();
  await page.settle();
  assert.equal(page.calls.at(-1)?.url, "/graft?preview&ids=7&project=beta");
  assert.equal(message.hidden, true);
  assert.equal(message.textContent, "");
  assert.equal(button.disabled, false);
});

test("graft: clicking graft POSTs the ids, and a 200 clears the input back to a disabled rest", async (t) => {
  const page = loadDashboardPage(t, runningPage(), (call) => (call.url === "/graft" ? dashboardReply(200, "grafted") : undefined));
  const { input, button, message } = graftParts(page);
  page.typeInto(input, "7");
  button.click();
  await page.settle();
  assert.deepEqual(page.calls.at(-1), { url: "/graft", method: "POST", body: "ids=7&project=beta" });
  assert.equal(input.value, "");
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "graft");
  assert.equal(message.hidden, true);
});

test("graft: a 422 shows the route's per-id verdicts and keeps the typed ids", async (t) => {
  const rejection = `<!doctype html><ul data-graft-verdicts><li>#7 — would graft</li><li>#8 — not found</li></ul>`;
  const page = loadDashboardPage(t, runningPage(), (call) => (call.url === "/graft" ? dashboardReply(422, rejection) : undefined));
  const { input, button, message } = graftParts(page);
  page.typeInto(input, "7 8");
  button.click();
  await page.settle();
  assert.deepEqual(page.calls.at(-1), { url: "/graft", method: "POST", body: "ids=7+8&project=beta" });
  assert.equal(message.hidden, false);
  assert.equal(message.textContent, "#7 — would graft  ·  #8 — not found");
  assert.equal(input.value, "7 8");
  assert.equal(button.disabled, true, "a rejected batch holds the button until the ids change");
});

test("graft: any other failure shows the route's trimmed body and keeps the typed ids", async (t) => {
  const page = loadDashboardPage(t, runningPage(), (call) =>
    call.url === "/graft" ? dashboardReply(502, "  couldn't reach graft for beta\n") : undefined,
  );
  const { input, button, message } = graftParts(page);
  page.typeInto(input, "7");
  button.click();
  await page.settle();
  assert.equal(page.calls.at(-1)?.method, "POST");
  assert.equal(message.hidden, false);
  assert.equal(message.textContent, "couldn't reach graft for beta");
  assert.equal(input.value, "7");
  assert.equal(button.disabled, false);
});
