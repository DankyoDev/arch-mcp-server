# 01 - Research

Everything in this document is verified against public sources and against the real host
(`dante`, Arch, systemd 262). The measurements are real bytes captured on 2026-11-12.

---

## 1. MCP protocol

Source: `modelcontextprotocol.io/specification/2025-06-18/server/tools`.

What matters for this project:

| Element | Implication |
|---|---|
| `name`, `title`, `description`, `inputSchema` | The description is always loaded into context. It must be ≤ 2 lines. |
| `outputSchema` + `structuredContent` | Allows returning validatable JSON; the text must still carry the serialized JSON for compatibility. |
| `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) | The client can request confirmation or filter. They are always declared. |
| Execution errors produce `isError: true` | Do not use JSON-RPC errors for business failures. |
| Tools are "model-controlled" | The server does not decide when; the model does. That is why the name and the description are critical. |
| Validate inputs, sanitize outputs, rate limit | Required by the spec. |

Conclusion: the contract is not "which command do I run", it is "which data do I return".

## 2. How tools for agents are designed

Source: Anthropic, *Writing effective tools for agents* (Sep 2025).

Principles we adopt literally:

1. **Fewer tools, better chosen.** "More tools do not always give better
   results". Common mistake: wrapping every endpoint. So we group by task.
2. **Namespacing.** Per-domain prefixes (`svc_`, `log_`, `pkg_`) so the agent
   can tell the boundaries apart. Anthropic measured real differences between prefix and suffix.
3. **Meaningful context.** Return `name` and state, not UUIDs or cryptic
   identifiers. No `mime_type`, `uuid`, internal paths if they are not needed.
4. **Token efficiency.** Pagination, filters, truncation and `response_format`
   (`concise`/`detailed`). In Claude Code the limit per response is 25k tokens; we
   set 8 KB.
5. **Prompt-engineered descriptions.** As if you were explaining it to someone new.
   Unambiguous parameter names (`unit_name`, not `name`).
6. **Evaluations.** Prototype, then real tasks, then measure calls, errors and tokens,
   then iterate. Without eval there is no improvement, only intuition.

Conclusion: the catalog is designed by task and validated with eval, not by command.

## 3. Code execution and progressive disclosure

Source: Anthropic, *Code execution with MCP* (Nov 2025) and Cloudflare Code Mode.

Key data:

- Loading every tool definition can cost **150k tokens**; with code execution and
  on-demand loading it drops to **~2k** (98.7% less).
- Intermediate results must not go through the model: they are filtered in the execution
  environment.

Twofold implication:

- The MCP must work well **with and without** Code Mode.
- With Code Mode (OpenCode uses it by default), only the tools in use are loaded, so
  a broad catalog is acceptable **if** the names are predictable.
- Even so, we offer **profiles** (`core`/`readonly`/`full`) for clients that load everything.

## 4. Existing MCP servers (state of the art)

GitHub search: 923 repos with "ssh mcp server", 79 with "systemd mcp". None is
specific to Arch. The relevant ones:

| Project | Stack | Contributes | What we take | What we do not |
|---|---|---|---|---|
| `classfang/ssh-mcp-server` (~1k stars) | Node | exec, SFTP, jobs, whitelist/blacklist regex, multihost | Whitelist/blacklist model, background jobs, `commandTemplate` | Runs arbitrary strings: does not validate intent |
| `tufantunc/ssh-mcp` v2 (~874 stars) | TS | policy engine (role × tier), human approval, audit, OPA, sessions | **Classification + approval + audit model** | 15 shell tools; too generic |
| `openSUSE/systemd-mcp` | Go | systemd over D-Bus (no `systemctl`), polkit, gatekeeper, TOON output | Idea of polkit-based authorization and `--list-tools` | Depends on local D-Bus: useless over SSH |
| `kascada/logmcp` | Go | read-only logs without a shell | Read-only approach | Logs only |

Lesson: nobody solved the real problem (remote host + tasks + compact output +
policies). There is room for this project.

## 5. Real measurements on `dante`

Host: Arch x86_64, kernel `7.2.15-arch1-1`, systemd **262.2**, 39 containers.

### 5.1 Native JSON support (verified)

| Command | JSON | Notes |
|---|---|---|
| `systemctl list-units` | `--output=json` | yes, complete |
| `systemctl list-unit-files` | `--output=json` | yes |
| `journalctl` | `--output=json` | yes, with `_*` metadata |
| `lscpu` | `-J` | yes |
| `lsblk` | `--json` | yes |
| `findmnt` | `--json` | yes |
| `ip` | `-j` | yes (addr, route, link) |
| `sensors` | `-j` | yes (lm_sensors) |
| `hostnamectl` | `--json=short` | yes |
| `systemd-analyze` | no JSON | text; parse it |
| `bootctl` | no JSON | text |
| `pacman` | no JSON | parse; or `expac` (not installed) |

### 5.2 Output size (the datum that justifies everything)

| Command | Bytes | Is raw worth it? |
|---|---:|---|
| `systemctl list-units --all --output=json` | **91 256** | No |
| `findmnt --json` | **69 754** | No |
| `journalctl -n 50 --output=json` | **63 783** | No |
| `systemctl list-unit-files --output=json` | 40 738 | No |
| `ip -j addr` | 29 475 | No |
| `ss -tunap` | 13 132 | No |
| `lscpu -J` | 4 648 | Only if detail is requested |
| `lsblk --json` | 1 484 | Yes, it is reasonable |
| `pacman -Qi bash` | 1 437 | Yes, per package |
| `ip -j route` | 1 234 | Yes |
| `sensors -j` | 808 | Yes |
| `df -P` | 747 | Yes |
| `free -b` | 207 | Yes |
| `systemd-analyze` | 122 | Yes |
| `timedatectl show` | 152 | Yes |

**Quantitative conclusion:** the three most common queries from an agent (units, logs,
mounts) add up to **225 KB** ≈ **60k tokens**. With compact parsers they must stay at **≤ 5 KB**
in total. That is the goal of this project.

### 5.3 Tools available on the host

Present: `systemctl`, `journalctl`, `sensors`, `smartctl`, `dkms`, `nmcli`, `ss`,
`reflector`, `pacman`, `ip`, `lsblk`, `findmnt`, `lscpu`.

Absent: `expac`, `checkupdates` (pacman-contrib), `lsof`, `nvidia-smi`, `fwupdmgr`.

Implication: capability detection at startup and *fallback* to `/proc` and `pacman -Qi`
when the tool is missing. `pkg_status` must work without `checkupdates`.

## 6. Command traps found

- `journalctl --output=json` includes ~40 `_*` fields per entry. You have to keep
  `__REALTIME_TIMESTAMP`, `PRIORITY`, `_SYSTEMD_UNIT`, `MESSAGE`, `_PID`.
- `systemctl list-units` without `--all` omits inactive units; with `--all` it blows up in
  size. Filter by state before serializing.
- `findmnt --json` includes hundreds of pseudo mounts (`cgroup`, `proc`, `sys`). Filter
  by `fstype not in (proc,sysfs,cgroup*,devtmpfs,tmpfs,overlay...)` unless they are requested.
- `sensors -j` uses chip names as keys; normalize to `{chip, sensor, value, unit}`.
- `pacman -Qu` returns empty and **exit 0** when there are no updates, and exit 1 in
  some cases; do not confuse that with an error.
- `systemd-analyze blame` can be slow; limit it to the top N.
- `ss -tunap` without privileges does not show the process of other users' sockets.
- `ip -j` uses abbreviated keys (`ifname`, `operstate`, `addr_info`); do not invent them.

## 7. Sources

- MCP - Tools: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- MCP - Architecture: https://modelcontextprotocol.io/docs/learn/architecture
- Anthropic - Writing effective tools for agents: https://www.anthropic.com/engineering/writing-tools-for-agents
- Anthropic - Code execution with MCP: https://www.anthropic.com/engineering/code-execution-with-mcp
- OpenCode - MCP servers (config V2): https://opencode.ai/docs/mcp-servers
- SSH MCP: https://github.com/classfang/ssh-mcp-server · https://github.com/tufantunc/ssh-mcp
- systemd MCP: https://github.com/openSUSE/systemd-mcp
- Arch Wiki (systemd, pacman, journal, NetworkManager): https://wiki.archlinux.org
- systemd - `systemctl(1)`, `journalctl(1)`, `systemd-analyze(1)`
