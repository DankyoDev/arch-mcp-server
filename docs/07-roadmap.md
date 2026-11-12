# 07 - Roadmap

> Status 2026-11-12: **phases 0-10 complete**, tag `v0.7.0`. 113 tools, 337 tests without network,
> 20 evals averaging 291 tokens on the real host, HTTP with bearer token, MCP resources and CI on
> GitHub Actions.

Each phase ends with something runnable and measurable. You do not move on to the next one
without meeting the acceptance criterion.

## Phase 0 - Skeleton (0.5-1 day)

- [x] `pnpm init`, strict TypeScript, ESM, `tsx` for development.
- [x] `config.ts` with zod: host, port, user, password/key, mode, profile, limits.
- [x] `connection/ssh.ts` with `ssh2` + `connection/local.ts`.
- [x] `exec/run.ts` + `quote.ts` + `budget.ts`.
- [x] MCP stdio server with a test tool (`sys_info`).
- [x] `policy/modes.ts` (readonly blocks everything that is not R).

**Acceptance:** `echo '{"jsonrpc":"2.0",...}' | arch-mcp` answers `tools/list` and `sys_info`
against the host.

## Phase 1 - Diagnostic core (2-3 days)

- [x] `sys_info`, `sys_status`, `sys_metrics`, `proc_list`, `proc_kill`.
- [x] `svc_list`, `svc_status`, `svc_failed`, `svc_timers`, `svc_unit_file`.
- [x] `log_query`, `log_errors`, `log_boots`, `log_unit_tail`.
- [x] Parsers + fixtures for each one.
- [x] `core` profile with 12 tools.

**Acceptance:** the 20 tasks in `docs/06-testing.md` §6 that only use sys/svc/log are
solved in ≤ 2 calls and ≤ 1.5k tokens.

## Phase 2 - Packages, network, disk (2-3 days)

- [x] `pkg_status`, `pkg_search`, `pkg_info`, `pkg_owns`.
- [x] `net_status`, `net_ports`, `net_conns`, `net_check`, `net_dns`.
- [x] `fs_usage`, `fs_ls`, `fs_find`, `fs_read`.
- [x] Capability detection and `E_UNSUPPORTED` with hints.

**Acceptance:** `pkg_status` works without `checkupdates`; `fs_usage` excludes pseudo-mounts;
`net_ports` identifies the process that owns the port.

## Phase 3 - Hardware, boot, sessions (2 days)

- [x] `hw_summary`, `hw_sensors`, `hw_gpu`, `hw_pci`, `hw_usb`, `hw_power`.
- [x] `boot_info`, `boot_time`, `boot_blame`.
- [x] `usr_sessions`, `usr_logins`, `sec_audit`, `sec_ssh_config`.
- [x] `readonly` profile complete (46 tools).

**Acceptance:** `hw_summary` responds in ≤ 400 ms and ≤ 1.5 KB; `sec_audit` detects
`PermitRootLogin` and a disabled firewall.

## Phase 4 - Controlled writes (2-3 days)

- [x] `policy/confirm.ts` (two-step tokens, TTL, single use).
- [x] `policy/denylist.ts` with the 4 families from `docs/05-security.md` §4.
- [x] `policy/audit.ts` (JSONL, redaction, rotation).
- [x] `svc_action`, `svc_daemon_reload`, `fs_write`, `pkg_install`, `pkg_remove`, `pkg_update`.
- [x] `job_start`, `job_status`, `job_kill`.

**Acceptance:** in `readonly` all mutations return `E_POLICY`; with `write` and no
token they return `E_CONFIRM`; with a token they run once and the token expires.

## Phase 5 - Evaluation and tuning (2 days)

- [x] `test/measure.ts` and token baseline.
- [x] 20 automated evals.
- [x] Description tuning (the ones that cause wrong calls).
- [x] `full` profile (56 tools) and `ARCH_MCP_PROFILE`.

**Acceptance:** average ≤ 1.5k tokens per task; 0 parameter errors in the evals.

## Phase 6 - Packaging (1 day)

- [x] npm package ready (`pnpm pack`, tarball install, `npm publish --dry-run`).
- [ ] Real publish to npm (requires `npm login` with the maintainer account).
- [x] `README.md` with configuration for OpenCode, Claude and Cursor.
- [x] `arch://rules`, `arch://capabilities`, `arch://cheatsheet` resources.
- [x] Optional HTTP transport (`--http`) with bearer token (`ARCH_MCP_HTTP_TOKEN`).
- [x] Tag `v0.2.0`.

**Acceptance:** a new host is configured with 4 environment variables and works without touching
code.

## Phase 7 - Daily use and fallback (ADR-021)

- [x] `exec` with a daily allowlist (rg, fd, jq, yq, tar, rsync, curl, git, croc...).
- [x] `exec_any` (admin + opt-in) and `script_run` (python/bash/node/perl/ruby).
- [x] Local gap log + `exec_gaps` + `gap_report` + optional collector.
- [x] `fs_grep` with ripgrep and grep fallback.
- [x] `host_capabilities` extended (rg, fd, jq, croc, curl, git, python3...).
- [ ] Recipes with parsers for the binaries that show up most in `exec_gaps`.
- [ ] Native download/transfer (`fetch_url`, `croc_send`/`croc_recv`).
- [ ] Daily file operations: cp, mv, rm, chmod, chown, archiving.

**Acceptance:** an agent solves a routine task without leaving the MCP and, when it uses the
fallback, the gap is recorded so it can become a native tool.

## Phase 8 - Daily Linux operations

- [x] Files: `fs_mkdir`, `fs_copy`, `fs_move`, `fs_remove`, `fs_chmod`, `fs_chown`.
- [x] Archives: `fs_archive`, `fs_archive_list`, `fs_checksum`, `fs_du`.
- [x] Transfer: `fetch_url` with size limit and sha256; `http_check`.
- [x] Network: `net_ping`, `net_route`.
- [x] Users: `usr_action` (create/delete/lock/unlock/group_add).
- [x] Firewall: `fw_rule` with ufw/firewalld (nftables is still read-only).
- [ ] Native transfer with `croc` (today via `exec`; requires job/streaming).
- [x] DNS and interfaces with writes: `net_dns_set` and `net_link` (protects lo, default route and backdoor).
- [ ] `apt`/`dnf` (out of scope: this MCP is Arch-first).

**Acceptance:** create, copy, move, archive, download and delete in `/tmp` without leaving the
MCP; create and delete a test user; add and remove a static route.

## Phase 9 - Root with the same user and extras

- [x] `ARCH_MCP_ALLOW_SUDO=1`: the tools run with `sudo -n` using the SSH user.
- [x] `ARCH_MCP_SUDO_ALLOW` to limit binaries or prefixes (`systemctl restart`).
- [x] `fs_symlink`, `proc_renice`, `net_dns_set` (resolvectl).
- [x] `svc_unit_write`/`svc_unit_delete` to create, replace or delete units.
- [x] `log_query` accepts relative windows (`-1h`, `30m`, `today`).
- [x] Editing systemd timers as a high-level unit: `svc_timer_set` (validates with `systemd-analyze calendar`).
- [x] `passwd`/`chpasswd` for users: `usr_password` (stdin, never argv).
- [x] `cron` (`cron_list`, `cron_write`, `cron_remove`; `cronie` in the test image).

**Acceptance:** with a normal SSH user and a NOPASSWD rule, a tool that needs root
(`useradd`, `chown`, `resolvectl`) works without switching user or asking for a password.

---

## Phase 10 - Containers and confirmation ergonomics (0.5 day)

Triggered by an audit of one real session: one Compose project took 23 calls, four of them
executions and eight `E_CONFIRM`. The fallback worked; the catalog and the confirmation flow
did not.

- [x] `docker_ps`, `docker_logs`, `docker_inspect`, `docker_compose` (ADR-025).
- [x] Container CLIs stay out of `exec`/`exec_any`; `container-flags` still applies.
- [x] A token request is a success with `confirm_required` (ADR-024); `E_CONFIRM` is an error.
- [x] Fingerprint ignores `dry_run` and whitespace-only script changes; `dry_run` returns a token.
- [x] `script_run` records the binaries it called and `exec_gaps` expands them (ADR-026).
- [x] Audit records `allow`/`deny`/`confirm`/`preview` (ADR-027).

**Acceptance:** bringing up a Compose project is five calls (compose preview, compose apply,
`docker_ps`, `docker_logs`, `docker_inspect`) and every one of them is a typed tool with
parsed output.

---

## Total estimate

| Phase | Days |
|---|---:|
| 0 | 1 |
| 1 | 3 |
| 2 | 3 |
| 3 | 2 |
| 4 | 3 |
| 5 | 2 |
| 6 | 1 |
| 10 | 0.5 |
| **Total** | **~15.5 days** of effective work |

## Risks and mitigation

| Risk | Mitigation |
|---|---|
| Parser complexity across versions | Per-version fixtures; fallback to text |
| `ssh2` and Cloudflare Access | Test first with a local key; document the alternative ProxyCommand |
| Catalog too large | Profiles + Code Mode |
| Tools the agent does not use | Per-phase eval; delete whatever is not called |
| Security | Phase 4 before publishing; checklist in `docs/05-security.md` §10 |
