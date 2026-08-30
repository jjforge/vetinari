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
 * `prune` → `/prune`, `redrive` → `/redrive`. Graft is a campaign-level move, not a per-issue
 * one, so it is not here.
 *
 * - A question or a stall wants a human answer, so both carry `reply` alongside prune/redrive.
 * - A conflict, red base or crash is fixed forward on the base and redriven, never answered
 *   per issue — prune and redrive only (the fix-forward instruction rides the sheet notice).
 * - A `failure` issue offers prune and redrive; a `running`/`unstarted` one offers only prune;
 *   a `completed` one is banked and offers nothing. `failure` is the wire word `/api/issue`
 *   ships (the `IssueStatus` enum), so the rule keys on it, never the design-prose `failed`.
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
}): { reply: boolean; prune: boolean; redrive: boolean } {
  if (archived) return { reply: false, prune: false, redrive: false };
  if (status === "parked") {
    const answerable = !reason || reason === "question" || reason === "stalled";
    return { reply: answerable, prune: true, redrive: true };
  }
  if (status === "failure") return { reply: false, prune: true, redrive: true };
  if (status === "running" || status === "unstarted") return { reply: false, prune: true, redrive: false };
  return { reply: false, prune: false, redrive: false };
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
