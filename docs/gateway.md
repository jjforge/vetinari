# Standing up the gateway (Telegram, end to end)

The **gateway** is one host-level daemon that fronts every project on the machine:
it is the **single Telegram consumer** (one poll per bot, so Telegram's
one-consumer-per-bot rule is never violated) and the **sole sender** — a run never
talks to Telegram itself. When a run parks or emits a notification it writes a
record into its own `.sandcastle.local/` and moves on; the gateway drains that
record and sends it. So until the gateway is running, **notifications silently do
not fire**: a campaign fills `.sandcastle.local/outbox/` and its parked questions
sit unannounced. This guide takes you from nothing to a draining outbox.

Design background: [ADR 0002 — the gateway is a dumb router; projects own their
comms](adr/0002-gateway-is-a-dumb-router-projects-own-comms.md) and
[ADR 0006 — one dashboard, registry-backed](adr/0006-one-dashboard-registry-backed-aggregated-server.md),
with the full design in [the gateway design spec](specs/2026-08-21-gateway-design.md).

## How a message flows

```
 a run (run / queue / campaign / carve)
   │  writes, never sends
   ▼
 <project>/.sandcastle.local/outbox/<id>.json      ← a category-tagged record
 <project>/.sandcastle.local/parked/<task>.json    ← a parked question
   │
   │  the gateway reads every registered project live from its base location
   ▼
 gateway daemon ── routes per <project>/.sandcastle.local/routing.json ──▶ Telegram
```

The gateway holds **no** project config and **no** secrets of its own (ADR 0002).
Each project *registers* a pointer to its **base location** (its
`.sandcastle.local/` directory), and the gateway reads that project's
credentials, routing, parked questions, and outbox **live** from there every tick.
Nothing is copied into the gateway; editing a project's config needs no
re-registration.

## 1. Credentials

A project's Telegram credentials live in its **base location**, in
`.sandcastle.local/orchestrator.env` — a plain `KEY=VALUE` shell file, gitignored
and never committed:

```bash
# <project>/.sandcastle.local/orchestrator.env
SANDCASTLE_TELEGRAM_BOT_TOKEN=123456:ABC-your-bot-token
SANDCASTLE_TELEGRAM_CHAT_ID=-1001234567890
SANDCASTLE_TELEGRAM_THREAD_ID=42          # optional — a forum thread under the chat
```

The gateway reads these live from each registered project's base location (it
never holds them itself), builds a bot connection from the token + chat, and uses
it to poll and send for that project. A project with **no** token/chat has no
connection: the gateway skips it — its outbox never drains and its questions are
never announced. `SANDCASTLE_TELEGRAM_THREAD_ID` is optional.

This is the change from the retired per-project **`dispatch`** poller. `dispatch`
was one process per project; its systemd unit sourced that project's own
`orchestrator.env` into its environment and read the token from there. Under the
gateway there is one process for the whole host, and it reads each project's
credentials by reference from that project's base location instead of from its own
environment. (Credentials still never go in `.sandcastle/.env` or any file injected
into an agent container — a bot token must not ride along into a sandbox.)

## 2. Declaring where messages go

A project declares its comms in its committed `sandcastle/config.mts`, with two
maps:

- **`destinations`** — named `{ bot, chat, thread? }` targets. The `bot` names the
  project's bot (its token is the one read from `.sandcastle.local/`, never inlined
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
    "progress:carve": "alerts",
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

**How routing reaches the gateway.** On every run, `autoRegister` materializes your
`destinations` + `notify` into the base location as
`.sandcastle.local/routing.json`, and the gateway reads that file live (ADR 0002 —
the dumb router reads plain JSON from the base location, never your TypeScript
config).

### The `routing.json = {}` note

`autoRegister` always writes `routing.json`, even when a project declares **no**
`destinations`/`notify` — then it is the empty object `{}`. An empty routing map
does **not** by itself silence delivery: with credentials present, every category
falls back to the project's **default** connection — the `SANDCASTLE_TELEGRAM_CHAT_ID`
in `orchestrator.env` — because the design chooses "fall back to the default" over
"silently drop." What an empty `routing.json` costs you is *routing*: you cannot
send failures to an alerts bot or split a thread; everything lands in the one
default chat.

The genuinely silent no-delivery is **missing credentials**, not an empty routing
map. With no `orchestrator.env` (no token/chat) a project has no connection at all,
so the gateway skips it: the outbox fills and nothing is sent, with only a skip
line in the gateway's log. That is why "a running campaign enqueues to
`.sandcastle.local/outbox/` and nothing sends." When notifications aren't firing,
check credentials and that the gateway is running first, and routing second.

## 3. Registration and running the daemon

**Registration is automatic.** Every run entry point (`run`, `queue`, `campaign`,
`carve`) calls `autoRegister` at start: it upserts this project's pointer
(`project`, project root, base location) into the host registry under
`~/.config/sandcastle/registry/` and refreshes `routing.json`. It is idempotent and
best-effort — a registry write that fails is logged, never fatal to the run — so you
never enroll a project by hand. (The registry is populated whether or not a gateway
is running, which is also what lets `status` serve a dashboard with no daemon —
ADR 0006.)

**Run the daemon:**

```bash
npx sandcastle-tdd gateway
```

It rebuilds its reply index from persisted parked records (so a restart
re-announces nothing and still routes a reply that arrived while it was down),
announces newly parked questions, drains every registered project's outbox on a
timer, and runs one poll loop per distinct bot. It also hosts the aggregated status
dashboard (default `127.0.0.1:8765`; override with `SANDCASTLE_GATEWAY_STATUS_PORT`
/ `SANDCASTLE_GATEWAY_STATUS_HOST`). Reply to a question's message in Telegram and
the gateway resumes that exact task; send `/status` for a text summary; send
`carve <issue>` (or `carve <project> <issue>` when several campaigns share a bot)
to preview and, on a `yes` reply, carve.

A backgrounded `gateway &` dies with its shell, so run it as a **systemd user
service** — one always-on daemon, restarted on crash, brought back at boot. If
you are migrating from `dispatch`, the next section rewrites your existing unit for
you. On a fresh host, install a unit whose `ExecStart` sources the host-level
`~/.config/sandcastle/gateway.env` and `exec`s `sandcastle-tdd gateway` (no
`WorkingDirectory` — the gateway fronts every project, not one), then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now sandcastle-dispatch   # start now + at every login
loginctl enable-linger "$USER"                       # ...and at boot, without a login
```

`enable-linger` is what makes it survive a headless reboot. Operate it with
`systemctl --user status|restart sandcastle-dispatch`.

## 4. Migrating off the per-project `dispatch` unit

If you already run the retired per-project `dispatch` poller, `migrate` moves you to
the gateway in one step. Preview first, then apply:

```bash
npx sandcastle-tdd migrate --dry-run   # print the plan, change nothing
npx sandcastle-tdd migrate             # apply it
```

Alongside the layout move (config → `sandcastle/`, old `.sandcastle/` state →
`.sandcastle.local/`, `.gitignore`), `migrate` does the two gateway-coupled parts:

- **Folds `orchestrator.env` into the gateway host config.** The host-only keys from
  the project's old `orchestrator.env` — including `GIT_CONFIG_GLOBAL` — are merged
  into `~/.config/sandcastle/gateway.env`, the env the gateway service sources. The
  fold is non-clobbering: a key already present with the **same** value is a no-op
  (re-running `migrate` changes nothing), and a key present with a **different**
  value is refused as a conflict rather than overwritten — so a second project's
  secret never silently clobbers the first's.
- **Rewrites the systemd unit into the host-level gateway service.** The unit at
  `~/.config/systemd/user/sandcastle-dispatch.service` is rewritten from a
  per-project `dispatch` poller (bound to one `WorkingDirectory`, running
  `dispatch`) into the host-level gateway: no `WorkingDirectory`, sourcing
  `gateway.env`, `exec`ing `sandcastle-tdd gateway`. The file keeps its
  `sandcastle-dispatch.service` name, so `systemctl --user restart
  sandcastle-dispatch` still drives it.

After applying, reload and restart:

```bash
systemctl --user daemon-reload
systemctl --user restart sandcastle-dispatch
```

Do not run `dispatch` and the gateway at once — two consumers of one bot fight over
its updates, and `dispatch` is retired.

## 5. Verification

**Prove the credentials round-trip** with `tg-test`. It reads
`SANDCASTLE_TELEGRAM_BOT_TOKEN` / `SANDCASTLE_TELEGRAM_CHAT_ID` from the
orchestrator's **own** environment, so source the project's `orchestrator.env`
first (the gateway itself reads them from the base location, but `tg-test` is a
standalone check):

```bash
set -a; source .sandcastle.local/orchestrator.env; set +a
npx sandcastle-tdd tg-test
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
  a systemd service these go to `journalctl --user -u sandcastle-dispatch`.
- Each outbox record file under `.sandcastle.local/outbox/<id>.json` gains a
  `sentAt` timestamp (and the `destination` it resolved to) once routed — that stamp
  is the idempotence marker, so a restart neither re-sends nor drops it. A record
  still missing `sentAt` after a tick has not been sent: check the project has
  credentials (a connection) and that the gateway is up.

Once a run is fully idle, its already-sent outbox records are cleared as part of
archiving; a record left **unsent** is deliberately kept so a message emitted while
the gateway was down is still sent when it comes back.
