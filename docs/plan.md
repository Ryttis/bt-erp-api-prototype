# BT ERP API Prototype — Implementation Plan

- This repository is being evolved from a mock/prototype API into a real read-only analytical API over the ERP replica.
- Implementation should proceed in small independently testable slices.
- Do not mark anything complete unless it is actually implemented and verified.

## Slice 1 — Inspect prototype and prepare replica connection

Review the current Fastify/TypeScript structure, identify reusable parts versus mock-only code, and add MariaDB replica configuration/connection without hard-coded credentials.

- [x] Review current project structure
- [x] Identify reusable prototype components
- [x] Identify mock-only components
- [x] Add replica DB environment configuration
- [x] Add MariaDB connection/pool
- [x] Verify read-only replica connectivity
- [x] Add/update tests

Verified: `npm run typecheck`, `npm test`, and `npm run test:integration` pass. Live replica connectivity and SELECT-only access for the `mcp` account on `infot_2` are confirmed. No write queries were used for verification.

## Slice 2 — Implement basic GET /vehicles

Add the first real replica-backed `/vehicles` endpoint using `masinos` plus the verified latest vehicle-user and leasing relations. Support basic filtering, pagination, and deterministic sorting.

- [x] Add vehicle repository/query layer
- [x] Add GET /vehicles
- [x] Add core vehicle fields
- [x] Add plate_number filter
- [x] Add plate_numbers filter
- [x] Add make filter
- [x] Add model filter
- [x] Add pagination
- [x] Add deterministic sorting
- [x] Add/update tests

Verified: typecheck, unit tests, and live replica integration tests pass, including all known rental prices, NHJ910 last payment, exact plate filtering, pagination, and sorting.

## Slice 3 — Add verified vehicle-finance fields

Expose the verified rental and leasing fields from the replica, including rent price and last payment amount, using the latest relation by `data_nuo DESC, id DESC`.

- [x] Add rent_price
- [x] Add consumer fields
- [x] Add consumer_from / consumer_to
- [x] Add lessor fields
- [x] Add bank fields
- [x] Add lease_start / lease_end
- [x] Add last_payment_amount
- [x] Verify known replica examples
- [x] Add/update tests

Known verification values:

- HOO756 rent_price = 1350
- LGK058 rent_price = 1700
- MUJ352 rent_price = 1371
- NHJ910 rent_price = 2100
- NJI449 rent_price = 1281
- NIR935 rent_price = 0
- NHJ910 last_payment_amount = 7226.34

## Slice 4 — Add deterministic numeric analytics

Add summary analytics that calculate over the complete filtered dataset in backend SQL/application logic rather than over one result page or in the LLM.

- [x] Add view=summary
- [x] Add count
- [x] Add sum
- [x] Add average
- [x] Add min
- [x] Add max
- [x] Support rent_price analytics
- [x] Support last_payment_amount analytics
- [x] Define null vs zero semantics
- [x] Add/update tests

Verified: typecheck, unit tests, and live integration tests pass. Complete-dataset count is 4205; rental sum is 3029117.22; last-payment sum is 52962.52. Filtered totals, zero inclusion, and empty-dataset null semantics are verified.

## Slice 5 — Add categorical analytics

Add bounded deterministic categorical operations for distinct values and grouped counts/metrics.

- [x] Add view=distinct
- [x] Add view=grouped
- [x] Support one group_by field
- [x] Add category result limits
- [x] Add deterministic ordering
- [x] Prevent partial results from appearing complete
- [x] Add/update tests

Verified: typecheck, unit tests, and live integration tests pass. Six-plate categories match row values across all six fields; grouped counts total 6 and rental sums total 7802. Complete-fleet active counts match summary; category overflow rejects without partial data.

## Slice 6 — Complete filters, sorting, and field projection

Add the remaining approved vehicle filters and allowlisted field projection/sorting without allowing arbitrary SQL or expressions.

- [x] Add active filter
- [x] Add department/group/market filters
- [x] Add rent_price_from/to
- [x] Add last_payment_from/to
- [x] Add consumer filters
- [x] Add lessor filters
- [x] Add bank filters
- [x] Add lease date filters
- [x] Add mileage filters where supported
- [x] Add fields projection allowlist
- [x] Expand sort_by allowlist
- [x] Add validation for unsupported fields
- [x] Add/update tests

Verified mappings are recorded in `docs/vehicle-schema.md`. Typecheck, unit tests, live integration, projection, range filters, mileage/date normalization, and cross-view count reconciliation pass. Representative EXPLAIN uses existing indexes.

## Slice 7 — Replica safety and performance

Add protections for the shared read-only replica and enough telemetry to detect expensive or unsafe analytical queries.

- [x] Add query timeout
- [x] Add bounded DB connection pool
- [x] Add bounded heavy-query concurrency
- [x] Add safe DB error handling
- [x] Add query timing telemetry
- [x] Prevent large raw result payloads
- [x] Review expensive queries with EXPLAIN
- [x] Evaluate compact result caching
- [x] Add cache stampede protection if caching is added
- [x] Add/update tests

Verified: MariaDB server-side statement timeout defaults to 30 seconds; analytical concurrency defaults to 3 active and 6 queued requests. Read-only live performance reporting and EXPLAIN checks pass. No cache is justified or added, so cache stampede protection is not applicable.

## Slice 8 — Connect BT Finance Analyst

Integrate the new replica-backed API with BT Finance Analyst so the MCP analytical layer uses the new dataset and deterministic analytics.

- [x] Add/update BT Finance Analyst vehicle adapter
- [x] Map canonical vehicle fields
- [x] Map filters
- [x] Map numeric analytics
- [x] Map distinct/grouped analytics
- [x] Verify count questions
- [x] Verify ranking questions
- [x] Verify sum/average questions
- [x] Verify grouped questions
- [x] Verify end-to-end tool result size remains compact

The Finance Analyst client, selected vehicle source, and adapter delegate rows, summaries, distinct values, grouped metrics, counts, and supported rankings to `/vehicles`. Mocked client/adapter tests, live HTTP integration, and real OpenAI chat verification pass, including deterministic department grouping.

## Slice 9 — Expand to next ERP domain

After vehicles are stable, select one additional finance domain and repeat the same pattern instead of trying to model the whole ERP at once.

- [x] Select next domain
- [x] Identify required replica tables
- [x] Define canonical dataset
- [x] Add read-only repository/query layer
- [x] Add filters
- [x] Add analytics
- [x] Add tests
- [x] Connect BT Finance Analyst adapter

## Overall Status

| Slice | Status |
|---|---|
| 1. Prototype + replica connection | Done |
| 2. GET /vehicles | Done |
| 3. Vehicle-finance fields | Done |
| 4. Numeric analytics | Done |
| 5. Categorical analytics | Done |
| 6. Filters / sorting / projection | Done |
| 7. Replica safety / performance | Done |
| 8. BT Finance Analyst integration | Done |
| 9. Next ERP domain | Done |

Status values: Not started, In progress, Done, Blocked.

## Rules

- Keep each slice independently testable.
- Prefer small changes over large rewrites.
- Replica access is read-only.
- Never accept arbitrary SQL from API clients or LLMs.
- Do not return large raw datasets to the LLM.
- Analytical results must not be presented as complete if processing was incomplete.
- Do not commit credentials or secrets.
- Do not modify unrelated files.
