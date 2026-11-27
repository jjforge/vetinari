/**
 * Service-lifecycle control for the host gateway — `vetinari gateway
 * status|start|stop|restart` — over the host's service manager: the systemd user
 * unit on Linux, the launchd LaunchAgent on macOS (both written by `gateway
 * install`). Each manager's verb→argv mapping is a pure seam (`ServiceManager`) so
 * it is unit-tested without shelling the tool; `runGatewayService` is the thin
 * decision over an injected IO (spawn + installed probe), so its exit-code
 * propagation and its uninstalled/absent-tool fallbacks are testable without a
 * real service.
 *
 * This wraps the USER-level service only (the one `gateway install` writes);
 * managing a `--system` unit or a LaunchDaemon is out of scope.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { gatewayLogPath, launchAgentPath, systemdUnitPath } from "./migrate.ts";

/** The systemd user unit the gateway runs as; `systemctl` accepts the bare name. */
export const GATEWAY_UNIT = "vetinari-gateway";

/** The lifecycle verbs `vetinari gateway <verb>` exposes. */
export type GatewayServiceVerb = "status" | "start" | "stop" | "restart";

const GATEWAY_SERVICE_VERBS: GatewayServiceVerb[] = ["status", "start", "stop", "restart"];

/** Whether a raw CLI token is one of the four exposed lifecycle verbs. */
export const isGatewayServiceVerb = (token: string): token is GatewayServiceVerb => (GATEWAY_SERVICE_VERBS as string[]).includes(token);

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
 * One host service manager the gateway runs under: the `tool` it shells, its argv
 * for each command (the four verbs plus the `is-active` probe — exit 0 when the
 * service is up), where to read the gateway's logs, and what to run after
 * `gateway install` for the service to exist.
 */
export interface ServiceManager {
  tool: string;
  argv: (command: GatewayServiceVerb | "is-active") => string[];
  logs: string;
  afterInstall: string;
}

/** The systemd user unit (Linux). */
export const systemdManager: ServiceManager = {
  tool: "systemctl",
  argv: gatewayServiceArgv,
  logs: `journalctl --user -u ${GATEWAY_UNIT}`,
  afterInstall: " (then `systemctl --user daemon-reload`)",
};

/**
 * The launchd LaunchAgent (macOS), in the user's GUI domain `gui/<uid>`, labelled
 * like the systemd unit. `bootstrap` loads and starts the agent's plist, `bootout`
 * stops and unloads it, `kickstart -k` restarts it, and `print` both shows it and is
 * the probe: it exits 0 only while the agent is loaded (`KeepAlive` keeps a loaded
 * agent running).
 */
export function launchdManager(uid: number, plistPath: string, logPath: string): ServiceManager {
  const target = `gui/${uid}/${GATEWAY_UNIT}`;
  const argv = (command: GatewayServiceVerb | "is-active"): string[] => {
    switch (command) {
      case "start":
        return ["bootstrap", `gui/${uid}`, plistPath];
      case "stop":
        return ["bootout", target];
      case "restart":
        return ["kickstart", "-k", target];
      default:
        return ["print", target];
    }
  };
  return { tool: "launchctl", argv, logs: logPath, afterInstall: "" };
}

/** This host's service manager: launchd on macOS, systemd everywhere else. */
export function hostServiceManager(platform: string = process.platform): ServiceManager {
  return platform === "darwin" ? launchdManager(process.getuid?.() ?? 0, launchAgentPath(), gatewayLogPath()) : systemdManager;
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
  logs: string = systemdManager.logs,
): string {
  const withHint = (line: string) => `${line}\nlogs: ${logs}`;
  const notActive = (past: string) => `${past} ${GATEWAY_UNIT} — but it is not active; see ${logs}`;
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

/** Print the "the service tool couldn't run at all" pointer and yield the failure code. */
function reportToolUnavailable(manager: ServiceManager, err: NodeJS.ErrnoException): number {
  console.error(
    `Couldn't run ${manager.tool} (${err.code ?? err.message}). ` +
      `The gateway service needs a ${manager.tool === "systemctl" ? "systemd user session" : "launchd user session"} — see \`vetinari gateway install\`.`,
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
async function probeActive(io: GatewayServiceIO, manager: ServiceManager): Promise<boolean | undefined> {
  const r = await io.probe(manager.argv("is-active"));
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
export async function runGatewayService(
  verb: GatewayServiceVerb,
  io: GatewayServiceIO,
  manager: ServiceManager = systemdManager,
): Promise<number> {
  if (!io.unitExists()) {
    console.error(`The ${GATEWAY_UNIT} service isn't installed. Run \`vetinari gateway install\` first${manager.afterInstall}.`);
    return 1;
  }

  // `status` already prints its own block; compose nothing, just propagate its code.
  if (verb === "status") {
    const result = await io.run(manager.argv("status"));
    if (result.spawnError) return reportToolUnavailable(manager, result.spawnError);
    return result.code ?? 1;
  }

  // "did X" vs "already was X" needs the prior state; only start/stop report a
  // no-op, so only they pre-probe. restart always cycles, so it skips this.
  const wasActive = verb === "restart" ? undefined : await probeActive(io, manager);

  // A no-op is reported without running the verb: launchctl fails `bootstrap` on a loaded
  // agent and `bootout` on an unloaded one, where systemctl would silently succeed.
  if ((verb === "start" && wasActive === true) || (verb === "stop" && wasActive === false)) {
    io.log(gatewayServiceMessage(verb, wasActive, undefined, manager.logs));
    return 0;
  }

  const result = await io.run(manager.argv(verb));
  if (result.spawnError) return reportToolUnavailable(manager, result.spawnError);
  const code = result.code ?? 1;

  // A non-zero verb already surfaced systemctl's own failure on inherited stderr;
  // don't claim success over it.
  if (code !== 0) return code;

  // start/restart confirm the resulting state; that same is-active probe is also
  // restart's exit code. A start that was already up is a no-op and skips it.
  let nowActive: boolean | undefined;
  let probeCode: number | null = 0;
  if (verb === "restart" || (verb === "start" && wasActive !== true)) {
    const probe = await io.probe(manager.argv("is-active"));
    probeCode = probe.spawnError ? null : probe.code;
    nowActive = probe.spawnError ? undefined : probe.code === 0;
  }

  io.log(gatewayServiceMessage(verb, wasActive, nowActive, manager.logs));

  // restart's exit code is the is-active code (1 if the probe couldn't run) —
  // unchanged from before; the other verbs keep the verb's own code.
  if (verb === "restart") return probeCode ?? 1;
  return code;
}

/** Spawn one real service-tool run, inheriting stdio so its output reaches the user. */
function spawnTool(tool: string, argv: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(tool, argv, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", (err) => resolve({ code: null, spawnError: err as NodeJS.ErrnoException }));
    child.on("exit", (code) => resolve({ code }));
  });
}

/**
 * Spawn one real service-tool probe with its output discarded, so an `is-active`
 * token (or launchctl's `print` block) stays off the terminal; only its exit code is read.
 */
function probeTool(tool: string, argv: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(tool, argv, { stdio: ["ignore", "ignore", "ignore"] });
    child.on("error", (err) => resolve({ code: null, spawnError: err as NodeJS.ErrnoException }));
    child.on("exit", (code) => resolve({ code }));
  });
}

/** The live IO: the unit or plist `gateway install` writes on this host, and real spawns of its tool. */
export function defaultGatewayServiceIO(manager: ServiceManager, platform: string = process.platform): GatewayServiceIO {
  return {
    unitExists: () => existsSync(platform === "darwin" ? launchAgentPath() : systemdUnitPath()),
    run: (argv) => spawnTool(manager.tool, argv),
    probe: (argv) => probeTool(manager.tool, argv),
    log: (line) => console.log(line),
  };
}
