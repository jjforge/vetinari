# vetinari

> **vetinari** /ˌvɛtɪˈnɑːri/ *n.*: a parallel TDD agent orchestrator in which the
> agents do all the work but never get a vote on whether it is *done*. That vote
> belongs to the test gate.
>
> *"Ankh-Morpork had dallied with many forms of government and had ended up with
> that form of democracy known as One Man, One Vote. The Patrician was the Man; he
> had the Vote."*
> Terry Pratchett, *Mort*

---

Nobody wants to babysit a coding agent — least of all one that quietly marks its
own broken work "done" and looks rather pleased about it. Vetinari is the deal you
actually wanted: hand it a backlog of issues, walk away, and come back to two
things and nothing in between — a base branch that is green with the finished work
merged onto it, and a short list of things that genuinely need a human, each with
one obvious next move.

It runs one agent per issue, in parallel, each sealed in its own container on its
own branch. **It runs your tests and decides what "done" means — the agent never
does.** Green means your gate commands exited zero, run by the orchestrator inside
the sandbox *after* the agent said it was finished; a red gate resumes that same
agent session with the failure attached, so it fixes the actual failure instead of
starting over. Anything an agent cannot finish without you becomes a question on
your phone: its branch and session are kept, and its container slot goes straight
to the next issue.

![The vetinari dashboard: one live landing over every project on the host, with per-repo cards, four fleet counters, and a cross-repo event log.](docs/dashboard.png)

Three properties carry the whole value:

- **The verdict is yours, not the agent's.** No signal but a green gate counts. An
  agent announcing it has finished carries exactly the authority you would grant a
  cat announcing that it is hungry: noted, and checked independently.
- **Nothing is lost, and nothing is guessed.** A park keeps the branch, the
  session, and the question; work that merged stays merged; every step is in a log
  you can replay. It never guesses a culprit, drops an under-specified issue
  silently, or un-parks anything on its own.
- **The base never advances onto unresolved work.** A campaign runs in waves, and
  the next wave starts only when every issue in the current one is merged and the
  merged base is green. Throughput never buys the right to build on a broken base.

The full operator's model — the five issue states, the park reasons and the move
each one asks of you, and a campaign start to finish — is
[`docs/user-guide.md`](docs/user-guide.md).

## Quickstart

```bash
npm install github:jjforge/vetinari
```

Needs Docker, Node 22+, and one agent-provider credential. Vetinari is
**provider-agnostic** (ADR 0016): a run or campaign executes on **Claude Code**
(the default), **pi**, or **Codex** — all resumable, so a parked question resumes
the same session — or on the experimental Copilot / Cursor / OpenCode. Put the
selected provider's key in `.vetinari.local/.env`, the one file that crosses into
the agent container; the exhaustive key list is in
[`docs/reference.md`](docs/reference.md).

Scaffold the layout:

```bash
npx vetinari init
```

This writes a committed `vetinari/config.mts` and `vetinari/Dockerfile`, plus the
ignored `.vetinari.local/` for machine-local state (logs, parked tasks, and the
`.env` above). Put everything project-specific in the config; nothing else needs
editing:

```ts
import { defineConfig, githubFetchTask } from "vetinari";

export default defineConfig({
  project: "myapp",
  image: "vetinari-myapp",             // built from vetinari/Dockerfile
  baseBranch: "main",

  // What decides green. `when` scopes a gate to branches that touched
  // matching files: explicit and logged, never a silent skip.
  gates: [
    { cmd: "npm test" },
    { cmd: "npm run test:e2e", when: /^(src\/routes|e2e)\// },
  ],

  setup: ["npm ci"],                   // once per sandbox, before the agent starts
  fetchTask: githubFetchTask("owner/repo"),  // title/body/comments/labels + state
});
```

Build the image and prove it before spending anything on an agent:

```bash
npx vetinari build          # build cfg.image from vetinari/Dockerfile, then baseline
```

`build` builds `cfg.image` from your Dockerfile and, on success, runs `baseline` —
the toolchain probe and every gate, with **no agent**. A red baseline is the
cheapest failure you will ever buy; do not run an agent until it is green.

Run one issue to watch a single loop go green or park:

```bash
npx vetinari run 436                    # one task: loop until green or parked
npx vetinari parked                     # what's waiting on you, and why
npx vetinari answer 436 "use approach B, and say why in the commit"
```

Commits land on `agent/436`; merging stays yours. Or hand the whole merge → test →
next-wave chain to a campaign:

```bash
git checkout main                       # merges land on the checked-out base
npx vetinari campaign 436 611 640       # select ids → plan waves → run
npx vetinari campaign ready-for-agent   # or select every open issue with a label
```

A campaign takes an issue **selection** (ids, or a label expanded to its open
issues), **plans** it into dependency-ordered, file-disjoint **waves**, and runs
them wave by wave: each wave's greens merge onto the base, the merged base is gated
as a whole, and only then does the next wave start. Watch every project on the
machine live with `npx vetinari status`, or answer parks from your phone through
the Telegram gateway.

## Where to go deeper

The README stops at your first hour.

- **[`docs/user-guide.md`](docs/user-guide.md)** — the operator's model: what
  vetinari is for, the issue states and park reasons, your five moves, and how to
  write an issue that can run unattended.
- **[`docs/design.md`](docs/design.md)** — current implementation truth: the data
  model, the run and campaign loops, integration, redrive, and where the code
  still diverges from the model.
- **[`docs/reference.md`](docs/reference.md)** — the exhaustive lists: every CLI
  mode (generated from `--help`), config field, on-disk file, environment
  variable, event kind, and Telegram routing rule.
- **[`docs/operations.md`](docs/operations.md)** — running it on a host: the
  gateway as a systemd service, the status line, upgrading, and `tidy`.

Built on [`@ai-hero/sandcastle`](https://github.com/mattpocock/sandcastle).
