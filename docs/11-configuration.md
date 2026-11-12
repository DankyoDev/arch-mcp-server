# 11 - Configuration

## 1. Environment variables

| Variable | Default | Description |
|---|---|---|
| `ARCH_MCP_HOST` | `localhost` | SSH host, or `localhost` for local mode |
| `ARCH_MCP_PORT` | `22` | SSH port |
| `ARCH_MCP_USER` | `$USER` | Remote user |
| `ARCH_MCP_PASSWORD` | - | SSH password (or use a key) |
| `ARCH_MCP_KEY` | - | Path to the private key |
| `ARCH_MCP_PASSPHRASE` | - | Key passphrase |
| `ARCH_MCP_HOST_KEY` | - | Expected `SHA256:...` (optional) |
| `ARCH_MCP_MODE` | `readonly` | `readonly` \| `write` \| `admin` |
| `ARCH_MCP_PROFILE` | `core` | `core` \| `readonly` \| `full` |
| `ARCH_MCP_ALLOW_SUDO` | `0` | Runs the tools with `sudo -n` (same SSH user) |
| `ARCH_MCP_SUDO_ALLOW` | - | List of binaries or prefixes allowed for sudo |
| `ARCH_MCP_ALLOW_RAW` | `0` | Enables `raw_exec` |
| `ARCH_MCP_MAX_BYTES` | `8192` | Budget per response |
| `ARCH_MCP_TIMEOUT_MS` | `15000` | Timeout per command |
| `ARCH_MCP_RATE_LIMIT` | `30` | Calls per minute |
| `ARCH_MCP_AUDIT` | `1` | Audit log enabled |
| `ARCH_MCP_AUDIT_PATH` | `~/.local/state/arch-mcp/audit.jsonl` | Audit path |
| `ARCH_MCP_CONFIRM_TTL` | `120` | Confirmation token lifetime (s) |
| `ARCH_MCP_HTTP_TOKEN` | - | Bearer token for HTTP (min. 16 characters) |
| `ARCH_MCP_ALLOW_ANY_EXEC` | `0` | Enables `exec_any` (admin) |
| `ARCH_MCP_ALLOW_SCRIPTS` | `0` | Enables `script_run` (admin) |
| `ARCH_MCP_GAP_LOG` | `~/.local/state/arch-mcp/gaps.jsonl` | Local fallback log |
| `ARCH_MCP_GAP_ENDPOINT` | - | Gap collector URL |
| `ARCH_MCP_GAP_TOKEN` | - | Collector bearer token |

Rules: secrets **only** via the environment. No passwords in `command`, in the configuration
JSON or in tool parameters.

## 2. OpenCode (V2)

```jsonc
// opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "arch": {
        "type": "local",
        "command": ["npx", "-y", "arch-mcp-server"],
        "environment": {
          "ARCH_MCP_HOST": "127.0.0.1",
          "ARCH_MCP_PORT": "2222",
          "ARCH_MCP_USER": "dante",
          "ARCH_MCP_KEY": "C:/Users/abrah/.ssh/id_arch",
          "ARCH_MCP_MODE": "readonly",
          "ARCH_MCP_PROFILE": "core"
        }
      }
    }
  }
}
```

- `codemode` is `true` by default in OpenCode: tools are loaded on demand. Leave it that way.
- For a client without Code Mode, use `"codemode": false` and the `core` profile.

## 3. Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "arch": {
      "command": "npx",
      "args": ["-y", "arch-mcp-server"],
      "env": {
        "ARCH_MCP_HOST": "127.0.0.1",
        "ARCH_MCP_PORT": "2222",
        "ARCH_MCP_USER": "dante",
        "ARCH_MCP_KEY": "/home/user/.ssh/id_arch",
        "ARCH_MCP_MODE": "readonly"
      }
    }
  }
}
```

## 4. SSH behind Cloudflare Access

`ssh2` does **not** support `ProxyCommand`. If the host is only reachable through
`cloudflared`, a local TCP tunnel has to be opened:

```bash
cloudflared access tcp --hostname ssh.dankyolabs.me --url 127.0.0.1:2222
```

And point the MCP at `ARCH_MCP_HOST=127.0.0.1` + `ARCH_MCP_PORT=2222`.

Alternatives, in order of convenience:

1. **LAN/Tailscale** straight to port 22 (no cloudflared).
2. cloudflared TCP tunnel as above (a `systemd --user` unit or a task at startup).
3. `ssh` with `ProxyCommand` is **not** an option: this MCP does not invoke the `ssh` binary.

## 5. Multiple hosts

One instance per host, with a different name:

```jsonc
{
  "mcp": {
    "servers": {
      "arch-dante": { "type": "local", "command": ["npx","-y","arch-mcp-server"],
        "environment": { "ARCH_MCP_HOST": "10.10.10.75", "ARCH_MCP_USER": "dante" } },
      "arch-drasp": { "type": "local", "command": ["npx","-y","arch-mcp-server"],
        "environment": { "ARCH_MCP_HOST": "100.89.17.36", "ARCH_MCP_USER": "ubuntu" } }
    }
  }
}
```

OpenCode normalizes to `arch_dante_svc_list`, etc.

## 6. Local mode

```jsonc
"environment": { "ARCH_MCP_LOCAL": "1", "ARCH_MCP_MODE": "readonly" }
```

`ARCH_MCP_LOCAL=1` is mandatory: `ARCH_MCP_HOST=localhost` or `127.0.0.1` do **not** enable
local mode, because the same value is used for the SSH container in `dev/` (ADR-017).

Useful to test the MCP on the machine itself before pointing it at a server.

## 7. MCP resources

| URI | What it is for |
|---|---|
| `arch://rules` | Host rules (allowed ports, critical services, what not to touch) |
| `arch://capabilities` | Detected tools and versions |
| `arch://cheatsheet` | "For X use tool Y" |

`arch://rules` is where the host owner's decisions go, e.g.:

```md
- Published ports: only 30000-35000.
- Do not restart docker/containerd without warning.
- nginx and postgres are critical: confirm before touching them.
```

It is what lets the rule travel with the server and not depend on a loaded skill.

## 8. Quick diagnostics

| Symptom | Probable cause | Fix |
|---|---|---|
| `E_CONN` on startup | wrong host/port, firewall | try `nc -z host 22` |
| `E_AUTH` | key or password | check `ARCH_MCP_KEY`/`ARCH_MCP_PASSWORD` |
| `E_TIMEOUT` on everything | host saturated or MTU | raise `ARCH_MCP_TIMEOUT_MS` |
| `E_UNSUPPORTED` | missing binary | install it or use another tool |
| unexpected `E_POLICY` | denylist | check `docs/05-security.md` §4 |
| Empty outputs | different `LANG` | the server forces `LANG=C` |

## 9. HTTP transport (optional)

Off by default; it is enabled with `--http` (or `ARCH_MCP_HTTP_PORT`).

```bash
ARCH_MCP_MODE=readonly node dist/index.js --http --port 3333
# endpoint Streamable HTTP: http://127.0.0.1:3333/mcp
```

- `--port N` / `ARCH_MCP_HTTP_PORT` (default 3333).
- `--host ADDR` / `ARCH_MCP_HTTP_HOST` (default `127.0.0.1`). If it is exposed outside
  localhost without a token, the server warns on stderr.
- `ARCH_MCP_HTTP_TOKEN` (min. 16 characters) requires `Authorization: Bearer <token>` on
  `/mcp`; without a token, the endpoint stays open. The comparison is constant-time and the
  token is never written to the logs. For MCP clients, configure it as a header:

```jsonc
{
  "mcp": {
    "arch": {
      "type": "remote",
      "url": "http://127.0.0.1:3333/mcp",
      "headers": { "Authorization": "Bearer change-me-to-a-long-token" }
    }
  }
}
```

- It is stateless: every request creates an MCP server on top of the same SSH connection, so
  several clients share a single channel.
- Without TLS the token travels in clear text: in production put a proxy with HTTPS in front.

## 10. Fallback and gap logging

The MCP prefers a native tool. If there is none, the agent can use `exec` (daily allowlist,
argv without shell), `exec_any` (any binary, admin) or `script_run` (inline code or a script,
admin). Every use leaves a line in the gap log:

```json
{"ts":"2026-11-12T18:00:00.000Z","host":"dante:22","binary":"croc","argv":["croc","send","x"],
 "exit":0,"ms":1200,"stdout_b":340,"native":false,"reason":"exec_any fallback"}
```

- `exec_gaps` groups by binary and counts uses; there you can see what is worth turning into a
  native tool.
- `gap_report` records a command the agent ran **outside** the MCP (manual SSH).
- `ARCH_MCP_GAP_ENDPOINT` sends every entry to a central collector with
  `Authorization: Bearer $ARCH_MCP_GAP_TOKEN`. It is best-effort: if the collector is down,
  the tool does not fail.

Minimal collector included in the repo (`scripts/gap-receiver.mjs`):

```bash
GAP_TOKEN=change-me GAP_FILE=/data/gaps.jsonl node scripts/gap-receiver.mjs
# POST /report  Authorization: Bearer <GAP_TOKEN>
```

On the Arch server it can run in a container with the port in the allowed range:

```bash
docker run -d --name arch-mcp-gaps -p 30070:8787 \
  -e GAP_TOKEN=change-me -e GAP_FILE=/data/gaps.jsonl \
  -v /srv/arch-mcp-gaps:/data \
  -v "$PWD/scripts/gap-receiver.mjs:/app/gap-receiver.mjs:ro" \
  --restart unless-stopped node:22-alpine \
  node /app/gap-receiver.mjs
```

Security: `exec_any` and `script_run` are arbitrary execution. They are only enabled with the
variables above **and** `ARCH_MCP_MODE=admin`; every call asks for two-step confirmation, goes
through the denylist and is recorded in the audit log. The gap log redacts sensitive flags
(`--password`, `--token`, `KEY=...`) and URL userinfo.

## 11. Root with the same SSH user

The MCP does not switch user or open a root session: it connects as `ARCH_MCP_USER` and, if
`ARCH_MCP_ALLOW_SUDO=1`, prepends `sudo -n` to the commands. The user needs NOPASSWD rules for
whatever it is going to run:

```sudoers
# /etc/sudoers.d/arch-mcp
dante ALL=(root) NOPASSWD: /usr/bin/pacman, /usr/bin/systemctl, /usr/bin/useradd, \
      /usr/bin/usermod, /usr/bin/userdel, /usr/bin/groupadd, /usr/bin/chown, \
      /usr/bin/resolvectl, /usr/bin/ip, /usr/bin/renice
```

- `ARCH_MCP_SUDO_ALLOW` limits what gets elevated. Empty = everything; if you fill it in, it
  accepts binaries (`useradd`) or prefixes (`systemctl restart`, `useradd`).
- With an allowlist, batch reads (`runSections`) stay without sudo so as not to elevate
  unlisted commands.
- If the NOPASSWD rule is missing, the MCP returns `E_PERM` with a clear hint; it never asks
  for a password on stdin and never stores it.
- `sudo` is rejected in `exec`/`exec_any`/`raw_exec`; only the transport does the elevation,
  not the model.
