# 09 - Command cookbook

Exact commands each tool implements, with their pitfalls. Verified on Arch
(kernel 7.2.15, systemd 262.2) on 2026-11-12.

Convention: on the remote host always export
`LANG=C LC_ALL=C SYSTEMD_COLORS=0 SYSTEMD_PAGER=cat`.

---

## 1. System

### Identity (`sys_info`)

```sh
cat /etc/os-release                     # PRETTY_NAME, VERSION_ID, ID
uname -r                                # kernel
uname -m                                # arch
cat /proc/uptime                        # uptime_s (first field)
cat /proc/loadavg                       # load 1/5/15
nproc --all
systemd-detect-virt                     # none | kvm | docker | ...
cat /proc/sys/kernel/hostname           # host
lscpu -J                                # CPU(s), Model name (fields with colons)
```

- Primary source: `/proc` + `/etc/os-release` + `uname` (ADR-015). `hostnamectl --json=short`
  is **not** used: it requires D-Bus and fails on minimal hosts or with `dbus-broker`
  masked.
- `sys_info` groups these commands into **one** call (`exec/sequence.ts`), not eight round
  trips.
- `systemd-detect-virt` exits with code ≠ 0 when it is `none`: do not treat it as an error.
- `lscpu -J` returns `"field": "CPU(s):"` and `"field": "Model name:"`, with colons; the
  parser strips them before comparing.

### Memory

```sh
cat /proc/meminfo   # MemTotal, MemAvailable, SwapTotal, SwapFree, Buffers, Cached
```

- Compute `used = MemTotal - MemAvailable` (not `MemFree`).
- Values in kB: multiply by 1024 before returning bytes.

### CPU

```sh
cat /proc/stat      # first line: cpu user nice system idle iowait irq softirq steal
```

- For a percentage: two samples separated by `window_ms` (300-3000) and compute deltas.
- `lscpu -J` (4.6 KB) only for `--detail`.

### Processes

```sh
ps -eo pid,ppid,user,pcpu,pmem,rss,stat,comm,args --sort=-pcpu
```

- `args` can be huge: cut to 80 characters in `concise`.
- `rss` comes in kB -> convert to bytes.
- `user` is truncated to 8 characters unless you set a width: `user:16=`. With `pid=`/`ppid=`
  and no column name (`=`) the header disappears and parsing is stable.
- `proc_kill`: `kill -SIGNAL pid`; validate that the pid exists and is not 1.

---

## 2. systemd

### Units

```sh
systemctl list-units --all --output=json --no-pager        # 91 KB - filter before serializing
systemctl list-units --failed --output=json --no-pager     # failed only
systemctl list-unit-files --output=json --no-pager         # 40 KB - only for svc_unit_file
```

Useful fields of the JSON: `unit`, `load`, `active`, `sub`, `description`.
Drop the rest.

- `--all` includes inactive units: use it only if `state=all` and still filter in the parser.
- `description` can be long: cut to 60 characters in `concise`.

### Detail of one unit

```sh
systemctl show <unit> \
  -p LoadState -p ActiveState -p SubState -p MainPID -p ExecMainStartTimestamp \
  -p NRestarts -p MemoryCurrent -p TasksCurrent -p UnitFileState -p FragmentPath \
  -p ExecMainStatus -p Result -p ExecStart \
  --no-pager
```

Output `key=value`. `MemoryCurrent` can be `[not set]` -> omit it.
`NRestarts` is cumulative since the unit started.

- **There is no `Unit` property**: to identify each block use `-p Id`. With
  `systemctl show a.service b.timer ...` the output is blocks separated by a blank line.
- A nonexistent unit does **not** fail: it returns exit 0 with `LoadState=not-found`. Check it
  before building the response.
- `ExecStart` brings `{ path=/usr/bin/sshd ; argv[]=... }`; the binary comes from `path=`.

### Failed units + error

```sh
systemctl list-units --failed --output=json --no-pager
journalctl -u <unit> -n 10 -p err --output=json --no-pager
```

- An empty `systemctl --failed` returns `[]` and exit 0.
- If the unit has no logs of its own, the journal can be empty: it is not an error.

### Timers

```sh
systemctl list-timers --all --output=json --no-pager
```

- **Verified on 262:** `--output=json` works and returns `next`/`last` in
  **microseconds** since epoch (`next`, `left`, `last`, `passed`, `unit`, `activates`).
  Convert to ISO 8601.
- Fallback if a version does not support it: `systemctl show <timer> -p NextElapseUSecRealtime
  -p LastTriggerUSec`.

### Actions

```sh
systemctl start|stop|restart|reload|enable|disable|mask|unmask <unit>
systemctl daemon-reload
```

- Only with `write` mode + token.
- `restart` of `ssh`, `sshd`, `systemd-*`, `dbus` -> denylist (it can lock you out).
- **`systemctl start` of a unit that fails returns exit ≠ 0** even if the command is correct.
  It is not `E_PERM`: you have to read `ActiveState` and return `active: failed` + `job_failed: true`
  with the first line of the error. `E_PERM` is reserved for `Access denied`.

---

## 3. Journal

```sh
journalctl --output=json --no-pager -n 50
journalctl -u <unit> --since "1 hour ago" -p err --output=json --no-pager
journalctl --list-boots --no-pager
```

Fields per entry (the only ones returned):

| journal field | Output |
|---|---|
| `__REALTIME_TIMESTAMP` (µs) | `ts` ISO 8601 |
| `PRIORITY` (0-7) | `prio`: emerg/alert/crit/err/warning/notice/info/debug |
| `_SYSTEMD_UNIT` | `unit` |
| `_PID` | `pid` |
| `MESSAGE` | `msg` |

- 63 KB per 50 lines -> always trim.
- `MESSAGE` can be a byte array if it carries binary: convert to a string or `<binary>`.
- `--since` accepts `"1 hour ago"`, ISO and `"today"`; normalize to ISO in the parameter.
- For `log_errors`: `-p err..alert`, deduplicate by `(unit, msg)` and count.

---

## 4. pacman / AUR

```sh
pacman -Qu                     # updates (empty = up to date; NOT an error)
pacman -Qdtq                   # orphans
pacman -Qqe | wc -l            # explicit packages
pacman -Qi <pkg>               # 1.4 KB, key : value format
pacman -Si <pkg>               # remoto
pacman -Ss <query>             # search (can be huge: limit it)
pacman -Qo <path>              # owner of a file
pacman -Ql <pkg>               # package files (limit to 100)
du -sb /var/cache/pacman/pkg   # cache size
```

- `pacman -Qi` has no JSON: parse `Field : value` blocks and translate the names.
- `pacman -Qo` prints `<path> is owned by <pkg> <version>` and exits with code 1 if nobody
  owns it.
- `pacman -Qdtq` also exits with code 1 when there are no orphans; empty + exit 1 = zero.
- Write errors: `target not found` -> `E_NOTFOUND`; `database is locked` ->
  `E_INTERNAL` with a retry hint; `Access denied` -> `E_PERM`. Do not return `E_PERM`
  for everything.
- `-Qu` may require `checkupdates` to avoid syncing the DB; if it is not there, use
  `pacman -Qu` (it changes nothing). **Empty + exit 1 = up to date or DB not refreshed**, it is
  not an error: `updates: 0`.
- AUR: if `yay`/`paru` exists, `yay -Qua` for AUR updates; if not, `aur: null`.
- `pkg_update` runs `pacman -Syu --noconfirm` with a 300 s timeout and two-step
  confirmation. For upgrades that may exceed that margin, use `job_start` with
  `command=pkg_update` and poll `job_status`.

---

## 5. Network

```sh
ip -j addr        # 29 KB - trim to ifname, operstate, mac, addr_info
ip -j route       # 1.2 KB - default route and gateway
ip -j link        # state and MTU
ss -tunapH        # 13 KB - listening + established, with process
ss -H -ltnp       # listening TCP only
resolvectl status # resolvers per interface (if systemd-resolved)
resolvectl query <name>
getent ahosts <name>   # glibc resolution, no resolvectl dependency
nmcli -t -f GENERAL.STATE,GENERAL.CONNECTION dev show <dev>
nmcli -t -f IN-USE,SSID,SIGNAL,RATE,SECURITY dev wifi
nft -j list ruleset   # JSON (if nftables)
```

- `ss` without root does not show the process of sockets owned by others: return `pid: null`
  in that case.
- **`ss` omits the state column** when you filter (`ss ... state established`): the line
  goes from 6 to 5 fields. The parser accepts both forms.
- `ip -j addr` brings IPv6 link-local: filter `scope link` in `concise`.
- `net_check`: TCP connect with a timeout; return `ms` and `ok`. Without `nc`/`curl`, use
  `bash -c 'exec 3<>/dev/tcp/"$1"/"$2"'` with host/port as `$1`/`$2`.
- DNS: `getent ahosts <name>` works with any resolution; `/etc/resolv.conf` gives the
  resolver.
- Cloudflare Access does **not** affect this: it is host traffic.

---

## 6. Disks and files

```sh
findmnt -J                    # 69 KB - filter pseudo-mounts
findmnt -J -b --output TARGET,SOURCE,FSTYPE,SIZE,USED,AVAIL,USE%   # no options (far less noise)
df -P -B1                     # 747 B, but does not cover btrfs subvolumes
df -P -i -B1                  # inodes per mount
lsblk -J -b                   # 1.5 KB, sizes in bytes
stat -c '%s %Y %F' <path>
find <dir> -maxdepth 1 -mindepth 1 -printf '%f\t%s\t%T@\t%y\n'   # fs_ls, without parsing ls
find <dir> -type f -name '*.conf' -printf '%p\t%s\t%T@\n'        # fs_find
du -sb <dir>                  # can be slow: limit depth
smartctl -j -H -A <dev>       # requires root; otherwise E_PERM with hint
```

- `findmnt` includes **file bind mounts** (`/etc/hosts`, `/etc/resolv.conf`, mounted keys).
  They are not storage: detect them with
  `findmnt -rn -o TARGET | while read -r t; do [ -d "$t" ] || echo "$t"; done` and exclude them.
- GNU find's `-printf` avoids parsing `ls -l` (names with spaces, local dates).
- `df -i` gives the inode percentage, which `findmnt` does not provide.

Pseudo-mount filter for `fs_usage`:

```
proc sysfs devtmpfs devpts tmpfs cgroup cgroup2 pstore bpf debugfs tracefs
securityfs configfs fusectl mqueue hugetlbfs autofs overlay squashfs
```

- `df` and `findmnt` disagree with btrfs: prefer `findmnt` for the mount point and
  `statvfs`/`df` for usage.
- `fs_read`: detect binary by a NUL in the first 512 bytes -> `E_UNSUPPORTED`.
- `fs_write` only with `write` + token; never in `/etc`, `/boot`, `~/.ssh`.

---

## 7. Hardware

```sh
lscpu -J                              # 4.6 KB
sensors -j                            # 808 B
lspci -mm -nn                         # quote-parseable
lsusb
cat /sys/class/thermal/thermal_zone*/temp
cat /sys/class/power_supply/*/capacity
cat /sys/class/power_supply/*/status
nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total \
           --format=csv,noheader,nounits
cat /sys/class/drm/card*/device/pp_dpm_sclk   # amdgpu (optional)
```

- `nvidia-smi` missing -> `gpus: []` and `hint` if there is an NVIDIA GPU in `lspci`.
- `sensors -j` groups by chip; normalize to a list. In containers it returns `{}` and **exit 1**:
  it is not an error, it is "no sensors".
- Temperatures in thousandths of a degree in sysfs -> divide by 1000.
- `lspci -mm -nn` quotes the fields: `slot "class [id]" "vendor [id]" "device [id]"`.
  Remove the trailing `[id]`; `lspci -k` gives the driver per slot.
- `smartctl -j -H -A` requires root; without smartmontools the tool returns `E_UNSUPPORTED`.
- `lsusb` may not be there (`usbutils` package): same policy.
- Battery: `/sys/class/power_supply/*/{capacity,status}`; without a battery there are no lines and the field
  is omitted.

---

## 8. Boot

```sh
systemd-analyze                 # 122 B: firmware, loader, kernel, userspace
systemd-analyze blame | head -n 10
bootctl status                  # only with EFI
cat /proc/cmdline
ls /boot
mokutil --sb-state              # secure boot (if present)
pacman -Q linux linux-lts      # installed kernels
```

- `bootctl` on BIOS says "Not booted with EFI": return `efi:false`, not an error.
- `systemd-analyze` may bring only `(userspace)` (containers): the absent phases are
  omitted and the total is computed by adding the present ones.
- `boot_blame` top 10; never the full listing.

---

## 9. Users and security

```sh
loginctl list-sessions --no-pager
last -F -n 10
lastb -n 10 2>/dev/null         # requires root for some records
sshd -T                          # requires root; otherwise parse /etc/ssh/sshd_config
passwd -S <user>                 # account status
find /etc -xdev -type f -perm -0002 2>/dev/null   # world-writable (limit it)
```

- `sshd -T` without root fails: fall back to reading the file and applying default values.
- `sshd -T` prints keys **in uppercase** (`PermitRootLogin`); the parser normalizes them to
  lowercase. If the binary does not exist, `E_UNSUPPORTED`.
- `lastb` empty because the record does not exist: `failed: []`.
- In `last`, boot rows have the TTY as `system boot` (two words); do not
  confuse them with logins.
- `loginctl list-sessions` empty with `systemd-logind` masked (containers): `[]`, not
  an error.
- `nft -j list ruleset` gives tables, chains and rules separately; the default policy is
  in the chain with `hook: "input"`.

---

## 10. Commands that are avoided

| Instead of | Use |
|---|---|
| `systemctl status` (text, colors) | `systemctl show -p` |
| `journalctl -xe` | `log_query`/`log_errors` |
| `top`/`htop` | `/proc/stat` + `ps -eo` |
| `df -h` | `findmnt -J` + `df -P -B1` |
| `free -h` | `/proc/meminfo` |
| `ifconfig` | `ip -j` |
| `netstat` | `ss -H` |
| `lsof -i` | `ss -tunapH` |
| `cat /etc/os-release` in every tool | cache it in `HostCapabilities` |
