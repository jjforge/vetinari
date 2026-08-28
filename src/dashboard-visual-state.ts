/**
 * The dashboard's state → visual-intent reducers — the pure mapping from a piece of
 * state to the classes and text a surface shows. The recurring dashboard regressions
 * (#96, #100, #101, #104) all lived in this mapping while it was scattered inline
 * across `dashboard-render.ts` and only reachable through `string.contains` assertions
 * on rendered HTML. Modelling it as named pure functions unit-tested in node (the
 * node-only gate, no jsdom/CDP) lets each rule be asserted directly (ADR 0012).
 *
 * Two kinds live here. **Server-side** class decisions (`dotClass`, `tallyDotClass`,
 * `hiddenPastCap`) are called at render. The **client-side** presentation-freeze
 * (`freezeIntent`) also runs in the browser — it ticks each second and reacts to the
 * pause click — so it is single-sourced to the browser via `${freezeIntent.toString()}`
 * inlined into the page script: the node test imports the same function the payload
 * ships. Every function shipped this way (`dotClass`, `tallyDotClass`, `freezeIntent`)
 * is a self-contained `function` declaration — no imports, no closures over module
 * scope, browser-safe JS only — so `.toString()` yields a runnable definition.
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
 * Whether a row past the collapsible cap renders `hidden` behind the "show older"
 * control (#101): the newest `cap` rows show, the rest hide until revealed. A pure
 * index test, called server-side by the archived-runs list.
 */
export function hiddenPastCap(index: number, cap: number): boolean {
  return index >= cap;
}

/**
 * Whether a live-pane frame counts as *visible* freshness activity — the signal that
 * resets the live-bar's "updated Ns ago" clock (#198). A pane (the live-tail, the
 * host-log) is a co-equal live surface, so lines it visibly appends should read as an
 * update just like a wave/feed refresh. Only a *visible* append counts: no new lines
 * (`appended === 0`), a collapsed pane (`!open`), or a pane whose own follow is paused so
 * frames merely buffer (`!following`) all leave the clock untouched — presentation is
 * frozen there, so freshness is too. The page-level pause is gated separately by the
 * live-bar itself (a paused page keeps reading "Paused" regardless of this).
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
 * The live-bar's presentation-freeze reducer (ADR 0008, §5/#100): maps the client's
 * pause state to the intent its thin DOM glue applies. `paused` freezes the readout at
 * "Paused" and the indicator at a paused label (disclosing any buffered count) rather
 * than ageing a frozen "updated Ns ago"; `bodyPaused` is the single root flag one CSS
 * rule keys off to freeze every dot at once. `lastUpdate` is null before the first
 * refresh (the landing opens "waiting for updates"; the campaign page seeds it to now).
 *
 * Self-contained and browser-safe: it is single-sourced into both page scripts via
 * `${freezeIntent.toString()}`, so the node test asserts the very function the browser
 * runs. The glue keeps the DOM writes (`document.body.dataset.paused = intent.bodyPaused`
 * …) — this only decides.
 */
export function freezeIntent({
  paused,
  buffered,
  lastUpdate,
  now,
}: {
  paused: boolean;
  buffered: number;
  lastUpdate: number | null;
  now: number;
}): { bodyPaused: string; liveState: string; ariaLabel: string; updatedText: string } {
  return {
    bodyPaused: String(paused),
    liveState: paused ? "paused" : "live",
    ariaLabel: paused ? "Paused" + (buffered ? " · " + buffered + " buffered" : "") : "Live",
    updatedText: paused
      ? "Paused"
      : lastUpdate == null
        ? "waiting for updates"
        : "updated " + Math.round((now - lastUpdate) / 1000) + "s ago",
  };
}
