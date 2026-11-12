# 10 - Decisions (ADR)

Short format: context, then decision, then consequences. If one changes, it is updated here.

---

## ADR-001 - TypeScript + Node

**Context:** the user's ecosystem is Node (pnpm, n8n, existing MCPs); the official MCP SDK is
TS-first. Alternatives: Python (fastmcp), Go (single binary).

**Decision:** strict TypeScript, ESM, Node >= 20.

**Consequences:** typing shared with the MCP schemas; requires a Node runtime on the agent
machine. Go would have given a single binary but less ergonomics with the SDK.

---

## ADR-002 - `ssh2` instead of the `ssh` binary

**Context:** invoking `ssh` per call costs 300-800 ms and with Cloudflare Access it may ask for
interactive authentication.

**Decision:** `ssh2` with a persistent connection and reconnection.

**Consequences:** host-key verification and reconnection have to be implemented; in exchange,
low latency, real cancellation and a single channel.

---

## ADR-003 - Task tools, not command tools

**Context:** `classfang/ssh-mcp-server` and `tufantunc/ssh-mcp` expose shell. That moves the
knowledge into the prompt and multiplies tokens.

**Decision:** 56 task tools (`svc_failed`, not `run_systemctl`).

**Consequences:** more work per tool, but responses 5-20x smaller and fewer errors.

---

## ADR-004 - Compact JSON always

**Context:** `systemctl list-units --output=json` = 91 KB; `journalctl` = 63 KB.

**Decision:** every tool returns a trimmed object, never stdout. `raw_exec` off.

**Consequences:** the parsers are the most delicate part; they are covered with fixtures and
tests.

---

## ADR-005 - Single envelope `{ok, data, meta}`

**Context:** the agent learns one shape and reuses it; errors need context.

**Decision:** common envelope, `E_*` codes with `hint`.

**Consequences:** a bit of redundancy per response (~40 B), offset by consistency.

---

## ADR-006 - Two-step confirmation

**Context:** the model sets a `confirm: true` boolean on its own.

**Decision:** ephemeral token returned by the server after a `preview`.

**Consequences:** one extra call on destructive operations; in exchange, the human sees the
effect and the audit records the confirmation. The token request itself is a success, not an
error (ADR-024), and the token is bound to the tool and its arguments.

---

## ADR-007 - Tool profiles

**Context:** clients without Code Mode load every definition.

**Decision:** `core` (12), `readonly` (66), `full` (113) via `ARCH_MCP_PROFILE`.

**Consequences:** the profile membership of each tool has to be maintained.

---

## ADR-008 - Local mode in addition to SSH

**Context:** the MCP must also work on the same machine.

**Decision:** `ARCH_MCP_HOST=localhost` uses `spawn` with the same contract.

**Consequences:** two backends to maintain, but easier tests and use without SSH.

---

## ADR-009 - No container management at first

**Context:** the first deployment ran a dozen Compose projects. Adding containers to the
catalog before the confirmation, audit and denylist work existed would have widened the blast
radius without any guard.

**Decision:** containers were out of scope; `docker` went on the denylist.

**Consequences:** every container operation fell to the fallback layer. Measured later: eight
`script_run` calls and eight confirmation round trips to bring up one project. **Superseded by
ADR-025.**

---

## ADR-010 - Denylist of processes, not of intent

**Context:** the 2026-11-12 incident: `docker run --privileged --cgroupns=host` with systemd
took the host down.

**Decision:** block concrete patterns (`--privileged`, `--cgroupns=host`, `--pid=host`,
`--net=host`, `rm -rf /`, `mkfs`, writes to `/etc` and `~/.ssh`) before executing.

**Consequences:** some legitimate commands are left out; override is allowed only with
`ARCH_MCP_ALLOW_UNSAFE=1` and reinforced audit.

---

## ADR-011 - English in code and in responses

**Context:** generic, publishable project; English keeps descriptions and documentation consistent.

**Decision:** code, descriptions, messages and documentation in English.

**Consequences:** one language across the repository; the docs stay close to the tool descriptions.

---

## ADR-012 - `structuredContent` + JSON text

**Context:** the 2025-06-18 spec allows `outputSchema`/`structuredContent`, but old clients
only read `content`.

**Decision:** send both.

**Consequences:** duplicates the payload on the wire; the client decides what to use.

---

## ADR-013 - Timeouts and jobs

**Context:** `pacman -Syu`, `mkinitcpio` or `btrfs scrub` take minutes.

**Decision:** normal tools with a 15 s timeout; long ones go to `job_*`.

**Consequences:** the agent must poll `job_status`; this is documented in the description.

---

## ADR-014 - No log streaming

**Context:** `journalctl -f` does not fit request/response.

**Decision:** cursor pagination (`log_query` with `since` or `cursor`).

**Consequences:** the agent polls; enough for diagnosis.

---

## ADR-015 - `sys_info` does not depend on D-Bus

**Context:** the cookbook §1 assumed `hostnamectl --json=short` as the main source. In the
local environment `dbus-broker` is masked (Docker Desktop does not expose the audit netlink)
and `hostnamectl` fails with *"Failed to connect to system scope bus"*. The same happens on
minimal hosts without `systemd-logind` or without D-Bus.

**Decision:** `sys_info` reads `/etc/os-release`, `/proc/uptime`, `/proc/meminfo`,
`/proc/sys/kernel/hostname`, `uname`, `nproc`/`lscpu -J` and `systemd-detect-virt`.
`hostnamectl` is not used; if it were used in the future it would be optional enrichment that
cannot make the tool fail.

**Consequences:** it works the same with and without D-Bus. The eight commands go in a single
grouped call (`exec/sequence.ts`), so the cost is a single SSH round trip (~90 ms measured).
Parsing `hostnamectl` text was discarded because it adds nothing that `/proc` does not
provide.

---

## ADR-016 - Synthetic fixtures, marked

**Context:** `docs/06-testing.md` §4 requires real fixtures. `journalctl` returns no entries
in the local environment (journald masked, `EUNATCH`) and the real host (`dante`) is off-limits
in this session.

**Decision:** every fixture is
`{cmd, exit, stdout, stderr, captured_at, host, synthetic}`. When there is no real capture, a
fixture with the exact shape of `journalctl --output=json` and `synthetic: true` is used; the
test consumes it the same way. When capturing from the real host, the file is replaced and
`synthetic` becomes `false`.

**Consequences:** the journal parsers are tested without network and without a host. The risk
is that a synthetic fixture does not cover oddities of the real journal (binary messages,
missing fields); those oddities are added as explicit parser cases, not as fixture
expectations.

---

## ADR-017 - Local mode only with `ARCH_MCP_LOCAL=1`

**Context:** `docs/02-architecture.md` §2 said that `ARCH_MCP_HOST=localhost` or `127.0.0.1`
imply local mode. That clashes with `dev/README.md`, which uses `127.0.0.1:2222` for the SSH
container: the MCP would have run the commands on Windows instead of over SSH.

**Decision:** local mode requires `ARCH_MCP_LOCAL=1`. `ARCH_MCP_HOST` is always an SSH target,
including `127.0.0.1`. On Windows local mode returns `E_UNSUPPORTED` (there is no `/bin/sh`).

**Consequences:** explicit configuration with no surprises; a `127.0.0.1` with a non-standard
port is no longer interpreted as "run it on my machine".

---

## ADR-018 - `raw_exec` by binary allowlist

**Context:** the denylist blocks concrete patterns, but a shell lets you build anything that
does not match a pattern (`sh -c '...'`). The catalog asks for an escape hatch off by default.

**Decision:** `raw_exec` requires `ARCH_MCP_ALLOW_RAW=1` **and** `ARCH_MCP_MODE=admin`, and
only accepts the first argv element from an allowlist of diagnostic binaries (`systemctl`,
`journalctl`, `pacman`, `ip`, `ss`, `cat`, `find`, `nft`, `smartctl`...). `sh`, `bash`,
`sudo`, `su`, `docker`, `podman` and `nsenter` are not on the list.

**Consequences:** there is still an escape hatch for rare cases, but without an arbitrary
shell; some legitimate commands are left out and have to be added to the allowlist with an
ADR.

---

## ADR-019 - In-memory jobs, fixed allowlist

**Context:** `pacman -Syu` or `mkinitcpio` take minutes and do not fit in the 15 s timeout.

**Decision:** `job_start` only accepts five commands (`pkg_update`, `mkinitcpio`, `reflector`,
`updatedb`, `btrfs_scrub`) and launches them with `nohup`, writing output and exit code to
`/tmp/arch-mcp-job-<id>.{log,exit}`. The job registry lives in process memory: if the MCP
restarts, the jobs keep running on the host but can no longer be queried.

**Consequences:** no arbitrary shell and no persistent state that can get corrupted; in
exchange, the agent must finish the work in the same session or look at the log on the host.

---

## ADR-020 - Optional HTTP with bearer token

**Context:** the phase 6 HTTP transport had no authentication and was only safe on localhost.
Exposing it on a LAN or behind a tunnel without a proxy added a remote administration surface
with no access control.

**Decision:** `ARCH_MCP_HTTP_TOKEN` (minimum 16 characters) enables
`Authorization: Bearer <token>` authentication on `/mcp`. The comparison is constant-time
(`timingSafeEqual`). Without a token, the server keeps working on localhost and warns on
stderr if it binds to a non-loopback address. The token is not logged and is not accepted via
query string.

**Consequences:** MCP clients must be able to send headers (OpenCode, Claude Code and Cursor
do it with `headers` in the server configuration). A TLS proxy in front is still recommended:
the token travels in clear text if HTTP is used without TLS.

---

## ADR-021 - Execution layers and gap logging

**Context:** the catalog covers common diagnosis and management, but Linux has
thousands of binaries and any external application (croc, ffmpeg, a script of your own) adds
more. An agent gets stuck as soon as it needs something that is not a native tool. On top of
that, `raw_exec` required admin and a fixed allowlist, so it was no good as a daily fallback
either.

**Decision:** three explicit layers:

1. **Native tools** (`fs_*`, `svc_*`, `pkg_*`...): parsed output, low cost, `core`/`readonly`
   profile.
2. **`exec`**: binaries from a daily allowlist (`rg`, `fd`, `jq`, `tar`, `rsync`, `curl`,
   `git`, `croc`...), argv without shell, two-step confirmation.
3. **`exec_any` / `script_run`**: escape hatch in admin, opt-in with
   `ARCH_MCP_ALLOW_ANY_EXEC=1` / `ARCH_MCP_ALLOW_SCRIPTS=1`. `exec_any` blocks shells and
   interpreters; `script_run` is the sanctioned path for python/bash/node/perl/ruby.

Every use of `exec`, `exec_any` or `script_run` is recorded in a local JSONL **gap log**
(`ARCH_MCP_GAP_LOG`) and, if `ARCH_MCP_GAP_ENDPOINT` is set, sent to a collector. `exec_gaps`
groups by binary and `gap_report` lets you record commands the agent ran outside the MCP. The
promotion rule is: a binary that shows up several times becomes a native tool or a recipe with
its own parser.

**Consequences:** the agent can use all of Linux without going back to raw SSH, but the
fallback consumes tokens (raw output) and must not be the default path. `exec_any` and
`script_run` are arbitrary execution: admin only, with confirmation, denylist and auditing.
The gap log redacts flags and credentials, and the collector is best-effort: if it is down,
the tool keeps working.

---

## ADR-022 - Daily operations with guards

**Context:** the catalog covered diagnosis and service/package management, but not the
operations a user performs every day: create/copy/move/delete files, archive, download, create
users, touch routes or open a port. Without them the agent went back to `exec` or to SSH.

**Decision:** native tools are added with the same security contract:

- **Files:** `dry_run` + token; `/`, `/etc`, `/usr`, `/boot`, `/proc`, `/sys`, `/dev`,
  `/home`, `/var`, `/root`, `~/.ssh` are rejected as a direct target; `..` forbidden; copying
  or moving a credential store is rejected.
- **Archives:** tar/tgz only (zip via `exec`); extraction requires an explicit, allowed
  destination.
- **Downloads:** `http(s)` only, byte cap, timeout and optional sha256; allowed destination.
- **Network:** `net_route` rejects the default route; `fw_rule` only supports ufw/firewalld and
  leaves nftables read-only so as not to generate rules blindly.
- **Users:** `usr_action` rejects `root` and the MCP user; deleting the home is explicit.

**Consequences:** the agent can operate without leaving the MCP, with a larger destructive
surface. Every destructive tool keeps `dry_run`, confirmation, denylist and audit; the ones
that cannot be made safe (zip, nftables, DNS) stay out and are documented as debt.

---

## ADR-023 - Root with the same SSH user

**Context:** on `dante` the MCP connects as `dante`, not as root. Many operations (`useradd`,
`chown`, `resolvectl`, negative `renice`) need root. The code had `ARCH_MCP_ALLOW_SUDO` in the
configuration, but `runCommand` never passed the options on to the denylist, so `sudo` was in
practice always blocked.

**Decision:** a `SudoConnection` decorator wraps the connection when `ARCH_MCP_ALLOW_SUDO=1`
and prepends `sudo -n` to every command. The SSH user does not change. Batch reads
(`runSections`) are elevated command by command. `ARCH_MCP_SUDO_ALLOW` accepts binaries or
prefixes and, if empty, elevates everything. No password is requested: the remote needs
NOPASSWD; if it is missing, `runCommand` returns `E_PERM` with a hint.

**Consequences:** the agent runs root commands with the same user and without managing
passwords, but the user needs sudoers. The denylist still applies to the real argv before
wrapping it, and `sudo` is still forbidden as a binary for `exec`/`exec_any`/`raw_exec`.
Elevation is a configuration decision, not a tool the model can invoke freely.

---

## ADR-024 - Confirmation requests are not errors

**Context:** a real session brought up one Compose project with 23 tool calls: four
executions and eight `E_CONFIRM` responses. The token was invalidated twice because the agent
re-emitted the same script with different trailing whitespace between the two calls, and the
client read `isError: true` as "the call failed", so it kept rewriting the arguments instead of
confirming them.

**Decision:** three changes to the same mechanism.

1. Asking for a token is a **success**: `ok: true`, `data.confirm_required`, `token`,
   `expires_in_s` and `preview`. `E_CONFIRM` is reserved for a token that is unknown,
   expired, already used or bound to other arguments.
2. The fingerprint drops `token` and `dry_run`, and ignores CRLF, trailing whitespace per line
   and edge blank lines in `source` and `content`. Internal spacing still counts.
3. `dry_run` returns the preview **and** a token for the real call.

**Consequences:** preview plus apply is two calls instead of three. The audit can tell a
preview from an execution (`preview` vs `allow`). A client that keys off
`error.code === 'E_CONFIRM'` must switch to `data.confirm_required`; this is a breaking
response change, hence 0.7.0.

---

## ADR-025 - Native container tools

**Context:** ADR-009 kept containers out of the catalog. The measurement in ADR-009's
consequences shows the cost: one Compose project, eight `script_run` calls, raw text output
and a gap log that could not say which binary was missing. That is exactly the promotion rule
of ADR-021 firing.

**Decision:** four tools. `docker_ps`, `docker_logs` and `docker_inspect` are read-only;
`docker_compose` runs `up -d`, `down`, `restart`, `stop` and `pull` in the `full` profile with
a token. The Compose file is detected from the project directory in one round trip, the file
name and the service names are validated, and the argv is fixed: no shell, no string
interpolation. Labels and environment values are never returned.

**Consequences:** `docker` stays forbidden for `exec`, `exec_any` and `raw_exec`. The
`containers` denylist rule gains an internal `allowContainers` flag that only these tools set,
and `container-flags` (`--privileged`, `--pid=host`, ...) keeps applying to everything.
`docker_compose` acts on a compose file that may declare `privileged: true`, which is why it
requires admin mode and a token, and why the documentation says so.

---

## ADR-026 - The gap log understands scripts

**Context:** consecutive `script_run` entries were all `script:bash` with argv
`["bash", "<temp>"]`. The promotion rule of ADR-021 wants "a binary that shows up several
times becomes a tool", but the log hid the binary, so Docker looked like bash.

**Decision:** `detectCommands()` reads a bash/sh source and returns the first binary of every
simple command, skipping shell builtins, wrappers (`sudo`, `env`, `nohup`...) and leading
`VAR=value` assignments. The list travels in `gap_log.commands`, and `exec_gaps` expands each
command into its own row with `via: "script_run"`.

**Consequences:** `exec_gaps` answers "which binary still has no tool". The detection is
static: `eval`, `xargs` and variables holding a command are invisible, so the field is a hint
for maintenance, never an input for policy.

---

## ADR-027 - Audit vocabulary separates preview from execution

**Context:** every successful call was recorded as `allow`, including `dry_run` previews,
which made the audit useless for measuring real activity and made a preview look like a
mutation that ran.

**Decision:** four decisions: `allow` (it ran), `preview` (`dry_run`, nothing ran),
`confirm` (a token was requested, nothing ran) and `deny` (refused by mode, rate limit or
denylist).

**Consequences:** the counts in `docs/06-testing.md` mean what they say. Anything that
aggregates the audit has to handle the new value.
