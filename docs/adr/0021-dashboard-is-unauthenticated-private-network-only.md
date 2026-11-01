# The dashboard is unauthenticated, reachable only over a private network

Status: recorded in design.md §11.

The dashboard has no authentication of any kind, yet several of its routes start a
process: `POST /answer` resumes a parked agent with caller-supplied text, `POST /prune`
and `POST /graft` reshape a running campaign, `POST /redrive` starts the recovery
campaign, and the prune and graft previews shell a dry run. The answer route is the
sharp one — its text goes straight into a coding agent that holds commit rights and a
provider credential. Both entry points (`vetinari status` and the gateway's built-in
dashboard) bind loopback by default, and the display string printed for a `0.0.0.0`
bind already assumed a private overlay network, but that assumption lived nowhere else.

Loopback alone was not the safe default it looked like. The routes read
`application/x-www-form-urlencoded` bodies, which a browser sends cross-site with no
preflight, so **any page open in the operator's browser** could POST to
`http://127.0.0.1:8765/answer`. And a page on an attacker's domain re-pointed at
`127.0.0.1` by **DNS rebinding** is same-origin with itself, so it could read every
route and pass any "Origin equals Host" comparison.

We keep the dashboard **unauthenticated by design**. Remote access — from a phone,
say — is supported **only** over a private overlay network (Tailscale, WireGuard) or
behind an authenticating reverse proxy the operator runs. What vetinari guards against
itself is the **browser-borne** request, with two checks run once at the server's
request entry, ahead of the route table, so every current and future route is covered:

- **Host check.** The `Host` header, port ignored, must be an IP literal, `localhost`,
  or a name listed in `VETINARI_STATUS_ALLOWED_HOSTS`. Rebinding always arrives under a
  DNS name, and a page served from an IP really is the dashboard's own origin. Anything
  else, or no `Host`, is a 403.
- **Origin check.** A present `Origin` — the literal `null` included — must be
  `http://<Host>` or `https://<Host>` for the request's own `Host`, port included, or
  the request is a 403. No `Origin` passes: curl and scripts send none and are not the
  browser threat. It applies to every request, not only the spawning ones, because
  that is simpler and the dashboard's own requests already pass.
- **Fetch-site check on the spawning GETs.** `GET /graft?preview` and `GET /prune?preview`
  shell a dry run, and a cross-site `<img>` or `<iframe>` GET carries no `Origin`, so the
  Origin check admits it. These two routes alone refuse with a 403 any request whose
  `Sec-Fetch-Site` is present and not `same-origin`; no `Sec-Fetch-Site` (curl, scripts)
  passes as before. Every other route keeps admitting it, so top-level navigation to the
  board from another site still works.

The browser is not the only client on the host. Every vetinari host runs Docker for its
agent containers, and a **prompt-injected agent is a script**: it can forge `Host` and
`Origin` at will, so the checks above admit it. And it can reach the port. On Linux a
packet for any of the host's own addresses is accepted whichever interface it arrives
on, so binding the tailnet IP rather than `0.0.0.0` does not keep a container out on a
host with no firewall. From there it could `POST /answer` text into another agent that
holds commit rights, or prune, redrive and stop the campaign. So one more check runs at
the same entry, **first**, ahead of the Host check:

- **Docker-peer check.** A request whose remote address lies inside a subnet of the
  Docker network agent containers run on — the default `bridge`, since vetinari never
  gives sandcastle a network — is a 403, on every route and method, and is logged as a
  `dashboard-docker-peer-refused` host-log row. The address is the one thing a script
  cannot forge. The subnets (IPv4 and IPv6) are read live from `docker network inspect`,
  once before the server listens and then about every minute. When Docker cannot be
  listed the check filters nothing and the dashboard keeps working, with one
  `dashboard-docker-peers-unavailable` warning per failure streak. Running first means a
  container sending a DNS-name `Host` still gets this refusal and its row.

Only the agents' network is refused. An authenticating reverse proxy or a sidecar on its
own user-defined Docker network stays admitted, since a proxy is a supported path. A
host firewall that denies incoming traffic (`ufw` with deny-incoming, say) is a second
layer beneath this check, not a substitute for it.

A bind to anything but loopback prints one warning line after the URL line, saying the
dashboard is unauthenticated and pointing at `docs/operations.md`. It never refuses
the bind.

## Considered Options

- **Document the posture only** — rejected as insufficient: it leaves the cross-site
  POST and rebinding holes open on the default loopback bind, where no network
  boundary helps.
- **Refuse a non-loopback bind without an acknowledgement flag** — rejected: binding
  wide is the only way to reach the dashboard over a tailnet, so the flag becomes a
  ritual every remote install types, and the warning line carries the same message
  without the friction.
- **A shared-secret token on the mutating routes** — rejected: a token has to be
  provisioned, stored and typed into a phone, and it duplicates what the overlay
  network or the operator's reverse proxy already authenticates. The network boundary
  is the authentication; vetinari only needs to stop the browser from reaching across
  it on the operator's behalf. The agent containers on the same host are inside that boundary,
  and the Docker-peer check, not a token, keeps them out. The token stays rejected
  unless the open check of Docker Desktop, whose containers reach the host by a
  different route, shows that it needs one.
- **Rely on binding the tailnet IP** to keep containers out — rejected: it is untested
  theory, and on Linux a container can still reach any host address absent a firewall.
  On the maintainer's host it was the firewall, not the bind, that kept a container out.
- **Refuse every Docker network's subnet** — rejected: it would refuse the operator's
  own reverse proxy or sidecar on its own network, which is a supported path.

## Consequences

- A MagicDNS or reverse-proxy name must be listed in `VETINARI_STATUS_ALLOWED_HOSTS`
  (one variable for both entry points); an IP-literal tailnet address needs nothing.
- A reverse proxy must pass the original `Host` through: the Origin check compares the
  browser's `Origin` against it.
- No CORS headers and no cross-origin access: a page on another origin cannot use the
  dashboard's API, by design.
- The dashboard refuses to be framed (`X-Frame-Options: DENY` and CSP
  `frame-ancestors 'none'` on every response, set at the same request entry): a click
  inside a framed dashboard carries the dashboard's own `Origin`, so the Origin check
  alone would admit a clickjacked Redrive, Stop or Prune.
- Reachability is the operator's responsibility. Binding the dashboard to a public
  interface is unsupported and, with these checks alone, still open to anyone who can
  reach the port with curl.
- **Known limit:** a container on `--network host` uses the host's own addresses, so
  the Docker-peer check cannot tell it from the host. vetinari never runs agents that
  way. If it ever gives sandcastle a network other than the default `bridge`, that
  network must be added to the refused list (`AGENT_CONTAINER_NETWORKS` in
  `src/docker-peers.ts`).
