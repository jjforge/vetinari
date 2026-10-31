// A happy-dom harness that runs a rendered dashboard page's inline client script in node (ADR
// 0012's DOM-shim exception): the glue — fetch calls, dialogs, navigation — that no reducer
// test can reach. The page loads against a stubbed fetch and a no-op EventSource, so it never
// touches the network.
import { Window } from "happy-dom";

/** One fetch the page made: its URL as written, method, and body as sent (`String(init.body)`). */
export interface DashboardFetchCall {
  url: string;
  method: string;
  body: string;
}

/** Answers a page fetch with a Response, or `undefined` to leave it unhandled. */
export type DashboardFetchStub = (call: DashboardFetchCall) => Response | undefined;

export interface DashboardDomPage {
  window: Window;
  /** The page's document, typed as the DOM lib's so tests use the standard element types. */
  document: Document;
  /** Every fetch the page made, handled or not, in order. */
  calls: DashboardFetchCall[];
  /** Type `text` into `input` as an operator would: set its value and fire `input`. */
  typeInto: (input: HTMLInputElement, text: string) => void;
  /** Let the page's pending promises and microtasks run (a short real timer). */
  settle: (ms?: number) => Promise<void>;
  /** Close the window — clearing its timers — and reject if any fetch went unhandled. */
  close: () => Promise<void>;
}

/** A stubbed Response, with `url` set as a followed redirect would leave it (the page navigates to it). */
export const dashboardReply = (status: number, body = "", url = "") => {
  const res = new Response(status === 204 ? null : body, { status });
  Object.defineProperty(res, "url", { value: url });
  return res;
};

// happy-dom has no EventSource, and the page's connect() opens one before anything else wires,
// so without this the whole script aborts. It never fires: no live frame reaches the page.
class SilentEventSource extends EventTarget {
  onopen = null;
  onerror = null;
  onmessage = null;
  readyState = 0;
  close() {}
}

/**
 * Load `html` (a renderer's page) into a happy-dom window at `url`, with `stub` as its fetch.
 * `/api/host-log` — which the host-log pane backfills on every load — is answered with an empty
 * window unless `stub` answers it. A fetch `stub` leaves unhandled resolves to a 599 the page
 * swallows like any failure, and is recorded so `close()` fails the test.
 */
export function loadDashboardPage(html: string, stub: DashboardFetchStub, url = "http://dashboard.test/beta"): DashboardDomPage {
  const window = new Window({
    url,
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
      navigation: { disableMainFrameNavigation: true },
    },
  });
  const calls: DashboardFetchCall[] = [];
  const unhandled: DashboardFetchCall[] = [];
  const fetchStub = async (input: string | URL, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? "GET", body: init?.body == null ? "" : String(init.body) };
    calls.push(call);
    const res = stub(call) ?? (call.url === "/api/host-log" ? dashboardReply(200, JSON.stringify({ lines: [] })) : undefined);
    if (res) return res;
    unhandled.push(call);
    return dashboardReply(599, "unhandled by the test's fetch stub");
  };
  // Both stubs go on before the write, so the inline script sees them as it runs.
  Object.assign(window, { fetch: fetchStub, EventSource: SilentEventSource });
  window.document.write(html);
  return {
    window,
    document: window.document as unknown as Document,
    typeInto: (input, text) => {
      input.value = text;
      input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    },
    calls,
    settle: (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms)),
    close: async () => {
      await window.happyDOM.close();
      if (unhandled.length) throw new Error(unhandled.map((c) => `unhandled fetch: ${c.method} ${c.url}`).join("\n"));
    },
  };
}
