# Migrating existing dashboard markup assertions

vetinari does not plan a sweep that rewrites the dashboard tests' existing
markup and CSS assertions into view-model or DOM-role assertions.

## Why this is out of scope

The dashboard test files pin a lot of rendered text: tag names, attribute order,
class names, CSS rules. That makes visual tweaks noisy, because one changed class
breaks a cluster of assertions. But those assertions aren't wrong. They catch real
regressions in the markup the dashboard's scripts and styles depend on, and no
defect sits behind them.

A sweep that rewrites them would touch most dashboard test files for no change in
behaviour, collide with every dashboard ticket in flight, and need its own review
to show that each rewritten assertion still pins what the old one did. That is
churn, not a fix.

The real gap is different: nothing *runs* the dashboard's client-side scripts.
That is tracked as its own work: a small DOM harness that drives the scripts
against the rendered markup. New tests should prefer that harness, or the view
model the renderers fold, over raw markup text. Existing assertions get
rewritten only when a change already touches them.

## Prior requests

- #537 — "Over a quarter of dashboard test assertions pin markup and CSS text instead of behaviour" (the migration half)
