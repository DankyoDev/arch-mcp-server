# Local test environment (Docker Desktop)

Two disposable Arch containers to develop and test the MCP without touching `dante`.

| Service | Port | What it tests |
|---|---|---|
| `arch-ssh` | `127.0.0.1:2222` | SSH transport, parsers, user commands, pacman |
| `arch-systemd` | `127.0.0.1:2223` | real systemd: units, timers, sockets, `--output=json` |

## Start / stop

```bash
cd dev
docker compose up -d --build
docker compose down          # keeps the image
docker compose down --rmi local -v   # deletes everything
```

## SSH

The test key is in `dev/ssh/id_test` (no passphrase, local only).

```bash
ssh -i dev/ssh/id_test -p 2222 root@127.0.0.1   # arch-ssh
ssh -i dev/ssh/id_test -p 2223 root@127.0.0.1   # arch-systemd
```

At startup `compose.yml` copies the key to `/root/.ssh/authorized_keys` with 0600
permissions: a bind mount from Windows arrives as 0777 and sshd rejects it.

## Known limitation: journald

On the Docker Desktop VM the audit netlink is not available
(`EUNATCH`, "Protocol driver not attached"), so `systemd-journald` and
`dbus-broker` do not start. They are masked in the image so the system
ends up in `running` state instead of `degraded`.

Consequence: `journalctl` returns no entries and `log_query`/`log_errors` are
tested with **fixtures** captured from the real host, not here.

Everything else in systemd (units, timers, sockets, `systemctl show`,
`--output=json`) works.

## Configuring the MCP against this environment

```jsonc
{
  "ARCH_MCP_HOST": "127.0.0.1",
  "ARCH_MCP_PORT": "2222",
  "ARCH_MCP_USER": "root",
  "ARCH_MCP_KEY": "C:/Users/abrah/Documents/programming/arch-mcp-server/dev/ssh/id_test",
  "ARCH_MCP_MODE": "readonly"
}
```

## What NOT to do

- Do not use `--cgroupns=host` or `--pid=host` (that is what took `dante` down).
- Do not mount the host `/` into a container.
- Do not use these containers to test anything destructive against the host: they are
  disposable, but the wrong habit carries over to the real server.
