# 02 - Architecture

## 1. Overview

```
┌─────────────┐   stdio (JSON-RPC)   ┌──────────────────────────────────────┐
│  Agent      │◄────────────────────►│  arch-mcp                            │
│ (OpenCode)  │                      │                                      │
└─────────────┘                      │  tools/*  →  parse/*  →  exec/*      │
                                     │      │          │          │        │
                                     │      └── policy/*        connection/*│
                                     └───────────────────────────┬──────────┘
                                                                 │ SSH (ssh2)
                                                        ┌────────▼────────┐
                                                        │  Linux host     │
                                                        │  systemd, pacman│
                                                        └─────────────────┘
```

Five layers, each with one responsibility and its own test:

| Layer | Responsibility | Does not |
|---|---|---|
| `tools/` | Contract: validate input, call the parser, return the envelope | Build commands |
| `parse/` | Turn stdout into typed objects | Execute |
| `exec/` | Build argv, quoting, timeouts, byte budget | Interpret semantics |
| `policy/` | Mode, denylist, confirmation, audit | Know about domains |
| `connection/` | SSH or local, reconnection, keepalive | Know about commands |

## 2. Stack

- **Node ≥ 20 + strict TypeScript (ESM)**. Same runtime as the user's ecosystem
  (pnpm, n8n, existing MCPs).
- `@modelcontextprotocol/sdk` - server and types.
- `zod` - input schemas and config validation.
- `ssh2` - pure JS SSH client: persistent connection, `exec` and SFTP without an external binary.
- No HTTP frameworks in phase 1. `node:http` only if HTTP transport is enabled.

**Why `ssh2` and not the `ssh` binary:** one `ssh` process per call costs 300-800 ms of
handshake; with Cloudflare Access it may also require interactive authentication. `ssh2`
keeps one session, does keepalive and allows cancelling commands. Trade-off: you have to
implement reconnection and host-key verification (see §7).

**Local mode:** with `ARCH_MCP_LOCAL=1` it uses `child_process.spawn` with the same contract
(ADR-017; the host name does not enable it). It lets you use the MCP on the same machine without SSH.

## 3. Flow of a call

1. The SDK validates the Zod schema. On failure, a protocol error with the offending field.
2. `policy.check(tool, args)`:
   - Does the mode allow the operation? `readonly` blocks mutations.
   - Does the command fall in the denylist? Then `E_POLICY` with `hint`.
   - Does it require confirmation? If there is no valid token, it returns `needs_confirm`.
3. `exec.run(argv, opts)`:
   - builds the line with `shellQuote()` per argument;
   - `timeout` (15 s by default; 120 s for pkg);
   - cuts stdout at `maxBytes` (8 KiB by default) and marks it truncated;
   - returns `{code, stdout, stderr, truncated, ms}`.
4. `parse.<domain>` converts. If the parser fails, `E_PARSE` with the first 200 bytes
   (useful to diagnose different versions).
5. `tools` composes the envelope (`docs/04-output-contracts.md`) and returns it as
   `structuredContent` + JSON text.
6. `policy.audit` writes a JSONL line (if enabled).

## 4. Modules

```
src/
├── index.ts            # Server + registry per profile
├── config.ts           # env → Config (zod), capability detection
├── connection/
│   ├── ssh.ts          # ssh2, single-connection pool, reconnect with backoff
│   ├── local.ts        # spawn
│   └── types.ts
├── exec/
│   ├── run.ts          # execution + timeout + byte cap
│   ├── quote.ts        # shellQuote()
│   └── budget.ts       # truncation, cursors, size
├── parse/
│   ├── systemd.ts      # units, unit-files, status, timers
│   ├── journal.ts      # JSON lines → compact entries
│   ├── proc.ts         # /proc/stat, meminfo, loadavg
│   ├── pacman.ts       # -Qu, -Qi, -Ss, -Ql
│   ├── net.ts          # ip -j, ss
│   ├── fs.ts           # findmnt, df, lsblk
│   └── hw.ts           # lscpu, sensors, nvidia
├── policy/
│   ├── modes.ts        # readonly | write | admin
│   ├── denylist.ts     # forbidden patterns (includes the incident)
│   ├── confirm.ts      # two-step tokens
│   └── audit.ts        # JSONL with redaction
└── tools/
    ├── sys.ts svc.ts log.ts pkg.ts net.ts fs.ts hw.ts boot.ts usr.ts sec.ts job.ts
```

## 5. Tool profiles

Clients without Code Mode load every definition. To avoid inflating the context:

| Profile | Tools | Use |
|---|---|---|
| `core` (default) | ~12 | What is used 90% of the time |
| `readonly` | ~46 | Full diagnostics without mutations |
| `full` | 109 | Everything, including writes and jobs |

It is selected with `ARCH_MCP_PROFILE`. The exact list is in `docs/03-tool-catalog.md`.

## 6. Capability detection

At startup **one** (grouped) call runs and detects:

```sh
command -v pacman systemctl journalctl nmcli sensors nvidia-smi smartctl dkms checkupdates ss
cat /etc/os-release
systemctl --version | head -1
```

Result: `HostCapabilities` in memory, exposed by `host_capabilities` and the resource
`arch://capabilities`. Tools that depend on something missing:

- are not registered if the profile is `core`, and
- if invoked, they return `E_UNSUPPORTED` with `hint` ("install `pacman-contrib`").

## 7. Connection and reconnection

- A single connection per process (ssh2 `Client`), reused.
- `keepaliveInterval: 10s`, `keepaliveCountMax: 3`.
- Connection timeout: 10 s.
- If the channel dies: retry **once**; if it fails, `E_CONN` with the last error.
- Host key: optional `ARCH_MCP_HOST_KEY` (`SHA256:...`). If absent, TOFU and a warning on
  stderr once. Never a silent `StrictHostKeyChecking=no`.
- Authentication by priority: `ARCH_MCP_KEY`, then `ARCH_MCP_PASSWORD`, then the SSH agent.

## 8. Concurrency

- One command at a time per connection (ssh2 multiplexes channels, but ordering makes the
  audit easier).
- Long-running tools (`pkg_update`, allowed `raw_exec`) go to `job_*`: they are launched,
  a `job_id` is returned and you query it with `job_status`.

## 9. Error model

```ts
type ErrCode =
  | "E_CONN" | "E_AUTH" | "E_TIMEOUT" | "E_NOTFOUND" | "E_PERM"
  | "E_POLICY" | "E_CONFIRM" | "E_UNSUPPORTED" | "E_PARSE"
  | "E_TRUNCATED" | "E_INTERNAL";
```

Rules:

- `E_POLICY` and `E_CONFIRM` **never** execute anything.
- Transport failures travel as `TransportError` and **keep their code**
  (`E_CONN`, `E_AUTH`, `E_TIMEOUT`) when the rejection is converted into a `Result`. They are never downgraded to
  `E_INTERNAL`.
- `E_PARSE` includes `raw_preview` (≤ 200 B) for diagnosis.
- `E_TIMEOUT` includes `duration_ms` and `hint` ("use job_* for long processes").
- Messages are actionable: what failed and what to do, in one line.

## 10. What this MCP does NOT do

- Docker, Podman, Kubernetes (another MCP).
- Cloudflare, Traefik, homelab DNS.
- Live log streaming (solved with cursor-based pagination).
- Execution of arbitrary scripts without an allowlist.
