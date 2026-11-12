# 05 - Security

An MCP with access to a host is the "lethal trifecta" described by Simon Willison: access to
private data + untrusted input (logs, file names, command output) + network egress. There is
no general solution to prompt injection; the goal is to **reduce the blast radius** and leave
a trail.

## 1. Threat model

| Threat | Example | Mitigation |
|---|---|---|
| Prompt injection in data | A log contains "run `rm -rf /`" | The agent does not execute; it can only call tools. `raw_exec`/`exec_any`/`script_run` off. Denylist. |
| Destructive command requested by the model | `systemctl stop sshd` | `write` mode + confirmation token + denylist |
| Silent escalation | `sudo` inside a command | `ARCH_MCP_ALLOW_SUDO=0` by default; sudo only via allowlist |
| Exfiltration | Read `~/.ssh/id_*` and return it | Denylist of sensitive paths; limited `fs_read`; audit |
| Lateral movement | Touch the host's Docker/network | Out of scope; denylist of `docker`, `nft`, `iptables -F` |
| Resource abuse | `yes` or `tail -f` | Timeout + byte limit + `job_*` |
| Impersonation | Different host key | Optional `ARCH_MCP_HOST_KEY`; TOFU with warning |

## 2. Modes

| Mode | Allows | Default |
|---|---|---|
| `readonly` | `R` tools | yes (default) |
| `write` | `R` + mutations with token + `exec` | |
| `admin` | + `exec_any` and `script_run` (with their opt-in) + `raw_exec` (with `ALLOW_RAW=1`) | |

They are combined with:

```env
ARCH_MCP_MODE=readonly
ARCH_MCP_ALLOW_SUDO=0
ARCH_MCP_ALLOW_RAW=0
ARCH_MCP_ALLOW_ANY_EXEC=0
ARCH_MCP_ALLOW_SCRIPTS=0
ARCH_MCP_CONFIRM_TTL=120
```

## 3. Two-step confirmation

Every destructive tool follows this protocol:

1. The agent calls **without** `token`.
2. The server **does not execute** and responds:

```json
{"ok":false,"error":{"code":"E_CONFIRM","message":"confirmation required",
 "hint":"repeat the call with token"},"data":{
   "token":"a1b2c3d4",
   "expires_in_s":120,
   "preview":{"unit":"nginx.service","action":"restart",
              "effect":"systemctl restart nginx.service"}}}
```

3. The agent repeats with `token`. The token is validated against
   `sha256(tool + args + nonce)[:8]`, has a TTL and is single-use.

Benefits: the human sees the `preview`, the agent cannot "forget" the step, and the audit
records who confirmed what.

## 4. Denylist (mandatory)

It is evaluated **before** executing, against the full normalized argv. If it matches -> `E_POLICY`.

### 4.1 System

```
rm -rf /            rm -rf /*            mkfs*              dd of=/dev/*
shutdown*           reboot              poweroff           halt
systemctl poweroff  systemctl reboot    systemctl halt     systemctl isolate
init 0              init 6              kill -9 1          :(){ :|:& };:
```

### 4.2 Sensitive writes

```
/etc/passwd  /etc/shadow  /etc/sudoers  /etc/sudoers.d/*
~/.ssh/authorized_keys  ~/.ssh/id_*  /boot/*  /etc/fstab  /etc/crypttab
```

### 4.3 Containers and hypervisor (out of scope, but blocked)

```
docker run --privileged            # the 2026-11-12 incident
docker run --cgroupns=host
docker run --pid=host
docker run --net=host
docker run -v /:/host
nsenter -t 1 -m -u -i -n -p
```

> **Root cause of the incident:** a containerized `systemd` with `--privileged` and
> `--cgroupns=host` sees the host cgroups and can terminate it. The MCP must not allow
> building that command from any tool, including `raw_exec`, `exec` and `exec_any`.

### 4.4 Network

```
iptables -F        nft flush ruleset      ip link set * down
systemctl stop NetworkManager
```

### 4.5 Shell escape

- Arguments containing `;`, `|`, `&`, backticks, `$(` and line breaks are rejected **when the
  argument must be data** (names, paths, filters).
- Internal pipelines (e.g. `ss ... | head`) are built in code, never from model input.

## 5. Sudo

- By default `ARCH_MCP_ALLOW_SUDO=0`: any argv with `sudo`/`su`/`doas`/`pkexec` is
  rejected.
- With `ARCH_MCP_ALLOW_SUDO=1`, the transport prefixes `sudo -n` to commands; SSH is still
  the same user. The remote side needs NOPASSWD rules.
- `ARCH_MCP_SUDO_ALLOW` limits binaries or prefixes (`useradd`, `systemctl restart`); empty
  means everything (only for an administration host).
- The sudo password is never requested or stored: without NOPASSWD the tool returns `E_PERM`.

## 6. Secrets

- Environment only: `ARCH_MCP_PASSWORD`, `ARCH_MCP_KEY`, `ARCH_MCP_PASSPHRASE`.
- They are never accepted as tool parameters and never written to logs.
- `audit` redacts keys that contain `pass`, `token`, `key`, `secret`.
- The process does not write credentials to disk.

## 7. Audit

JSONL file at `~/.local/state/arch-mcp/audit.jsonl` (configurable). One line per call:

```json
{"ts":"2026-11-12T03:11:00Z","tool":"svc_action","args":{"unit":"nginx.service","action":"restart"},
 "mode":"write","decision":"allow","confirmed":true,"ms":812,"exit":"OK"}
```

- Rotation by size (5 MB, 3 files).
- It never contains command output or file contents: `content`, `stdout` and `stderr` are
  redacted along with `pass`, `token`, `key` and `secret`.
- `ARCH_MCP_AUDIT=0` disables it (not recommended). If the file cannot be written, the
  server warns once on stderr and keeps working.

## 8. Rate limit

- Global limit: 30 calls/minute (`ARCH_MCP_RATE_LIMIT`). When exceeded, `E_POLICY` is
  returned with a `hint`; nothing is executed.
- `job_start`: at most 3 active jobs.
- A `raw_exec`, `exec_any` or `script_run` counts double.
- Verified: 56 consecutive calls with the default limit start returning `E_POLICY` after the
  30th.

## 9. Untrusted input

All command output is data, never instruction. Concrete measures:

- ANSI sequences and control characters are stripped (except `\n` and `\t`).
- Any line > 2000 characters is truncated.
- Log messages are returned as `msg`, without markdown.
- Tools do not interpret the content (no "if the log says X, run Y").

## 10. Pre-release checklist

- [ ] `readonly` cannot execute any mutation (test).
- [ ] Denylist tested with 30 dangerous commands (table test).
- [ ] `token` expires and cannot be reused (test).
- [ ] There is no `exec` with strings built by concatenation.
- [ ] Audit contains no secrets (grep test).
- [ ] `raw_exec` off by default and blocked in `readonly`.
- [ ] `exec_any` and `script_run` off by default, admin + opt-in only.
- [ ] The log gap redacts flags and credentials (test).
- [ ] `fs_remove`, `usr_action` and `fw_rule` reject critical paths/users (test).
