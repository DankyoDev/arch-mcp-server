# arch-mcp-server

https://github.com/DankyoDev/arch-mcp-server · https://www.npmjs.com/package/arch-mcp-server

[![npm](https://img.shields.io/npm/v/arch-mcp-server.svg)](https://www.npmjs.com/package/arch-mcp-server)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/node/v/arch-mcp-server.svg)](package.json)

An MCP server for administering a Linux host (with first-class Arch support) from an agent:
system state, systemd, journal, packages, network, disks, hardware, boot, sessions and
security.

This is not an `ssh` wrapper. It is a layer of **tasks**: every tool returns compact,
actionable JSON, and every response is measured in bytes so it does not burn context.

```
status:  complete implementation, 109 tools, v0.6.1
docs:    ./docs
```

## Why it exists

An agent administering Linux today does this:

```
ssh host 'systemctl list-units --output=json'   -> 91 KB of JSON in context
ssh host 'journalctl -n 50 --output=json'       -> 63 KB, mostly useless metadata
```

With this MCP (measured against the `dev/` environment):

```
sys_status()          -> 373 B, 1 call
svc_failed()          -> 100 B with 0 failed units
fs_usage()            -> 191 B
log_query(50)         -> ~1.5 KB with real entries
```

The 20 tasks in `docs/06-testing.md` section 6 average **291 tokens** and at most 2 calls on
the real host (20/20).

## Installation

From the repository (requires Node >= 20 and pnpm to build):

```bash
pnpm install
pnpm build
node dist/index.js        # stdio, ready for an MCP client
```

With `npx`, straight from the registry:

```bash
npx -y arch-mcp-server    # runs the `arch-mcp` bin
```

Globally from npm:

```bash
npm i -g arch-mcp-server
arch-mcp
```

You can also pack and install it locally:

```bash
pnpm pack
npm i -g ./arch-mcp-server-0.6.1.tgz
arch-mcp
```

## Minimal configuration

Everything goes through the environment, never through tool parameters:

```bash
ARCH_MCP_HOST=127.0.0.1
ARCH_MCP_PORT=2222
ARCH_MCP_USER=root
ARCH_MCP_KEY=C:/Users/me/.ssh/id_ed25519
```

With those four variables and `ARCH_MCP_MODE=readonly` (the default) the server works without
touching code. To operate as root without changing users:

```bash
ARCH_MCP_ALLOW_SUDO=1
# optional: restrict to specific binaries or prefixes
ARCH_MCP_SUDO_ALLOW=useradd,usermod,userdel,groupadd,chown,resolvectl,ip,renice
```

The SSH user needs NOPASSWD sudoers rules. Every other variable is documented in
`docs/11-configuration.md`.

### OpenCode

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "arch": {
        "type": "local",
        "command": ["node", "/path/to/arch-mcp-server/dist/index.js"],
        "environment": {
          "ARCH_MCP_HOST": "127.0.0.1",
          "ARCH_MCP_PORT": "2222",
          "ARCH_MCP_USER": "root",
          "ARCH_MCP_KEY": "C:/Users/me/.ssh/id_ed25519",
          "ARCH_MCP_MODE": "readonly",
          "ARCH_MCP_PROFILE": "core"
        }
      }
    }
  }
}
```

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "arch": {
      "command": "node",
      "args": ["/path/to/arch-mcp-server/dist/index.js"],
      "env": {
        "ARCH_MCP_HOST": "127.0.0.1",
        "ARCH_MCP_PORT": "2222",
        "ARCH_MCP_USER": "root",
        "ARCH_MCP_KEY": "/home/me/.ssh/id_ed25519",
        "ARCH_MCP_MODE": "readonly"
      }
    }
  }
}
```

## Profiles

| Profile | Tools | Use |
|---|---:|---|
| `core` (default) | 12 | 90% of everyday diagnosis |
| `readonly` | 63 | full diagnosis without mutations |
| `full` | 109 | everything, including writes, jobs, daily operations, fallback and `raw_exec` |

`ARCH_MCP_PROFILE` selects the profile. With Code Mode the definitions load on demand, so a
large catalog does not inflate the context.

## Security (summary)

- **Readonly by default.** Mutations require `ARCH_MCP_MODE=write` plus a two-step
  confirmation token (TTL, single use, bound to the tool and its arguments).
- **Process denylist** before execution: `rm -rf /`, `mkfs`, `dd of=/dev/`, `--privileged`,
  `--cgroupns=host`, `--pid=host`, `--net=host`, `reboot`, critical units (`sshd`, `dbus`,
  `systemd-*`), and writes to `/etc/passwd`, `/etc/sudoers` or SSH keys.
- **No interpolation**: every command is argv quoted with `shellQuote()`; `fs_write` content
  travels over stdin.
- **JSONL audit** with rotation at `~/.local/state/arch-mcp/audit.jsonl`; tokens and file
  contents are redacted.
- **Rate limit** of 30 calls per minute; `raw_exec` counts double.
- `exec` only accepts a daily allowlist (rg, fd, jq, tar, rsync, curl, git, croc...) and asks
  for confirmation; `exec_any` and `script_run` require `admin` mode and an explicit opt-in.
- `raw_exec` is off unless `ARCH_MCP_ALLOW_RAW=1` and mode is `admin`, and it only accepts a
  binary allowlist (never shells).

Full detail in `docs/05-security.md`.

## Daily operations and fallback

Three layers, from cheapest to most powerful:

1. **Native tools** (`fs_*`, `svc_*`, `pkg_*`...): parsed, compact output.
2. **`exec`**: daily binaries from an allowlist (`rg`, `fd`, `jq`, `yq`, `tar`, `rsync`,
   `curl`, `wget`, `git`, `croc`, checksums...) with shell-free argv and confirmation.
3. **`exec_any` / `script_run`**: admin mode and opt-in. `exec_any` rejects shells and
   interpreters; `script_run` runs python/bash/node/perl/ruby inline or an existing script.

Every fallback call is recorded in `~/.local/state/arch-mcp/gaps.jsonl`, and `exec_gaps`
groups it by binary. `gap_report` records commands the agent ran outside the MCP. If
`ARCH_MCP_GAP_ENDPOINT` is set, reports are sent to a collector (`scripts/gap-receiver.mjs`).
The rule: a binary that keeps showing up in `exec_gaps` becomes a native tool or a parsed
recipe.

### Daily operations

- **Files:** `fs_mkdir`, `fs_copy`, `fs_move`, `fs_remove`, `fs_chmod`, `fs_chown`,
  `fs_symlink`. All with `dry_run` and confirmation; `fs_remove` refuses `/`, `/etc`, `/usr`,
  `/home`...
- **Archives and hashes:** `fs_archive` (tar/tgz), `fs_archive_list`, `fs_checksum`, `fs_du`.
- **Downloads:** `fetch_url` with a byte cap and optional sha256; `http_check` for status and
  latency.
- **Network:** `net_ping` (loss and rtt), `net_route` (add/delete route), `net_dns_set`
  (resolvectl), `fw_rule` (allow/deny/delete with ufw or firewalld).
- **Processes:** `proc_renice` to change priority.
- **systemd:** `svc_unit_write`/`svc_unit_delete` to create, replace or delete units in
  `/etc/systemd/system` with `daemon-reload` (and optional `enable`).
- **Users:** `usr_action` to create, delete, lock, unlock or add to a group. It never touches
  `root` or the MCP user.
- **Root without changing users:** `ARCH_MCP_ALLOW_SUDO=1` runs tools with `sudo -n` as the
  same SSH user. The remote side needs NOPASSWD rules; see `docs/11-configuration.md` §11.

## MCP resources

| URI | Content |
|---|---|
| `arch://rules` | host owner rules (`ARCH_MCP_RULES` or `~/.config/arch-mcp/rules.md`) |
| `arch://capabilities` | detected tools and features |
| `arch://cheatsheet` | which tool answers which question |

## HTTP transport (optional)

Off by default. For clients that do not speak stdio:

```bash
ARCH_MCP_HOST=... node dist/index.js --http --port 3333
# Streamable HTTP at http://127.0.0.1:3333/mcp
```

With `ARCH_MCP_HTTP_TOKEN` (at least 16 characters) the endpoint requires
`Authorization: Bearer <token>`; without it the endpoint is open and only safe on localhost or
behind a proxy. See `docs/11-configuration.md` §9.

## Development

```bash
pnpm test        # 313 unit tests, no network
pnpm audit:tools # every tool against a host (mutations in dry_run)
pnpm measure     # 20 evals against a host (ARCH_MCP_*), measures tokens
pnpm fixtures    # recapture fixtures from the dev container
pnpm lint        # tsc --noEmit
```

The local test environment lives in `dev/` (two disposable Arch containers). Tests never touch
the real host.

## Project status

- [x] Research and real measurements
- [x] Architecture and tool catalog
- [x] Output contracts, security, testing and roadmap
- [x] Implementation phases 0-5 (56 tools, evals, measurement)
- [x] Phase 6: resources, HTTP with optional bearer token, packaging and `v0.2.0`
- [x] Phase 7: `exec`/`exec_any`/`script_run` fallback, `fs_grep`, gap log and `v0.3.0`
- [x] Phase 8: files, archives, downloads, ping, routes, users and firewall, `v0.4.0`
- [x] Phase 9: sudo as the same user, symlinks, renice, DNS and `v0.5.0`
- [x] Post-roadmap coverage: AUR, kernel modules, sysctl, mounts, coredumps and local
      accounts, `v0.6.0`

A living map of which commands have a native tool, which go through `exec` and which remain
out of scope: `docs/13-command-coverage.md`.
