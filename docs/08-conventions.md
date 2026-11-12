# 08 - Conventions

## 1. Language and style

- TypeScript **strict**, ESM, `moduleResolution: bundler`.
- Node ≥ 20. No experimental APIs.
- `pnpm`. No `npm` and no `yarn`.
- Format: 2 spaces, single quotes, semicolons, width 100.
- No `any`. At parsing boundaries: `unknown` + type guard.
- Small functions; at most ~40 lines per tool handler.

## 2. Naming

| Element | Convention | Example |
|---|---|---|
| Tool | `domain_action` | `svc_failed`, `pkg_status` |
| Parameter | descriptive `snake_case` | `unit_name` -> `unit`, `since`, `limit` |
| Function | `camelCase` | `parseUnits`, `runCommand` |
| Type | `PascalCase` | `HostCapabilities`, `ExecResult` |
| File | `kebab-case` or domain | `svc.ts`, `systemd.ts` |
| Constant | `SCREAMING_SNAKE` | `MAX_BYTES` |

- Tool names are **short and predictable**: the agent guesses them.
- No generic verbs (`get_`, `list_` only if it is literally a list).
- Prefer `svc_failed` over `get_failed_services`.

## 3. Input schemas

- Zod, with `.describe()` on every field (one sentence, not a paragraph).
- Explicit defaults; never `optional()` without `.default()` when there is a sensible value.
- Enums instead of free strings.
- `limit` with `.max(100)`.
- Paths are validated as absolute (`startsWith('/')`).

Example:

```ts
const SvclistInput = z.object({
  state: z.enum(['failed', 'running', 'all']).default('all').describe('Filter by state'),
  pattern: z.string().max(64).optional().describe('Case-insensitive substring of the unit name'),
  limit: z.number().int().min(1).max(100).default(50),
});
```

## 4. Tool descriptions

- At most 2 lines (≈ 25 words).
- First line: what it returns. Second (optional): when to use it.
- No long examples: the example goes in the catalog, not in the schema.

```ts
description: 'Failed systemd units with their last error. Use it before reading the full journal.'
```

## 5. Errors

- `Result<T>` on the tool path: `{ok:true,data} | {ok:false,error}`.
- `throw` only for bugs (never for an expected failure).
- Every `E_*` has an actionable `hint`.
- Messages are in **English** in the code and in the response, consistent with the tool
  descriptions and with a generic, publishable project.

## 6. Commands

- Always argv: `['systemctl', 'show', unit, '-p', 'ActiveState', '--value']`.
- `shellQuote()` for each element when building the SSH line.
- Forbidden: `cmd + userInput`.
- Explicit timeouts per tool (default 15 s; pkg 300 s; jobs separately).
- `LANG=C`, `LC_ALL=C` and `SYSTEMD_COLORS=0` in the remote environment for stable parsing.

## 7. Parsers

- Input: `string`. Output: a typed value or `E_PARSE`.
- Never assume field order; use JSON when it exists.
- Tolerate new fields (ignore unknown ones).
- One parser per format, not per command.

## 8. Tests

- Name: `describe('parseUnits')` + `it('returns [] when there are no failures')`.
- Fixtures in `test/fixtures/`, never hand-made data if it can be captured.
- Tests do not touch the network.

## 9. Git

- Conventional commits: `feat(svc): add svc_failed`, `fix(parse): handle empty journal`.
- One commit = one tool or one parser.
- Branch per phase (`feat/phase-1-core`).
- Tag per release (`v0.1.0`).

## 10. Documentation

- Every new tool is added to `docs/03-tool-catalog.md` **in the same commit**.
- If the output contract changes, `docs/04-output-contracts.md` is updated.
- Decisions with an alternative are documented as an ADR in `docs/10-decisions.md`.

## 11. Checklist for adding a tool

1. Does it replace ≥ 3 calls, reduce output ≥ 5×, or avoid a costly error?
2. Name and description (≤ 2 lines).
3. Zod schema with `.describe()`.
4. Command with argv + parser.
5. Fixture + parser test.
6. Envelope + `annotations`.
7. Catalog entry with measured bytes.
8. Assigned profile.

## 12. Anti-patterns

- Returning stdout "just in case".
- A tool that does two things (list and delete).
- Ambiguous boolean parameter (`force`, `all` without context).
- Depending on English output without `LANG=C`.
- Adding a dependency to parse something that already comes in JSON.
