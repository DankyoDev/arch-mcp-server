# 13 - Command coverage (living map)

There is no useful list of "every Linux command": there are thousands, they change per distro
and any installed app adds more. This document is a map of what **we actually use**, not an
exhaustive inventory. The source of real demand is `exec_gaps`: every binary the agent has to
run through the fallback shows up there.

Promotion rule:

1. A binary shows up several times in `exec_gaps`.
2. A native tool is implemented (or a recipe with a parser).
3. A fixture/test is added and it is noted here.
4. The binary stops being a fallback for that task.

## Status

| Status | Meaning |
|---|---|
| **Native** | MCP tool with parsed output. |
| **Exec** | Allowed in `exec` (argv, no shell, confirmation). |
| **Admin** | `exec_any`/`script_run` only (admin + opt-in). |
| **Out** | Blocked by the denylist or deliberately out of scope. |

## System and processes

| Command | Status | Tool / note |
|---|---|---|
| `uname`, `hostname`, `nproc`, `lscpu` | Native | `sys_info`, `host_capabilities` |
| `free`, `uptime`, `/proc/stat` | Native | `sys_status`, `sys_metrics` |
| `ps`, `top` (snapshot) | Native | `proc_list` |
| `kill`, `pkill` | Native | `proc_kill` (explicit signal) |
| `renice` | Native | `proc_renice` (token) |
| `sudo` | Transport | `ARCH_MCP_ALLOW_SUDO=1` + NOPASSWD; it is not a tool |
| `systemctl` (list/show/failed) | Native | `svc_list`, `svc_status`, `svc_failed`, `svc_timers` |
| `systemctl start/stop/restart` | Native | `svc_action` (token) |
| create/edit units | Native | `svc_unit_write`, `svc_unit_delete`, `svc_timer_set` (token) |
| `journalctl` | Native | `log_query`, `log_errors`, `log_boots`, `log_unit_tail` |
| `dmesg` | Native | `kernel_log` (journalctl -k, dmesg fallback) |
| `lsmod`, `modinfo`, `modprobe` | Native | `mod_list`, `mod_info`, `mod_load`, `mod_unload`, `mod_blacklist` |
| `sysctl` | Native | `sysctl_get`, `sysctl_set` (token; persists in `/etc/sysctl.d`) |
| `coredumpctl` | Native | `coredump_list`, `coredump_info` |
| `journalctl --vacuum-*` | Native | `journal_vacuum` (token) |
| `crontab` | Native | `cron_list`, `cron_write`, `cron_remove` (token; backup in `/tmp`) |
| `systemd-run`, `at` | Admin | requires validation before nativizing |

## Packages (Arch)

| Command | Status | Tool / note |
|---|---|---|
| `pacman -Qu/-Qdtq/-Qi/-Ss/-Qo` | Native | `pkg_status`, `pkg_info`, `pkg_search`, `pkg_owns` |
| `pacman -S/-R/-Syu` | Native | `pkg_install`, `pkg_remove`, `pkg_update` (token) |
| `pacman -Ql`, `-Sc`, `-Sy` | Native | `pkg_files`, `pkg_clean`, `pkg_sync` (token) |
| `checkupdates` | Native | built into `pkg_status` |
| `yay`/`paru` | Native | `aur_search`, `aur_install` (token); updates in `pkg_status` |
| `makepkg` | Admin | AUR build; not automated |
| `apt`, `dnf`, `zypper` | Out | this MCP is Arch-first |

## Network

| Command | Status | Tool / note |
|---|---|---|
| `ip addr`, `ip route` (read) | Native | `net_status` |
| `ss -tulnp`, `ss -tunap` | Native | `net_ports`, `net_conns` |
| `getent`, `resolvectl` | Native | `net_dns` (read), `net_dns_set` (write) |
| `ping` | Native | `net_ping` |
| `curl` (download) | Native | `fetch_url` |
| `curl` (HTTP status) | Native | `http_check` |
| `ip route add/del` | Native | `net_route` (token; does not touch default) |
| `ip link set up` | Native | `net_link` (token); `down` blocked by the `network-down` rule |
| `ufw`, `firewall-cmd` | Native | `fw_rule` (token; nftables read-only) |
| `nft` (write) | Out | `net_firewall` only reads; edit by hand |
| `nmcli` (connect/disconnect) | Native | `net_wifi_action` (token; does not drop the active connection without `force`) |
| `traceroute`, `mtr` | Exec | add to the allowlist if used |
| `iperf3`, `speedtest` | Admin | not implemented |
| `tcpdump` | Admin | not implemented |

## Files and text

| Command | Status | Tool / note |
|---|---|---|
| `ls`, `stat`, `find` | Native | `fs_ls`, `fs_find` |
| `rg`, `grep` | Native | `fs_grep` (`rg --json`, `grep` fallback) |
| `cat`, `head`, `tail`, `sed -n` | Native | `fs_read` |
| `tee`, file writes | Native | `fs_write` (stdin, no shell) |
| `mkdir`, `cp`, `mv`, `rm` | Native | `fs_mkdir`, `fs_copy`, `fs_move`, `fs_remove` |
| `chmod`, `chown` | Native | `fs_chmod`, `fs_chown` |
| `ln -s` | Native | `fs_symlink` |
| `tar`, `gzip` | Native | `fs_archive`, `fs_archive_list` |
| `sha256sum`, `sha512sum`, `md5sum`, `b2sum` | Native | `fs_checksum` |
| `du` | Native | `fs_du` |
| `df`, `findmnt` | Native | `fs_usage`, `fs_mounts` |
| `mount`, `umount` | Native | `fs_mount`, `fs_umount` (token; target must exist) |
| `fd` | Exec | `exec` (there is no specific tool yet) |
| `jq`, `yq` | Exec | `exec` |
| `bat`, `eza`, `dust`, `ncdu`, `tree` | Exec | `exec` (presentation; little gain from native) |
| `zip`, `unzip`, `7z` | Exec | `exec` (tar/tgz is the native path) |
| `rsync`, `scp`, `croc` | Exec | `exec`; native `croc` pending streaming |
| `patch`, `diff`, `comm`, `join` | Exec | `exec` |
| `awk`, `perl`, `python` | Admin | `script_run` (not `exec_any`) |

## Hardware, boot and security

| Command | Status | Tool / note |
|---|---|---|
| `lscpu`, `lsblk`, `lspci`, `lsusb` | Native | `hw_summary`, `hw_pci`, `hw_usb` |
| `sensors`, `nvidia-smi` | Native | `hw_sensors`, `hw_gpu` |
| `smartctl` | Native | `fs_smart` (E_UNSUPPORTED if the disk does not expose SMART) |
| `systemd-analyze`, `bootctl` | Native | `boot_time`, `boot_blame`, `boot_info` |
| `loginctl`, `last`, `lastb` | Native | `usr_sessions`, `usr_logins` |
| `getent passwd/group` | Native | `usr_list` |
| `sshd -T` | Native | `sec_ssh_config` |
| `useradd`, `usermod`, `userdel`, `groupadd` | Native | `usr_action` (token; not root/MCP user) |
| `passwd` | Native | `usr_password` (chpasswd via stdin; interactive `passwd` is still out) |
| `visudo`, `sudoers` | Out | never through the MCP |
| `fail2ban-client`, `lynis` | Admin | not implemented |
| `mkfs`, `dd of=/dev/*`, `wipefs` | Out | denylist |
| `shutdown`, `reboot`, `poweroff` | Out | denylist |

## Transfers and external apps

The pattern for an app we do not know is always the same:

```
host_capabilities            # is it installed?
exec ["croc","--version"]    # or exec_any in admin mode
exec ["croc","send","x"]     # real usage
exec_gaps                    # croc shows up
→ native tool or recipe      # once it repeats
```

`exec` covers `croc`, `curl`, `wget`, `rsync`, `scp`, `git` and `tar` with variable arguments.
Native `croc` is still pending because it needs to return the code before finishing; today
`exec` or `script_run` is used if it has to be orchestrated.

## Maintenance

- `pnpm audit:tools` must still report 0 unexpected failures.
- Every new tool updates `docs/03-tool-catalog.md` (params, output, bytes).
- Every promoted binary is removed from the fallback list in this document.
- If a command cannot be made safe, it stays **Out** and the reason is explained.
