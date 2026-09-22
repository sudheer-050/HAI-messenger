# coturn (STUN/TURN) — MYAG-219

Self-hosted NAT traversal for voice calling, deployed only via
`docker-compose.yml.myserver` on myserver — not part of local dev.

## What this is

- `coturn/turnserver.conf` — static config, no secrets. Committed.
- The `coturn` service in `docker-compose.yml.myserver` — runs
  `coturn/coturn:4.6.2` with `network_mode: host` (needed so the whole
  relay port range is reachable without listing hundreds of individual
  Docker port mappings).
- Credentials use coturn's standard "REST API" time-limited mechanism
  (`lt-cred-mech` + `use-auth-secret`): `TURN_SHARED_SECRET` never reaches a
  client. The backend (MYAG-218-BE) computes, per call:
  - `username = <unix-expiry-timestamp>` (e.g. now + 600s)
  - `password = base64(HMAC-SHA1(TURN_SHARED_SECRET, username))`
  and hands only that pair to the frontend. coturn independently derives the
  same password from the username + shared secret and rejects anything that
  doesn't match or has expired.

## Ports

| Port(s)          | Protocol | Purpose                          |
|-------------------|----------|-----------------------------------|
| 3478               | UDP+TCP  | STUN/TURN control (TCP is fallback for UDP-blocking networks) |
| 49160–49172        | UDP      | Media relay (13 ports — deliberately narrow, not coturn's 49152–65535 default) |

Firewall (UFW, on myserver itself):
```
sudo ufw allow 3478/udp comment 'coturn STUN/TURN'
sudo ufw allow 3478/tcp comment 'coturn STUN/TURN'
sudo ufw allow 49160:49172/udp comment 'coturn relay range'
```
UFW changes need passwordless sudo temporarily enabled by the user — same
as any other `sudo`-gated change on this box.

**Router port forwarding is also required** and is outside SSH/UFW's reach:
myserver (192.168.0.180) sits behind home-router NAT with no public IP of
its own. The router must forward the same three port ranges above (UDP
3478, TCP 3478, UDP 49160-49172) to 192.168.0.180. This is a one-time
manual step on the router's admin page — nothing here can do it remotely.
Until it's done, coturn is reachable on the LAN only, and the "reachable
from outside the LAN" acceptance criterion in MYAG-219 can't be verified.

## `TURN_EXTERNAL_IP` and dynamic IPs

coturn needs to tell NATed clients its public-facing address
(`--external-ip`). Since myserver has no static public IP from its ISP
(unless one has been purchased separately), `TURN_EXTERNAL_IP` will go
stale if the ISP-assigned address changes. Two ways to handle this going
forward (not yet implemented — flagging for a follow-up, not blocking this
issue):
- A dynamic-DNS hostname (e.g. via the router or a DDNS client) resolved
  once at container start instead of a hardcoded IP.
- A small systemd timer / cron job that re-checks the public IP and
  restarts the `coturn` container (env var change) only when it drifts.

## Secret storage and rotation

`TURN_SHARED_SECRET` lives only in myserver's `.env` (gitignored, never
committed) and is read by both the `coturn` and `backend` services. To
rotate: generate a new value (`openssl rand -hex 32`), update `.env`, then
`docker compose -f docker-compose.yml.myserver up -d coturn backend` to
restart both with the new value. Rotating invalidates only *new* credential
mint requests going forward — in-flight calls using an already-issued
short-lived credential keep working until that credential's own ~10 minute
TTL expires, so rotation doesn't need to be call-aware.

## Verifying credential expiry (acceptance criterion)

Once deployed and a credential-minting endpoint exists on the backend:
1. Mint a credential, note its `username` (the embedded expiry timestamp).
2. Use it to make a TURN allocation (e.g. `turnutils_uclient -t -u <user> -w <pass> <TURN_EXTERNAL_IP>`) — should succeed.
3. Wait past the expiry, repeat the same allocation attempt with the same
   (now-expired) credential — coturn must reject it (`401`).
