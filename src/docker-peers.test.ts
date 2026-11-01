import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerPeerDenial, listDockerBridgeSubnets } from "./docker-peers.ts";

const subnets = ["172.17.0.0/16", "fd00:dead::/64"];

test("dockerPeerDenial refuses an address inside a listed subnet — IPv4, IPv4-mapped and IPv6", () => {
  for (const addr of ["172.17.0.5", "::ffff:172.17.0.5", "fd00:dead::5"]) {
    assert.equal(
      dockerPeerDenial(addr, subnets),
      "request from a Docker network refused (agent containers may not use the dashboard)",
      addr,
    );
  }
});

test("dockerPeerDenial admits loopback, a tailnet address and another network's subnet", () => {
  for (const addr of ["127.0.0.1", "::1", "100.64.1.2", "172.19.0.5"]) {
    assert.equal(dockerPeerDenial(addr, subnets), null, addr);
  }
});

// A stand-in `docker` that records its argv and prints `stdout`, exiting `code`.
function fakeDocker603(stdout: string, code = 0): { bin: string; argv: () => string } {
  const dir = mkdtempSync(join(tmpdir(), "vetinari-fake-docker-"));
  const bin = join(dir, "docker");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" > "${dir}/argv"\nprintf '%s' '${stdout}'\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  return { bin, argv: () => readFileSync(join(dir, "argv"), "utf8").trim() };
}

test("listDockerBridgeSubnets reads the default bridge network's IPv4 and IPv6 subnets from docker network inspect", async () => {
  const docker = fakeDocker603("172.17.0.0/16 fd00:dead::/64 ");
  assert.deepEqual(await listDockerBridgeSubnets(docker.bin), ["172.17.0.0/16", "fd00:dead::/64"]);
  assert.equal(docker.argv(), "network inspect --format {{range .IPAM.Config}}{{.Subnet}} {{end}} bridge");
});

test("listDockerBridgeSubnets rejects when docker is missing or the command fails", async () => {
  await assert.rejects(listDockerBridgeSubnets(join(tmpdir(), "no-such-docker-603")));
  await assert.rejects(listDockerBridgeSubnets(fakeDocker603("", 1).bin));
});
