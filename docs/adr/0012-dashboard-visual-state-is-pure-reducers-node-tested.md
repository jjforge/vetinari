# The dashboard's state → visual-intent mapping is pure reducers, node-tested

The dashboard's recurring regressions (#96, #100, #101, #104) were all the same
shape: a piece of state maps to the wrong class or readout text. A "0 running"
tally kept pulsing (#100); a feed row past the cap still painted (#101). The
mapping was scattered inline across `dashboard-render.ts` — some at server render,
some inside the browser scripts authored as template strings — and only reachable
through `string.contains` assertions on the rendered HTML (`assert.match(html,
/bucket === "running" && count === 0/)`), which pin the *source text* of a rule,
not its *behaviour*: they pass whether or not the rule is correct.

We model that mapping as **pure TS reducers in `dashboard-visual-state.ts`, unit-
tested in node** with real assertions. The gate stays node-only (`npx tsx --test
src/*.test.ts`) — no jsdom, no CDP, no browser. A reducer takes state and returns
the visual intent (a class fragment, or a `{bodyPaused, liveState, ariaLabel,
updatedText}` object); the render code and the browser glue call it and apply the
result, but never re-decide. Today: `dotClass` and `tallyDotClass` (the dot/idle
class decisions), `hiddenPastCap` (the show-older cap), and `freezeIntent` (the
live-bar presentation-freeze).

**The client reducer is single-sourced to the browser via `.toString()`.** The
freeze machine and the tally class run *in the browser* — they tick each second and
react to the pause click — so they cannot simply be imported at render. Instead the
page script inlines `const freezeIntent = ${freezeIntent.toString()};` (and the
`dotClass`/`tallyDotClass` it needs), so the node test imports the very function the
payload ships. This reuses the pattern the archived-runs list already uses for
`highlightJsonLine`/`cappedRawRows`. The constraint that makes it work: a shipped
reducer is a self-contained named `function` — no imports, no closures over module
scope, browser-safe JS only — so `.toString()` yields a runnable definition. Each
inlining carries the one-line `__name = (fn) => fn` shim in case a bundling build
ever leaves esbuild's `keepNames` wrapper on the source (a no-op under the current
`tsx` runtime, which emits clean source).

## Consequences

- A state→visual rule is asserted directly (`tallyDotClass({kind:"running",
  count:0}) === "running idle"`) from a known-good literal, not by matching the
  rule's own source in a blob of HTML. The test survives a rewrite of the render
  code and fails if the rule's behaviour changes.
- The browser and the node test run one function, so the freeze machine cannot
  drift between "what the test checks" and "what ships" — the class of bug that let
  #100 regress after it was first fixed.
- A new state→visual decision belongs in `dashboard-visual-state.ts` as a named
  reducer with a node test, not inline in a render string. If it runs client-side,
  ship it via `.toString()` and keep the DOM writes in the thin glue.
