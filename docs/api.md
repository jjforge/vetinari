# The external read API (`/api/v1/`)

A read-only HTTP API for an outside consumer — another agent, a script, a bot —
that wants to watch campaigns without scraping the dashboard. It is served by
both dashboards, `vetinari status` and the one the gateway hosts, on the same
port. The decision and its alternatives are recorded in
[ADR 0027](adr/0027-external-consumers-read-a-versioned-api-v1.md).

Three endpoints, all `GET`:

| Endpoint | Answers |
| --- | --- |
| `GET /api/v1/projects` | every registered project, with a one-line summary of its campaign |
| `GET /api/v1/campaign?project=<name>` | one project's campaign: its waves, their members, and its parked work |
| `GET /api/v1/events` | a Server-Sent Events doorbell that says which project changed |

Every other method on these paths answers `404`. There is no write route under
`/api/v1/`.

## Vocabulary

Every status and reason is the orchestrator's own enum value
([design §2](design.md#2-data-model)), never a dashboard display string.

| Type | Values |
| --- | --- |
| `CampaignState` | `unstarted`, `running`, `parked`, `completed`, `failed` |
| `WaveStatus` | `unstarted`, `running`, `parked`, `completed`, `failed` |
| `IssueStatus` | `unstarted`, `running`, `parked`, `completed`, `failed` |
| `Membership` | `member`, `grafted`, `pruned` |
| `ParkReason` | `question`, `stalled`, `conflict`, `red-base`, `crash`, `stopped`, `outdated-agent` |

Held work is one `parked` state at every level, with a `ParkReason` saying why
([ADR 0019](adr/0019-held-work-is-one-parked-state-at-every-level.md)).
`Membership` is a separate axis from the status: a `pruned` member has left the
plan but is still listed, and a `grafted` one was added to the running campaign.

**Every field below is always present.** An empty value is `null`, never a
missing key.

## `GET /api/v1/projects`

`200`, `content-type: application/json`:

```ts
interface V1Projects {
  projects: V1ProjectSummary[];
}
interface V1ProjectSummary {
  project: string; // the registry name — pass it to /api/v1/campaign
  repo: string | null; // the project's origin repo as owner/name, null when it has none
  campaign: {
    name: string | null; // the run's --name, null when unnamed
    status: CampaignState;
    issues: { unstarted: number; running: number; parked: number; completed: number; failed: number };
  };
}
```

`campaign` is always an object. A project with no campaign reads
`status: "unstarted"` with every count `0`. `issues` counts every member of the
live waves by its status, leaving `pruned` members out. A project whose base
location has gone (moved or deleted since it registered) is left out of the list.

## `GET /api/v1/campaign?project=<name>`

`200`, `content-type: application/json`:

```ts
interface V1Campaign {
  project: string;
  repo: string | null;
  name: string | null;
  status: CampaignState;
  waves: V1Wave[];
  parked: V1Parked[];
}
interface V1Wave {
  index: number; // the wave's number in the plan, from 0
  status: WaveStatus;
  reason: ParkReason | null; // the wave's own hold — red-base or stopped — else null
  members: V1Member[]; // in plan order, pruned members included
}
interface V1Member {
  issue: string; // the issue id
  status: IssueStatus;
  reason: ParkReason | null; // why it is parked, else null
  membership: Membership;
}
interface V1Parked {
  issue: string;
  reason: ParkReason;
  parkedAt: string; // ISO timestamp
  question: string; // what the agent asked, or why it stopped
}
```

- `waves` leaves out a wave whose every member was pruned, so `index` can skip a
  number where such a wave was.
- A wave can read `parked` with `reason: null`: then a member is held, and the
  member carries the reason.
- `parked` lists the parked records waiting on a person, in order. A park can
  outlive its log (the run was archived), so `parked` can be non-empty while
  `waves` is empty.
- `status` is the fold of the waves (`failed` over `parked` over `running`, then
  `completed` when every wave completed, else `unstarted`), except that a
  non-empty `parked` list makes a `running`, `completed` or `unstarted` campaign
  read `parked`. A `failed` campaign stays `failed`.

`404` with the body `not found` when `project` is missing, names no registered
project, or names one whose base location has gone. The name is matched exactly
against the registry.

## `GET /api/v1/events` — the doorbell

A `text/event-stream` that says *which* project changed, never *what* changed.
Every frame is an unnamed `data:` frame; there are no named (`event:`) frames.

1. On connect: `retry: 3000`, then exactly one frame
   `data: {"project":null}` — **re-fetch everything**. It also arrives on every
   reconnect, so a consumer that missed changes while disconnected catches up.
2. After that: `data: {"project":"<name>"}` — **re-fetch that project's
   `/api/v1/campaign`**. One frame per project per debounce window (about
   300 ms) in which its live log gained an event that changes what a view shows;
   pure machine noise rings nothing.

The stream carries no state of its own: the endpoints above are the truth, and a
frame only says when to read them. The live-update connections of a dashboard
are capped (16 at once, shared with the dashboard's own stream); past the cap a
connection is refused with `503`.

A consumer loop:

```text
connect to /api/v1/events
on {"project":null}: GET /api/v1/projects, then GET /api/v1/campaign for each project
on {"project":"<name>"}: GET /api/v1/campaign?project=<name>
```

## Compatibility promise

- **Versioning is by path prefix.** This is `v1`.
- **Within v1, changes are additive only:** a new field, a new endpoint, or a new
  enum value — the last only when the orchestrator's own enum gains one. A
  consumer should ignore fields it does not know and tolerate enum values it does
  not know.
- **Renaming or removing a field, or changing its type or meaning, needs
  `/api/v2/`.**
- The contract is enforced by a test (`src/dashboard-route-api-v1.test.ts`) that
  pins every shape against a literal, so a breaking change fails the build.
- **The dashboard's own `/api/*` routes are not covered.** `/api/status`,
  `/api/events` and the rest are built for the web UI and change with it, without
  notice.

## Access

The API inherits the dashboard's posture
([ADR 0021](adr/0021-dashboard-is-unauthenticated-private-network-only.md),
[operations: Exposing the dashboard](operations.md#exposing-the-dashboard)):

- **Unauthenticated, private network only.** There is no token or login. Reach it
  on loopback, over a private overlay network (Tailscale, WireGuard), or behind an
  authenticating reverse proxy you run.
- **A script passes the Origin check.** curl and scripts send no `Origin`, and a
  request with none is admitted.
- **A DNS name must be allowlisted.** A request under a `Host` that is a DNS name
  other than `localhost` (a MagicDNS name, a proxy's name) is refused with `403`
  unless the name is in `VETINARI_STATUS_ALLOWED_HOSTS`. An IP literal needs
  nothing.
- **Agent containers are refused.** A client inside the Docker network the agent
  containers run on gets `403`, whatever its headers.
