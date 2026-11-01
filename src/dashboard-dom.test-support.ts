// A happy-dom harness that runs a rendered dashboard page's inline client script in node (ADR
// 0012's DOM-shim exception): the glue — fetch calls, dialogs, navigation — that no reducer
// test can reach. The page loads against a stubbed fetch and a no-op EventSource, so it never
// touches the network. A test pushes a live frame into the page through `emit`.
import type { TestContext } from "node:test";
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
  /** Push an SSE frame of `type` carrying `JSON.stringify(data)` into the page's most recently
   * opened EventSource, as the server would: a named event for its listeners, and — for
   * `"message"`, the unnamed frame — its `onmessage` too. */
  emit: (type: string, data: unknown) => void;
  /** Close the window — clearing its timers — and reject if any fetch went unhandled. Runs
   * itself after the test (so a failed assertion still clears the page's interval) unless the
   * test already called it. */
  close: () => Promise<void>;
}

/** A stubbed Response, with `url` set as a followed redirect would leave it (the page navigates to it). */
export const dashboardReply = (status: number, body = "", url = "") => {
  const res = new Response(body, { status });
  Object.defineProperty(res, "url", { value: url });
  return res;
};

// happy-dom has no EventSource, and the page's connect() opens one before anything else wires,
// so without this the whole script aborts. It never fires on its own: a frame reaches the page
// only when the test pushes one through the page's `emit`.
class SilentEventSource extends EventTarget {
  onopen = null;
  onerror = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readyState = 0;
  close() {}
}

/**
 * Load `html` (a renderer's page) into a happy-dom window at `url`, with `stub` as its fetch,
 * closed after test `t`.
 * `/api/host-log` — which the host-log pane backfills on every load — is answered with an empty
 * window unless `stub` answers it. A fetch `stub` leaves unhandled resolves to a 599 the page
 * swallows like any failure, and is recorded so `close()` fails the test.
 */
export function loadDashboardPage(
  t: TestContext,
  html: string,
  stub: DashboardFetchStub,
  url = "http://dashboard.test/beta",
): DashboardDomPage {
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
  // Every stream the page opens, oldest first, so `emit` can reach the live one.
  const streams: SilentEventSource[] = [];
  class RecordedEventSource extends SilentEventSource {
    constructor() {
      super();
      streams.push(this);
    }
  }
  // Both stubs go on before the write, so the inline script sees them as it runs.
  Object.assign(window, { fetch: fetchStub, EventSource: RecordedEventSource });
  window.document.write(html);
  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= window.happyDOM.close().then(() => {
      if (unhandled.length) throw new Error(unhandled.map((c) => `unhandled fetch: ${c.method} ${c.url}`).join("\n"));
    }));
  t.after(() => (closing ? undefined : close()));
  return {
    window,
    document: window.document as unknown as Document,
    typeInto: (input, text) => {
      input.value = text;
      input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    },
    calls,
    settle: (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms)),
    emit: (type, data) => {
      const stream = streams.at(-1);
      if (!stream) throw new Error("emit: the page opened no EventSource");
      const event = new MessageEvent(type, { data: JSON.stringify(data) });
      stream.dispatchEvent(event);
      if (type === "message") stream.onmessage?.(event);
    },
    close,
  };
}
