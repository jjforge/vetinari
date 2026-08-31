/**
 * The dashboard's state → visual-intent reducers — the pure mapping from a piece of
 * state to the classes and text a surface shows. The recurring dashboard regressions
 * (#96, #100, #101, #104) all lived in this mapping while it was scattered inline
 * across `dashboard-render.ts` and only reachable through `string.contains` assertions
 * on rendered HTML. Modelling it as named pure functions unit-tested in node (the
 * node-only gate, no jsdom/CDP) lets each rule be asserted directly (ADR 0012).
 *
 * Two kinds live here. **Server-side** class decisions (`dotClass`, `tallyDotClass`)
 * are called at render. The **client-side** presentation-freeze
 * (`freezeIntent`) also runs in the browser — it ticks each second — so it is
 * single-sourced to the browser via `${freezeIntent.toString()}`
 * inlined into the page script: the node test imports the same function the payload
 * ships. Every function shipped this way (`dotClass`, `tallyDotClass`, `freezeIntent`)
 * is a self-contained `function` declaration — no imports, no closures over module
 * scope, browser-safe JS only — so `.toString()` yields a runnable definition.
 *
 * `reasonWord` is shipped both ways — the status line and the parked card read it server-side,
 * and the issue sheet single-sources it into the browser via `.toString()` — so it is a
 * self-contained `function` over a plain string (a `ParkReason` value, or a raw park-record
 * reason), browser-safe with no imports, exactly like `issueMoves` and the freeze reducers.
 */

/**
 * The state-class fragment a status dot carries — the status verbatim today (a
 * `running` dot is `.dot.running`). The one place a status→dot-class alias would live,
 * and the base `tallyDotClass` extends. Used server-side by the wave-member row and
 * shipped to the browser (via `.toString()`) as `tallyDotClass`'s helper.
 */
export function dotClass(status: string): string {
  return status;
}

/**
 * A park reason's display word (design §2.3): the single mapping from a `ParkReason` value to
 * the word every surface prints beside `parked`. The one rule — never a reason-string regex —
 * so a reason is spelled one way in the status line, the parked card and the issue sheet alike.
 * `red-base` reads as two words; the rest are their value verbatim (an unrecognised record
 * reason passes straight through). Takes a plain string so the shipped `.toString()` carries
 * no type import and a raw park-record reason feeds it directly.
 */
export function reasonWord(reason: string): string {
  return reason === "red-base" ? "red base" : reason;
}

/**
 * The moves the issue sheet offers for a given lifecycle state and park reason (design §11,
 * user-guide park reasons) — the single pure rule behind "exactly the moves the reason
 * allows" (#307). Each move POSTs to a route that shells the CLI verb: `reply` → `/answer`,
 * `prune` → `/prune`. Redrive picks up the *whole campaign* (design §7), so it is a
 * campaign control on the project page ({@link redriveAllowed}), never an issue move — and
 * neither is graft; both are absent here (#325).
 *
 * - A question or a stall wants a human answer, so both carry `reply` alongside prune.
 * - A conflict, red base or crash is fixed forward on the base and redriven at the campaign,
 *   never answered per issue — prune only (the fix-forward instruction rides the sheet notice).
 * - A `failed` issue offers prune; a `running`/`unstarted` one offers prune; a `completed`
 *   one is banked and offers nothing. `failed` is the wire word `/api/issue` ships (the
 *   `IssueStatus` enum, now the design's own word), so the rule keys on it directly.
 * - An archived (read-only) issue offers nothing — no move mutates a finished run's log.
 *
 * A legacy park with no reason reads as an answerable question (mirroring `renderMoves`).
 * Self-contained and browser-safe: single-sourced into the sheet script via `.toString()`,
 * so the node test asserts the very function the browser runs. The `reason` param is a plain
 * string here (the `ParkReason` values) so the shipped `.toString()` carries no type import.
 */
export function issueMoves({
  status,
  reason,
  archived,
}: {
  status: string;
  reason?: string;
  archived?: boolean;
}): { reply: boolean; prune: boolean } {
  if (archived) return { reply: false, prune: false };
  if (status === "parked") {
    const answerable = !reason || reason === "question" || reason === "stalled";
    return { reply: answerable, prune: true };
  }
  if (status === "failed") return { reply: false, prune: true };
  if (status === "running" || status === "unstarted") return { reply: false, prune: true };
  return { reply: false, prune: false };
}

/**
 * Whether a whole-campaign redrive is safe to offer (design §7, §11) — the single pure
 * rule the greyed control, its confirm dialog, and the `/redrive` route all gate on, so the
 * button, the page and the server can never disagree on when a redrive is allowed (#325).
 *
 * Redrive is safe only when both hold: the campaign's fold is **stopped** — `parked`
 * (`campaign-parked`, or a crash whose in-flight members folded to `parked{crash}`) or
 * `failed` (`campaign-failed`) — **and** no campaign process for the project still holds the
 * host lease (`leaseLive` is false, from the same probe crash detection reads). A live lease,
 * or a still-`running` fold, means there is a process to collide with — the observed bug was a
 * second campaign spawned over a draining wave — so it refuses. A `completed` campaign is
 * settled and an `unstarted`/empty one never ran, so neither is a redrive target. When it
 * refuses it carries a one-line reason the control and the route's 409 both surface verbatim.
 *
 * `campaignState` is a plain string (the `CampaignState` values) so this stays a
 * dependency-free reducer beside the others in this file.
 */
export function redriveAllowed(campaignState: string, leaseLive: boolean): { allowed: boolean; reason: string } {
  if (leaseLive || campaignState === "running") return { allowed: false, reason: "a campaign process is still running" };
  if (campaignState === "parked" || campaignState === "failed") return { allowed: true, reason: "" };
  if (campaignState === "completed") return { allowed: false, reason: "the campaign is settled — nothing to redrive" };
  return { allowed: false, reason: "no campaign to redrive" };
}

/**
 * What the summary-line graft control carries across a live-region soft-refresh (#329) — the
 * single pure rule the swap gates on. A live event replaces `#live-region` wholesale, and the
 * graft form lives inside it: the server renders the ids input with no `value`, so the fresh
 * node always arrives empty and re-wired at rest. This decides, from the outgoing node's
 * captured state, exactly what the incoming node should show, so nothing the operator typed —
 * ids, an inline validation error, or an in-flight graft — is silently lost.
 *
 * `captured` is read off the outgoing form immediately before the swap: `ids` the typed value
 * (verbatim, so spacing survives), `error` the inline error text currently showing (`""` when
 * none), `busy` whether a graft POST is in flight (`aria-busy`). The return is what to apply:
 * `ids`/`error` to restore, `invalid` the validation flag (an error means the submit stays
 * disabled for the same reason), `busy` whether to re-enter the in-flight look.
 *
 * An empty, untouched field with no graft in flight carries nothing — the fresh node is left
 * exactly as the server rendered it. Self-contained and browser-safe: single-sourced into the
 * page script via `.toString()`, so the node test drives the very function the swap runs.
 */
export function graftCarry(captured: { ids: string; error: string; busy: boolean }): {
  ids: string;
  error: string;
  invalid: boolean;
  busy: boolean;
} {
  const busy = Boolean(captured.busy);
  const ids = captured.ids || "";
  const hasIds = ids.trim().length > 0;
  // Nothing typed and no graft in flight → carry nothing; the fresh node stays at rest.
  if (!hasIds && !busy) return { ids: "", error: "", invalid: false, busy: false };
  // An in-flight graft has cleared its error, so an error only rides alongside settled ids.
  const error = hasIds && !busy ? captured.error || "" : "";
  return { ids: hasIds ? ids : "", error, invalid: error.length > 0, busy };
}

/**
 * Whether a page resurfacing from the background should reconnect its SSE stream (#351).
 * On iOS 18+ a tab hidden more than ~20s has its connection silently closed by the OS with
 * no `error` event and `readyState` still `1` (OPEN) — the stream is dead but nothing in the
 * page can learn that by asking. So a resume decides purely from how long the page was
 * hidden: `hiddenAt` is the wall-clock stamp taken when it went hidden (null if it was never
 * hidden this session), `now` the resume moment. Both a `visibilitychange`→visible and a
 * `pageshow` fire on one iOS resume and read the same stale `hiddenAt`, so both reach the same
 * verdict here — a `connecting` latch, not this reducer, is what collapses them to one stream.
 *
 * Self-contained and browser-safe: single-sourced into both page scripts via
 * `${resumeIntent.toString()}`, so the node test asserts the very function the browser runs.
 */
export function resumeIntent({
  hiddenAt,
  now,
}: {
  hiddenAt: number | null;
  now: number;
}): { reconnect: boolean } {
  // Reconnect only past this hidden-duration. A reconnect is not free — the new connection
  // trips #331's connect ring, costing a full page re-fetch and a tail re-seed (worst over
  // the tailnet, ADR 0008) — so a brief desktop tab-flick must not pay it. Sized below the
  // ~20s window in which iOS closes a backgrounded connection, so the error is always in the
  // safe direction: an occasional needless reconnect, never a missed dead stream.
  const RECONNECT_AFTER_MS = 10000;
  if (hiddenAt == null) return { reconnect: false };
  return { reconnect: now - hiddenAt > RECONNECT_AFTER_MS };
}

/**
 * The tally chip's dot-class fragment, with the idle rule (§5, #100): a running dot
 * pulses to signal work in flight, so a "0 running" tally — which has none — keeps the
 * blue but gets `idle` to still it. Only `running` at zero is idle; `parked`/`queued`
 * never pulse, so a zero of those is unremarkable. Runs client-side in the landing's
 * `load()`, shipped via `.toString()`.
 */
export function tallyDotClass({ kind, count }: { kind: string; count: number }): string {
  return dotClass(kind) + (kind === "running" && count === 0 ? " idle" : "");
}

/**
 * Whether a live-pane frame counts as *visible* freshness activity — the signal that
 * resets the live-bar's "updated Ns ago" clock (#198). A pane (the live-tail, the
 * host-log) is a co-equal live surface, so lines it visibly appends should read as an
 * update just like a wave/feed refresh. Only a *visible* append counts: no new lines
 * (`appended === 0`), a collapsed pane (`!open`), or a pane whose own follow is paused so
 * frames merely buffer (`!following`) all leave the clock untouched — presentation is
 * frozen there, so freshness is too.
 *
 * Self-contained and browser-safe: single-sourced into the pane scripts via
 * `${paneActivity.toString()}`, so the node test asserts the very function they run.
 */
export function paneActivity({
  appended,
  open,
  following,
}: {
  appended: number;
  open: boolean;
  following: boolean;
}): boolean {
  return appended > 0 && open && following;
}

/**
 * The live-bar's freshness readout (ADR 0008): maps the last-refresh time to the
 * "updated Ns ago" text its thin DOM glue writes onto the readout. `lastUpdate` is null
 * before the first refresh (the landing opens "waiting for updates"; the campaign page
 * seeds it to now), and otherwise the readout ages second by second from `now`.
 *
 * Self-contained and browser-safe: it is single-sourced into both page scripts via
 * `${freezeIntent.toString()}`, so the node test asserts the very function the browser
 * runs. The glue keeps the DOM write (`updatedEl.textContent = …`) — this only decides.
 */
export function freezeIntent({
  lastUpdate,
  now,
}: {
  lastUpdate: number | null;
  now: number;
}): { updatedText: string } {
  return {
    updatedText:
      lastUpdate == null
        ? "waiting for updates"
        : "updated " + Math.round((now - lastUpdate) / 1000) + "s ago",
  };
}
