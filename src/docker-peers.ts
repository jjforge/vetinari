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
 * Take the first listing — awaited, so no request is served unchecked — and keep its result. A
 * listing that fails or times out filters nothing (the dashboard keeps working), logging one
 * `dashboard-docker-peers-unavailable` warning.
 */
export async function watchDockerPeerSubnets(
  list: DockerSubnetLister,
  opts: { timeoutMs: number; logger: Pick<Logger, "log"> },
): Promise<DockerPeerWatch> {
  let current: string[] = [];
  try {
    current = await listWithin(list, opts.timeoutMs);
  } catch (err) {
    try {
      opts.logger.log("dashboard-docker-peers-unavailable", { error: String(err) });
    } catch {}
  }
  return { subnets: () => current, stop: () => {} };
}
