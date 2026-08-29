/**
 * Service-lifecycle control for the host gateway's systemd user unit —
 * `vetinari gateway status|start|stop|restart`. The verb→`systemctl` argv
 * mapping is a pure seam (`gatewayServiceArgv`) so it is unit-tested without
 * shelling systemctl; `runGatewayService` is the thin decision over an injected
 * IO (spawn + unit-file probe), so its exit-code propagation and its
 * uninstalled/absent-systemctl fallbacks are testable without a real service.
 *
 * This wraps the existing `vetinari-gateway.service` USER unit only (the one
 * `gateway install` writes); managing a `--system` unit or a non-systemd host is
 * out of scope.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { systemdUnitPath } from "./migrate.ts";

/** The systemd user unit the gateway runs as; `systemctl` accepts the bare name. */
export const GATEWAY_UNIT = "vetinari-gateway";

/** The lifecycle verbs `vetinari gateway <verb>` exposes. */
export type GatewayServiceVerb = "status" | "start" | "stop" | "restart";

const GATEWAY_SERVICE_VERBS: GatewayServiceVerb[] = ["status", "start", "stop", "restart"];

/** Whether a raw CLI token is one of the four exposed lifecycle verbs. */
export const isGatewayServiceVerb = (token: string): token is GatewayServiceVerb =>
  (GATEWAY_SERVICE_VERBS as string[]).includes(token);

/**
 * The `systemctl` argv for one command against the gateway unit: always `--user
 * <command> vetinari-gateway`. `status` adds `--no-pager` so it prints a single
 * block and returns instead of opening a pager. General over the command token
 * (not just the four verbs) so `restart`'s `is-active` follow-up shares it; the
 * CLI restricts the exposed set via `isGatewayServiceVerb`.
 */
export function gatewayServiceArgv(command: string): string[] {
  const argv = ["--user", command, GATEWAY_UNIT];
  if (command === "status") argv.push("--no-pager");
  return argv;
}

/**
 * One `systemctl` invocation's outcome: its exit `code` (null when it never ran
 * because the binary is absent), and the `spawnError` in that case — so the
 * caller can tell "systemctl reported a non-zero" (a real service state) from
 * "systemctl isn't here at all".
 */
export interface RunResult {
  code: number | null;
  spawnError?: NodeJS.ErrnoException;
}

/** The one-line logs pointer appended to every composed success/no-op message. */
const logsHint = `logs: journalctl --user -u ${GATEWAY_UNIT}`;

/**
 * The effects service control needs, injected so `runGatewayService` stays a pure
 * decision: whether the unit file exists (the "installed?" probe), one `systemctl`
 * run (stdio inherited, so the verb's own output reaches the user), a `probe` run
 * (stdio NOT inherited, so an `is-active` token never leaks onto the terminal
 * beside the composed message), and `log` for the composed line itself (stdout).
 */
export interface GatewayServiceIO {
  unitExists: () => boolean;
  run: (argv: string[]) => Promise<RunResult>;
  probe: (argv: string[]) => Promise<RunResult>;
  log: (line: string) => void;
}

/**
 * Compose the single line each verb prints on success. `wasActive`/`nowActive` are
 * `undefined` when their `is-active` probe couldn't run (spawn error) — messaging
 * then falls back to a plain action confirmation rather than claiming a state it
 * couldn't read. The honest "came up not active" variants already point at
 * journalctl themselves, so they carry no separate hint.
 */
export function gatewayServiceMessage(
  verb: GatewayServiceVerb,
  wasActive: boolean | undefined,
  nowActive: boolean | undefined,
): string {
  const withHint = (line: string) => `${line}\n${logsHint}`;
  const notActive = (past: string) =>
    `${past} ${GATEWAY_UNIT} — but it is not active; see journalctl --user -u ${GATEWAY_UNIT}`;
  switch (verb) {
    case "start":
      if (wasActive === true) return withHint(`${GATEWAY_UNIT} was already running — nothing to do.`);
      if (nowActive === false) return notActive("started");
      if (nowActive === true) return withHint(`started ${GATEWAY_UNIT} — now active.`);
      return withHint(`started ${GATEWAY_UNIT}.`);
    case "stop":
      if (wasActive === false) return withHint(`${GATEWAY_UNIT} wasn't running — nothing to do.`);
      if (wasActive === true) return withHint(`stopped ${GATEWAY_UNIT} — now inactive.`);
      return withHint(`stopped ${GATEWAY_UNIT}.`);
    case "restart":
      if (nowActive === false) return notActive("restarted");
      if (nowActive === true) return withHint(`restarted ${GATEWAY_UNIT} — now active.`);
      return withHint(`restarted ${GATEWAY_UNIT}.`);
    default:
      return "";
  }
}

/** Print the "systemctl couldn't run at all" pointer and yield the failure code. */
function reportSystemctlUnavailable(err: NodeJS.ErrnoException): number {
  console.error(
    `Couldn't run systemctl (${err.code ?? err.message}). ` +
      `The gateway service needs a systemd user session — see \`vetinari gateway install\`.`,
  );
  return 1;
}

/**
 * Read the unit's active state via a captured `is-active` probe. Returns `true`
 * when active, `false` when not, and `undefined` when the probe itself couldn't
 * run (spawn error) — the caller then messages honestly without a state it never
 * read. Stdio is captured (not inherited) so the raw `active`/`inactive` token
 * never leaks onto the terminal beside the composed line.
 */
async function probeActive(io: GatewayServiceIO): Promise<boolean | undefined> {
  const r = await io.probe(gatewayServiceArgv("is-active"));
  if (r.spawnError) return undefined;
  return r.code === 0;
}

/**
 * Drive one lifecycle verb against the gateway unit, print what it did and the
 * resulting state, and return the exit code the CLI should exit with. Pre-flights
 * the installed check so an uninstalled unit (or absent systemctl) yields a clear
 * pointer to `vetinari gateway install` rather than systemctl's raw failure.
 *
 * `status` delegates wholly to systemctl's own output. `start`/`stop` first probe
 * `is-active` so a silent systemctl no-op ("already running" / "wasn't running")
 * still reports what changed; `start`/`restart` then confirm the RESULTING state.
 * The messaging probes never alter the outcome: every path keeps the exit code it
 * had before — the verb's own code, and for a successful `restart` the follow-up
 * `is-active` code (a service that came back inactive is a non-zero exit).
 */
export async function runGatewayService(verb: GatewayServiceVerb, io: GatewayServiceIO): Promise<number> {
  if (!io.unitExists()) {
    console.error(
      `The ${GATEWAY_UNIT} service isn't installed. Run \`vetinari gateway install\` first (then \`systemctl --user daemon-reload\`).`,
    );
    return 1;
  }

  // `status` already prints its own block; compose nothing, just propagate its code.
  if (verb === "status") {
    const result = await io.run(gatewayServiceArgv("status"));
    if (result.spawnError) return reportSystemctlUnavailable(result.spawnError);
    return result.code ?? 1;
  }

  // "did X" vs "already was X" needs the prior state; only start/stop report a
  // no-op, so only they pre-probe. restart always cycles, so it skips this.
  const wasActive = verb === "restart" ? undefined : await probeActive(io);

  const result = await io.run(gatewayServiceArgv(verb));
  if (result.spawnError) return reportSystemctlUnavailable(result.spawnError);
  const code = result.code ?? 1;

  // A non-zero verb already surfaced systemctl's own failure on inherited stderr;
  // don't claim success over it.
  if (code !== 0) return code;

  // start/restart confirm the resulting state; that same is-active probe is also
  // restart's exit code. A start that was already up is a no-op and skips it.
  let nowActive: boolean | undefined;
  let probeCode: number | null = 0;
  if (verb === "restart" || (verb === "start" && wasActive !== true)) {
    const probe = await io.probe(gatewayServiceArgv("is-active"));
    probeCode = probe.spawnError ? null : probe.code;
    nowActive = probe.spawnError ? undefined : probe.code === 0;
  }

  io.log(gatewayServiceMessage(verb, wasActive, nowActive));

  // restart's exit code is the is-active code (1 if the probe couldn't run) —
  // unchanged from before; the other verbs keep the verb's own code.
  if (verb === "restart") return probeCode ?? 1;
  return code;
}

/** Spawn one real `systemctl` run, inheriting stdio so its output reaches the user. */
function spawnSystemctl(argv: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("systemctl", argv, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", (err) => resolve({ code: null, spawnError: err as NodeJS.ErrnoException }));
    child.on("exit", (code) => resolve({ code }));
  });
}

/**
 * Spawn one real `systemctl` probe with stdout captured (not inherited), so an
 * `is-active` token stays off the terminal; only its exit code is read.
 */
function probeSystemctl(argv: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("systemctl", argv, { stdio: ["ignore", "ignore", "ignore"] });
    child.on("error", (err) => resolve({ code: null, spawnError: err as NodeJS.ErrnoException }));
    child.on("exit", (code) => resolve({ code }));
  });
}

/** The live IO: the unit file `gateway install` writes, and real `systemctl` spawns. */
export function defaultGatewayServiceIO(): GatewayServiceIO {
  return {
    unitExists: () => existsSync(systemdUnitPath()),
    run: spawnSystemctl,
    probe: probeSystemctl,
    log: (line) => console.log(line),
  };
}
