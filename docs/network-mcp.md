# Network-hosted MCP (central server)

By default gnosys runs **locally**: your IDE spawns `gnosys serve` over stdio and
reads `~/.gnosys/gnosys.db` on the same machine. That stays the zero-config
default and needs nothing here.

The **central server** topology instead runs one always-on gnosys over HTTP, and
points every machine's IDE at its URL. One live brain, no cross-machine sync.
Trade-off: when the server is unreachable, those clients have no memory — so use
this when your machines can reach the host (e.g. over Tailscale).

## Run the server

**On a Mac (peer-as-host, no Docker):**

```bash
gnosys serve --transport http --host 127.0.0.1 --port 7777
# share over a tailnet by binding the tailnet address (or front it with Tailscale):
gnosys serve --transport http --host 100.x.y.z --port 7777 --token "$(openssl rand -hex 16)"
```

Keep it running with `launchd` (a LaunchAgent invoking the same command).

**In Docker (Synology / any host that runs containers):**

```bash
docker compose up -d            # builds the image, runs serve --transport http on :7777
# or:
docker build -t gnosys-mcp .
docker run -d -p 7777:7777 -v gnosys-data:/data \
  -e GNOSYS_SERVE_TOKEN=your-secret gnosys-mcp
```

The DB lives on the host-local volume `/data` (`GNOSYS_HOME=/data`). **Never** back
that volume with an SMB/NFS share — network filesystems corrupt SQLite under
gnosys's many small writes (that's the whole reason this exists). On Synology use
an internal-volume Docker mount; Hyper Backup of that volume covers backups.

## Point a client (IDE) at it

Configure the IDE's MCP server as an HTTP/URL server instead of a `command`:

```jsonc
// Example (shape varies by IDE)
{ "mcpServers": { "gnosys": { "url": "http://100.x.y.z:7777/mcp" } } }
```

With a token, add `"headers": { "Authorization": "Bearer your-secret" }`.
(`gnosys setup ides` can write this for you — see Phase B.)

Clients pass their own machine-local `projectRoot` per call, and the server
resolves it via `machine.json` + `project_locations` (v5.10.0), so the one brain
maps each machine's paths correctly.

## Security

- Binds `127.0.0.1` by default. Only expose it over a trusted network (Tailscale
  tailnet), never the public internet.
- Set `GNOSYS_SERVE_TOKEN` (or `--token`) to require `Authorization: Bearer …`.
- `/health` is unauthenticated (liveness only; reveals nothing but session count).

## Rate limiting

gnosys does not implement in-process rate limiting, by design:

- It binds `127.0.0.1` by default — only local processes can reach it.
- Any non-loopback bind **requires** a bearer token (the server refuses to
  start without one), so there is no anonymous request path to abuse.
- It is a single-user / small-trusted-group personal brain, not a
  multi-tenant public API — there is no per-tenant quota problem.
- Abuse is already bounded by unguessable session IDs, session isolation,
  the idle-session reaper (orphaned sessions are reclaimed), and the
  default-deny Origin guard (browsers are rejected unless allowlisted).

If you expose gnosys beyond a trusted tailnet, put it behind a reverse proxy
(Caddy / nginx / Tailscale) and apply rate limiting and TLS there —
the network perimeter is the correct layer for it, not the app process.

## Health

```bash
curl http://HOST:7777/health        # {"status":"ok","sessions":N}
```

## Backup (independent of the live setup)

- `gnosys export` → markdown vault → **git** (versioned, human-readable), and/or
- Synology **Hyper Backup** of the host-local DB volume.
- Never two-way-sync the live `.db` between writers.
