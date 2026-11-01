# Operations — running vetinari on a host

This is the "how do I run it on a host" material: putting the CLI on PATH,
standing up the gateway as a service so questions reach you, capping how many containers the machine runs,
wiring the status line, upgrading, and the reconciliation tools you reach for
when something drifts. The [README](../README.md) covers the first hour and the
[user guide](user-guide.md) the operator's model; this is the reference for
keeping an install healthy over time.

## Putting the CLI on PATH

Vetinari is one shared checkout per machine (ADR 0003), not a project
dependency, so `npx` finds nothing to run in a project, and `npm link` /
`npm install -g` need a writable global prefix (on a nix host it is the read-only
store). A `node_modules/.bin` shim does not help either: `src/cli.mts`'s
`#!/usr/bin/env -S npx tsx` shebang looks for `tsx` in the *calling* project. So
put a wrapper on PATH, once per machine, from the vetinari checkout:

```bash
npm run vetinari -- install                  # writes ~/.local/bin/vetinari
npm run vetinari -- install --dir ~/bin      # a different directory
npm run vetinari -- install --dry-run        # print the wrapper, write nothing
```

The wrapper is a `/bin/sh` script that runs `node` with this checkout's tsx loader
and `src/cli.mts` — the launch `gateway install` resolves, without `npx`, so it
works in any directory, including a project with no `package.json`. After it,
`vetinari …` is the invocation everywhere, and the one the status line defaults
to.

- **`--dir`** picks the directory (default `~/.local/bin`, created if missing; a
  relative path resolves against the current directory).
- **Re-running is safe.** A wrapper `install` wrote before (it carries a marker
  comment) is rewritten. Any other file at `<dir>/vetinari` is a refusal (exit 4)
  naming the path; **`--force`** overwrites it.
- **Off PATH.** If the directory is not on your `PATH`, `install` still writes the
  wrapper, then prints the line to add to your shell profile:
  `export PATH="<dir>:$PATH"`, or `fish_add_path <dir>` under fish.
- **Re-run after moving the checkout** — the wrapper bakes its absolute path. A
  node upgrade needs no rerun: the wrapper takes `node` from your `PATH`, where an
  interactive shell's toolchain manager has already put it. The gateway's systemd
  unit pins an absolute `node` instead, because systemd starts it with no such
  `PATH` (see below).

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

Rather than hand-editing the file, run **`vetinari tg-connect`** from the project
root: it prompts for the bot token and chat (or takes `--token`/`--chat`), sends
one message to verify them, and writes the two `VETINARI_TELEGRAM_*` keys into this
`host.env` (creating it `0600`), leaving any other keys in place. `vetinari init`
offers the same step after its scaffold. The optional `VETINARI_TELEGRAM_THREAD_ID`
is a property of a destination, not the bot connection — it stays a hand-edit here.
`run`/`campaign`/`redrive`/`baseline` and the gateway warn (once, at start) when
`.env` or `host.env` is group- or world-readable; they never change its mode.

The gateway reads these live from each registered project's base location (it
never holds them itself), builds a bot connection from the token + chat, and uses
it to poll and send for that project. A project with **no** token/chat has no
connection: the gateway skips it — its outbox never drains and its questions are
never announced. Credentials must never go in `.vetinari.local/.env` or any file
injected into an agent container — a bot token must not ride along into a
sandbox. The agent preflight refuses a `.env` that names `VETINARI_TELEGRAM_BOT_TOKEN`
or `VETINARI_TELEGRAM_CHAT_ID`, even with an empty value.

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
the gateway skips it: the outbox fills and nothing is sent, with only a
`gateway-skip-no-credentials` row in the gateway's log — logged once per project
per gateway start, not every tick. When notifications aren't firing, check
credentials and that the gateway is running first, and routing second.

### Group chats — allowlisting senders

In a **private** chat (a positive chat id) the chat *is* the other person, so
only they can reply — nothing to configure. In a **group** chat (a negative id:
group, supergroup or channel) every member could answer a parked agent or run
`prune`, so the gateway acts only on messages from senders you list:

```bash
# <project>/.vetinari.local/host.env
VETINARI_TELEGRAM_ALLOWED_SENDERS=123456789, 987654321   # Telegram user ids
```

- **No allowlist, no group routing.** With none set, every message from a group
  chat is refused. The gateway warns at start, once per project with a group chat
  (default or a named destination) and no allowlist on its bot; outbound notices
  still go out.
- **Refusals are silent.** Nothing is sent back to the chat; the host log gets one
  `telegram-sender-refused` row with the bot id, chat and sender id — never the
  message text. An anonymous group admin arrives as Telegram's anonymous-admin
  bot, so it is refused unless that id is listed.
- **A shared bot shares its allowlist.** The allowed senders on a bot are the
  union of `VETINARI_TELEGRAM_ALLOWED_SENDERS` across every project on that token —
  which project a message belongs to is only known after routing.
- **Edits take effect live**, on the next poll, with no gateway restart.

**Finding a user id:** have the person send a message in the group, then read the
`sender` field of its `telegram-sender-refused` row in `vetinari host log`.

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
vetinari gateway
```

It rebuilds its reply index from persisted parked records (so a restart
re-announces nothing and still routes a reply that arrived while it was down),
announces newly parked questions, drains every registered project's outbox on a
timer, and runs one poll loop per distinct bot. It also hosts the aggregated
status dashboard (default `127.0.0.1:8765`; override with
`VETINARI_GATEWAY_STATUS_PORT` / `VETINARI_GATEWAY_STATUS_HOST`). A
`VETINARI_GATEWAY_STATUS_PORT` that is not a port number (0–65535) refuses to
start, naming the variable. The gateway does not read `VETINARI_STATUS_PORT`
(that is `vetinari status`'s variable); if it is set in the gateway's
environment, a startup warning names it and the port actually in use. Reply to a
question's message in Telegram and the gateway resumes that exact task; send
`/status` for a text summary; send `prune <issue>` (or `prune <project> <issue>`
when several campaigns share a bot) to preview and, on a `yes` reply, prune.

**Checking it is alive.** The gateway's dashboard answers `GET /healthz` with
when each of its loops last completed a pass — so a hung announce or poll loop
shows up even while the process and dashboard stay up:

```bash
curl -s 127.0.0.1:8765/healthz
```

```json
{
  "stale": false,
  "announce": { "lastTick": "2026-10-21T12:00:00.000Z", "stale": false },
  "bots": [{ "bot": "123456789", "lastPoll": "2026-10-21T12:00:40.000Z", "stale": false }]
}
```

- `announce.lastTick` — when the announce loop last finished a pass (announce
  and outbox drain) without an error; `null` before the first.
- `bots` — one entry per bot currently polled. `bot` is the bot's numeric id
  (the token's part before the first `:`; the token itself is never shown).
  `lastPoll` is when that loop's last long-poll returned — a failed poll counts,
  so this reports a live loop, not a working token; `null` before the first. A
  bot whose polls keep failing backs off up to 5 min between polls, so it reads
  `stale` while it waits — `telegram-poll-failed` in the host log says why.
- A `stale` flag is set when a loop has not ticked for more than **3× its
  interval** — 3× the announce interval for `announce`, 3× the 50 s long-poll
  timeout for a bot — counted from the gateway's (or that loop's) start before
  its first tick. The top-level `stale` is set when any of them is.

The status is always `200`; the `stale` flag carries the verdict. The standalone
`vetinari status` server has no gateway loops, so `/healthz` there is a `404`.

### Installing the gateway as a service

A backgrounded `gateway &` dies with its shell, so a park raised after you close
the terminal goes unanswered. Run it as a **systemd user service** instead — one
always-on daemon, restarted on crash, brought back at boot. Write the unit for
this install with `gateway install`:

```bash
vetinari gateway install          # --dry-run to print the unit and write nothing

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

**On macOS** there is no systemd, so `gateway install` and the `status|start|stop|restart`
verbs refuse (exit `4`) with a pointer instead of writing a unit nothing reads. Run
`vetinari gateway` in a terminal (Telegram relay and dashboard), or `vetinari status` for
the dashboard alone; either stops when that terminal closes.

### Verifying the round-trip

**Prove the credentials** with `tg-test`. It reads `VETINARI_TELEGRAM_BOT_TOKEN`
/ `VETINARI_TELEGRAM_CHAT_ID` from the orchestrator's **own** environment, so
source the project's `host.env` first (the gateway itself reads them from the
base location, but `tg-test` is a standalone check):

```bash
set -a; source .vetinari.local/host.env; set +a
vetinari tg-test
```

It sends a message, waits for your reply, and echoes it back — a green round-trip
confirms the token and chat id are right. A `sendMessage failed` means the token
was rejected or the chat id is wrong (see `telegram-send-failed` in the log).
In a group chat with no `VETINARI_TELEGRAM_ALLOWED_SENDERS`, `tg-test` waits
forever: your reply is refused (look for `telegram-sender-refused` in
`vetinari host log`) — see "Group chats" above.

**Confirm the outbox is draining** with a real message. With the gateway running,
start a small campaign (or trigger any parked question); a `campaign-start` /
`wave-start` record lands in the outbox. Then check that it drained:

- The gateway logs one line per routed record — `gateway-routed` (broadcast
  categories) and `gateway-announced` (a parked `question`), plus
  `gateway-route-failed` / `gateway-announce-failed` on a send that didn't land.
  A project with no credentials logs `gateway-skip-no-credentials` instead, once
  per gateway start.
  For a systemd service these go to `journalctl --user -u vetinari-gateway`.
- Each outbox record file under `.vetinari.local/outbox/<id>.json` gains a
  `sentAt` timestamp (and the `destination` it resolved to) once routed — that
  stamp is the idempotence marker, so a restart neither re-sends nor drops it. A
  record still missing `sentAt` after a tick has not been sent: check the project
  has credentials (a connection) and that the gateway is up.
- A send Telegram rejected logs `telegram-send-failed` with the HTTP `status`
  (or `"network"`) and Telegram's `description` — `Bad Request: chat not found`
  is a wrong chat id — plus `retryAfter` (seconds) on a `429`. A failed outbox
  record stays unsent and is retried on a backoff, not every tick: 5 s, doubling
  per failure to a 5 min cap. A `429` also holds off every other record on that
  bot until its `retryAfter` has passed. The backoff lives in memory, so a
  gateway restart retries at once.

**When replies never arrive.** A poll Telegram rejects logs
`telegram-poll-failed` with the bot's numeric id, `status` and `description`,
once per distinct failure per 5 min, and the loop backs off (5 s doubling to
5 min, or a `429`'s `retryAfter` if longer; the next good poll resets it). A
`401` means the token was revoked or rotated; a `409` (`Conflict: terminated by
other getUpdates request`) means a second process is polling the same bot —
find and stop it (an inline `gateway &` beside the service, or a `tg-test`).

Once a run is fully idle, its already-sent outbox records are cleared as part of
archiving; a record left **unsent** is deliberately kept so a message emitted
while the gateway was down is still sent when it comes back.

## Exposing the dashboard

The dashboard — `vetinari status`, or the one the gateway hosts — is
**unauthenticated by design** ([ADR 0021](adr/0021-dashboard-is-unauthenticated-private-network-only.md)).
Several of its routes start a process: a reply to a parked issue resumes an agent
that holds commit rights with the text you typed, and prune, graft and redrive
reshape a campaign. Anyone who can reach its port can do the same. So:

- **Never bind it to a public interface.** It binds `127.0.0.1` by default
  (`status --host`, `VETINARI_STATUS_HOST`, `VETINARI_GATEWAY_STATUS_HOST`).
- **Reach it remotely only over a private overlay network** (Tailscale,
  WireGuard) **or behind an authenticating reverse proxy** you run. There is no
  token or login to fall back on.

Binding anything other than loopback (`127.0.0.0/8`, `::1`, `localhost`) prints
a warning line after the URL line. The bind still goes ahead; the line is a
reminder, and under the gateway it lands in its stdout (the systemd journal), not
`host.jsonl`.

### What the server refuses

Even on loopback, a page open in your browser could otherwise reach the dashboard,
and an agent container on the same host could reach it whatever the bind.
Every request passes three checks before any route runs; any failure is a `403`
with a one-line plain-text reason:

- **Docker peer.** A request from inside a subnet of the Docker network agent
  containers run on — the default `bridge` — is refused, first, on every route,
  whatever its `Host` or `Origin`. An agent is a script that can forge those
  headers, but not the address it connects from. The subnets are read from
  `docker network inspect bridge` before the dashboard starts listening and
  re-read about every minute. A reverse proxy or sidecar on its own Docker network
  is not refused. If Docker cannot be listed (no `docker`, daemon down), nothing is
  refused by this check and the dashboard keeps working.
- **Host.** The `Host` header, port ignored, must be an IP address literal
  (`127.0.0.1`, `[::1]`, `100.64.1.2`), `localhost`, or a name listed in
  **`VETINARI_STATUS_ALLOWED_HOSTS`** — comma-separated, case-insensitive, read by
  both `status` and the gateway. This is what defeats DNS rebinding, which always
  arrives under a DNS name.
- **Origin.** A browser's `Origin` header, when present (`null` included), must be
  `http://<Host>` or `https://<Host>` for the request's own `Host`, port included.
  This is what stops another site's page POSTing to `/answer`. A request with no
  `Origin` — curl, a script — passes.

Every `POST` to the dashboard — refused, rejected or run — is recorded in
`host.jsonl` as one `dashboard-request` row with its method, path (no query
string), the status it was sent, and the remote address, so `vetinari host log`
shows who replied, pruned, grafted, redrove or stopped, and what they got back.

A request the Docker-peer check refuses — any method — also writes one
`dashboard-docker-peer-refused` row with its method, path (no query string) and
remote address; a refused `POST` writes its `dashboard-request` row (status `403`)
as well. When `docker network inspect` fails or times out, one
`dashboard-docker-peers-unavailable` warning row is written, once per failure
streak rather than per re-read. Seeing it means agent containers are not being
refused: check Docker on the host.

### Over a tailnet

Bind the dashboard to the host's tailnet IP, so it listens only where your
tailnet devices reach it.

The bind is **not** what keeps agent containers out. On Linux, a packet for any
of the host's own addresses is accepted whichever interface it arrives on, so on
a host with no firewall a container can probably reach the tailnet IP too. What
keeps them out is the dashboard's Docker-peer check (see
[What the server refuses](#what-the-server-refuses)), with a host firewall that
denies incoming traffic (`ufw` with deny-incoming, say) as a second layer.
Whether Docker Desktop, whose containers reach the host by a different route, is
covered is still an open question; on Docker Desktop, do not rely on the check
alone.

```bash
vetinari status --host 100.x.y.z
# or, for the gateway's dashboard:
VETINARI_GATEWAY_STATUS_HOST=100.x.y.z vetinari gateway
```

Opening it by tailnet IP (`http://100.x.y.z:8765`) needs nothing more. Opening it
by MagicDNS name needs that name listed:

```bash
VETINARI_STATUS_ALLOWED_HOSTS=myhost.tailnet.ts.net
```

The gateway's unit carries no environment of its own, and `gateway install`
rewrites it, so set the variables in a drop-in, which survives a re-install:

```bash
systemctl --user edit vetinari-gateway
# [Service]
# Environment=VETINARI_GATEWAY_STATUS_HOST=100.x.y.z
# Environment=VETINARI_STATUS_ALLOWED_HOSTS=myhost.tailnet.ts.net
vetinari gateway restart
```

### Behind a reverse proxy

A reverse proxy that authenticates you is the other supported path. It must
**pass the original `Host` header through** to the dashboard — the Origin check
compares the browser's `Origin` against it — and that public name must be listed
in `VETINARI_STATUS_ALLOWED_HOSTS`. A proxy that rewrites `Host` to `127.0.0.1`
will see every browser `POST` refused, because the browser's `Origin` names the
proxy's host, not the rewritten one.

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
vetinari statusline install                      # default: vetinari statusline
vetinari statusline install --dry-run            # print the plan, write nothing
vetinari statusline uninstall                    # restore what it wrapped
```

`install` edits the project's committed `.claude/settings.json`. It is
idempotent, and `--dry-run` prints the plan and writes nothing.

The default is `vetinari statusline` — the wrapper
[`vetinari install`](#putting-the-cli-on-path) puts on PATH once per machine. It
lands in the committed settings, so it reads the same on every machine. Pass
`--run-command` only if you invoke the CLI some other way.

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
  "statusLine": { "type": "command", "command": "vetinari statusline", "refreshInterval": 5 }
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
afterwards: re-run `baseline` in each project, because that is what
proves the image, gates, and config an update has to keep working, and it costs
no agent.

### Update this package

Every project on the machine runs the one vetinari checkout (ADR 0003), so
updating it updates them all at once:

```bash
cd ~/Code/vetinari            # wherever you cloned it
git pull && npm ci            # or check out a tag or sha to pin a version
vetinari gateway restart      # a running gateway picks up the new code
```

Then re-run `vetinari baseline` in each project. Its image, gates, and config
are what an update has to keep working, and `baseline` exercises all three
without agent cost.

Re-run [`vetinari install`](#putting-the-cli-on-path) only if the checkout moved,
and [`vetinari gateway install`](#installing-the-gateway-as-a-service) after a node
or tsx upgrade.

If a campaign exists in any project, read
[During a campaign, and rolling back](#during-a-campaign-and-rolling-back) first.

### During a campaign, and rolling back

**Don't upgrade under a live campaign.** A running campaign keeps the code it
already loaded, while each member `run` it spawns, and any `answer`, `redrive`,
dashboard or Telegram action started meanwhile, loads the new code from disk, so
one campaign ends up mixing two versions. Wait until no campaign is running in
any project, or stop one gracefully with `vetinari stop`. Upgrading under a
**parked** campaign is safe, since no process is running; its redrive simply runs
on the new code.

The sequence:

1. `vetinari stop` in each project with a live campaign, then wait for the
   campaign process to exit. A graceful stop lets the wave in flight finish and
   integrate; the campaign then shows parked `stopped`.
2. `git pull && npm ci` in the vetinari checkout.
3. `vetinari gateway restart`.
4. `vetinari baseline` in each project.
5. `vetinari redrive` in each project where a campaign was stopped or parked.

**Rolling back.** While no campaign is running, check out the earlier tag or sha
in the checkout, then run `npm ci`, `vetinari gateway restart`, and
`vetinari baseline` in each project. State a newer version wrote is read
best-effort: an older version skips event kinds it doesn't know and ignores extra
fields in parked records. A campaign **started** under the newer version should be
finished, or ended with `vetinari clear`, before you roll back, because its log may
depend on behaviour the older version lacks.

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
npm install @ai-hero/sandcastle@latest   # in the vetinari checkout
npm run check-contract                   # ~1s, no Docker: is the surface intact?
vetinari baseline                        # container + gate path still work
vetinari run <small task>                # agent + session + resume still work
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

## Backing up and restoring

Some of vetinari's state is durable: nothing rebuilds it, so back it up. The rest
is disposable: it is rebuilt or can be re-created. Paths are those of the
[on-disk layout](reference.md#on-disk-layout).

### Back up

- **`.vetinari.local/parked/`** — the parked records, the source of truth for
  parked work.
- **`.vetinari.local/outbox/`** — notices not yet sent.
- **`.vetinari.local/logs/orchestrator.jsonl`** and
  **`.vetinari.local/logs/archive/`** — the event log the campaign state is
  rebuilt from, and the run history.
- **`.vetinari.local/copilot/`** — the Copilot session state a resume needs.
- **The unmerged `agent/<id>` branches** in the project's git repo — agents' work
  not yet merged. Back up the repo, or push them to a private remote.
- **The host config dir's `max-concurrent-containers` file** — operator-set
  config. Back it up, or re-create it by hand.

**Keep the secrets elsewhere.** `.vetinari.local/.env` and
`.vetinari.local/host.env` hold credentials: keep them in a password manager
rather than in backups.

**Already in git:** `vetinari/config.mts` and `vetinari/Dockerfile`.

### Disposable

These are rebuilt or re-created, so a backup can skip them:

- the gate logs (`.vetinari.local/logs/gate-<ts>-<n>.log`), agent logs
  (`.vetinari.local/logs/agent-<task>.log`), activity logs
  (`.vetinari.local/logs/activity-<task>.jsonl`) and dashboard-action logs
  (`.vetinari.local/logs/dashboard/`);
- any host cache directories a project's `mounts` point at, such as
  `.vetinari.local/cache/` in a Go project;
- `.vetinari.local/worktrees/` — the agent worktrees, rebuilt from their
  `agent/<id>` branches;
- `.vetinari.local/routing.json` — re-materialized from the config;
- the generated `.vetinari.local/tsconfig.json`;
- the host config dir's registry — re-register the project (see below);
- `<host config dir>/logs/host.jsonl` — the host diagnostics log.

### Never restore

Do not restore the lease files in `<host config dir>/slots/` (the `<pid>.json`
leases and `.lock`), or the project lock files `.vetinari.local/findings.lock`
and `.vetinari.local/parked/.lock`. They describe processes that no longer exist.

### Restore

With no campaign and no gateway running:

1. Put the durable files back.
2. If the registry was lost, re-register each project. Any project command that
   loads the config (`run`, `campaign`, `baseline`, …) registers it, so the
   `baseline` in step 4 does. `tidy` and `gateway` don't.
3. Run `vetinari tidy` — a dry run first, then `vetinari tidy --apply`.
4. Run `vetinari gateway restart`, then `vetinari baseline` in each project.
5. Run `vetinari redrive` in each project where a campaign was parked.

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
Until then a stale pointer is skipped, and logs `registry-stale` in the host log
once per process, not on every read.

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
