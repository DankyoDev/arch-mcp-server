# 06 - Testing

Three environments, from least to most risk. Something destructive is **never** tested on the real host.

> Development **does not depend** on `dante`. The whole MCP can be built and validated against
> a local Linux (WSL2 or a container). The real host is only used at the end, for fixtures and
> integration.

## 0. Windows: development environment

The agent machine is Windows. The MCP runs there (Node), but the **target** must be Linux.

### 0.1 Chosen: Docker Desktop (Hyper-V/VMM backend) + `dev/`

The repository ships a ready-made environment in `dev/`:

| Service | Port | Purpose |
|---|---|---|
| `arch-ssh` | `127.0.0.1:2222` | SSH transport, parsers, pacman, user commands |
| `arch-systemd` | `127.0.0.1:2223` | real systemd: units, timers, sockets, `--output=json` |

```bash
cd dev
docker compose up -d --build
ssh -i ssh/id_test -p 2222 root@127.0.0.1
ssh -i ssh/id_test -p 2223 root@127.0.0.1
```

Details and limitations in `dev/README.md`. Summary:

- `arch-systemd` runs `privileged` **inside the disposable Docker Desktop VM**, with
  `cgroup: private`. Never `cgroupns=host`.
- `systemd-journald` and `dbus-broker` are masked: the VM does not expose the audit
  netlink (`EUNATCH`). `journalctl` returns no entries, so log tests use
  **fixtures** from the real host.
- `systemctl`, timers, sockets and `--output=json` work normally.

### 0.2 Alternative: WSL2 + Arch

If you prefer systemd with a real journal:

```powershell
Add-AppxPackage .\ArchWSL-AppX_x64.appx   # github.com/yuk7/ArchWSL/releases
wsl --shutdown
```

`/etc/wsl.conf` -> `[boot] systemd=true`. Inside: `pacman -Syu --noconfirm nodejs npm openssh
lm_sensors` and `systemctl enable --now sshd`.

### 0.3 What cannot be tested locally

- Exact outputs from `dante` (systemd 262.2, 39 containers, the friend's network).
- `pacman` with the real package/update state.
- Cloudflare Access and the `ProxyCommand` of `cloudflared`.
- The evals against the real host.

That is captured as **fixtures** once the server comes back; the code does not change.

## 1. Arch container (user commands)

To validate parsers and commands that do not need systemd:

```bash
docker run --rm -it --cgroupns=private \
  -v "$PWD/test/fixtures:/fixtures" archlinux:base bash
```

Inside:

```bash
pacman -Sy --noconfirm procps-ng iproute2 findmnt coreutils util-linux
```

- **Without** `--privileged`.
- **Without** `--cgroupns=host` (see the 2026-11-12 incident in `docs/05-security.md` §4).
- Without `--pid=host`, without `--net=host`.

Works for: `lscpu`, `lsblk`, `findmnt`, `df`, `free`, `ps`, `ip -j`, pacman parsers.

## 2. Real systemd without risking the host

Two valid options, in order of preference:

### 2.1 systemd-nspawn (recommended)

```bash
sudo pacman -S --needed arch-install-scripts
sudo mkdir -p /var/lib/machines/arch-test
sudo pacstrap -c /var/lib/machines/arch-test base
sudo systemd-nspawn -D /var/lib/machines/arch-test --boot
```

- Complete, isolated systemd system.
- Can be destroyed and recreated.
- Does not share cgroups with the host (nspawn creates its own hierarchy).

### 2.2 Disposable QEMU VM

```bash
qemu-img create -f qcow2 arch.qcow2 8G
# boot from the Arch ISO, minimal install, snapshot before each test
```

Slower, but it is the only environment for testing `pacman -Syu`, `mkinitcpio`, `bootctl`.

### 2.3 What is NOT done

```bash
# FORBIDDEN: container systemd with host cgroups
docker run -d --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  archlinux:latest /usr/lib/systemd/systemd
```

That is what brought the server down on 2026-11-12. It is not repeated.

## 3. Real host (`dante`)

Read-only, and only after the tool passes in a container/nspawn.

- Connect with the MCP in `ARCH_MCP_MODE=readonly`.
- The read tools are run and their outputs are saved as fixtures.
- Never `pkg_update`, `svc_action`, `fs_write` or `job_start` against production.
- If a mutation must be tested: nspawn or VM.

## 4. Fixtures

Structure:

```
test/fixtures/
├── systemctl-failed.json
├── journalctl-50.json
├── pacman-qi-bash.txt
├── sensors.json
└── ...
```

Each fixture is `{cmd, exit, stdout, stderr, captured_at, host}`. The parser tests
consume the fixture and compare against the expected object. That way the tests are fast,
deterministic and need no network.

Rule: if a parser changes, the fixture is updated **and** the diff is reviewed.

## 5. Tests per layer

| Layer | Type | Tool |
|---|---|---|
| `parse/` | unit with fixtures | `node:test` |
| `exec/quote` | case table (quotes, `$`, spaces, `;`) | `node:test` |
| `policy/*` | table of allowed/denied commands | `node:test` |
| `tools/` | integration with a fake server (connection mock) | `node:test` |
| E2E | real Arch container | `test/e2e.sh` script |

Target coverage: 100% in `policy/` and `quote.ts`; ≥ 80% in `parse/`.

## 6. Evaluations (what measures whether it is useful)

20 real tasks, run against the host in `readonly`. Measured: calls, tokens,
errors and hit rate.

1. "Is the server healthy?" -> 1 call (`sys_status`).
2. "Why did nginx fail?" -> `svc_failed` (+ `log_query` if needed).
3. "How much free RAM is there and which process is using it?" -> `sys_status` + `proc_list`.
4. "Are there pending updates?" -> `pkg_status`.
5. "What is using up the disk?" -> `fs_usage` (+ `fs_find` if detail is asked for).
6. "Is 8080 listening?" -> `net_ports`.
7. "Why won't service X start?" -> `svc_status` + `log_query`.
8. "When was the last boot and how long did it take?" -> `boot_info` + `boot_time`.
9. "Is the firewall active?" -> `sec_audit`.
10. "Which kernel do I have and which ones are installed?" -> `boot_info`.
11. "Is it overheating?" -> `hw_summary`.
12. "Which timer runs next?" -> `svc_timers`.
13. "Who is logged in?" -> `usr_sessions` + `usr_logins`.
14. "Which package owns /usr/bin/foo?" -> `pkg_owns`.
15. "Are there errors in the last hour's journal?" -> `log_query`.
16. "Which units are failed?" -> `svc_failed`.
17. "Does 1.1.1.1 respond?" -> `net_check`.
18. "Which DNS do I use?" -> `net_status`.
19. "Is a reboot pending?" -> `sys_status`.
20. "Which disks are degraded?" -> `fs_smart` + `sys_status`.

Success criterion: ≤ 2 calls per task and ≤ 1.5k tokens on average. If a typical task
needs 5 calls, the catalog is wrong.

**Measured result (phase 5, `arch-systemd`, 2026-11-12):** all 20 tasks, run with
`pnpm measure` against `profile=full`:

| Metric | Value | Limit |
|---|---:|---:|
| Maximum calls per task | 2 | 2 |
| Average tokens per task | **77** | 1500 |
| Most expensive task | 227 tokens (sys_status + proc_list) | - |
| Parameter errors | 0 | 0 |

Task 20 returns `E_UNSUPPORTED` in `fs_smart` because the container has no
`smartmontools`; the error envelope (174 B) also fits the budget and the eval treats it
as a valid response (not as a parameter error).

**Measurement on the real host (`dante`, Arch, 2026-11-12, `profile=full`):** 20/20 tasks
solved, **291 tokens on average**, a maximum of 2 calls and 0 parameter errors. The real
host is more expensive than the container (77 tokens) because it returns real data (more
units, more disks, a journal with history); the 1.5k limit is met with room to spare.

Comparison with the raw baseline in `docs/01-research.md` §5.2 (units + journal +
mounts): **224 793 B ≈ 56 198 tokens** versus 373 B (1 call to `sys_status`) and 191 B
(`fs_usage`).

**Cost of the definitions (measured in phase 9).** The previous baseline is the cost of doing
the work without an MCP; it is not what the catalog takes up in context. A full `tools/list` measures:

| Profile | Tools | Definitions | Name + description |
|---|---:|---:|---:|
| `core` (default) | 12 | 8 648 B ≈ 2 200 tokens | 1 982 B ≈ 500 tokens |
| `readonly` | 63 | 38 267 B ≈ 9 600 tokens | 9 080 B ≈ 2 300 tokens |
| `full` | 109 | 80 042 B ≈ 20 000 tokens | 16 012 B ≈ 4 000 tokens |

These are `bytes/4` estimates; a real tokenizer gives 20-30% more in the worst case. With Code
Mode the definitions are loaded on demand; without it, `core` keeps the fixed cost at ~2k
tokens. `arch://cheatsheet` is a resource and only takes up context if the agent reads it.

## 7. Token measurement

Script `test/measure.ts`:

- Runs each task from §6 against the host.
- Adds up `JSON.stringify(result).length / 4` per call.
- Compares with the raw `ssh` equivalent (cookbook commands).
- Fails the build if the average goes up > 20% over the baseline.

Usage: `ARCH_MCP_HOST=... ARCH_MCP_PORT=... ARCH_MCP_USER=... ARCH_MCP_KEY=... pnpm measure`.

Initial baseline (measured in `docs/01-research.md` §5.2): 225 KB for the three most common
queries.

## 8. CI

- `pnpm test` -> unit tests (no network), including the HTTP auth ones with a local `fetch`.
- `pnpm test:e2e` -> Arch container (only in CI with Docker).
- `pnpm lint` -> `tsc --noEmit` (there is no eslint, the type is the linter).
- No CI that touches the real host.

Current implementation: `pnpm test` runs 313 tests without network; `pnpm measure` is the eval
against a host (dev or real in readonly) and does not run in CI. `pnpm audit:tools` calls the 101
audit entries (all the tools with `dry_run` in mutations) against a host and
fails if any of them returns an unexpected error.

**Real verification (phase 6, `arch-systemd`):** besides the audit, the following were run with
real data: `svc_action` (stop/start/restart with token), a unit that fails
(`job_failed`), drop-ins, `proc_kill` with a real signal, `pkg_remove`/`pkg_install`,
`job_start` + `job_status` of `updatedb` (exit 0) and `raw_exec`. The containers are left
clean (`reset-failed`, no test units).

`pkg_update` was run in full (`E_CONFIRM` -> `pacman -Syu --noconfirm`, exit 0, 5.8 s) in
a disposable container created from the same image and removed when it finished, without touching
`arch-ssh` or `arch-systemd`. Since the image was up to date, the output was
`there is nothing to do`; what was validated is the flow, the timeout and the parsing of the result.

**HTTP transport (phase 6):** `test/http.test.ts` starts the server on an ephemeral port and
checks 401 without a token / with a wrong token, 200 with the right token, the no-token mode and the
404 outside `/mcp`. It was also tested by hand against the container with `ARCH_MCP_HTTP_TOKEN`.

**Real journal (2026-11-12):** `journal-50`, `journal-errors`, `journal-boots`
and `journal-unit-sshd` were captured from `dante` with `ssh` in read-only mode (redacting IPs, SSH
fingerprints and MACs). The fixtures carry `host: "dante"`, `synthetic: false` and `redacted`. The
capture uncovered a real bug: `parseBoots` only understood the em dash separator of the synthetic
fixtures and returned `[]` with the real format of `journalctl --list-boots` (dates separated by a
space and with the `-05` zone). Fixed and covered with both formats.

**Fallback (phase 7, ADR-021):** `test/exec.test.ts` covers the allowlist, confirmation, the denylist
of `find -exec`, interpreters blocked in `exec_any`, `script_run` with write/execute/cleanup
and the gap log redaction. `test/fs-grep.test.ts` covers `rg --json`, the fallback to
`grep` and the error mapping. The `scripts/gap-receiver.mjs` collector is tested by hand with
`curl` against `POST /report`.

It was also really tested against `arch-systemd` (2026-11-12) with `python`, `ripgrep`, `fd` and
`jq` installed: `exec` ran `rg --version`, `fs_grep` returned 2 real matches for
`PermitRootLogin`, `script_run` ran `print(6*7)` -> `42`, `exec_any` ran `uname -r` and
`exec_gaps` showed the 4 binaries used. The gap log was left in `/tmp` and was not versioned.

**Daily operations (phase 8):** in the same container `/tmp/arch-mcp-daily` was created, copied,
renamed, archived, extracted, had its permissions/owner changed and was deleted; `fs_checksum` returned the
sha256; `fs_du` sorted by size; `fetch_url` downloaded 16 B from a local HTTP with a verified sha256;
`http_check` returned 200/5 ms; `net_ping` showed 0% loss; `usr_action`
created, locked and deleted `archmcptest`; `net_route` added and removed `203.0.113.0/24` through `lo`.
`fw_rule` returned `E_UNSUPPORTED` because the container has no ufw/firewalld (tested with a
simulated connection in the tests).

**Root and extras (phase 9):** `pnpm audit:tools` with `ARCH_MCP_ALLOW_SUDO=1` passed the 101
calls (the container already runs as root, so `sudo -n` is transparent). The following were tested:
`fs_symlink` (link to `/etc/hostname`, read and checksum through the link), `proc_renice`
on PID 1, `net_dns_set` in `dry_run` and `log_query` with `since: "-1h"`. The
`SudoConnection` wrapper has its own tests for prefix, sections and `ARCH_MCP_SUDO_ALLOW`.

A real unit was also created and deleted (`arch-mcp-real-test.service`): `svc_unit_write` +
`svc_status` (`inactive`) + `svc_unit_file` + `svc_unit_delete` + `svc_status` (`E_NOTFOUND`).
