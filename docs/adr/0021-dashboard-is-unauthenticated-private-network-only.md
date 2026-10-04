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
  it on the operator's behalf.

## Consequences

- A MagicDNS or reverse-proxy name must be listed in `VETINARI_STATUS_ALLOWED_HOSTS`
  (one variable for both entry points); an IP-literal tailnet address needs nothing.
- A reverse proxy must pass the original `Host` through: the Origin check compares the
  browser's `Origin` against it.
- No CORS headers and no cross-origin access: a page on another origin cannot use the
  dashboard's API, by design.
- Reachability is the operator's responsibility. Binding the dashboard to a public
  interface is unsupported and, with these checks alone, still open to anyone who can
  reach the port with curl.
