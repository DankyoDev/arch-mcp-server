# 04 - Output contracts

## 1. Single envelope

Every tool returns the same envelope. The agent learns one shape and reuses it.

```json
{
  "ok": true,
  "data": { },
  "meta": {
    "host": "dante",
    "ms": 42,
    "truncated": false,
    "total": 39,
    "cursor": null
  }
}
```

Error:

```json
{
  "ok": false,
  "error": {
    "code": "E_POLICY",
    "message": "container CLIs are not available through exec",
    "hint": "use docker_ps, docker_logs, docker_inspect or docker_compose",
    "data": { "rule": "containers" }
  },
  "meta": { "host": "dante", "ms": 0 }
}
```

Rules:

- `data` is **never** `null` when `ok:true`. If there are no results: `[]` or `{}`.
- `meta.ms` always. `meta.truncated` always (boolean).
- `meta.cursor` only if there are more pages.
- Errors are returned with `isError: true` in the MCP result.
- In MCP, **`structuredContent` with this object** is sent plus the same JSON as text
  (compatibility with old clients).

### Confirmation is not an error

A mutation without its token answers `ok: true` and runs nothing:

```json
{
  "ok": true,
  "data": {
    "confirm_required": true,
    "token": "362fa67f",
    "expires_in_s": 120,
    "preview": { "unit": "nginx.service", "action": "restart", "effect": "systemctl restart nginx.service" }
  },
  "meta": { "host": "dante", "ms": 1, "truncated": false }
}
```

- Repeating the same call with `token` runs it once.
- `dry_run: true` returns the preview **and** a token, so preview plus apply is two calls.
- The token is bound to the tool and its arguments. `token` and `dry_run` are excluded from
  that fingerprint, and trailing whitespace, line endings and edge blank lines in `source`
  and `content` are ignored, so re-emitting the same script does not invalidate it.
- `E_CONFIRM` (with `isError: true`) means the token was unknown, expired, already used or
  bound to other arguments. `confirm_required` means "send this token back".

## 2. Types and units

| Datum | Type | Unit | Example |
|---|---|---|---|
| Sizes | integer | bytes | `"size_b": 1073741824` |
| Percentages | number | 0-100, 1 decimal | `"use_pct": 42.3` |
| Durations | integer | milliseconds | `"ms": 42` |
| Dates | string | ISO 8601 UTC | `"since": "2026-11-12T03:10:22Z"` |
| Paths | string | absolute | `"/var/log/journal"` |
| PIDs | integer | - | `"pid": 1234` |
| Signals | string | name | `"signal": "TERM"` |

Dates are never returned in local format or as epoch unless the parameter asks for it.

## 3. Names and abbreviations

- Short, consistent keys: `_b` (bytes), `_pct`, `_ms`, `_s`.
- `id` only for identifiers the agent reuses (job_id, unit, boot_id).
- No redundant prefixes (`"unit_name"` -> `"unit"` inside `svc_*`).
- No decorative `null`: if a field does not apply, it is omitted.

## 4. Compact vs detailed format

Tools that can return a lot accept `detail: "concise" | "detailed"` (default
`concise`):

| Tool | concise | detailed |
|---|---|---|
| `svc_list` | unit, active, sub | + desc, load, type |
| `svc_status` | state, pid, since, last_error | + exec, mem, tasks, cgroup |
| `proc_list` | pid, user, cpu, mem, cmd (80 chars) | + ppid, rss, state, start |
| `log_query` | ts, prio, msg | + unit, pid, boot |
| `pkg_info` | name, version, installed | + deps, required_by, size |

The agent asks for `detailed` only when it needs it. That change alone already cuts ~60% in
diagnostic queries.

## 5. Pagination

- `limit` with a hard cap per tool (50-100).
- If there is more, `meta.cursor` = base64 of the offset (`offset:N`).
- The tool accepts `cursor` and continues from there.
- List tools also return `meta.total` with the number of available items.
- An implicit "next page" is **never** returned: the agent must ask for it.

## 6. Truncation

- Default budget: **8 KiB** of serialized JSON.
- Configurable maximum: 32 KiB (`ARCH_MCP_MAX_BYTES`).
- When truncating:
  - `meta.truncated = true`
  - `meta.total` = number of items in the full list (not the returned slice)
  - `meta.total_b` = bytes of the full payload, untruncated
  - it cuts on whole items (never in the middle of a string)
  - the `content` text is still **JSON only** so old clients do not break; the notice
    travels in `meta.truncated`/`meta.total_b` and in the error `hint` if nothing fit
  - if it is an object (not a list) and it does not fit, `E_TRUNCATED` is returned with a
    `hint` instead of a half object

Truncated envelope example:

```json
{"ok":true,"data":[{"ts":"2026-11-12T03:10:22Z","prio":"err","msg":"bind() to 0.0.0.0:80 failed"}],
 "meta":{"host":"dante","ms":44,"truncated":true,"total":120,"total_b":48211}}
```

## 7. Order and stability

- Lists sorted deterministically (by name or by the requested `sort` field).
- Never sort by a volatile field unless asked (avoids noisy diffs).
- Parsers ignore empty lines and ANSI (`\x1b\[[0-9;]*m`).

## 8. What is not returned

- Raw stdout (except `raw_exec`).
- Table headers, separators, colors.
- `stderr` messages if the command succeeded (they are discarded), except `raw_exec`.
- Journal metadata (`_MACHINE_ID`, `_CMDLINE`, `__MONOTONIC_TIMESTAMP`...).
- Internal cgroup paths.

## 9. Full examples

`sys_status`:

```json
{"ok":true,"data":{
  "load":[0.42,0.38,0.31],
  "mem":{"used_pct":31.2,"avail_b":10911000000},
  "swap":{"used_pct":0.0},
  "disks":[{"mount":"/","use_pct":42.1},{"mount":"/home","use_pct":39.8}],
  "failed_units":0,
  "reboot_required":false,
  "updates":0,
  "temp_max_c":48,
  "top":[{"name":"node","cpu_pct":3.1},{"name":"dockerd","mem_pct":2.0}]
},"meta":{"host":"dante","ms":38,"truncated":false}}
```

`svc_failed`:

```json
{"ok":true,"data":{"count":1,"units":[{
  "unit":"nginx.service",
  "since":"2026-11-12T03:10:22Z",
  "exit":"1/FAILURE",
  "log":["nginx: [emerg] bind() to 0.0.0.0:80 failed"]
}]},"meta":{"host":"dante","ms":61,"truncated":false}}
```

`log_query` with truncation:

```json
{"ok":true,"data":[{"ts":"2026-11-12T03:10:22Z","prio":"err","msg":"bind() to 0.0.0.0:80 failed"}],
 "meta":{"host":"dante","ms":44,"truncated":true,"total":120,"total_b":48211,"cursor":"b2Zmc2V0OjUw"}}
```
