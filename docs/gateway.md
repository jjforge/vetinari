# Standing up the gateway (Telegram, end to end)

The **gateway** is one host-level daemon that fronts every project on the machine:
it is the **single Telegram consumer** (one poll per bot, so Telegram's
one-consumer-per-bot rule is never violated) and the **sole sender** — a run never
talks to Telegram itself. When a run parks or emits a notification it writes a
record into its own `.vetinari.local/` and moves on; the gateway drains that
record and sends it. So until the gateway is running, **notifications silently do
not fire**: a campaign fills `.vetinari.local/outbox/` and its parked questions
sit unannounced. This guide takes you from nothing to a draining outbox.

Design background: [ADR 0002 — the gateway is a dumb router; projects own their
comms](adr/0002-gateway-is-a-dumb-router-projects-own-comms.md) and
[ADR 0006 — one dashboard, registry-backed](adr/0006-one-dashboard-registry-backed-aggregated-server.md),
with the full design in [the gateway design spec](specs/2026-08-21-gateway-design.md).

## How a message flows

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

The gateway holds **no** project config and **no** secrets of its own (ADR 0002).
Each project *registers* a pointer to its **base location** (its
`.vetinari.local/` directory), and the gateway reads that project's
credentials, routing, parked questions, and outbox **live** from there every tick.
Nothing is copied into the gateway; editing a project's config needs no
re-registration.

## 1. Credentials

A project's Telegram credentials live in its **base location**, in
`.vetinari.local/host.env` — a plain `KEY=VALUE` shell file, gitignored
and never committed. It is named by container-reach (ADR 0011): `host.env` stays
host-side — read by the orchestrator process and live by the gateway, never
crossing into a container — while `.env` is the container gate:

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
never announced. `VETINARI_TELEGRAM_THREAD_ID` is optional.

This is the change from the retired per-project **`dispatch`** poller. `dispatch`
was one process per project; its systemd unit sourced that project's own host-side
secrets file (then `orchestrator.env`, now `host.env`) into its environment and read
the token from there. Under the
gateway there is one process for the whole host, and it reads each project's
credentials by reference from that project's base location instead of from its own
environment. (Credentials still never go in `.sandcastle/.env` or any file injected
into an agent container — a bot token must not ride along into a sandbox.)

## 2. Declaring where messages go

A project declares its comms in its committed `vetinari/config.mts`, with two
maps:

- **`destinations`** — named `{ bot, chat, thread? }` targets. The `bot` names the
  project's bot (its token is the one read from `.vetinari.local/`, never inlined
  here); `chat` and the optional `thread` say *where* on that bot a message lands.
- **`notify`** — routing rules: each key is a bare `category` or a
  `category:event`, plus a `*` wildcard default; each value is a destination name.

```ts
export default defineConfig({
  // …
  destinations: {
    ops:    { chat: "-1001111111111", bot: "mybot" },
    alerts: { chat: "-1002222222222", bot: "mybot" },
  },
  notify: {
    "*": "ops",              // everything, by default, to ops
    failure: "alerts",       // halts and resume errors to alerts
    "progress:prune": "alerts",
    question: "ops",         // the interactive category — see below
  },
});
```

The five message categories are fixed: `question`, `success`, `failure`,
`progress`, `finding`. Resolution is exact-`category:event` over bare `category`
over `*`. `question` is the only **interactive** category (the gateway watches its
destination for your reply), so it must resolve to **exactly one** destination —
config load fails with a clear error if your notify map (via a `question` entry or
the wildcard) would fan `question` to more than one place. Broadcast categories may
fan anywhere.

### The message skeleton

Every outbound comms message a run enqueues (the notices built in `src/modes.ts`)
follows one **labeled skeleton**, so a push notification reads the same whichever
event fired:

```
<emoji> <project> · <LABEL> · <context>      ← header: LABEL is the state/action in CAPS;
                                               context is `batch N/M`, `N tasks`, a name…
<one terse signal line>                       ← what happened — no parenthetical rationale
Recover: `<command>` …                        ← where relevant: the exact command to type
<detail / impact block>                       ← rides below, as today
```

The voice is **terse and self-contained**: lead with what happened and what to do,
shed low-value explanatory rationale, and where a message points at a recovery
path, **name the exact command** — a pause notice says `` `campaign --resume` ``,
`` `prune <issue>` ``, or `` `campaign --auto-prune` ``, never a bare "resume". Keep
the defined vocabulary (`wave-parked` / `quarantined`, per `CONTEXT.md`). The
`console.log` stdout lines are a separate surface and keep their own format, but the
two pause lines still name `` `campaign --resume` `` so the recovery command is never
only in Telegram.

**How routing reaches the gateway.** On every run, `autoRegister` materializes your
`destinations` + `notify` into the base location as
`.vetinari.local/routing.json`, and the gateway reads that file live (ADR 0002 —
the dumb router reads plain JSON from the base location, never your TypeScript
config).

### The `routing.json = {}` note

`autoRegister` always writes `routing.json`, even when a project declares **no**
`destinations`/`notify` — then it is the empty object `{}`. An empty routing map
does **not** by itself silence delivery: with credentials present, every category
falls back to the project's **default** connection — the `VETINARI_TELEGRAM_CHAT_ID`
in `host.env` — because the design chooses "fall back to the default" over
"silently drop." What an empty `routing.json` costs you is *routing*: you cannot
send failures to an alerts bot or split a thread; everything lands in the one
default chat.

The genuinely silent no-delivery is **missing credentials**, not an empty routing
map. With no `host.env` (no token/chat) a project has no connection at all,
so the gateway skips it: the outbox fills and nothing is sent, with only a skip
line in the gateway's log. That is why "a running campaign enqueues to
`.vetinari.local/outbox/` and nothing sends." When notifications aren't firing,
check credentials and that the gateway is running first, and routing second.

## 3. Registration and running the daemon

**Registration is automatic.** Every run entry point (`run`, `campaign`,
`prune`) calls `autoRegister` at start: it upserts this project's pointer
(`project`, project root, base location) into the host registry under
`~/.config/vetinari/registry/` and refreshes `routing.json`. It is idempotent and
best-effort — a registry write that fails is logged, never fatal to the run — so you
never enroll a project by hand. (The registry is populated whether or not a gateway
is running, which is also what lets `status` serve a dashboard with no daemon —
ADR 0006.)

**Run the daemon:**

```bash
npx vetinari gateway
```

It rebuilds its reply index from persisted parked records (so a restart
re-announces nothing and still routes a reply that arrived while it was down),
announces newly parked questions, drains every registered project's outbox on a
timer, and runs one poll loop per distinct bot. It also hosts the aggregated status
dashboard (default `127.0.0.1:8765`; override with `VETINARI_GATEWAY_STATUS_PORT`
/ `VETINARI_GATEWAY_STATUS_HOST`). Reply to a question's message in Telegram and
the gateway resumes that exact task; send `/status` for a text summary; send
`prune <issue>` (or `prune <project> <issue>` when several campaigns share a bot)
to preview and, on a `yes` reply, prune.

A backgrounded `gateway &` dies with its shell, so a park raised after you close
the terminal goes unanswered. Run it as a **systemd user service** instead — one
always-on daemon, restarted on crash, brought back at boot. If you are migrating
from `dispatch`, the next section rewrites your existing unit for you. On a fresh
host, **write the unit for this install** with `gateway install`:

```bash
npx vetinari gateway install          # --dry-run to print the unit and write nothing

systemctl --user daemon-reload
systemctl --user enable --now vetinari-gateway   # start now + at every login
loginctl enable-linger "$USER"                       # and at boot, without a login session
```

`gateway install` writes `~/.config/systemd/user/vetinari-gateway.service` with an
`ExecStart` resolved for **this host** — a fully absolute `node` + tsx-loader + CLI
invocation, with **no `WorkingDirectory`** (the gateway fronts every project, not
one), no env file to source (it stores no global credentials, reading each project's
live from its base location), and — critically — **no `bash -lc`, `env`, `npx`, or
`PATH` lookup**. That matters because systemd starts the unit with a clean
environment: a `bash -lc 'exec vetinari …'` unit is a *non-interactive login* shell
that never sources `~/.bashrc`, so a `.bashrc`-hooked toolchain manager (nvm, fnm,
mise, asdf) never puts its node `bin` on `PATH` and the unit crash-loops with
`status=127`. The absolute chain sidesteps `PATH` entirely. **Re-run `gateway
install` after a node or tsx upgrade** — the baked paths pin their current location.

`enable --now` alone brings the daemon back only when you log in; **`enable-linger`
is what makes it survive a headless reboot**, telling systemd to start your user
manager at boot. Operate it with `vetinari gateway status|start|stop|restart` (which
wrap `systemctl --user … vetinari-gateway`); gateway detail goes to `journalctl
--user -u vetinari-gateway`. Do not also run an
inline `gateway &`, or the two consumers fight over the bot's updates.

## 4. Migrating off the per-project `dispatch` unit

If you already run the retired per-project `dispatch` poller, `migrate` moves you to
the gateway in one step. Preview first, then apply:

```bash
npx vetinari migrate --dry-run   # print the plan, change nothing
npx vetinari migrate             # apply it
```

Alongside the layout move (config → `vetinari/`, old `.sandcastle/` state →
`.vetinari.local/`, `.gitignore`), `migrate` does the two gateway-coupled parts:

- **Deletes any stale `gateway.env`.** The gateway stores no global credentials
  (ADR 0002) — it reads each project's live from that project's base location — so
  `~/.config/vetinari/gateway.env` holds nothing legitimate. `migrate`
  removes it; per-project secrets stay where they belong, in each project's own
  `.vetinari.local/host.env`.
- **Renames the host-side secrets file.** An existing `.vetinari.local/orchestrator.env`
  is renamed to `.vetinari.local/host.env` (ADR 0011) — named by the axis that
  distinguishes it from the container gate `.env`. The container-secrets file keeps
  its sandcastle-imposed name `.env`.
- **Rewrites the systemd unit into the host-level gateway service.** The unit at
  `~/.config/systemd/user/vetinari-gateway.service` is rewritten from a
  per-project `dispatch` poller (bound to one `WorkingDirectory`, running
  `dispatch`) into the host-level gateway: no `WorkingDirectory`, no env file to
  source, and a fully absolute `node` + tsx-loader + CLI `ExecStart` resolved for
  this host — no `bash -lc`, `env`, `npx`, or `PATH` lookup, so it starts under
  systemd's clean environment (the same resolved unit `gateway install` writes on a
  fresh host; §3). Re-run `migrate` (or `gateway install`) after a node/tsx upgrade
  to re-resolve the baked paths.

After applying, reload and restart:

```bash
systemctl --user daemon-reload      # the unit file changed
vetinari gateway restart            # wraps `systemctl --user restart vetinari-gateway`
```

Do not run `dispatch` and the gateway at once — two consumers of one bot fight over
its updates, and `dispatch` is retired.

## 5. Verification

**Prove the credentials round-trip** with `tg-test`. It reads
`VETINARI_TELEGRAM_BOT_TOKEN` / `VETINARI_TELEGRAM_CHAT_ID` from the
orchestrator's **own** environment, so source the project's `host.env`
first (the gateway itself reads them from the base location, but `tg-test` is a
standalone check):

```bash
set -a; source .vetinari.local/host.env; set +a
npx vetinari tg-test
```

It sends a message, waits for your reply, and echoes it back — a green round-trip
confirms the token and chat id are right. A `sendMessage failed` means the token was
rejected or the chat id is wrong (see `telegram-send-failed` in the log).

**Confirm the outbox is draining** with a real message. With the gateway running,
start a small campaign (or trigger any parked question); a `campaign-start` /
`wave-start` record lands in the outbox. Then check that it drained:

- The gateway logs one line per routed record — `gateway-routed`
  (broadcast categories) and `gateway-announced` (a parked `question`), plus
  `gateway-route-failed` / `gateway-announce-failed` on a send that didn't land. For
  a systemd service these go to `journalctl --user -u vetinari-gateway`.
- Each outbox record file under `.vetinari.local/outbox/<id>.json` gains a
  `sentAt` timestamp (and the `destination` it resolved to) once routed — that stamp
  is the idempotence marker, so a restart neither re-sends nor drops it. A record
  still missing `sentAt` after a tick has not been sent: check the project has
  credentials (a connection) and that the gateway is up.

Once a run is fully idle, its already-sent outbox records are cleared as part of
archiving; a record left **unsent** is deliberately kept so a message emitted while
the gateway was down is still sent when it comes back.
