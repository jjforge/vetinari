/**
 * The single source of truth for the CLI's public mode list. `--help` (the
 * `USAGE` in `cli.mts`) is rendered from `MODES` by `renderUsage`, and a doc test
 * (`help.test.ts`) cross-checks the README "## Modes" table against the same list
 * — so the two hand-maintained command references an agent reads (README in its
 * worktree, `--help` on the host) can no longer drift apart (issue #167). Add,
 * remove or rename a mode here and both surfaces move together, or the gate fails.
 *
 * Each entry is one row: `signature` is the exact invocation shown as the mode's
 * heading and — verbatim — the README table's first column; `blurb` is the gloss
 * `--help` prints under it. The README keeps its own richer per-row prose; only
 * the set of signatures is pinned across the two.
 */
export interface Mode {
  /** The exact invocation, e.g. `campaign --resume`. Matched against the README. */
  signature: string;
  /** The one-line-ish gloss `--help` renders; word-wrapped by `renderUsage`. */
  blurb: string;
}

export const MODES: Mode[] = [
  {
    signature: "build [--no-baseline]",
    blurb:
      "build the agent image (cfg.image from vetinari/Dockerfile, neither repeated on the CLI) via sandcastle, then run baseline on success. --no-baseline builds only. A build or baseline failure exits non-zero with sandcastle's output shown",
  },
  {
    signature: "baseline",
    blurb: "prove the image runs every gate green — no agent, no cost",
  },
  {
    signature: "run <task> [--agent <name>] [--model <m>] [--effort <e>]",
    blurb:
      "the TDD loop: agent turn → gate → resume on red. --agent picks the provider (claude | pi | codex, default claude or cfg.agent.provider; copilot | cursor | opencode are experimental — non-resumable, so a parked question needs postComment to be answered); --model/--effort override that provider's defaults, effort in the provider's own vocabulary. A bad provider/effort or missing provider credentials fails fast before the container (ADR 0016). --json streams the raw event log to stdout for tooling; without it the terminal shows human-readable lines only and no JSON reaches stdout (design §11)",
  },
  {
    signature:
      'campaign [--dry-run] [--override] [--name "…"] [--auto-prune] [--agent <name>] <ids-or-labels…>',
    blurb:
      "select issues, plan them into dependency-ordered file-disjoint waves, then run them (queue a wave, merge greens → gate base → next). A numeric token is an issue id; a NON-numeric token is a label expanded to the open issues carrying it (needs a listByLabel resolver — githubIssuesByLabel(repo) — else a label fails fast). --dry-run plans only, printing the wave plan + provenance + suggested --name and running nothing (this replaces the old campaign-plan). --override skips the planner and runs each positional as one literal wave (labels inside still expand). --on-underspecified=drop|fail pre-decides the planner's not-confident halt for non-interactive runs. --name labels the run; --agent (with --model/--effort) selects the provider for the whole campaign and every child wave (claude | pi | codex; copilot | cursor | opencode experimental; ADR 0016). If a merge-conflict quarantine strands dependents in later waves the campaign pauses for a human by default; --auto-prune prunes the stranded closure and runs on (ADR 0013). The terminal shows human-readable lines — the plan, per-wave progress, the one-line stop reason and the exact recovery command; --json streams the raw event log to stdout for tooling instead, and without it no JSON reaches stdout (design §11)",
  },
  {
    signature: "redrive",
    blurb:
      "pick an unfinished campaign back up on the current base — the umbrella verb (ADR 0020): reconstructs the plan from the event log and re-enters the first wave that did not close, reconciling it before running (design §7) — a green-but-unmerged member is integrated without a rerun, an answered park (its record gone) re-runs, an unresolved park re-parks the wave, and a failed member stops the campaign as failed again unless --override re-runs it. Redoes no already-merged issue. Takes no issue args; use it after a prune, graft, fix-forward, crash, or failure. Nothing left to run reports so and exits clean (`campaign --resume` is a one-release alias). --json streams the raw event log to stdout for tooling; without it the terminal shows human-readable lines only (design §11)",
  },
  {
    signature: "prune <issue>",
    blurb:
      "prune <issue> + everything blocked by it from the RUNNING campaign: appends a prune event the loop honors at the next wave boundary (the in-flight wave finishes; only future waves shrink). Banked work stays — a merged/green member is kept, only parked/not-yet-started ones leave. A pruned issue's parked record (branch/worktree/session) is preserved so it stays resumable; --purge is the rare true-drop that clears it. Needs a running campaign (--dry-run to only preview).",
  },
  {
    signature: "graft <ids…>",
    blurb:
      "add issues to a RUNNING (or paused/wave-parked/resumable) campaign — the additive mirror of prune (ADR 0014): appends a graft event the loop honors at the next wave boundary. The in-flight wave finishes untouched; the added issues re-layer into future waves (after their blockers, basename-disjoint), leaving already-planned waves stable. Rejected whole — naming the offenders — if any id is unknown/closed or already in the campaign. Needs a campaign that has not finished (--dry-run to only print the resulting placement).",
  },
  {
    signature: "init [--dry-run]",
    blurb:
      "scaffold a NEW project onto the layout: create the committed vetinari/ (a defineConfig skeleton + a Dockerfile template), the excluded .vetinari.local/, and add .vetinari.local/ to .gitignore. Idempotent and non-clobbering — an existing vetinari/ config is never overwritten (--dry-run to print the plan and write nothing). Installs and vendors nothing",
  },
  {
    signature: "migrate [--dry-run]",
    blurb:
      "move this project onto the vetinari/ + .vetinari.local/ layout: config → vetinari/, old .sandcastle/ state → .vetinari.local/, .gitignore updated, and the host-side orchestrator.env renamed to host.env. A one-time layout move — it carries no other rename shims (--dry-run to print the plan and change nothing)",
  },
  {
    signature: 'changelog collect [--title "…"]',
    blurb:
      'fold this repo\'s changelog.d/*.md fragments into CHANGELOG.md under today\'s milestone (append to the top milestone if it is dated today, else start one), then delete the consumed fragments. What the orchestrator runs per wave at merge; a human may run it directly. --title sets a fresh milestone\'s title (default: "Collected changes")',
  },
  {
    signature: "tidy [--apply] [--all]",
    blurb:
      "reconcile the drift a by-hand fix-forward or merge leaks (ADR 0013): fold orphaned changelog.d/ fragments whose issue is merged, GC agent/<id> branches + worktrees that are PROVABLY reachable from the base, and clear parked records for issues now merged. Never touches an unmerged, quarantined, parked, or wave-parked branch. Dry-run by default (prints what it would do); --apply acts. --all sweeps every registered project, not just this one, and drops duplicate-projectRoot registry pointers (keeping the canonical .vetinari.local one)",
  },
  {
    signature: "answer <task> <text>",
    blurb: "resume a parked task with a human answer",
  },
  {
    signature: "gateway",
    blurb:
      "the host daemon fronting every registered project: the sole Telegram consumer and sender — announces parked questions, routes replies to the right project+task, and resumes them concurrently via the shared install. Also recognizes `prune <issue>` (and `prune <project> <issue>` when several campaigns run on one bot): previews the closure and prunes the resolved project on a `yes` reply to the preview",
  },
  {
    signature: "gateway install [--dry-run]",
    blurb:
      "write the host-level systemd unit for THIS install to ~/.config/systemd/user/vetinari-gateway.service, with a fully absolute node + tsx-loader + cli ExecStart — no bash -lc, env, npx, or PATH dependency, so it starts under systemd's clean environment (fixes the nvm/fnm/mise/asdf crash-loop). Re-run after a node/tsx upgrade (--dry-run to print the unit and write nothing)",
  },
  {
    signature: "gateway status",
    blurb:
      "show whether the host gateway service is running — wraps `systemctl --user status vetinari-gateway --no-pager` and propagates its exit code. A missing/uninstalled service (or absent systemctl) points you at `gateway install` rather than a raw failure",
  },
  {
    signature: "gateway start",
    blurb: "start the host gateway service — `systemctl --user start vetinari-gateway` (the unit `gateway install` wrote)",
  },
  {
    signature: "gateway stop",
    blurb: "stop the host gateway service — `systemctl --user stop vetinari-gateway`",
  },
  {
    signature: "gateway restart",
    blurb:
      "restart the host gateway service so it serves the current code (tsx compiles at startup, so a restart is how merged changes go live) — `systemctl --user restart vetinari-gateway`, then reports is-active",
  },
  {
    signature: "host log [-n <count>] [--tail] [--json]",
    blurb:
      "read the persistent host log (<gatewayConfigDir>/logs/host.jsonl) at the terminal — the host/gateway diagnostics that land nowhere a per-project feed shows. Prints the most recent events newest-first, one human-readable line each; -n bounds the window (default 50). --json passes the raw JSONL through untouched (for jq/grep); --tail (or -f) follows live, printing new events as they append. Reads the file directly, so no daemon need be running — a missing host.jsonl prints \"no host log yet\" and exits clean",
  },
  {
    signature: "parked",
    blurb: "list parked tasks and their questions",
  },
  {
    signature: "clear",
    blurb:
      "archive the run log + clear parked, resetting the dashboard/status line to idle (automatic on clean campaign completion; this forces it now)",
  },
  {
    signature: "status [--port <port>] [--host <host>]",
    blurb:
      "one dashboard over the host registry: campaign/wave and parked status for every registered project, a dropdown to switch between them (a single project is one entry). Reads the registry, so no gateway daemon is required",
  },
  {
    signature: "registry remove <name>",
    blurb:
      "remove one project's pointer from the host registry, so the dashboard stops listing it (the explicit counterpart to the auto-register every run performs — not container slots). A name that is not registered is a clean no-op",
  },
  {
    signature: "statusline",
    blurb:
      "one compact line for the Claude Code status bar (reads Claude Code's JSON on stdin; wire into settings.json)",
  },
  {
    signature: 'statusline install [--run-command "<cmd>"] [--dry-run]',
    blurb:
      "wire the status line into the project's committed .claude/settings.json. A status line already configured there is kept as line 1 with the 🏰 campaign line added under it (never replaced). Idempotent. --run-command sets how the CLI is invoked (default: npx vetinari statusline)",
  },
  {
    signature: "statusline uninstall [--dry-run]",
    blurb: "remove it, restoring whatever status line it wrapped",
  },
  {
    signature: "tg-test",
    blurb: "prove the Telegram round-trip",
  },
];

/**
 * Marker comments bracketing the generated modes table inside `docs/reference.md`.
 * `scripts/gen-reference.ts` rewrites the region between them from `MODES`, and
 * `help.test.ts` pins the region on disk to `renderModesReference()` — so the
 * reference's mode list is generated, never hand-kept, and the drift test that
 * once guarded the README "## Modes" table now guards this section (design §13.3).
 */
export const MODES_REFERENCE_BEGIN =
  "<!-- BEGIN GENERATED MODES — from src/help.ts (MODES); regenerate with `npm run gen-reference`, do not hand-edit -->";
export const MODES_REFERENCE_END = "<!-- END GENERATED MODES -->";

/** Escape the markdown-table cell delimiter so a blurb's `a | b` keeps its cell. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/**
 * Render the `docs/reference.md` "CLI modes" table from `MODES`, wrapped in the
 * marker comments so the generator can rewrite exactly this block. Each row is
 * `| \`signature\` | blurb |`, the blurb the same gloss `--help` shows, with its
 * pipes escaped so the table survives.
 */
export function renderModesReference(): string {
  const rows = MODES.map(
    (m) => `| \`${m.signature}\` | ${escapeCell(m.blurb)} |`,
  ).join("\n");
  return `${MODES_REFERENCE_BEGIN}
| Mode | What it does |
| --- | --- |
${rows}
${MODES_REFERENCE_END}`;
}

/** The heading `--help` opens with. */
const HEADER = "vetinari <mode> [args]";

/**
 * The fixed footer under the mode list: the global `--config` option and the
 * host-ceiling note, neither of which is a mode.
 */
const FOOTER = `Options: --config <path>   (default: vetinari/config.mts in cwd)

Host container ceiling: set MAX_CONCURRENT_CONTAINERS (or a max-concurrent-containers
file in the gateway config dir) to cap live containers across ALL projects; every
campaign cooperates through a filesystem lease to stay within it. Unset resolves
to a machine-derived default (never unbounded). There is no per-run cap: a lone project
fills the ceiling. A project's cut when projects contend is its \`containerShare\`
(high | medium | low, default medium). See ADR 0010 and ADR 0011.`;

/** Where a mode's blurb starts, in columns (2-space indent + padded signature). */
const GUTTER = 27;
/** The right margin blurb text wraps at. */
const WIDTH = 90;

/** Greedy word-wrap `text` to `width` columns. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/)) {
    if (cur && (cur + " " + word).length > width) {
      lines.push(cur);
      cur = word;
    } else {
      cur = cur ? cur + " " + word : word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Render the `USAGE` text `cli.mts` prints for `--help` (and on an unknown mode)
 * from `MODES`: each mode's signature, then its blurb wrapped into the gutter. A
 * signature that fits before the gutter shares its first blurb line; a longer one
 * takes its own line with the blurb starting underneath.
 */
export function renderUsage(): string {
  const pad = " ".repeat(GUTTER);
  const body = MODES.map((m) => {
    const blurb = wrap(m.blurb, WIDTH - GUTTER);
    const head = "  " + m.signature;
    if (head.length < GUTTER) {
      const first = head.padEnd(GUTTER) + blurb[0];
      return [first, ...blurb.slice(1).map((l) => pad + l)].join("\n");
    }
    return [head, ...blurb.map((l) => pad + l)].join("\n");
  }).join("\n");
  return `${HEADER}\n\n${body}\n\n${FOOTER}`;
}
