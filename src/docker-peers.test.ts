import test from "node:test";
import assert from "node:assert/strict";
import { dockerPeerDenial } from "./docker-peers.ts";

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
