<!--
DRAFT — not the live README. Proposed rewrite for the sandcastle-tdd → Vetinari
rename (see #54). Promote into README.md atomically as part of that rename, once
the naming decisions (npm scope, final config tokens) are locked. Install URL,
package name, and config paths below assume the post-rename names and are NOT
valid yet.
-->

# Vetinari

> **Vetinari** — an orchestrator that runs your backlog as parallel coding
> agents which cannot mark their own work done, and ask you instead of guessing.
>
> Each task gets a container, a branch, and a TDD loop it drives. Green means
> your tests passed — never an agent saying so. A blocked agent parks and pings
> you; reply and it resumes with full context.

---

> *"Ankh-Morpork had dallied with many forms of government and had ended up with
> that form of democracy known as One Man, One Vote. The Patrician was the Man;
> he had the Vote."*
> — Terry Pratchett, *Mort*

An agent's own claim of completion never decides anything. It runs; Vetinari
holds the vote.

You have a backlog and one of you. The tasks are independent — different files,
different branches — but you can only babysit one agent at a time, and an agent
left alone will cheerfully declare victory over a red suite. Vetinari runs them
all at once in isolated containers and refuses to take any of them at their word.

## How it works

**Green means your test command passed.** After every "I'm done" signal, the
orchestrator runs the gates from your config inside the sandbox and reads the
exit code; only zero returns green. A red gate resumes that same agent session
with the failure output attached, so it keeps its context and fixes the actual
failure instead of starting over.

**A blocked agent parks: question to you, slot back to the pool.** On a
`BLOCKED` signal, an exhausted turn budget, or an idle stall, the question and
session id are written to disk, the container is torn down, and you get a
message. Reply and that agent resumes with full context — new container, fresh
process, days later if you like. Parking frees the slot immediately, so one
stuck task never starves the other nine.

**Parallelism is the default, not a mode.** One branch, worktree, and container
per task means concurrent tasks can't corrupt each other's state; a bounded pool
keeps N slots full.

## Install

```bash
npm install github:jjforge/vetinari
```

Needs Docker, Node 22+, and a `.vetinari.local/.env` holding
`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. `ANTHROPIC_API_KEY` works as
a drop-in alternative when you want per-run cost attribution and spend limits in
the Console.

## Quick Start

Put everything project-specific in `vetinari.config.mts` at your project root:

```ts
import { defineConfig } from "vetinari";

export default defineConfig({
  project: "myapp",
  image: "vetinari-myapp",   // templates/Dockerfile + your toolchain
  baseBranch: "main",

  // What decides green. `when` scopes a gate to branches that touched
  // matching files — explicit and logged, never a silent skip.
  gates: [
    { cmd: "npm test" },
    { cmd: "npm run test:e2e", when: /^(src\/routes|e2e)\// },
  ],
});
```

Then hand it your backlog and let the pool run.

## Built on Sandcastle

Vetinari uses [Sandcastle](https://github.com/mattpocock/sandcastle)
(`@ai-hero/sandcastle`) for its sandbox primitives — containers, worktrees,
branch strategy, result collection — and adds the parts above it: the gate loop
that decides green, the park-and-ask protocol, and the bounded parallel pool.
