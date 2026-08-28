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

/**
 * The two effects service control needs, injected so `runGatewayService` stays a
 * pure decision: whether the unit file exists (the "installed?" probe) and one
 * `systemctl` run (stdio inherited, so its own output reaches the user).
 */
export interface GatewayServiceIO {
  unitExists: () => boolean;
  run: (argv: string[]) => Promise<RunResult>;
}

/**
 * Drive one lifecycle verb against the gateway unit and return the exit code the
 * CLI should exit with. Pre-flights the installed check so an uninstalled unit
 * (or absent systemctl) yields a clear pointer to `vetinari gateway install`
 * rather than systemctl's raw failure. Otherwise it shells the verb and
 * propagates systemctl's own exit code — so scripts can rely on it — and
 * `restart`, once it succeeds, probes `is-active` and returns THAT code, mirroring
 * the retired `make gateway-restart` (a service that came back inactive is a
 * non-zero exit).
 */
export async function runGatewayService(verb: GatewayServiceVerb, io: GatewayServiceIO): Promise<number> {
  if (!io.unitExists()) {
    console.error(
      `The ${GATEWAY_UNIT} service isn't installed. Run \`vetinari gateway install\` first (then \`systemctl --user daemon-reload\`).`,
    );
    return 1;
  }
  const result = await io.run(gatewayServiceArgv(verb));
  if (result.spawnError) {
    console.error(
      `Couldn't run systemctl (${result.spawnError.code ?? result.spawnError.message}). ` +
        `The gateway service needs a systemd user session — see \`vetinari gateway install\`.`,
    );
    return 1;
  }
  const code = result.code ?? 1;
  if (verb === "restart" && code === 0) {
    const active = await io.run(gatewayServiceArgv("is-active"));
    if (active.spawnError) return 1;
    return active.code ?? 1;
  }
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

/** The live IO: the unit file `gateway install` writes, and a real `systemctl` spawn. */
export function defaultGatewayServiceIO(): GatewayServiceIO {
  return { unitExists: () => existsSync(systemdUnitPath()), run: spawnSystemctl };
}
