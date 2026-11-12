# 03 - Tool catalog

113 tools across 14 domains. `core` = 12, `readonly` = 66, `full` = 113.

Column legend:

- **Params**: exact names (snake_case).
- **Bytes**: typical size of `data` in the reasonable worst case.
- **A**: annotations - `R` readOnly, `D` destructive, `I` idempotent, `O` openWorld.

### `core` profile (12)

`sys_info`, `sys_status`, `svc_list`, `svc_status`, `svc_failed`, `log_query`,
`log_errors`, `pkg_status`, `fs_usage`, `net_ports`, `proc_list`, `host_capabilities`.

> Status: the `full` profile registers **113/113** tools and `readonly` **66/66**;
> `core` is 12. Profiles are selected with `ARCH_MCP_PROFILE`.

---

## sys_ - system (7)

| Tool | What it answers | Params | Output | Bytes | A |
|---|---|---|---:|---|
| `sys_info` | Host identity and capabilities | - | host, kernel, distro, arch, uptime_s, virt, cpu{}, mem{} | 400 | R |
| `sys_status` | "How is the server doing?" in one call | `detail` | load, mem%, swap%, disks[], failed_units, updates, reboot_required, temp_max, top[] | 900 | R |
| `sys_metrics` | Snapshot with deltas (CPU, IO, network) | `window_ms` (300-3000) | cpu_total, cpu_core[], mem, swap, io{}, net{} | 700 | R |
| `proc_list` | Filtered/sorted processes | `filter`, `sort`(cpu\|mem\|pid), `limit`(≤50) | [{pid,user,cpu,mem,rss,cmd}] | 2500 | R |
| `proc_kill` | Signal to a process | `pid`, `signal`(TERM), `dry_run`(false), `token` | {pid, signal, result} | 120 | D |
| `proc_renice` | Change priority | `pid`, `nice`, `dry_run`, `token` | {pid, nice} | 100 | D |
| `sys_services_summary` | Summary of units by state | - | {total, running, failed, inactive} | 150 | R |

**sys_status** (core) - the most used tool. It returns only the abnormal plus the essential:

```json
{"load":[0.4,0.3,0.2],"mem":{"used_pct":31.2,"avail_b":10911000000},
 "swap":{"used_pct":0},"disks":[{"mount":"/","use_pct":42}],
 "failed_units":0,"reboot_required":false,"updates":0,"temp_max_c":48,
 "top":[{"name":"node","cpu_pct":3.1},{"name":"dockerd","mem_pct":2.0}]}
```

Rule: if `failed_units=0` and `reboot_required=false`, the agent already knows the host is
healthy without reading further. That is the saving.

**`sys_info` measurement (phase 0):** against `arch-systemd` (2026-11-12): `data` 245 B,
full envelope 323 B, 94 ms, a single grouped SSH call of 8 commands. Reasonable worst case
(long CPU name + 64 cores): ~400 B. It replaces `hostnamectl --json=short` (1.4 KB) + `uname`
+ `/proc/*` + `lscpu -J` (4.6 KB).

**Phase 1 measurements** (`arch-systemd`, 2026-11-12, full envelope):

| Tool | Case | Bytes | ms |
|---|---|---:|---:|
| `sys_status` | concise / detailed | 366 / 695 | 250 |
| `sys_metrics` | window 500 ms | 303 | 528 |
| `proc_list` | limit 5 | 522 | 9 |
| `svc_list` | state=all, limit 20 | 1397 | 24 |
| `svc_list` | state=failed, no failures | 103 | 8 |
| `svc_status` | sshd.service | 243 | 13 |
| `svc_failed` | no failures | 99 | 10 |
| `svc_timers` | 3 timers | 524 | 13 |
| `svc_unit_file` | sshd.service | 482 | 15 |
| `host_capabilities` | full host | 697 | 15 |

`log_*` returns `[]` and ~90 B in the local environment because journald is masked;
its bytes with real entries are measured in phase 5 with the synthetic fixtures.

**`sys_status` rules:** `reboot_required` only looks at the `/var/run/reboot-required` flag;
`disks` collapses bind mounts of the same device and drops pseudo-mounts (`/run`, `/dev`,
`tmpfs`) so it does not return container noise.

**Phase 2 measurements** (`arch-systemd`, 2026-11-12, full envelope):

| Tool | Case | Bytes | ms |
|---|---|---:|---:|
| `pkg_status` | up to date, no AUR | 173 | 253 |
| `pkg_search` | "bash", 5 results | 671 | 191 |
| `pkg_info` | bash installed | 518 | 12 |
| `pkg_owns` | /usr/bin/bash | 140 | 10 |
| `net_status` | eth0 + route + DNS | 245 | 8 |
| `net_ports` | port 22 | 217 | 9 |
| `net_conns` | SSH session | 134 | 8 |
| `net_check` | 127.0.0.1:22 | 97 | 11 |
| `net_dns` | localhost | 145 | 9 |
| `fs_usage` | real mounts only | 191 | 14 |
| `fs_ls` | /etc, 10 entries | 964 | 7 |
| `fs_find` | *.conf, 5 results | 521 | 7 |
| `fs_read` | /etc/pacman.conf, 10 lines | 370 | 7 |

`fs_usage` also filters **file bind mounts** (`/etc/hosts` and similar) with
`findmnt -rn -o TARGET` + `[ -d "$t" ]`: without that, a container returns four "disks"
that are actually host files.

**Phase 3 measurements** (`arch-systemd`, 2026-11-12, full envelope):

| Tool | Case | Bytes | ms |
|---|---|---:|---:|
| `hw_summary` | CPU + disks, no sensors | 252 | 33 |
| `hw_sensors` | no lm-sensors data | 89 | 6 |
| `hw_gpu` | no dedicated GPU | 80 | 25 |
| `hw_pci` | 5 devices | 750 | 24 |
| `hw_usb` | 2 container root hubs | 218 | 7 |
| `hw_power` | container, no battery | 90 | 14 |
| `boot_info` | kernel + cmdline + bootctl | 457 | 21 |
| `boot_time` | userspace only | 114 | 9 |
| `boot_blame` | top 5 | 323 | 212 |
| `usr_sessions` | logind masked | 79 | 6 |
| `usr_logins` | container wtmp | 98 | 7 |
| `sec_audit` | sshd + nft + lastb | 428 | 203 |
| `sec_ssh_config` | permitrootlogin | 130 | 9 |
| `net_firewall` | nftables, 6 rules | 304 | 7 |
| `net_wifi` | nmcli present, NetworkManager stopped | E_UNSUPPORTED | - |
| `fs_smart` | /dev/vda virtio: SMART not supported | E_UNSUPPORTED | - |
| `fs_mounts` | fstype=overlay | 277 | 7 |

Phase 3 acceptance: `hw_summary` 33 ms and 252 B (limit 400 ms / 1.5 KB); `sec_audit` detects
`PermitRootLogin prohibit-password` and the active nftables firewall.

`boot_info.cmdline` is truncated to 300 characters: on Docker Desktop it reaches ~500 B on
its own.

---

## svc_ - systemd (10)

| Tool | What it answers | Params | Output | Bytes | A |
|---|---|---|---:|---|
| `svc_list` | Filtered units | `state`(failed\|running\|all), `pattern`, `type`, `limit` | [{unit, active, sub, desc}] | 2000 | R |
| `svc_status` | Details of one unit | `unit` | state, main_pid, exec, restarts, mem_b, tasks, since, last_error | 700 | R |
| `svc_failed` | Failed units + last error | `lines`(10) | [{unit, since, exit, log[]}] | 1200 | R |
| `svc_action` | start/stop/restart/reload/enable/disable/mask | `unit`, `action`, `dry_run`, `token` | {unit, action, active, job_failed?, error?, ms} | 150 | D,I |
| `svc_timers` | Timers and next run | - | [{unit, next, last, activates}] | 800 | R |
| `svc_unit_file` | Unit content and drop-ins | `unit` | {path, content, dropins[{path,content}]} | 3000 | R |
| `svc_unit_write` | Create/replace a unit and daemon-reload | `unit`, `content`, `enable`, `token` | {unit, path, enabled} | 150 | D |
| `svc_unit_delete` | Disable and delete a unit | `unit`, `token` | {unit, deleted} | 100 | D |
| `svc_daemon_reload` | `systemctl daemon-reload` | `token` | {ok, units_reloaded} | 100 | D |
| `svc_timer_set` | Creates the `<name>.service` + `<name>.timer` pair with a validated `OnCalendar` | `name`, `schedule`, `command`, `description`, `enable`, `token` | {service, timer, next_elapse} | 180 | D |

**svc_failed** (core) - the one that saves the most time during incidents:

```json
{"count":0,"units":[]}
```

With one failure:

```json
{"count":1,"units":[{"unit":"nginx.service","since":"2026-11-12T03:10:22Z",
 "exit":"1/FAILURE","log":["..."]}]}
```

Implementation: `systemctl --failed --output=json --no-pager` (failed only, not 91 KB) +
`journalctl -u <unit> -n 10 -p err --output=json`, trimmed by the parser. The details
(`since`, `exit`) come from **one** `systemctl show <unit1> <unit2> ... -p Id -p Result` for
all units, not from one call per unit.

---

## cron - scheduled tasks (3)

| Tool | What it answers | Params | Output | Bytes | A |
|---|---|---|---:|---|
| `cron_list` | Entries, variables and invalid lines of a crontab | `user?`, `raw`(false) | {user, exists, count, entries[], env[], invalid[]} | 1500 | R |
| `cron_write` | Replaces the whole crontab (stdin, no shell) | `content`, `user?`, `dry_run`, `token` | {written, count, backup} | 200 | D |
| `cron_remove` | Deletes the crontab after backing it up | `user?`, `dry_run`, `token` | {removed, backup} | 150 | D |

- `cron_write` and `cron_remove` **back up** the previous crontab to
  `/tmp/arch-mcp-crontab-<ts>.bak` before touching anything.
- The content is sent over **stdin** (`crontab -`), never interpolated into the shell line.
- A `user` other than the SSH user requires root; otherwise `E_PERM` with a hint.
- NUL, CRLF and lines longer than 1000 characters are rejected (`E_POLICY`).
- `cron_list` returns `exists:false` when there is no crontab (it is not an error).

---

## kernel - modules and sysctl (8)

| Tool | What it answers | Params | Output | Bytes | A |
|---|---|---|---:|---|
| `mod_list` | Loaded modules (`lsmod`) | `filter`, `limit`(100) | [{name, size_b, used, by[]}] | 3000 | R |
| `mod_info` | `modinfo` of a module | `name` | {filename, license, description, depends, parm[]} | 4000 | R |
| `mod_load` | Loads a module | `name`, `token` | {module, loaded} | 120 | D |
| `mod_unload` | Unloads a module | `name`, `token` | {module, loaded} | 120 | D |
| `mod_blacklist` | Adds to `modprobe.d` and unloads | `name`, `unload`, `token` | {module, blacklisted, unloaded} | 150 | D |
| `sysctl_get` | Reads one parameter or all of them | `key?`, `limit`(200) | {key, value} / [{key, value}] | 6000 | R |
| `sysctl_set` | Applies at runtime and persists | `key`, `value`, `persist`, `token` | {key, value, persisted} | 120 | D |
| `kernel_log` | Kernel messages | `lines`(30), `priority` | [{ts, prio, msg}] | 4000 | R |

---

## log_ - journal (7)

| Tool | What it answers | Params | Output | Bytes | A |
|---|---|---|---:|---|
| `log_query` | Search with filters | `unit`, `priority`, `since`, `until`, `grep`, `limit`(50), `cursor` | [{ts, prio, msg}]; `detail=detailed` adds unit, pid, boot | 6700 | R |
| `log_errors` | Errors from the current boot, deduplicated | `limit`(30) | [{count, unit, msg, last_ts}] | 5200 | R |
| `log_boots` | List of boots | - | [{id, first, last}] | 1100 | R |
| `log_unit_tail` | Last N from a unit (convenience alias) | `unit`, `lines`(20) | [{ts, prio, msg}] | 3000 | R |
| `coredump_list` | Crashes recorded by systemd-coredump | `limit`(20) | [{time, pid, uid, signal, exe, size}] | 2500 | R |
| `coredump_info` | Details of a coredump | `pid` | {pid, info} (bounded text) | 8000 | R |
| `journal_vacuum` | Trims the journal by size or age | `max_size`/`max_time`, `token` | {before, after} | 200 | D |

**log_query** (core) trims each entry to 5 fields. `--output=json` brings ~40 fields and
63 KB per 50 lines; the parser leaves ~6.7 KB with the 50 from the real `dante` fixture
(messages of 40-120 characters). With short messages it drops to ~1.5 KB. That is the
contract: never 63 KB.

---

## pkg_ - pacman/AUR (12)

They are only registered if `pacman` exists. AUR if `yay`/`paru` are present.

| Tool | What it answers | Params | Output | Bytes | A |
|---|---|---|---:|---|
| `pkg_status` | Updates, sync, orphans, cache | - | {updates[n], last_sync, orphans, cache_b, aur} | 800 | R |
| `pkg_search` | Search packages | `query`, `source`(repo\|aur), `limit`(10) | [{name, version, repo, desc}] | 1500 | R,O |
| `pkg_info` | Installed/remote details | `name` | {name, version, size_b, deps[], required_by[], installed} | 1200 | R |
| `pkg_update` | Full upgrade | `dry_run`(true), `token` | dry: {updates, packages[]}; apply: {ok, ms, output} | 2000 | D |
| `pkg_install` | Install | `names[]`, `dry_run`, `token` | {installed[], size_b, ms} | 800 | D,O |
| `pkg_remove` | Uninstall (without orphan dependencies) | `names[]`, `dry_run`, `token` | {removed[]} | 500 | D |
| `pkg_owns` | Which package owns a file | `path` | {path, package, version} | 150 | R |
| `pkg_files` | Files a package installs (`pacman -Ql`) | `name`, `limit`(100) | {package, files[]} | 3000 | R |
| `pkg_clean` | Cleans the pacman cache (`-Sc`) | `token` | {freed_b, cache_after_b} | 150 | D |
| `pkg_sync` | Refreshes the databases (`-Sy`) | `token` | {synced} | 80 | D |
| `aur_search` | Searches the AUR with yay/paru | `query`, `limit`(10) | [{name, version, description}] | 1500 | R,O |
| `aur_install` | Builds and installs an AUR package | `name`, `token` | {package, installed} | 120 | D,O |

`pkg_status` is the one that replaces `checkupdates` when it is not installed:
`pacman -Qu` → if empty, `updates: []`; `pacman -Qdtq` → orphans;
`du -sb /var/cache/pacman/pkg` → cache.

---

## net_ - network (13)

| Tool | What it answers | Params | Output | Bytes | A |
|---|---|---|---:|---|
| `net_status` | Interfaces, IPs, route, DNS | - | ifaces[], default_route, dns[] | 2000 | R |
| `net_ports` | Listening ports + process | `port`, `proto`(tcp\|udp), `limit` | [{port, proto, addr, pid, proc}] | 2500 | R |
| `net_conns` | Established connections | `port`, `limit` | {count, by_proc[{proc,count}]} | 1200 | R |
| `net_check` | Does an endpoint answer? | `target`, `timeout_ms`(5000) | {ok, ms, error?} | 200 | R,O |
| `net_dns` | Resolve a name | `name`, `type`(A) | {name, answers[], resolver} | 400 | R,O |
| `net_wifi` | Wi-Fi status (nmcli) | - | {ssid, signal, rate, security, connected} | 300 | R |
| `net_wifi_action` | Enables/disables a saved connection (nmcli) | `connection`, `action`, `force`, `token` | {connection, action, active} | 150 | D |
| `net_firewall` | Summarized rules | - | {backend, default_policy, rules_count, sample[]} | 1500 | R |
| `net_ping` | Ping with loss and rtt | `host`, `count`(4), `timeout_ms` | {sent, received, loss_pct, rtt_ms} | 250 | R,O |
| `net_route` | Add/delete route | `action`, `destination`, `via`, `dev`, `metric`, `token` | {action, destination} | 150 | D,O |
| `net_dns_set` | Per-interface DNS (resolvectl) | `interface`, `servers[]`, `token` | {interface, servers} | 120 | D,O |
| `fw_rule` | Open/close port (ufw/firewalld) | `action`, `port`, `protocol`, `source`, `token` | {backend, action, port} | 150 | D,O |
| `net_link` | Brings an interface up (`ip link set up`); bringing it down is blocked | `interface`, `dry_run`, `token` | {interface, action, state} | 120 | D |

`net_ports` uses `ss -tunapH` and trims; `ss` is 13 KB and the detail of each socket is
not needed here.

`net_check` opens a TCP connection from **the host**, not from the agent machine, with
`timeout N bash -c 'exec 3<>/dev/tcp/"$1"/"$2"' _ host port`; the host and the port travel as
positional arguments, never interpolated into the script.

---

## fetch/http - transfer (2)

| Tool | What it answers | Params | Output | Bytes | A |
|---|---|---:|---:|---|
| `fetch_url` | Download http(s) to a file | `url`, `path`, `max_bytes`, `timeout_ms`, `sha256`, `token` | {url, path, bytes, sha256?} | 150 | D,O |
| `http_check` | Status/latency of a URL | `url`, `method`(HEAD), `timeout_ms`, `expect_status` | {status, ms, bytes, ok} | 150 | R,O |

`fetch_url` uses `curl` (or `wget`) with `--max-filesize` and verifies the sha256 if you pass
it. `http_check` does not fail on a 4xx/5xx: it returns the code and `ok` according to
`expect_status`.

---

## docker_ - containers (4)

| Tool | What it answers | Params | Output | Bytes | A |
|---|---|---|---:|---:|---|
| `docker_ps` | Which containers exist and in what state | `all`(true), `project`, `name`, `limit`(50), `cursor` | [{name, id, image, state, status, ports, project?, service?, health?}] | 4000 | R |
| `docker_logs` | Last lines of one container | `name`, `tail`(100), `since`, `timestamps`(false), `contains` | {name, tail, stdout[], stderr[], truncated} | 4000 | R |
| `docker_inspect` | One container in detail | `name` | {name, id, image, state, running, restart_policy, health?, ports{}, networks[], mounts[], env_count} | 500 | R |
| `docker_compose` | `up -d`, `down`, `restart`, `stop`, `pull` on a project | `dir`, `action`, `file?`, `services[]`, `build`, `remove_orphans`, `timeout_ms`, `dry_run`, `token` | {dir, action, services[], code, stdout, stderr, truncated, ms} | 400 | D,O |

The Compose file is detected from `dir` in **one** round trip (`compose.yaml`, `compose.yml`,
`docker-compose.yaml`, `docker-compose.yml`), the file name is validated and services are
appended as separate argv elements. The tool never builds a shell string, and `up` is always
detached. Labels and environment values are not returned: `docker_inspect` gives `env_count`
instead of the values, because registries and compose files put secrets there.

Container CLIs stay blocked for `exec` and `exec_any` (denylist rule `containers`); these four
tools are the only sanctioned path, and the `container-flags` rule keeps `--privileged`,
`--pid=host` and friends out even here.

---

## fs_ - storage (21)

| Tool | What it answers | Params | Output | Bytes | A |
|---|---|---|---:|---|
| `fs_usage` | Usage per real mount | `include_pseudo`(false) | [{mount, fstype, size_b, used_b, use_pct, inodes_pct}] | 1200 | R |
| `fs_ls` | List a directory | `path`, `hidden`, `limit`(50), `sort` | [{name, type, size_b, mtime}] | 3000 | R |
| `fs_find` | Search by name/size/date | `path`, `name`, `min_size`, `mtime_days`, `limit`(20) | [{path, size_b, mtime}] | 2500 | R |
| `fs_grep` | Search content (rg → grep) | `path`, `pattern`, `glob`, `fixed`, `ignore_case`, `hidden`, `max_results`(50) | {total, matches:[{path, line, text}]} | 3000 | R |
| `fs_read` | Read text | `path`, `offset`, `lines`(100) | {path, lines[], total_lines, truncated} | 6000 | R |
| `fs_write` | Write a file | `path`, `content`, `mode`, `dry_run`, `token` | {path, bytes, mode} | 150 | D |
| `fs_smart` | Disk health | `device` | [{device, model, health, temp_c, hours}] | 800 | R |
| `fs_mounts` | Filtered raw mounts | `fstype` | [{target, source, fstype, options}] | 2000 | R |
| `fs_mkdir` | Create a directory | `path`, `mode`(755), `parents`, `token` | {path, mode} | 100 | D |
| `fs_copy` | Copy a file/directory | `source`, `destination`, `recursive`, `preserve`, `overwrite`, `token` | {source, destination} | 120 | D |
| `fs_move` | Move/rename | `source`, `destination`, `overwrite`, `token` | {source, destination} | 120 | D |
| `fs_remove` | Delete a file/directory | `path`, `recursive`, `token` | {path, recursive} | 100 | D |
| `fs_chmod` | Change permissions | `path`, `mode`, `recursive`, `token` | {path, mode} | 100 | D |
| `fs_chown` | Change owner | `path`, `owner`, `recursive`, `token` | {path, owner} | 100 | D |
| `fs_symlink` | Create a symbolic link | `target`, `link`, `force`, `token` | {target, link} | 100 | D |
| `fs_archive` | Create/extract tar/tgz | `action`, `archive`, `source`, `destination`, `format`, `token` | {action, archive} | 150 | D |
| `fs_archive_list` | List entries of a tar | `archive`, `format`, `limit`(100) | {archive, entries[]} | 1500 | R |
| `fs_checksum` | Hash of a file | `path`, `algorithm`(sha256) | {path, algorithm, hash} | 150 | R |
| `fs_du` | Sizes under a directory | `path`, `depth`(1), `limit`(20) | [{path, size_b}] | 2000 | R |
| `fs_mount` | Mounts a filesystem on an existing directory | `source`, `target`, `fstype`, `options`, `token` | {target, source, fstype, options} | 200 | D |
| `fs_umount` | Unmounts a mount point | `target`, `lazy`, `token` | {target, mounted} | 120 | D |

`fs_usage` filters pseudo-mounts: `findmnt --json` is 69 KB and 95% noise.

---

## hw_ - hardware (6)

| Tool | What it answers | Params | Output | Bytes | A |
|---|---|---|---:|---|
| `hw_summary` | CPU, GPU, disks, temps, battery | - | {cpu, gpus[], disks[], temps{}, battery} | 800 | R |
| `hw_sensors` | Normalized raw sensors | `chip` | [{chip, sensor, value, unit}] | 1200 | R |
| `hw_gpu` | GPU (nvidia/amd/intel) | - | [{vendor, model, driver, temp_c, util_pct, mem_used_b}] | 800 | R |
| `hw_pci` | PCI devices | `filter` | [{slot, class, vendor, device, driver}] | 2500 | R |
| `hw_usb` | USB devices | - | [{bus, id, desc}] | 1200 | R |
| `hw_power` | Battery, AC, governor | - | {battery{}, ac, governor, profiles} | 400 | R |

---

## boot_ - boot (3)

| Tool | What it answers | Params | Output | Bytes | A |
|---|---|---|---:|---|
| `boot_info` | Kernel, bootloader, EFI, secure boot | - | {running_kernel, installed[], bootloader, efi, secure_boot} | 900 | R |
| `boot_time` | Boot time | - | {firmware_ms, loader_ms, kernel_ms, userspace_ms, total_ms} | 300 | R |
| `boot_blame` | What took the longest | `limit`(10) | [{unit, ms}] | 600 | R |

---

## usr_ / sec_ (7)

| Tool | What it answers | Params | Output | Bytes | A |
|---|---|---|---:|---|
| `usr_sessions` | Active sessions | - | [{user, tty, seat, since, remote}] | 600 | R |
| `usr_logins` | Recent logins and failures | `limit`(10) | {ok[], failed[]} | 1200 | R |
| `usr_action` | Create/delete/lock a user or group | `action`, `name`, `shell`, `groups`, `home`, `remove_home`, `token` | {action, name} | 100 | D,O |
| `usr_password` | Changes the password with `chpasswd` over stdin | `user`, `password`, `token` | {user, changed} | 80 | D |
| `usr_list` | Local users or groups (`getent`) | `type`, `filter`, `limit`(100) | [{name, uid, gid, home, shell}] | 3000 | R |
| `sec_audit` | Basic posture | - | {ssh_root_login, password_auth, firewall, world_writable[], failed_logins, updates} | 1500 | R |
| `sec_ssh_config` | `sshd -T` summarized | `key` | {key, value} | 300 | R |

---

## job_ - long-running processes (3)

| Tool | What it answers | Params | Output | Bytes | A |
|---|---|---|---:|---|
| `job_start` | Start an allowed command | `command`, `target`, `dry_run`(false), `timeout_s`, `token` | {job_id, started} | 200 | D |
| `job_status` | State and incremental output | `job_id`, `offset` | {state, exit_code, ms, output, next_offset} | 3000 | R |
| `job_kill` | Terminate | `job_id`, `token` | {job_id, state} | 120 | D |

They only accept commands from the jobs allowlist (`pkg_update`, `mkinitcpio`, `pacman -S`,
`reflector`, `updatedb`, `btrfs scrub`). Never arbitrary shells.

---

## exec - daily use and fallback (5)

| Tool | What it answers | Params | Output | Bytes | A |
|---|---|---:|---:|---|
| `exec` | Everyday binary from the allowlist | `argv[]`, `timeout_ms`, `max_bytes`, `dry_run`, `token` | {code, stdout, stderr, truncated, ms} | variable | D,O |
| `exec_any` | Any non-blocked binary (admin) | `argv[]`, `timeout_ms`, `max_bytes`, `dry_run`, `token` | {code, stdout, stderr, truncated, ms} | variable | D,O |
| `script_run` | Run inline code or a script | `language`, `source`\|`path`, `args[]`, `timeout_ms`, `keep`, `token` | {code, stdout, stderr, interpreter, path?, ms} | variable | D,O |
| `exec_gaps` | Which binaries the fallback used | `limit`(50), `binary` | {total, path, binaries[]} | 1200 | R |
| `gap_report` | Record a command run outside the MCP | `binary`, `argv[]`, `note`, `exit`, `dry_run` | {reported, path} | 100 | D |

`exec` is the middle layer: it covers `rg`, `fd`, `jq`, `yq`, `tar`, `rsync`, `curl`, `git`,
`croc`, checksums and similar without opening a shell. `exec_any` requires
`ARCH_MCP_ALLOW_ANY_EXEC=1` + `admin` and rejects shells and interpreters; `script_run` is the
sanctioned path for python/bash/node/perl/ruby and requires `ARCH_MCP_ALLOW_SCRIPTS=1` + `admin`.
Every execution leaves one line in the gap log (redacted argv) and, if
`ARCH_MCP_GAP_ENDPOINT` is set, it is sent to the collector. `exec_gaps` groups and `gap_report`
records whatever the agent ran over SSH outside the MCP.

---

## meta (2)

| Tool | What it answers | Params | Output | Bytes | A |
|---|---|---|---:|---|
| `host_capabilities` | What this host supports | - | {os, version, tools{}, features{}} | 700 | R |
| `raw_exec` | Escape hatch | `argv[]`, `token` | {code, stdout, stderr, truncated} | variable | D,O |

`raw_exec` is the **legacy** escape hatch: disabled unless `ARCH_MCP_ALLOW_RAW=1` **and**
`admin` mode. Even then it goes through the denylist and a binary allowlist (systemctl,
journalctl, pacman, ip, ss, df, cat, find...); `sh`, `bash`, `sudo` and `docker` are out. For
daily use `exec` is preferred; `raw_exec` is left for exceptional diagnosis. The argv is
validated element by element and is never interpolated into a shell string.

**Phase 4 measurements** (`arch-systemd`, 2026-11-12, `mode=write profile=full`):

| Tool | Case | Bytes | ms |
|---|---|---:|---:|
| `svc_action` | dry_run | 139 | 1 |
| `svc_daemon_reload` | dry_run | 97 | 1 |
| `svc_daemon_reload` | run with token | 97 | 12 |
| `fs_write` | dry_run | 142 | 1 |
| `fs_write` | 18 B written with token | 120 | 14 |
| `pkg_update` | dry_run | 106 | 255 |
| `pkg_install` | dry_run | 152 | 1 |
| `proc_kill` | dry_run | 123 | 10 |
| `job_start` | dry_run | 138 | 1 |

**Phase 7 measurements** (`arch-systemd` with ripgrep/python, 2026-11-12, `mode=admin`):

| Tool | Case | Bytes | ms |
|---|---|---:|---:|
| `exec` | `rg --version` with token | 205 | 9 |
| `fs_grep` | `/etc/ssh` + `PermitRootLogin` | 293 | 9 |
| `script_run` | `print(6*7)` inline | 130 | 14 |
| `exec_gaps` | 4 binaries used | 900 | 1 |

**Phase 8 measurements** (`arch-systemd`, 2026-11-12, `mode=admin`):

| Tool | Case | Bytes | ms |
|---|---|---:|---:|
| `fs_mkdir` | dry_run | 143 | 1 |
| `fs_copy` | dry_run | 181 | 1 |
| `fs_archive` | dry_run create | 191 | 1 |
| `fs_checksum` | /etc/hostname | 196 | 1 |
| `fs_du` | /etc, 3 entries | 217 | 1 |
| `net_ping` | 127.0.0.1 ×2 | 182 | 1 |
| `net_route` | dry_run add | 165 | 1 |
| `usr_action` | dry_run create | 137 | 1 |
| `fetch_url` | dry_run | 184 | 1 |
| `http_check` | connection error | 193 | 2000 |

`tools/list` with `profile=full` registers **113** tools, exactly the catalog.

**Phase 9 measurements** (`arch-systemd`, 2026-11-12, `mode=admin` + sudo):

| Tool | Case | Bytes | ms |
|---|---|---:|---:|
| `proc_renice` | dry_run | 114 | 1 |
| `fs_symlink` | dry_run | 156 | 1 |
| `net_dns_set` | dry_run | 138 | 1 |
| `svc_unit_write` | dry_run | 207 | 1 |
| `svc_unit_delete` | dry_run | 181 | 1 |

**Phase 10 measurements** (`arch-mcp` fixtures, 2026-11-12, no host contact):

| Tool | Case | Bytes | ms |
|---|---|---:|---:|
| `docker_ps` | 3 containers, Compose labels | 581 | - |
| `docker_logs` | 50 lines with timestamps | 2175 | - |
| `docker_inspect` | running container, 3 env vars | 488 | - |

Phase 4 acceptance verified end to end: in `readonly` the six mutations return `E_POLICY`; in
`write` without a token they return `ok: true` with `confirm_required` and nothing runs; with
the token they run once, and a reused token returns `E_CONFIRM`. The audit records
`allow`/`deny`/`confirm`/`preview` and does not contain tokens or file contents.

---

## MCP resources

| URI | Content |
|---|---|
| `arch://rules` | Host rules (ports, critical services, what not to touch) - user specific |
| `arch://capabilities` | Output of `host_capabilities` |
| `arch://cheatsheet` | Equivalent commands: which tool to use for which task |

`arch://rules` is what replaces the "operational" half of a skill: it is read once and
holds the decisions (e.g. "do not restart `docker` without warning", "ports 30000-35000").

---

## What is NOT implemented

- `run_shell` with `bash -c` as the main tool: the fallback is `exec` (argv, no shell) and
  `script_run` (admin, opt-in).
- One tool per binary (`ls`, `cat`, `systemctl status`...).
- `man`, `--help`, embedded documentation.
- `.zip` archives (tar/tgz only; `zip`/`unzip` via `exec` if installed).
- Docker/containers (separate MCP).
- Installing AUR packages with compilation as part of `pkg_install` (that is `job_*`).
