# Copilot resumes through a mounted per-issue Copilot directory

Status: recorded in design.md §9 and §12.

ADR 0016 shipped the GitHub Copilot CLI as an experimental, **non-resumable**
provider: the loop re-entered every turn fresh, harvested no findings, and an
answered park needed `postComment` and a fresh run. sandcastle's own `copilot()`
provider marks Copilot non-resumable because a Copilot session is not one file it can
copy between the host and the container. We decided to make Copilot **resumable** by
mounting each issue's Copilot state into its agent container, so Copilot gets the
same loop as Claude: gate failures continue the session, an answered park resumes
it, the findings harvest runs, and a crash with commits resumes on its branch.

## The evidence (Copilot CLI 1.0.105)

A spike established:

- `copilot -p … --output-format json --session-id <uuid>` starts a session with that
  id, and the stream's final `result` event echoes it as `sessionId`.
- `--session-id` is **create-or-resume**: given an id that already exists, it
  continues that session instead of starting one.
- `copilot -p … --resume <id>` continues the conversation, in the same container
  and in a fresh container that mounts the same `~/.copilot` directory.
- A session is a whole directory tree: the `session-store.db` SQLite index plus
  `session-state/<id>/…`.
- With `COPILOT_GITHUB_TOKEN` in the environment, Copilot writes **no credential**
  into `~/.copilot`. Its `config.json` holds only a first-launch timestamp.

## Decision

Each issue's Copilot state lives in `.vetinari.local/copilot/<task-id>/` on the host,
bind-mounted read-write at `/home/agent/.copilot` in that issue's agent container.
vetinari wraps sandcastle's `copilot()` (its command, prompt-size check and stream
parser are reused) and overrides three things:

- it captures sessions;
- its session storage looks for `session-state/<id>/` in the issue's Copilot
  directory and transfers nothing, because the mount already shares it;
- a fresh turn passes a **fresh** `--session-id <uuid>`, and a later turn passes
  `--resume <id>`.

The directory is mounted only for agent runs. The gate and baseline sandboxes never
get one. It is removed wherever vetinari drops the issue's branch: after a green
merged-base gate (for merged and already-merged issues), and on `prune --purge` and
`tidy --apply`. A parked, stopped or crashed issue keeps it, so its session can resume.

## Why a directory mount, not a session-file transfer

sandcastle resumes Claude, pi and Codex by copying one session file out of the
container after a turn and back in before the next. A Copilot session is a SQLite
index plus a directory tree, so a one-file transfer cannot reproduce it, and copying
the whole tree in and out each turn would rebuild what a mount gives for free. The
mount also means a session written by a container that crashed or was stopped is
already on the host, with nothing to capture.

## Why per issue

The SQLite store is shared by every session in a `~/.copilot` directory. Agents run
concurrently, so one directory shared across issues would put several Copilot
processes on one database. A directory per issue keeps every store single-writer,
and makes cleanup a matter of removing that issue's directory.

## Why a fresh `--session-id` per new session, never a reused one

Copilot reports its session id only in the final `result` event. sandcastle's
completion timeout can end a turn after the agent signalled but before that event,
which would leave the turn with no session id to resume. Because vetinari chooses
the id before the turn starts, it reports it as the turn's session id from the
turn's first stream line, so a cut-off turn still resumes.

The id is a new uuid on every fresh turn, never derived from the issue or reused.
`--session-id` is create-or-resume, so a reused id would silently continue an old
conversation where a fresh start was meant.

## The container-boundary invariant

Design §9 and ADR 0011 keep secrets out of the container: the only credential file
that crosses is `.vetinari.local/.env`. The Copilot directory is not configuration
or a secret. It is the agent's own working state, like its worktree, and it
verifiably holds no credential while the token comes from the environment. The
invariant stands: the credential still crosses only through `.env`.

## Consequences

- `copilot` leaves the non-resumable set. Cursor and OpenCode stay experimental and
  non-resumable.
- `agentFor` takes the task id, so a Copilot provider knows which issue's directory
  backs its session storage. This is a public API change.
- An agent container gains one more host path, read-write, for Copilot runs only.
- `forkSession` is not supported for Copilot. Nothing in vetinari uses it.

## Considered Options

- **One shared `~/.copilot` across issues** — rejected: concurrent agents would
  share one SQLite store, and a merged issue's state could not be removed alone.
- **Copying the session tree in and out each turn** — rejected: more moving parts
  than a mount, and a crashed turn's session would be lost.
- **Deriving the session id from the issue** — rejected: create-or-resume would
  continue a stale session where a fresh one was meant.
