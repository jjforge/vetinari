# The campaign wave-planner is a generic feature with a config-provided file-set resolver

The campaign wave-planner (`campaign-plan`) — which turns a selected set of ticket
ids into the dependency-ordered, file-disjoint wave arguments `campaign` consumes —
is a **generic vetinari feature**, a peer of `carve`, not a project-owned tool.
It was first drafted as a jjforge-owned script on the argument that "the resolver is
jjforge-specific (it knows `templates/repo/`, the locale append-target, our tracker)."
That argument does not hold: vetinari already absorbs project-specific knowledge
through **config seams** (`blockedBy`, `fetchTask`, `reportFinding`), and the file-set
resolution is one more of the same.

Decisions:

- **File-set resolution is a config seam.** A project supplies a `fileSet(ticket) →
  { files, confident }` resolver in its config, beside `blockedBy`/`fetchTask`. The
  tool never hard-codes any project's paths. vetinari **ships a generic default**
  (parse cited paths → basename → validate against the tree; `confident: false` when a
  ticket cites nothing or cites what the tree does not have), the same way it ships
  `githubBlockedBy`. A project can use the default or wrap it with its own
  symbol/route→file index.
- **The DAG foundation is shared with `carve`.** Stage A/B (restrict `blockedBy` to the
  selected set, then topologically layer) is factored beside `computeCarve`, which
  already does the restriction. Stage D partitions each layer into file-disjoint
  sub-waves by basename.
- **An under-specified ticket halts to the requestor — it is never planned around
  silently.** When the resolver returns `confident: false`, `campaign-plan` (a
  human-run planning tool) **prompts** the requestor with two choices: (A) **remove
  that issue and its dependents** — `carve` semantics via `computeCarve` — and plan the
  rest, or (B) **stop** so the requestor puts the file-set data on the issue and
  re-runs. Non-interactive runs decide via `--on-underspecified=drop|fail`, defaulting
  to **fail**.

## Considered Options

- **jjforge-owned script** — rejected: the only project-specific part is the resolver,
  which is a config seam like the existing ones; keeping the tool in jjforge would
  fork a generic capability into one project.
- **Silently isolate an under-specified ticket into its own sub-wave** — rejected: the
  human should decide remove-vs-enrich; guessing hides missing data behind a
  plausible-looking plan.

## Consequences

Cross-repo: jjforge supplies its own `fileSet` resolver in its config; nothing
jjforge-specific enters vetinari. The deferred "(c)" idea — agents emit their
actual touched file-set on completion for post-hoc validation — is a separate future
vetinari feedback loop, tracked on its own. The output is not a pure function of
the ids (it reads the tree and may prompt), which is accepted: the tree is the ground
truth the campaign runs against, and the prompt is the point.
