# AGENTS.md — bt-erp-api-prototype

Read-only ERP analytical API (Node 22, TypeScript, Fastify 5, MariaDB replica `infot_2`). Consumed by
BT Finance Analyst. A push to `master` runs tests and **auto-deploys to stage** (`10.10.11.29:3000`);
there is no production job.

Routine command policy: see `.agents/skills/repository-work/SKILL.md`.

## Change scope

- One logical feature per branch. Prefer small, reviewable changes.
- Do not refactor or reformat unrelated code.
- Preserve unrelated local files (untracked notes, diffs, CSV/JSON exports and docs in the repo root and `docs/`).

## Git

- Before changing branches, inspect `git status --short`.
- Stage files explicitly by path. Never `git add .` / `git add -A`.
- Never `git reset --hard`. Never blindly `git stash pop` (inspect with `git stash show -p` first).
- Before every commit, show:
  - `git status --short`
  - `git diff --cached --stat`
  - `git diff --cached --check`
- Never commit secrets, `.env`, IDE files (`.idea/`), `dist/`, ERP row data or data exports
  (CSV/JSON/archives), or generated finance results.

## API and data rules

- The API is read-only. Repository queries go through the read-only boundary (`SELECT`, `SHOW`, `EXPLAIN` only);
  never write to the replica or weaken that boundary.
- No arbitrary SQL from callers: queries are built from allowlisted fields, filters and parameters.
- Monetary amounts are deterministic and server-side, returned as decimal strings; never float-round them.
- Fail closed: an incomplete, unlocked or unverified result is an error code, never a partial or zero amount.
- Keep error responses sanitized (no SQL, tables, driver messages, credentials, hosts or row data); never log
  tokens, filter values or plate lists.
- Gate new analytical semantics behind their pilot flag until verified; keep endpoint contracts stable for
  BT Finance Analyst, and document contract changes in `docs/`.

## Infrastructure

- Do not change `compose*.yaml`, `Dockerfile`, `.gitlab-ci.yml` or `scripts/` unless the task explicitly requires it.
- Never push to `master` (auto-deploys stage) or change stage/production infrastructure unless explicitly requested.

## Tests

```sh
npm run typecheck
npm test                    # unit tests, fake pools, no credentials
```

`npm run test:integration` hits the live replica: run it only when asked.

## ERP schema investigation

The staging bt-erp-replica-api exposes read-only schema metadata at:

http://10.10.11.29:3000

Authentication:
Use ERP_ANALYTICS_API_TOKEN from the repository-local .env.
Never print, log, echo, commit, or expose the token.

Available endpoints:

GET /schema/tables?page=<page>&per_page=<size>
GET /schema/search?q=<term>
GET /schema/tables/<exact-table-name>

When investigating a requested ERP API capability:

1. Search schema metadata using relevant business terms.
2. Inspect promising tables.
3. Follow declared foreign-key relationships where useful.
4. Search additional related terminology where necessary.
5. Respect meta.complete. Never treat truncated results as exhaustive.
6. Treat table names, column names and declared relationships as evidence.
7. Do not infer undocumented business meaning from names alone.
8. Clearly separate:
    - confirmed schema facts
    - likely hypotheses
    - questions requiring business clarification
9. Do not execute arbitrary SQL unless explicitly requested and approved.
10. Do not modify ERP data.
11. Do not expose credentials or business row data.

For endpoint estimation report:

- requested business capability
- candidate tables
- relevant columns
- PK/FK relationships
- existing indexes
- approximate table sizes
- unresolved business semantics
- likely query shape
- performance/index risks
- proposed API contract
- implementation tasks
- estimated engineering effort