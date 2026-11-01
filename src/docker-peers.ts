import { execFile } from "node:child_process";
import { BlockList, isIP } from "node:net";
import type { Logger } from "./log.ts";

/** The one-line 403 body for a request from an agent containers' Docker network. */
export const DOCKER_PEER_REFUSAL = "request from a Docker network refused (agent containers may not use the dashboard)";

/**
 * The dashboard's guard against agent containers (ADR 0021): a prompt-injected agent is a script,
 * so it can forge Host and Origin — what it cannot forge is the address it connects from. Returns
 * the 403 body when `remoteAddress` falls inside any of `subnets` (CIDR strings, IPv4 or IPv6; an
 * IPv4-mapped `::ffff:` address matches its IPv4 subnet), or null to admit it. Pure.
 */
export function dockerPeerDenial(remoteAddress: string | undefined, subnets: string[]): string | null {
  if (!remoteAddress || subnets.length === 0) return null;
  const blocked = new BlockList();
  for (const cidr of subnets) {
    const [net, prefix] = cidr.split("/");
    const family = isIP(net);
    if (family === 0 || !/^\d+$/.test(prefix ?? "")) continue;
    blocked.addSubnet(net, Number(prefix), family === 4 ? "ipv4" : "ipv6");
  }
  const family = isIP(remoteAddress);
  if (family === 0) return null;
  return blocked.check(remoteAddress, family === 4 ? "ipv4" : "ipv6") ? DOCKER_PEER_REFUSAL : null;
}

/** Lists the CIDR subnets whose peers are refused; rejects when they cannot be listed. */
export type DockerSubnetLister = () => Promise<string[]>;

/**
 * The Docker networks agent containers run on: only the default `bridge`, since vetinari never
 * passes a `network` to sandcastle. A user-defined network — an operator's authenticating reverse
 * proxy or a sidecar — is deliberately not refused (ADR 0021). Give sandcastle a network, add it here.
 */
export const AGENT_CONTAINER_NETWORKS = ["bridge"];

/**
 * The subnets (IPv4 and IPv6) of `AGENT_CONTAINER_NETWORKS`, by `docker network inspect`. Rejects
 * when they cannot be listed — no `docker` on PATH, daemon down, a failed or timed-out command — so
 * the watcher filters nothing and proceeds, as `readMountParentOwners` does.
 */
export function listDockerBridgeSubnets(docker = "docker", timeoutMs = 5_000): Promise<string[]> {
  const args = ["network", "inspect", "--format", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", ...AGENT_CONTAINER_NETWORKS];
  return new Promise((resolve, reject) => {
    execFile(docker, args, { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.split(/\s+/).filter(Boolean));
    });
  });
}

/** The latest listed subnets, kept fresh until `stop`. */
export interface DockerPeerWatch {
  subnets(): string[];
  stop(): void;
}

/** `list()`, or a rejection once `timeoutMs` passes first. */
async function listWithin(list: DockerSubnetLister, timeoutMs: number): Promise<string[]> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([list(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Take the first listing — awaited, so no request is served unchecked — then re-list every
 * `intervalMs` on an `unref`'d timer that `stop` clears; a request never waits on a refresh, it
 * reads the latest list. A listing that fails or times out filters nothing (the dashboard keeps
 * working), logging one `dashboard-docker-peers-unavailable` warning per failure streak.
 */
export async function watchDockerPeerSubnets(
  list: DockerSubnetLister,
  opts: { intervalMs: number; timeoutMs: number; logger: Pick<Logger, "log"> },
): Promise<DockerPeerWatch> {
  let current: string[] = [];
  let failing = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const refresh = async () => {
    try {
      current = await listWithin(list, opts.timeoutMs);
      failing = false;
    } catch (err) {
      current = [];
      if (!failing) {
        try {
          opts.logger.log("dashboard-docker-peers-unavailable", { error: String(err) });
        } catch {}
      }
      failing = true;
    }
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void refresh().then(schedule), opts.intervalMs).unref();
  };
  await refresh();
  schedule();
  return {
    subnets: () => current,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
