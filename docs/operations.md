# Operations — running vetinari on a host

This is the "how do I run it on a host" material: standing up the gateway as a
service so questions reach you, capping how many containers the machine runs,
wiring the status line, upgrading, and the reconciliation tools you reach for
when something drifts. The [README](../README.md) covers the first hour and the
[user guide](user-guide.md) the operator's model; this is the reference for
keeping an install healthy over time.

## The gateway

The **gateway** is one host-level daemon that fronts every project on the
machine. It is the **single Telegram consumer** (one poll per bot, so Telegram's
one-consumer-per-bot rule is never violated) and the **sole sender** — a run
never talks to Telegram itself. When a run parks or emits a notice it writes a
record into its own `.vetinari.local/` and moves on; the gateway drains that
record and sends it. So until the gateway is running, **notifications do not
fire**: a campaign fills `.vetinari.local/outbox/` and its parked questions sit
unannounced, delivered once the gateway comes back — waiting, not lost.

Design background: [ADR 0002 — the gateway is a dumb router; projects own their
comms](adr/0002-gateway-is-a-dumb-router-projects-own-comms.md) and
[ADR 0006 — one dashboard, registry-backed](adr/0006-one-dashboard-registry-backed-aggregated-server.md),
with the current model in [design.md §10](design.md).

### How a message flows

```
 a run (run / campaign / prune)
   │  writes, never sends
   ▼
 <project>/.vetinari.local/outbox/<id>.json      ← a category-tagged record
 <project>/.vetinari.local/parked/<task>.json    ← a parked question
   │
   │  the gateway reads every registered project live from its base location
   ▼
 gateway daemon ── routes per <project>/.vetinari.local/routing.json ──▶ Telegram
```

The gateway holds **no** project config and **no** secrets of its own
(ADR 0002). Each project *registers* a pointer to its **base location** (its
`.vetinari.local/` directory), and the gateway reads that project's credentials,
routing, parked questions, and outbox **live** from there every tick. Nothing is
copied into the gateway; editing a project's config needs no re-registration.

### Credentials — per-project `host.env`

A project's Telegram credentials live in its **base location**, in
`.vetinari.local/host.env` — a plain `KEY=VALUE` shell file, gitignored and never
committed. It is named by container-reach (ADR 0011): `host.env` stays host-side
— read by the orchestrator process and live by the gateway, never crossing into
a container — while `.env` is the container gate.

```bash
# <project>/.vetinari.local/host.env
VETINARI_TELEGRAM_BOT_TOKEN=123456:ABC-your-bot-token
VETINARI_TELEGRAM_CHAT_ID=-1001234567890
VETINARI_TELEGRAM_THREAD_ID=42          # optional — a forum thread under the chat
```

The gateway reads these live from each registered project's base location (it
never holds them itself), builds a bot connection from the token + chat, and uses
it to poll and send for that project. A project with **no** token/chat has no
connection: the gateway skips it — its outbox never drains and its questions are
never announced. Credentials must never go in `.vetinari.local/.env` or any file
injected into an agent container — a bot token must not ride along into a
sandbox.

### Bots are per project

Each project names its own bot and chat in its `host.env`; **projects may share a
bot or each have their own**. The gateway is the one process that consumes each
bot and the sole sender, so any number of projects and bots share one gateway. A
reply routes by `(bot, messageId)` back to the exact project and issue that
asked, and the gateway shells `answer` in that project's root.

Where a project's messages land is declared in its committed
`vetinari/config.mts` with two maps:

- **`destinations`** — named `{ chat, thread? }` targets. One bot per project
  (design §10): its token is the one read from `host.env`, never inlined here, so
  a destination names no bot — `chat` and the optional `thread` only say *where*
  on that one bot a message lands.
- **`notify`** — routing rules: each key is a bare `category` or a
  `category:event`, plus a `*` wildcard default; each value is a destination
  name.

```ts
export default defineConfig({
  // …
  destinations: {
    ops:    { chat: "-1001111111111" },
    alerts: { chat: "-1002222222222" },
  },
  notify: {
    "*": "ops",              // everything, by default, to ops
    failure: "alerts",       // halts and resume errors to alerts
    "progress:prune": "alerts",
    question: "ops",         // the interactive routing key — see below
  },
});
```

The four message categories are fixed: `success`, `failure`, `progress`,
`finding`. Resolution is exact-`category:event` over bare `category` over `*`.
`question` is not a category — a question is a parked record the gateway
announces — but it is a **routing key** you may map: it is the one **interactive**
key (the gateway watches its destination for your reply and the park announcement
goes there), so it must resolve to **exactly one** destination — config load fails
with a clear error if your notify map (via a `question` entry or the wildcard)
would fan `question` to more than one place. Broadcast categories may fan anywhere.

**The event names changed (breaking).** A `category:event` key uses the settled
§2.1 event words. If you routed on the old outbound event names, update the keys:

| Old key | New key |
| --- | --- |
| `progress:queue-start` | *(removed — the wave is framed by `progress:wave-start`)* |
| `progress:queue-done` | *(removed — the wave is framed by `success:wave-done`)* |
| `success:wave-merged` | `success:wave-done` |
| `success:campaign-complete` | `success:campaign-done` |
| `progress:campaign-resume` | `progress:redrive` |
| `failure:wave-parked` | `failure:campaign-parked` |
| `failure:quarantine-paused` | `failure:campaign-parked` |
| `progress:auto-prune` | `progress:prune` |

**How routing reaches the gateway.** On every run, `autoRegister` materializes
your `destinations` + `notify` into the base location as
`.vetinari.local/routing.json`, and the gateway reads that file live (ADR 0002 —
the dumb router reads plain JSON from the base location, never your TypeScript
config).

`autoRegister` always writes `routing.json`, even when a project declares **no**
`destinations`/`notify` — then it is the empty object `{}`. An empty routing map
does **not** by itself silence delivery: with credentials present, every category
falls back to the project's **default** chat — the `VETINARI_TELEGRAM_CHAT_ID` in
`host.env` — because the design chooses "fall back to the default" over "silently
drop." What an empty `routing.json` costs you is *routing*: you cannot send
failures to an alerts bot or split a thread; everything lands in the one default
chat.

The genuinely silent no-delivery is **missing credentials**, not an empty routing
map. With no `host.env` (no token/chat) a project has no connection at all, so
the gateway skips it: the outbox fills and nothing is sent, with only a skip line
in the gateway's log. When notifications aren't firing, check credentials and
that the gateway is running first, and routing second.

### Registration and running the daemon

**Registration is automatic.** Every run entry point (`run`, `campaign`,
`prune`) calls `autoRegister` at start: it upserts this project's pointer
(`project`, project root, base location) into the host registry under
`~/.config/vetinari/registry/` and refreshes `routing.json`. It is idempotent and
best-effort — a registry write that fails is logged, never fatal to the run — so
you never enroll a project by hand. (The registry is populated whether or not a
gateway is running, which is also what lets `status` serve a dashboard with no
daemon — ADR 0006.)

Run the daemon:

```bash
npx vetinari gateway
```

It rebuilds its reply index from persisted parked records (so a restart
re-announces nothing and still routes a reply that arrived while it was down),
announces newly parked questions, drains every registered project's outbox on a
timer, and runs one poll loop per distinct bot. It also hosts the aggregated
status dashboard (default `127.0.0.1:8765`; override with
`VETINARI_GATEWAY_STATUS_PORT` / `VETINARI_GATEWAY_STATUS_HOST`). Reply to a
question's message in Telegram and the gateway resumes that exact task; send
`/status` for a text summary; send `prune <issue>` (or `prune <project> <issue>`
when several campaigns share a bot) to preview and, on a `yes` reply, prune.

### Installing the gateway as a service

A backgrounded `gateway &` dies with its shell, so a park raised after you close
the terminal goes unanswered. Run it as a **systemd user service** instead — one
always-on daemon, restarted on crash, brought back at boot. Write the unit for
this install with `gateway install`:

```bash
npx vetinari gateway install          # --dry-run to print the unit and write nothing

systemctl --user daemon-reload
systemctl --user enable --now vetinari-gateway   # start now + at every login
loginctl enable-linger "$USER"                    # and at boot, without a login session
```

`gateway install` writes `~/.config/systemd/user/vetinari-gateway.service` with
an `ExecStart` resolved for **this host** — a fully absolute `node` + tsx-loader
+ CLI invocation, with **no `WorkingDirectory`** (the gateway fronts every
project, not one), no env file to source (it stores no global credentials,
reading each project's live from its base location), and — critically — **no
`bash -lc`, `env`, `npx`, or `PATH` lookup**. That matters because systemd starts
the unit with a clean environment: a `bash -lc 'exec vetinari …'` unit is a
*non-interactive login* shell that never sources `~/.bashrc`, so a
`.bashrc`-hooked toolchain manager (nvm, fnm, mise, asdf) never puts its node
`bin` on `PATH` and the unit crash-loops with `status=127`. The absolute chain
sidesteps `PATH` entirely. **Re-run `gateway install` after a node or tsx
upgrade** — the baked paths pin their current location.

`enable --now` alone brings the daemon back only when you log in; **`enable-linger`
is what makes it survive a headless reboot**, telling systemd to start your user
manager at boot. Operate it with:

```bash
vetinari gateway status     # is it running? (wraps systemctl --user status)
vetinari gateway start
vetinari gateway stop
vetinari gateway restart    # after the unit or the CLI changes
```

These wrap `systemctl --user … vetinari-gateway`; gateway detail goes to
`journalctl --user -u vetinari-gateway`. Do not also run an inline `gateway &`,
or the two consumers fight over the bot's updates.

### Verifying the round-trip

**Prove the credentials** with `tg-test`. It reads `VETINARI_TELEGRAM_BOT_TOKEN`
/ `VETINARI_TELEGRAM_CHAT_ID` from the orchestrator's **own** environment, so
source the project's `host.env` first (the gateway itself reads them from the
base location, but `tg-test` is a standalone check):

```bash
set -a; source .vetinari.local/host.env; set +a
npx vetinari tg-test
```

It sends a message, waits for your reply, and echoes it back — a green round-trip
confirms the token and chat id are right. A `sendMessage failed` means the token
was rejected or the chat id is wrong (see `telegram-send-failed` in the log).

**Confirm the outbox is draining** with a real message. With the gateway running,
start a small campaign (or trigger any parked question); a `campaign-start` /
`wave-start` record lands in the outbox. Then check that it drained:

- The gateway logs one line per routed record — `gateway-routed` (broadcast
  categories) and `gateway-announced` (a parked `question`), plus
  `gateway-route-failed` / `gateway-announce-failed` on a send that didn't land.
  For a systemd service these go to `journalctl --user -u vetinari-gateway`.
- Each outbox record file under `.vetinari.local/outbox/<id>.json` gains a
  `sentAt` timestamp (and the `destination` it resolved to) once routed — that
  stamp is the idempotence marker, so a restart neither re-sends nor drops it. A
  record still missing `sentAt` after a tick has not been sent: check the project
  has credentials (a connection) and that the gateway is up.

Once a run is fully idle, its already-sent outbox records are cleared as part of
archiving; a record left **unsent** is deliberately kept so a message emitted
while the gateway was down is still sent when it comes back.

## Capping containers on the host

Two knobs bound how many agent containers a machine runs at once (design §8):

- **`MAX_CONCURRENT_CONTAINERS`** is a property of the *host*, not a project — an
  env var, or a `max-concurrent-containers` file in the gateway config dir. It
  bounds live containers across every project. Unset, it resolves to a
  machine-derived default (never unbounded). There is no per-run cap; a lone
  project fills the ceiling. Set it because a full gate per turn is CPU-bound and
  parallel agents also share your account's rate limits.
- **`containerShare: high | medium | low`** (default `medium`) is a *project's*
  declared cut of the ceiling when projects contend, set in its
  `vetinari/config.mts`. Each contending project gets a floor of one container
  plus a weighted share of the remainder (weights `7:2:1` for high:medium:low) —
  never preemptive, never starving. A busy run drains to a smaller share as its
  turns finish rather than being killed.

The lease that enforces this is a file under the host config dir that every run
reads and writes directly. The gateway is **not** the allocator; a
gateway-spawned `answer` takes a slot like any run. See
[ADR 0011](adr/0011-configuration-layers.md) for the configuration-layers model
(scope × secrecy × container-reach).

## The status line

`vetinari statusline` prints a compact view of a run into the Claude Code status
bar, so a campaign in flight is visible without leaving the editor.

### What it shows

Two lines. Line 1 mirrors Claude Code's own default (model, directory, git
branch, context-used %), with the model name trimmed of its `(1M context)`
suffix. Line 2 is the vetinari run: the wave in flight and a count per state. The
🏰 marks it, and there is no project name, since line 1 already shows the
directory:

```
Opus 4.8 · jjforge · develop · 24%
🏰 wave 2/3 · ✅2 🔄1 ⏸1 ⚪1
```

Outside a vetinari project, line 2 is simply omitted, leaving line 1. A non-zero
exit would blank the whole bar, so `statusline` never errors out: any missing
piece just narrows what prints.

### Install

```bash
vetinari statusline install                      # default: npx vetinari statusline
vetinari statusline install --run-command ".vetinari.local/run statusline"
vetinari statusline install --dry-run            # print the plan, write nothing
vetinari statusline uninstall                    # restore what it wrapped
```

`install` edits the project's committed `.claude/settings.json`. It is
idempotent, and `--dry-run` prints the plan and writes nothing.

Pass `--run-command` to match however you invoke the CLI in your project, so the
`vetinari` import and the config both resolve. The default is `npx vetinari
statusline`; an in-repo launcher such as `.vetinari.local/run statusline` is the
common override.

**Wrapping a status line you already have.** Install **respects a status line you
already have**, including one set at the user level in
`~/.claude/settings.json`. Whatever is configured stays as line 1, rendered
exactly as it is (colours and all), and the 🏰 campaign line is added *under* it,
never replacing it, so a customized bar keeps working. Under the hood, install
base64-encodes your existing command into a `--base-b64` suffix on the installed
command; `vetinari statusline` runs that command for line 1 and appends its own
campaign line, falling back to its own context line only when yours produces
nothing. When the project has no status line of its own, it wraps the one
inherited from `~/.claude/settings.json` (which a project-level write would
otherwise shadow, blanking its colours).

`uninstall` reverses it exactly: it restores your previous command, or drops the
project `statusLine` entirely when vetinari wrapped nothing (or when what it
wrapped was the inherited user-level line, so the inheritance applies again).

A `statusLine` in the higher-precedence `.claude/settings.local.json` owns the
whole block Claude Code renders, so an install into `.claude/settings.json` would
be shadowed and never show. When `install` detects one there it **warns and skips
the write** (exit 0) rather than leaving an inert entry, naming
`.claude/settings.local.json` as the shadowing layer and telling you to remove
its `statusLine` (or add the 🏰 line there yourself). `uninstall` warns
symmetrically.

### Wiring it by hand

`install` just writes this entry; you can write it yourself instead:

```json
{
  "statusLine": { "type": "command", "command": ".vetinari.local/run statusline", "refreshInterval": 5 }
}
```

`refreshInterval` matters. Claude Code refreshes the status line on its own
events, but nothing tells it when the orchestrator's log changes; polling every
few seconds keeps the line live during a run. `statusline` reads Claude Code's
JSON on stdin, resolves the config from the workspace directory, and derives line
2 from the log alone, with no network, so it stays cheap enough to run on every
refresh.

## Upgrading

Two things update independently: this package (the orchestrator) and
`@ai-hero/sandcastle` (the library it runs on). Both come down to the same habit
afterwards: re-run `baseline` in each consuming project, because that is what
proves the image, gates, and config an update has to keep working, and it costs
no agent.

### Update this package

**Installed from git** (`github:jjforge/vetinari`): npm copies the repo at a
commit, so updates are explicit:

```bash
npm update vetinari                          # move to the tip of main
npm install github:jjforge/vetinari#<sha>    # or pin to a commit
```

Then re-run `npx vetinari baseline` in that project. Its image, gates, and config
are what an update has to keep working, and `baseline` exercises all three
without agent cost.

**Installed from a local path** (`file:../vetinari`): npm creates a **symlink**,
so the consuming project always runs your working tree and a `git pull` in the
package directory takes effect immediately with no reinstall. Convenient while
developing the orchestrator, and worth knowing when debugging: a consuming
project has no pinned version to blame, because it has no pin.

Config changes are the other update path. `defineConfig` is typed, so `npx tsc
--noEmit` in the consuming project catches a renamed or dropped field.

### The shims `migrate` no longer carries

`migrate` moves a pre-layout project **once** and does not accumulate shims for
later renames: it now performs only the one-time layout move (`vetinari/` +
`.vetinari.local/`, config → `vetinari/`, old `.sandcastle/` state →
`.vetinari.local/`, the `.gitignore` edit) and the host-side `orchestrator.env` →
`host.env` rename. A rename is a breaking change with a stated benefit, not a
shim `migrate` carries forever (design §9, §13.1). The following one-off shims —
added for a tool only weeks old — have been removed. If you are upgrading a
project old enough to need one, apply it by hand:

- **`hostWeight` → `containerShare`.** Replace a numeric `hostWeight: N` in
  `vetinari/config.mts` with `containerShare: "high" | "medium" | "low"`.
- **`host-slots` → `max-concurrent-containers`.** Rename the host-ceiling file in
  the gateway config dir, keeping its value.
- **`dispatch` → `gateway` systemd unit.** Re-run `vetinari gateway install` to
  write this host's `vetinari-gateway.service`, replacing any per-project
  `dispatch` poller unit. (The `dispatch` poller is retired: it was one process
  per project sourcing that project's secrets into its own environment; the
  gateway is one process for the whole host, reading each project's credentials
  by reference from its base location. Do not run both — two consumers of one bot
  fight over its updates.)
- **Stale `gateway.env`.** Delete any `gateway.env` in the gateway config dir —
  the gateway holds no secrets of its own (ADR 0002).
- **`VETINARI_TELEGRAM_*` in the container gate.** Remove any
  `VETINARI_TELEGRAM_*` keys from `.vetinari.local/.env`; they belong only in
  `.vetinari.local/host.env`, never in a container. Rotate any bot token that was
  exposed there.

### Update `@ai-hero/sandcastle`

> **Temporary fork pin.** `@ai-hero/sandcastle` is pinned to a fork,
> `git+https://github.com/zachthieme/sandcastle.git`, at the `state-dir-prebuilt`
> commit, for the `stateDir` option vetinari needs (it routes sandcastle's own
> artifacts under `.vetinari.local/` instead of a stray `.sandcastle/`). That
> branch carries a prebuilt `dist/`, because npm 11 blocks a dependency's
> build-on-install scripts by default and a git install could not otherwise build
> it. The change itself is upstream as
> [mattpocock/sandcastle#961](https://github.com/mattpocock/sandcastle/pull/961);
> this pin is temporary, to be dropped for a published `@ai-hero/sandcastle` (the
> flow below) once that PR lands in a release. The clean feature branch
> (`configurable-state-dir`, what the PR tracks) carries no `dist/`.

When on a published release, the dependency is pinned `^0.12.0`, so npm's caret
allows patches only. sandcastle is pre-1.0, so a minor can carry behavioural
changes; pinning to patches lets us adopt a minor deliberately, after
re-verifying the integration points below, rather than by surprise.

```bash
npm install @ai-hero/sandcastle@latest   # here, and in each consuming project
npm run check-contract                   # ~1s, no Docker: is the surface intact?
npx vetinari baseline                    # container + gate path still work
npx vetinari run <small task>            # agent + session + resume still work
```

Climb all four rungs, because each sees what the one below cannot.
`check-contract` catches a renamed export or dropped option in about a second;
`tsc` alone will **not**, because vetinari probes a few optional members of
sandcastle's result objects at runtime. `baseline` proves the container path.
Only a real `run` exercises the agent, the gate→resume cycle, and session
capture.

vetinari builds on four sandcastle behaviours that no static check can see. These
are the integration points `check-contract` prints, and the ones we re-verify on
any minor bump:

1. **A sandbox command returns a non-zero exit code rather than throwing.** This
   is what lets a red gate read as red, so it is the behaviour we depend on most
   and the first we check on an upgrade.
2. **`resumeSession` is used without `maxIterations > 1`.**
3. **An idle agent throws a catchable timeout**, which is how a stall is detected
   and parked.
4. **Session capture writes host-side JSONL, and re-creating a sandbox on an
   existing branch reuses that worktree**: together, what make park→answer
   survive a fresh process.

Consuming projects pin the library themselves (it's a peer in practice), so bump
it there too and re-run that project's `baseline`.

## Reconciliation tools

### `tidy` — fold the drift a by-hand resolution leaks

Human-in-the-loop resolution — a manual fix-forward, a by-hand merge — is where
artifacts leak. `vetinari tidy` reconciles that (ADR 0013): it folds orphaned
`changelog.d/` fragments whose issue is merged, garbage-collects `agent/<id>`
branches and worktrees whose commits are **provably** reachable from the base,
and clears parked records for issues now merged. Its one load-bearing rule is
that a branch dies only when it is provably reachable from the base — it **never**
touches a branch with unmerged work, and never a parked or quarantined issue,
whose work must stay resumable.

```bash
vetinari tidy            # dry run — print the plan, change nothing (the default)
vetinari tidy --apply    # act on the plan
vetinari tidy --all      # sweep every registered project (dry run unless --apply)
```

Run it from a project root, or use `--all` to sweep the whole host registry — the
same sweep also drops provably-dead duplicate registry pointers. When a fold
touches `CHANGELOG.md`, review it and commit it yourself; `tidy` never commits.

### `registry remove` — drop a stale project pointer

Every run auto-registers its project's pointer into the host registry;
`registry remove` is the explicit counterpart — it deletes one project's pointer
so the dashboard stops listing it.

```bash
vetinari registry remove <name>
```

It acts on the host registry (not a project's container lease), so it runs from
anywhere and needs no project config in the current directory. Removing a pointer
whose project you have since deleted keeps a moved-or-gone project from lingering
on the dashboard.

## `host log` — the host-level diagnostics reader

Host and gateway diagnostics are written to a persistent host log
(`host.jsonl`) under the host config dir. `host log` is the reader for it — the
one to reach for when a host daemon is the thing that's broken, since it reads the
file directly off disk and needs no running gateway.

```bash
vetinari host log                 # the recent window, newest-first
vetinari host log -n 200          # a larger window
vetinari host log --tail          # follow live, like tail -f
vetinari host log --json          # raw JSONL, chronological — for jq/grep/tail
```

The two outputs deliberately differ in order (design §14): the human render is
**newest-first**, so the most recent event leads with no scrolling; `--json` stays
in on-disk **chronological** order, byte-faithful for `jq`/`tail`. A
missing or empty log reads clean ("no host log yet"), never an error.
