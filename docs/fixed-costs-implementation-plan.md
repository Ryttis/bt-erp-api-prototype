# Fixed-Cost Analytics Implementation Plan

**Project:** BT Finance Analyst

**Repository:** `bt-erp-api-prototype`

**Branch:** `feature/mp-8-fixed-costs`

**Plan date:** 2026-09-23

**Status baseline:** `docs/fixed-costs-status-2026-09-23.md`

**Delivery model:** one feature branch and one merge request, implemented through small reviewable commits

## 1. Objective

Deliver deterministic, read-only truck fixed-cost analytics backed by the ERP production replica, while preserving explicit current and locked representations and preventing total/detail double counting.

Target endpoints:

```text
GET /expense-analytics/fixed-costs/summary
GET /expense-analytics/fixed-costs/breakdown
GET /expense-analytics/fixed-costs/dimensions
```

The planned first enabled monetary scope is `truck`. The `trailer`, `department`, `support` and `expedition` scopes remain behind `SEMANTICS_UNVERIFIED` until they pass separate semantic, reconciliation and performance gates.

## 2. Tracking rules

Status markers:

- `[ ]` — not started;
- `[~]` — in progress;
- `[x]` — completed and verified;
- `[!]` — blocked by a recorded decision or missing evidence.

Every implementation change must update this plan in the same commit when it:

- starts or completes a tracked item;
- changes the public contract;
- adds or resolves a blocker;
- records reconciliation, `EXPLAIN`, test or cache evidence;
- enables or disables an allocation-scope capability.

An item may be marked `[x]` only when its acceptance criteria are satisfied and its evidence is recorded in Section 12.

## 3. Confirmed implementation baseline

- [x] Fixed-cost module exists.
- [x] Fixed-cost routes are registered and authenticated.
- [x] Summary, breakdown and dimensions route shells exist.
- [x] `allocationScope` is mandatory and allowlisted.
- [x] Paired date bounds, ISO dates, date ordering and the 366-day range limit are validated.
- [x] Unknown, repeated and unsafe/SQL-shaped parameters are rejected.
- [x] `INVALID_QUERY` and `SEMANTICS_UNVERIFIED` are deterministic.
- [x] Blocked monetary requests execute no replica query.
- [x] All monetary allocation scopes are disabled in the static capability registry. The Slice 6P pilot is resolved separately from configuration and leaves the registry unchanged.
- [x] Response metadata types exist.
- [x] Bounded internal diagnostics, unit tests and an opt-in integration test exist.
- [x] Diagnostic SQL is static, parameterized and bounded.
- [x] Current/locked value and date states are diagnosed without exposing raw financial values.
- [x] Bounded detail dates are compared categorically against both summary dates; no monetary summary/detail reconciliation exists.
- [x] Truck mapping through `uzdaviniai.uzdavinio_masina` is represented in diagnostics only.
- [x] No diagnostic HTTP or CLI surface is exposed.

Baseline commits:

```text
2b252b8 Add fixed-cost analytics semantic gate
07067a9 Add bounded fixed-cost diagnostic tooling
6d5360f Extend fixed-cost semantic diagnostics
```

## 4. Evidence baseline

### 4.1 Confirmed structural facts and active safety rules

Schema facts captured through the authenticated schema API, plus safety rules already enforced in code. These are structural evidence and engineering decisions, not approved financial semantics.

- [x] `kastai_fiksuoti_ataskaita` is the task-level fixed-cost summary candidate, PK `uzdavinys`, holding current and locked truck, trailer and department totals, cost/lock dates, `deleted` and `last_update`.
- [x] `uzdaviniai` repeats `kastaiVilkiko`, `kastaiPriekabos` and `kastaiSkyriaus` and must never be added to the summary table.
- [x] `kastai_fiksuoti_vilkikai_det` holds current task-date truck cost components, PK (`uzdavinys`, `kastai_data`).
- [x] `kastai_fiksuoti_vilkikai_det_locked` is the locked counterpart and must never be added to the current detail.
- [x] `kastaivilkikai` is a configuration/rate candidate, not an allocated truck-total source.
- [x] `kastai_fiksuoti_detalizacija` holds float-based daily cost and day-count calculation/audit data and is not a first public monetary source.
- [x] Current and locked representations must never be added together; the safety rule is active in code, ERP confirmation of their precedence is pending.
- [x] Summary and component representations must never be added together.
- [x] No declared foreign keys and no explicit currency column exist in the inspected fixed-cost tables.
- [x] The configured `infot_2` replica is reachable read-only, and fixed-cost schema metadata was captured from it on 2026-09-22.

### 4.2 ERP developer-confirmed business semantics (2026-09-23)

Business meaning confirmed by the ERP developer and recorded as FCB-01 to FCB-12 in `docs/costs-endpoint.md` section 15. Confirmation of meaning is not reconciliation and does not open the activation gate in Section 9.

- [x] `kastaivilkikai` is configuration/classifier input (FCB-01).
- [x] `kastai_fiksuoti_ataskaita` contains the calculated task-level fixed-cost results (FCB-02).
- [x] `kastai_fiksuoti_vilkikai_det` contains the same truck result split into components (FCB-03).
- [x] The `_locked` tables contain the locked representation (FCB-04).
- [x] `locked_kastaiVilkiko_data = '0000-00-00'` means the truck result is not locked (FCB-05).
- [x] `kastai_data` identifies the cost month (FCB-06).
- [x] Currency is EUR (FCB-07).
- [x] The truck used for the logistics chain is `uzdaviniai.uzdavinio_masina` (FCB-08).
- [x] ERP displays current and locked values separately (FCB-09). How the API exposes or selects them remains a contract decision.
- [x] Recent values can continue recalculating for approximately three months (FCB-10).

### 4.3 Unresolved semantics blocking monetary implementation

No item below may be presented as fact in code, response metadata or documentation until it is approved and recorded in Section 12. Each maps to the canonical open-question register in `docs/costs-endpoint.md` section 8.

- [!] Which rounding rule explains the sub-euro residual between the component sum and the stored task-level total (FC-06, FC-07). The 2024-2025 sweep measured every comparable task within 1.00 EUR and 56.68 percent within 0.01 EUR, so additivity holds at euro scale; the residual rule and the acceptable tolerance are unapproved.
- [!] Which ERP report and which settled 2025 month are used for reconciliation, and the official reference result for that month (FC-11, FCB-12). Neither was supplied and neither may be invented.
- [!] The Finance-approved reconciliation tolerance (FC-14). The implementation uses 0.01 EUR as a recorded safety value, now known to be too tight to describe the data; a threshold at or above 1.00 EUR per task would classify every comparable row in the sweep as reconciled.
- [!] Whether `deleted = 0` defines reportable summary rows (FC-03).
- [!] Whether zero and negative truck fixed-cost amounts are valid (FC-13).
- [!] Whether one task belongs to exactly one truck fixed-cost calculation (FC-15).
- [!] The API-level rule for selecting or exposing current versus locked values (FC-02). FCB-09 confirms ERP display behavior only.
- [!] An acceptable indexed query plan for a month-filtered public endpoint. No index exists on `kastai_fiksuoti_ataskaita.kastai_data`, so the month filter currently requires a full primary-key walk.
- [!] The inclusion rule for summary rows whose task is absent from `uzdaviniai`.

## 5. First-release contract decisions

- [ ] Approve the exact summary response shape containing separate current and locked measures.
- [ ] Approve how unlocked tasks appear in aggregate responses: locked amount excluded, locked amount `null`, and explicit unlocked count.
- [ ] Approve the exact meaning of `complete` for ranges containing unlocked tasks.
- [ ] Approve the summary count measures: total task count, locked task count and unlocked task count.
- [ ] Approve the initial `breakdown` groupings: `month`, `truck` and `costComponent` only.
- [ ] Approve the initial `dimensions` values and projections for truck and cost component.
- [ ] Confirm whether `deleted = 0` is the reportable-row rule for `kastai_fiksuoti_ataskaita`.
- [ ] Define the decimal comparison and reconciliation tolerance.
- [ ] Define zero and negative-value handling.
- [ ] Assign and increment a fixed-cost `semanticsVersion` when these rules are approved.
- [ ] Keep `classificationVersion` absent or explicitly unavailable until cost-group classification is implemented; do not invent a version.

## 6. Implementation slices

### Slice 4 — Closed-period reconciliation and production query proof

Goal: prove the exact truck source, joins, amount relationships and query plans before enabling public monetary responses.

- [!] Select one settled 2025 calendar month with locked truck-cost data. Blocked: FCB-12 withholds the month. Two engineering probe months (2025-03, 2025-07) exercised the tooling only.
- [x] Record the probed months without recording sensitive task identifiers.
- [x] Add a bounded closed-period reconciliation repository operation.
- [x] Keep current and locked comparisons separate; neither is added to nor compared against the other representation.
- [x] Compare current detail-component sums with current task-level totals.
- [x] Compare locked detail-component sums with locked task-level totals.
- [x] Count missing summary rows, missing detail rows and missing truck mappings.
- [x] Count unlocked rows and zero lock dates in the selected period.
- [x] Measure the `deleted` flag distribution without assuming its meaning.
- [x] Detect join multiplication before aggregation.
- [x] Return only aggregate counts, categorical outcomes and differences; do not expose raw rows or task IDs.
- [x] Run `EXPLAIN` for each intended production query shape.
- [x] Record indexes, access type, estimated rows and temporary/filesort use.
- [x] Classify absolute differences into documented magnitude buckets in SQL decimal arithmetic.
- [x] Report comparable, all-sampled and relative-to-exact denominators, with `null` for a zero denominator.
- [x] Keep no-detail, multiple-detail and missing-total rows outside the monetary buckets and count them separately.
- [x] Exclude the truncation sentinel from every counter while preserving the hard query bound.
- [x] Distinguish `taskLimit`, `sampledTaskCount` and `fetchedTaskCount` in metadata.
- [x] Aggregate quarters and years from counts, never from averaged monthly percentages.
- [x] Sweep all 24 months of 2024-2025 sequentially and record bounded prefix diagnostics.
- [x] Reject any production query shape that requires an unbounded scan. The month-filtered summary scan is recorded as unacceptable for a public endpoint.
- [!] Compare the result with the corresponding official ERP report or ERP UI output. Blocked: no official reference result is available (FC-11, FCB-12).
- [!] Record Finance/ERP acceptance of the selected period and tolerance. Blocked: FC-11 and FC-14 remain open.

Acceptance criteria:

- [!] Summary/detail relationships reconcile within the approved tolerance. No approved tolerance exists. Against the 0.01 EUR implementation value, 43.33 percent of comparable rows fall outside it; against a 1.00 EUR threshold, none do.
- [!] Current/locked differences are zero or explicitly explained for the settled period. Not established without an approved period and reference.
- [x] Truck joins do not multiply monetary values. No task in either probe had more than one current or locked detail row, and every populated `uzdavinio_masina` resolved to exactly one master row.
- [!] Every intended production query has an acceptable bounded plan. The internal diagnostic plan is acceptable; a month-filtered public shape is not, because `kastai_data` is unindexed.
- [!] The reconciliation result and approver are recorded in Section 12. Measurements are recorded; no approver exists.

Suggested commit:

```text
Reconcile closed-period truck fixed costs
```

### Slice 5 — Monetary repository and runtime contract

Entry condition partially met. The 2024-2025 sweep and the Slice 5 complete-month runs show the component sum reproduces the stored total within 1.00 EUR for every comparable record, so the component path is viable as an explanatory breakdown. Slice 5 therefore implements the internal repository only: the authoritative total is read from the summary table and never recomputed from components, so FC-P16 no longer blocks the repository, but it still blocks publishing any component-derived measure.

Goal: introduce the production repository boundary and explicit current/locked response semantics while keeping the public capability disabled.

- [x] Add a fixed-cost monetary repository interface.
- [x] Add a truck implementation using only static, parameterized, read-only SQL.
- [x] Use `kastai_fiksuoti_ataskaita` as the authoritative task-level source, recorded as an implementation decision rather than a completed ERP-report reconciliation.
- [x] Use current and locked truck detail tables only for their corresponding component representations. They are explanatory breakdowns only; the authoritative total is never derived from them.
- [x] Join tasks through `uzdaviniai.id`, and trucks through `uzdaviniai.uzdavinio_masina` (FC-08), used only for the optional bounded truck allowlist.
- [!] Apply the approved `deleted` rule. Blocked (FC-03): results are always separated by declared row state and aggregation fails closed until an internal approved policy is supplied.
- [x] Filter on `kastai_data` as the cost month (FCB-06); the lock date is never substituted for the accounting period.
- [x] Preserve decimal values without JavaScript floating-point aggregation.
- [x] Emit explicit `EUR` currency metadata (FCB-07).
- [x] Report null comparison fields, never `0.00`, for a row-state group with no comparable record, and mark it `structurally_non_comparable`.
- [x] Emit an explicit `dateBasis` of `kastai_data` for both representations; the lock date is never a reporting-period filter.
- [x] Preserve summary rows whose task is missing from `uzdaviniai` through an unconditional `LEFT JOIN`, and report `missingTaskCount`.
- [x] Return current and locked measures separately.
- [!] Return lock state and lock-date semantics explicitly. Deferred: the repository reports the representation, and the lock-date contract belongs to the public response (FC-02).
- [!] Represent unlocked completeness explicitly. Deferred with FC-02/FC-P06.
- [x] Route production queries through the existing analytics concurrency gate.
- [x] Add sanitized repository error handling.
- [!] Add fixed-cost telemetry for duration, outcome, timeout, busy state and bounded result counts. Intentionally deferred: no production path executes yet, and telemetry belongs with the enabled endpoint.
- [x] Keep the truck public capability disabled throughout this slice.

Acceptance criteria:

- [x] Repository unit tests cover parameters, SQL allowlists and decimal handling.
- [x] Tests prove current and locked values are never added together, including mutation guards against crossing the two sources.
- [x] Tests prove summary totals are not repeated by detail joins; detail access is a correlated aggregate, never a fan-out join.
- [x] Tests prove blocked public requests still execute no monetary query.
- [x] Typecheck and 119 unit tests pass. Opt-in monetary integration passed on three complete months; the pre-existing `live invoices` drift is recorded separately.

Suggested commit:

```text
Add truck fixed-cost monetary repository
```

### Slice 6A — Truck summary contract and disabled orchestration

Goal: build the smallest reusable summary layer, with no capability activation.

Entry condition: none beyond Slice 5. Nothing in this slice depends on an unresolved approval, because nothing in it is publicly reachable.

- [x] Finalize the public summary request contract: `allocationScope=truck` plus a paired `dateFrom`/`dateTo`, with unknown, repeated and SQL-shaped input rejected and the 366-day maximum preserved. Evidence: `src/fixed-costs/summary-contract.ts`; `tests/unit/fixed-cost-summary.test.ts`.
- [x] Define the future summary response with current and locked kept separate, decimal-string or null amounts, and total/locked/unlocked/unknown counts.
- [x] Define metadata: `sourceFamily`, `amountSemantics`, `dateBasis`, `semanticsVersion`, `reconciliationStatus`, `complete`, `limitations`, representation block and orphan information.
- [x] Add deterministic stable ordering for every emitted collection, including limitations.
- [x] Add internal orchestration calling the monetary repository independently per representation, behind an injected executor.
- [x] Count declared lock state from the ERP-confirmed `0000-00-00` sentinel (FCB-05), with an explicit `unknown` class rather than a guess.
- [x] Preserve the `SERVICE_BUSY` distinction through the repository instead of flattening gate saturation.
- [x] Prove the route boundary: a valid truck summary request still returns 422 with zero replica access, and no new HTTP or CLI path exists.
- [x] Validate injected cost months against the request: canonical `YYYY-MM-01` and overlapping the requested range, so a response can never describe a period other than its own data. Necessary conditions only; FC-P19 stays open.
- [!] Resolve the day-range to cost-month mapping. Blocked (FC-P19): `planTruckFixedCostSummaryPeriod` reports the blocker instead of inventing inclusivity, partial-month or multi-month rules.
- [!] Support a period spanning more than one cost month. Blocked: month totals cannot be added without JavaScript decimal arithmetic.

Acceptance criteria:

- [x] Current and locked values are never crossed, added or substituted.
- [x] Authoritative totals are never derived from component sums.
- [x] Reconciliation differences are never netted away; the gross absolute figure is preserved.
- [x] Structurally non-comparable populations keep their real total with null comparisons.
- [x] No replica access occurs without an injected approved deleted-row policy.
- [x] Existing `/vehicles`, invoice and schema routes remain registered and unchanged.

Suggested commit:

```text
Add truck fixed-cost summary contract and gated orchestration
```

### Slice 6P — Provisional locked truck summary pilot

Goal: give BT Finance Analyst one provisional, internal, flag-gated monetary answer — the locked truck fixed-cost total for one settled calendar month — without resolving or pre-empting any Slice 6B approval.

**Temporary MP-8 pilot policy, not permanent Finance approval.** Tracked separately from Slice 6B; Slice 6B, 7B, 8B, Slice 9 caching and the Section 9 production gate stay open. Full contract: `docs/costs-endpoint.md` section 21.

Pilot policy: summary endpoint and `truck` scope only; exactly one complete calendar month at least six months before the current month; source `kastai_fiksuoti_ataskaita`; reportable amount `locked_kastaiVilkiko`; period basis `kastai_data`; EUR; `deleted = 0` included, `deleted = 1` excluded, any other state refused; every included task locked, otherwise refused; no component-derived total; no current value; no caching.

- [x] Add the fail-closed `ERP_FIXED_COST_TRUCK_SUMMARY_PILOT_ENABLED` flag: default `false`, strict `true`/`false`, invalid values fail configuration. Documented in `.env.example`; `compose.yaml` untouched. Evidence: `src/config.ts`; `tests/unit/config.test.ts`; `tests/unit/fixed-cost-pilot.test.ts`.
- [x] Resolve capability deterministically from validated configuration (`resolveFixedCostCapability`); only `summary` + `truck` + flag `true` resolves as enabled. The static registry is deeply frozen and still all-disabled.
- [x] Wire routes with `config.fixedCosts` only; a missing or non-boolean option resolves to disabled; no request, model or query input reaches the resolver.
- [x] Flag off: the valid summary request returns 422 `SEMANTICS_UNVERIFIED` with zero replica and gate access.
- [x] Accept only one exact complete, settled calendar month; refuse partial and multi-month ranges (`PERIOD_NOT_COMPLETE_MONTH`) and recent months (`PERIOD_NOT_SETTLED`) before replica access. Avoids FC-P19 rather than answering it.
- [x] Execute one locked read through the existing gated repository with the frozen internal `exclude_deleted` pilot policy, static unqualified SQL, bound values, `AnalyticsGate`, configured timeout and the 50,000-record bound with truncation detection.
- [x] Refuse unlocked or unknown lock state (`PERIOD_NOT_FULLY_LOCKED`); refuse truncated, undeclared-state, missing-total or inconsistent results (`INCOMPLETE_RESULT`).
- [x] Return the stored locked total as canonical decimal text, with no JavaScript arithmetic. Absence of ERP rows is never interpreted as zero: no rows, or rows only in `deleted = 1`, return 422 `NO_DATA_FOR_PERIOD`; `"0.00"` is returned only for real, complete, fully locked `deleted = 0` records whose stored total is `0.00` (final correction).
- [x] Convert a null, missing or malformed driver result into `INCOMPLETE_RESULT` instead of a generic 500; the repository now rejects non-object rows with its typed result error (final correction).
- [x] Emit fixed pilot metadata: exact `semanticsVersion` `truck-fixed-cost-summary-pilot-v1`, `reconciliationStatus` `provisional_unreconciled_erp_reference`, `pilot: true` and sorted constant limitations.
- [x] Preserve `SERVICE_BUSY` (503), `QUERY_TIMEOUT` (504) and `REPLICA_UNAVAILABLE` (503) with sanitized messages; connection-acquisition timeouts report `REPLICA_UNAVAILABLE`, not `QUERY_TIMEOUT` (review fix).
- [x] Add duration/outcome telemetry without amounts, identifiers, dates, rows or driver diagnostics (review fix: diagnostics replaced by a failure classification).
- [x] Keep breakdown, dimensions and every other scope at 422; add no route.
- [x] Add 31 unit tests including 8 mutation guards, and an opt-in live test with `EXPLAIN`.
- [x] Run the opt-in live pilot test and record the pilot-specific `EXPLAIN`. 2025-03 and 2025-07 passed on 2026-09-23 after fixing a test-only BigInt serialization failure; evidence in Section 12 and `docs/costs-endpoint.md` section 21.
- [!] Stage deployment and smoke test. Pending review and commit.

Acceptance criteria:

- [x] With the flag off, behaviour is identical to Slice 8A.
- [x] With the flag on, only the restricted truck summary can succeed.
- [x] No current, component-derived, deleted, unlocked, truncated or fabricated amount can be returned, and no amount is inferred from missing data.
- [x] Existing `/vehicles`, invoice and schema routes are unchanged.
- [x] The live pilot returns 200 for a settled 2025 month with a fully locked included population: 2025-03 (20,795/20,795 locked) and 2025-07 (23,669/23,669 locked).

Known limitation: the pilot `EXPLAIN` confirms the month filter is a full primary-key walk of `kastai_fiksuoti_ataskaita` (`type: index`, `key: PRIMARY`, no possible keys, ~1,556,311 estimated rows, `Using where`); all other accesses are single-row primary-key lookups. Acceptable only as internal low-volume pilot behaviour; not production-ready. FC-P17 stays open.

Rollback: set `ERP_FIXED_COST_TRUCK_SUMMARY_PILOT_ENABLED=false` and restart.

Suggested commit:

```text
Add flag-gated provisional truck fixed-cost summary pilot
```

### Slice 6B — Reconciliation, performance approval and capability activation

Goal: satisfy the activation criteria and enable the first public monetary result.

**This slice cannot start until the blockers below are answered. None may be resolved by engineering.**

- [!] Accept an official ERP report and reference month, then reconcile against it (FC-11, FC-P01, FC-P02).
- [!] Approve the reconciliation tolerance (FC-14, FC-P04).
- [!] Approve the `deleted` inclusion rule (FC-03, FC-P03).
- [!] Approve the public current-versus-locked exposure policy (FC-02, FC-P12).
- [!] Approve the day-range to cost-month mapping (FC-P19).
- [!] Obtain a production-suitable access path for month filtering; `kastai_data` is unindexed and a month currently scans approximately 1.56 million summary rows (FC-P17).
- [ ] Add success, empty-result, timeout and busy-response tests against the enabled path.
- [ ] Add integration reconciliation coverage for the accepted reference month.
- [ ] Enable only the truck summary capability after every acceptance test passes.
- [ ] Keep truck breakdown, truck dimensions and all other scopes disabled.

Acceptance criteria:

- [ ] The accepted closed-period API result matches the official ERP reference.
- [ ] Recent/unlocked ranges cannot be mistaken for final locked results.
- [ ] No unsupported filter or measure reaches the repository.
- [ ] Existing `/vehicles`, invoice and schema endpoints remain unchanged.

Suggested commit:

```text
Enable truck fixed-cost summary analytics
```

### Slice 7A — Gated breakdown contract and orchestration

Goal: build the breakdown contract, bounds and orchestration with no activation and no production SQL.

- [x] Finalize the breakdown request contract: an exact parameter allowlist rejecting unknown, repeated, SQL-shaped, field, measure, filter, table and column input. Evidence: `src/fixed-costs/breakdown-contract.ts`; `tests/unit/fixed-cost-breakdown.test.ts`.
- [x] Add an allowlisted `groupBy` contract with explicit per-grouping availability, so a blocked grouping is never treated as supported.
- [x] Add bounded pagination for grouped results: max page size 200, default 50, max 1,000 groups, out-of-range page fails closed.
- [x] Add a maximum group count that fails closed rather than truncating.
- [x] Add allowlisted sorting with an immutable `truckId` tie-breaker, so pages tile the set exactly once.
- [x] Add deterministic filtering by verified numeric truck identifier only.
- [x] Reject unsupported groupings, sorting, filters and measures.
- [x] Keep current and locked measures separate through two independent reads.
- [x] Use stored authoritative totals and never reconstruct a task total from components.
- [x] Join no detail table in the breakdown path, so a one-to-many relationship cannot multiply a task total.
- [x] Report unresolved trucks separately, with no invented identifier.
- [x] Define a static technical component inventory, marked explanatory and semantics-unverified, with no synthetic residual bucket.
- [x] Run capability and policy gates before any executor access.
- [x] Reject incomplete, truncated, duplicate, mismatched or population-inconsistent executor results.
- [x] Validate every monetary field as decimal text, including reconciliation measures, and refuse a resolved truck group that claims missing-task records. Added by pre-commit review after both were reproduced.
- [x] Preserve timeout and `SERVICE_BUSY` errors unchanged.
- [x] Fail closed with a typed error on a missing or mislabelled registry entry, and report a missing executor distinctly from an unavailable dimension. Added by pre-commit review after both were reproduced.
- [!] Implement `truck` grouping SQL. Deferred to 7B: a month-filtered grouped statement still needs the access path FC-P17 leaves unresolved, so no bounded query can be proved safe yet.
- [!] Implement `month` grouping. Blocked (FC-P19).
- [!] Implement `costComponent` grouping. Blocked (FC-06, FC-07).
- [!] Order by a monetary measure. Deferred to 7B: money must be ordered by SQL, never compared as decimal strings in JavaScript.

Acceptance criteria:

- [x] Pagination and sorting are deterministic and reproducible.
- [x] No task-level amount is multiplied by a one-to-many detail join.
- [x] Group-count and date-range limits are enforced.
- [x] A partial aggregation is never returned as complete.

Suggested commit:

```text
Add gated truck fixed-cost breakdown contract and orchestration
```

### Slice 7B — Approved grouping semantics, reconciliation, query plans and activation

Goal: prove the grouped queries and enable the public breakdown.

**Cannot start until the blockers below are answered. None is resolvable by engineering.**

- [!] Approve the date-range to cost-month mapping so a `month` grouping can define its buckets (FC-P19).
- [!] Approve independent additivity of the component fields so `costComponent` can carry measures (FC-06, FC-07).
- [!] Approve the `deleted` inclusion rule (FC-03), the reconciliation tolerance (FC-14) and the public current/locked exposure policy (FC-02).
- [!] Accept an official ERP report and reference period (FC-11).
- [!] Obtain a production-suitable access path for month-filtered grouping (FC-P17).
- [ ] Add the bounded grouped statement with static unqualified identifiers, bound values, AnalyticsGate, configured timeout and limit-plus-sentinel protection.
- [ ] Run and record `EXPLAIN` for every grouping query shape; a full `kastai_data` scan remains unacceptable for activation.
- [ ] Add SQL-side ordering so a monetary sort field becomes available.
- [ ] Add total-versus-breakdown reconciliation tests against the accepted reference.
- [ ] Enable the truck breakdown capability only after every acceptance test passes.
- [ ] Keep truck dimensions and all other scopes disabled.

Acceptance criteria:

- [ ] Every breakdown reconciles to its corresponding summary representation.
- [ ] Every grouping query has an acceptable bounded plan.
- [ ] Timeout and concurrency limits are enforced on the enabled path.
- [ ] Existing `/vehicles`, invoice and schema endpoints remain unchanged.

Suggested commit:

```text
Enable truck fixed-cost breakdown analytics
```

### Slice 8A — Gated dimension contract, availability registry and orchestration

Goal: build the dimension contract, availability registry and orchestration with no activation and no dimension SQL.

**Every dimension is publicly unavailable because no fixed-cost filter or grouping capability has been activated.** A dimension lists values usable by an enabled filter or grouping; none is enabled.

- [x] Finalize the dimensions request contract: exactly six parameters, rejecting unknown, repeated, SQL-shaped, field, measure, grouping, schema-discovery and internal-control input. Evidence: `src/fixed-costs/dimension-contract.ts`; `tests/unit/fixed-cost-dimensions.test.ts`.
- [x] Add one static, deeply frozen availability registry recording source, availability, blockers, allowed fields, filters, sorting, page bound and exposure classification.
- [x] Keep every registry entry publicly unavailable, asserted by test, with mutation guards proving a flipped entry is the only thing that reaches an executor.
- [x] Restrict the truck dimension to the verified numeric identifier, excluding `masinos_nr`, registration, status, lifecycle, department, lease, driver and every other unrelated or sensitive column.
- [x] Invent no truck display name and no unknown-truck value; unresolved records stay structural counters.
- [x] Keep the fifteen technical component fields as a static explanatory inventory, deterministically ordered, non-additive, non-public, with no synthetic residual and no `INFORMATION_SCHEMA` read.
- [x] Represent the month dimension as blocked with zero database access.
- [x] Run capability and availability gates before any executor access.
- [x] Add bounded pagination and deterministic total ordering per dimension.
- [x] Reject incomplete, truncated, duplicate, oversized or mismatched executor results.
- [x] Distinguish blocked/unavailable from available-but-empty, so an unavailable dimension is never a plausible empty success.
- [x] Preserve timeout and `SERVICE_BUSY` errors unchanged.
- [x] Fail closed with a typed error on a missing or mislabelled registry entry, and report a missing executor distinctly from an unavailable dimension. Added by pre-commit review after both were reproduced.
- [!] Add a live month-availability query. Blocked: `kastai_data` is unindexed, so enumeration would scan the full summary table (FC-P17), and the month mapping is unapproved (FC-P19).
- [!] Add a live truck-value query. Deferred to 8B: a truck dimension must be scoped to trucks appearing in fixed-cost analytics data, which needs the access path FC-P17 leaves unresolved.

Acceptance criteria:

- [x] No sensitive or unrelated ERP field is reachable through the dimension contract.
- [x] Arbitrary column, table and schema-discovery requests are rejected.
- [x] Pagination and ordering are deterministic and reproducible.
- [x] An unavailable dimension cannot be mistaken for an empty successful one.

Suggested commit:

```text
Add gated truck fixed-cost dimension contract and orchestration
```

### Slice 8B — Approved values, bounded indexed queries, integration evidence and activation

Goal: prove the dimension queries and enable the public dimensions endpoint.

**Cannot start until the blockers below are answered. None is resolvable by engineering.**

- [!] Enable a fixed-cost filter or grouping capability, so a dimension has a consumer at all.
- [!] Obtain a production-safe access path for `kastai_data` (FC-P17).
- [!] Approve the date-range to cost-month mapping (FC-P19).
- [!] Approve independent additivity before `costComponent` can become a business dimension (FC-06, FC-07).
- [!] Approve any public truck display field beyond the verified numeric identifier.
- [ ] Add bounded indexed queries scoped to trucks present in fixed-cost analytics data, never a full `masinos` enumeration.
- [ ] Run and record `EXPLAIN` for every dimension query shape.
- [ ] Add integration evidence for the enabled dimension.
- [ ] Enable the truck dimensions capability only after all tests pass.

Acceptance criteria:

- [ ] Every returned dimension value can be used by an enabled filter or grouping.
- [ ] Dimension queries are bounded, indexed and deterministic.
- [ ] No sensitive ERP field is returned.
- [ ] Existing `/vehicles`, invoice and schema endpoints remain unchanged.

Suggested commit:

```text
Enable truck fixed-cost dimensions
```

### Slice 9 — Response caching and operational hardening

Goal: add safe cached responses without hiding freshness or semantic version changes.

- [ ] Define which successful summary, breakdown and dimensions responses are cacheable.
- [ ] Define normalized cache keys containing endpoint, normalized arguments, `semanticsVersion` and classification version when applicable.
- [ ] Define separate TTLs for settled and recent periods.
- [ ] Do not cache authentication, validation, busy or timeout failures as successful data.
- [ ] Prevent cross-environment and cross-version cache collisions.
- [ ] Add cache hit/miss/bypass telemetry.
- [ ] Return cache age or generation-time metadata.
- [ ] Add tests for key normalization, expiry, semantic-version invalidation and isolation.
- [ ] Load-test bounded representative requests.
- [ ] Confirm cache behavior does not bypass the capability registry.

Acceptance criteria:

- [ ] Cached and uncached responses are contract-equivalent.
- [ ] Semantic changes cannot reuse stale cached values.
- [ ] Recent-period freshness limitations are explicit.
- [ ] Cache failures safely fall back to bounded live queries or deterministic service errors.

Suggested commit:

```text
Cache fixed-cost analytics responses
```

### Slice 10 — Documentation and release readiness

Goal: make the enabled capability supportable, reviewable and safe to release.

- [ ] Document all three public endpoint contracts.
- [ ] Document example requests and redacted responses.
- [ ] Document current/locked, accounting-period, currency and completeness semantics as approved.
- [ ] Document supported filters, groupings, sorting and limits.
- [ ] Document deterministic error responses.
- [ ] Document cache behavior and freshness limitations.
- [ ] Update `docs/costs-endpoint.md` to remove stale statuses or replace it with a link to this plan and the dated audit.
- [ ] Update the capability matrix.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm test`.
- [ ] Run `npm run test:integration` against the configured replica environment.
- [ ] Run whitespace checks on every feature file.
- [ ] Review the complete branch diff against its merge base.
- [ ] Confirm no unrelated user-owned files are staged.
- [ ] Obtain ERP/Finance acceptance for the reconciled reference period.
- [ ] Obtain code review for query safety, decimal handling and anti-duplication rules.
- [ ] Prepare one merge request for the complete fixed-cost feature branch.

Acceptance criteria:

- [ ] All enabled behavior is documented and tested.
- [ ] All unresolved limitations are explicit in runtime metadata and documentation.
- [ ] Only the truck scope capabilities that passed their gates are enabled.
- [ ] The release runbook includes rollback and capability-disable steps.

Suggested commit:

```text
Document and prepare fixed-cost analytics release
```

## 7. Deferred allocation scopes

These scopes are not part of the first truck release and must remain disabled:

- [!] Trailer fixed-cost analytics — requires separate source, join, reconciliation and query-plan approval.
- [!] Department fixed-cost analytics — requires historical department attribution and reconciliation approval.
- [!] Support-cost analytics — requires overlap, allocation, deletion and lock semantics.
- [!] Expedition-cost analytics — requires percentage, current/locked and overlap semantics.
- [!] Cross-scope grand total — prohibited until source precedence and overlap rules are approved.

Each deferred scope must receive its own reconciliation slice before capability activation. Truck approval does not approve any other scope.

## 8. Explicit non-goals for the first release

- [x] No arbitrary SQL endpoint.
- [x] No dynamic table or column selection from caller input.
- [x] No sum across truck, trailer, department, support and expedition scopes.
- [x] No addition of current and locked representations.
- [x] No addition of summary and component representations.
- [x] No reconstruction of ERP calculation algorithms from configuration tables.
- [x] No cost-group classification invented from column names.
- [x] No raw diagnostic HTTP or CLI capability.
- [x] No sensitive or unrelated ERP fields in API responses.

## 9. Production monetary activation gate

Truck monetary capability may be enabled only when every item below is complete:

- [ ] Exact source and row grain approved.
- [ ] Current and locked amount semantics approved.
- [ ] Locked/unlocked response behavior approved.
- [ ] `deleted` inclusion rule approved.
- [ ] Currency semantics approved (implicit, converted or joined) and represented in the runtime contract.
- [ ] Accounting-month filtering implemented and tested.
- [ ] Truck join and cardinality verified.
- [ ] Summary/detail additivity reconciled.
- [ ] Current/locked overlap resolved.
- [ ] Zero, negative and rounding rules approved.
- [ ] Safe indexed query plans demonstrated.
- [ ] One settled 2025 period reconciled with an ERP reference.
- [ ] Supported filters, dimensions, groupings and measures allowlisted.
- [ ] Response metadata states source, semantics, completeness, reconciliation and limitations.
- [ ] Unit and integration tests pass.
- [ ] Capability registry enables only the approved truck operation.

## 10. Required test matrix

- [x] Authentication is required for every fixed-cost endpoint.
- [x] Missing and invalid `allocationScope` requests fail deterministically.
- [x] Unknown, repeated and SQL-shaped parameters fail deterministically.
- [x] Missing, reversed, malformed and excessive date ranges fail deterministically.
- [x] Disabled scopes return `SEMANTICS_UNVERIFIED` without replica access.
- [ ] Current and locked values are never added together.
- [ ] Summary and detail values are never double-counted.
- [ ] Joins do not multiply task-level amounts.
- [ ] Unlocked tasks are represented according to the approved contract.
- [ ] `deleted` rows follow the approved rule.
- [ ] Null, zero and negative values follow approved rules.
- [ ] Decimal aggregation avoids binary floating-point errors.
- [ ] Currency is always explicit in responses and matches the approved currency rule.
- [ ] Pagination limits and group-count limits are enforced.
- [ ] Sorting is allowlisted and deterministic.
- [ ] Unsupported filters, groupings, dimensions and measures fail deterministically.
- [ ] Timeouts and concurrency saturation return safe deterministic errors.
- [ ] Response metadata matches the executed semantics.
- [ ] Cache keys isolate different queries and semantic versions.
- [ ] The selected 2025 period reconciles with the accepted ERP reference.
- [x] Existing vehicle, invoice and schema behavior does not regress.

## 11. Open decisions and blockers

| ID | Decision or evidence needed | Owner | Blocks | Status |
|---|---|---|---|---|
| FC-P01 | Exact settled 2025 reconciliation month (FC-11, FCB-12) | ERP / Finance | Monetary activation | Open; explicitly withheld, must not be invented |
| FC-P02 | Official ERP report/UI result for the selected month (FC-11, FCB-12) | ERP / Finance | Monetary activation | Open; explicitly withheld, must not be invented |
| FC-P03 | `deleted` inclusion rule (FC-03) | ERP / Finance | Production queries | Open |
| FC-P04 | Decimal reconciliation tolerance (FC-14) | Finance | Monetary activation | Open |
| FC-P05 | Zero and negative-value treatment (FC-13) | Finance | Monetary activation | Open |
| FC-P06 | Unlocked-task aggregate representation and completeness rule | Finance / API owner | Public contract | Open |
| FC-P07 | Initial breakdown groupings and filters | BA / Finance | Breakdown activation | Open |
| FC-P08 | Truck dimension projection and identifier exposure | BA / Security | Dimensions activation | Open |
| FC-P09 | Cache backend and settled/recent TTLs | API owner / Operations | Cached release | Open |
| FC-P10 | Cost classification availability/version behavior | Finance / BT Finance Analyst | Classified breakdown only | Deferred |
| FC-P11 | Authoritative truck fixed-cost source and the meaning of each `kastaiVilkiko` field (FC-01, FC-12) | ERP / BA | Slice 4 and all monetary work | Confirmed 2026-09-23 (FCB-01 to FCB-04) |
| FC-P12 | API rule for exposing or selecting current versus locked (FC-02) | ERP / Finance / API owner | Public contract | Open; FCB-09 confirms ERP displays both separately |
| FC-P13 | Reporting date basis, including whether `kastai_data` is the accounting month (FC-04, FC-16) | Finance / BA | Production queries | Confirmed 2026-09-23 (FCB-06) |
| FC-P14 | Currency semantics: implicit EUR, converted, or joined (FC-05) | Finance / ERP | Response contract | Confirmed 2026-09-23 (FCB-07): EUR |
| FC-P15 | Truck field for reporting: `uzdavinio_masina` or `uzd_vilk_vaziavo` (FC-08) | ERP / BA | Truck grouping and filtering | Confirmed 2026-09-23 (FCB-08) |
| FC-P16 | Rounding rule behind the sub-euro residual between the component sum and the stored total (FC-06, FC-07) | ERP / Finance | Slice 5 and all monetary work | Open, narrowed: 0 of 116,678 comparable rows exceed 1.00 EUR; 43.33% exceed 0.01 EUR |
| FC-P17 | Index or alternative access path for month-filtered production queries | ERP DBA / API owner | Public endpoint performance | Open: `kastai_fiksuoti_ataskaita.kastai_data` is unindexed. A full month runs in ~2 s today, which does not make the plan production-ready. |
| FC-P18 | Inclusion rule for summary rows whose task is absent from `uzdaviniai` | ERP / Finance | Production queries | Open: 105 and 78 such rows in the two probes |
| FC-P19 | Day-range to cost-month mapping: `dateTo` inclusivity, partial-month treatment and multi-month spans | Finance / BA | Slice 6B activation | Open: the summary contract accepts calendar days, the repository is scoped to a whole cost month, and no rule connects them |

## 12. Evidence and completion log

### Decisions

| Date | ID | Decision | Evidence/approver | Commit/MR |
|---|---|---|---|---|
| 2026-09-23 | BASELINE | Dated implementation audit adopted as the plan baseline. | `docs/fixed-costs-status-2026-09-23.md` | — |
| 2026-09-23 | FCB-01..FCB-12 | ERP developer confirmed source roles, component split, locked representation, lock-state sentinel, cost month, EUR currency, truck field, separate display and the ~3-month recalculation window. | `docs/costs-endpoint.md` section 15 | — |
| 2026-09-23 | SLICE-4 | Bounded internal month reconciliation added; settlement bound of six months and a 0.01 EUR tolerance recorded as implementation safety values pending Finance approval. | `src/fixed-costs/reconciliation-*.ts` | — |
| 2026-09-23 | SLICE-4B | Magnitude buckets, sentinel correction and count-based quarterly/yearly aggregation added; 24-month sweep shows no comparable task above 1.00 EUR, superseding the earlier additivity reading. | `docs/costs-endpoint.md` section 16 | — |
| 2026-09-23 | SLICE-5 | Authoritative total read from `kastai_fiksuoti_ataskaita` and never recomputed; detail tables are explanatory only; decimal-string contract; deleted-row policy fails closed. | `docs/costs-endpoint.md` section 17 | — |
| 2026-09-23 | SLICE-5-FIX | Pre-commit corrections: null comparison fields for an empty comparable population, orphan-preserving `LEFT JOIN` with `missingTaskCount`, and explicit `dateBasis: kastai_data`. | `docs/costs-endpoint.md` section 17 | — |
| 2026-09-23 | SLICE-6A | Summary contract and disabled orchestration; lock-state counters from the confirmed FCB-05 sentinel; `SERVICE_BUSY` preserved. Slice 6 split into 6A and 6B because its checklist mixed buildable work with unresolved approvals. | `docs/costs-endpoint.md` section 18 | — |
| 2026-09-23 | SLICE-7A | Breakdown contract, grouping-availability registry, bounds, deterministic ordering and gated orchestration. No production SQL: a grouped month-filtered statement still depends on FC-P17. Slice 7 split into 7A and 7B. | `docs/costs-endpoint.md` section 19 | — |
| 2026-09-23 | SLICE-6P | Temporary MP-8 pilot policy (not Finance approval): flag-gated locked truck summary for one settled complete month, `deleted = 0` only, fully locked population required, no current value, no caching. Slice 6B not advanced. | `docs/costs-endpoint.md` section 21 | — |
| 2026-09-23 | SLICE-8A | Dimension contract, static availability registry with exposure classification, truck/component/month boundaries and gated orchestration. No dimension SQL: month enumeration needs FC-P17 and the truck dimension must be scoped to analytics data. Slice 8 split into 8A and 8B. | `docs/costs-endpoint.md` section 20 | — |

### Reconciliation

| Date | Scope | Period | Reference | Current result | Locked result | Detail result | Outcome | Commit/MR |
|---|---|---|---|---|---|---|---|---|
| 2026-09-23 | truck | 2025-03 probe | None available | Counters only | Counters only | 2,185/4,894 outside 0.01 | Not reconciled | — |
| 2026-09-23 | truck | 2025-07 probe | None available | Counters only | Counters only | 2,343/4,921 outside 0.01 | Not reconciled | — |
| 2026-09-23 | truck | 2024-01..2025-12 sweep | None available | Buckets only | Buckets only | 0/116,678 above 1.00 EUR | Not reconciled | — |

### Query plans

| Date | Operation | Bounds | Index/access result | Estimated/scanned rows | Accepted | Commit/MR |
|---|---|---|---|---|---|---|
| 2026-09-23 | Month reconciliation statement | 2 month bounds; `LIMIT 5001`; gate + timeout | Task/truck/detail PRIMARY `eq_ref`/`ref`, 1 row each | 5,001 derived | Yes, internal only | — |
| 2026-09-23 | Month filter on summary table | `kastai_data` range | `type: index`, full PK walk, no usable index | ~1,556,311 | No for a public endpoint | — |
| 2026-09-23 | Slice 6P exact locked pilot statement (2025-03 and 2025-07, identical) | 2 bound month values; `LIMIT 50001`; gate + timeout | `a`: `index`, key PRIMARY, possible_keys null, `Using where`; `t`: `eq_ref` PRIMARY, `Using index`; both locked-detail subqueries: `ref` PRIMARY; outer: `<derived6>` `ALL`, `Using temporary; Using filesort` | `a` ~1,556,311; derived 50,001; lookups 1 | Yes, low-volume internal pilot only; not for general production (FC-P17 open) | — |

### Validation

| Date | Slice | Command/check | Result | Evidence | Commit/MR |
|---|---|---|---|---|---|
| 2026-09-23 | Baseline audit | `npm run typecheck` | Passed | No TypeScript errors | — |
| 2026-09-23 | Baseline audit | `npm test` | Passed | 71 unit tests, 0 failures | — |
| 2026-09-23 | Slice 4 | `npm run typecheck` | Passed | No TypeScript errors | — |
| 2026-09-23 | Slice 4 | `npm test` | Passed | 84 unit tests, 0 failures (13 new) | — |
| 2026-09-23 | Slice 4 | `npm run test:integration` | Passed | 7 live passed, 2 opt-in fixed-cost tests skipped | — |
| 2026-09-23 | Slice 4 | Opt-in reconciliation, 2025-03 and 2025-07 | Passed | EXPLAIN and counters only; both hit the 5,000-task bound | — |
| 2026-09-23 | Slice 4 | `git diff --check` | Passed | Scoped to Slice 4 files | — |
| 2026-09-23 | Slice 4B | `npm test` | Passed | 98 unit tests, 0 failures (27 reconciliation, incl. 4 mutation guards) | — |
| 2026-09-23 | Slice 4B | Opt-in sweep, 24 months | Passed | 288-387 ms per month; bounded prefix diagnostics | — |
| 2026-09-23 | Slice 4B | `npm run test:integration` | Passed with known flake | Pre-existing `live invoices` row-count drift, unrelated to fixed costs | — |
| 2026-09-23 | Slice 5 | `npm test` | Passed | 119 unit tests, 0 failures (21 monetary, incl. 5 mutation guards) | — |
| 2026-09-23 | Slice 5 | Opt-in monetary integration | Passed | 2024-01, 2025-03, 2025-12 complete within the 50,000-record bound; counts only | — |
| 2026-09-23 | Slice 5 | `npm run test:integration` | Passed with known flake | Same pre-existing `live invoices` drift; 1 of 2 runs | — |
| 2026-09-23 | Slice 5 corrections | `npm test` | Passed | 128 unit tests, 0 failures (30 monetary, incl. 8 mutation guards) | — |
| 2026-09-23 | Slice 5 corrections | Opt-in monetary integration, 2025-03 | Passed | Record counts unchanged by the LEFT JOIN; `missingTaskCount` 342 | — |
| 2026-09-23 | Slice 6A | `npm test` | Passed | 148 unit tests, 0 failures (20 new summary tests) | — |
| 2026-09-23 | Slice 6A review | `npm test` | Passed | 151 unit tests after adding period/request consistency validation and 3 regression tests | — |
| 2026-09-23 | Slice 7A | `npm test` | Passed | 171 unit tests, 0 failures (20 new breakdown tests incl. mutation guards) | — |
| 2026-09-23 | Slice 7A review | `npm test` | Passed | 173 unit tests after validating reconciliation decimals and refusing missing-task records on resolved groups | — |
| 2026-09-23 | Slice 8A | `npm test` | Passed | 189 unit tests, 0 failures (16 new dimension tests incl. mutation guards) | — |
| 2026-09-23 | Slice 8A review | `npm test` | Passed | 192 unit tests after guarding the registry lookup and correcting the missing-executor reason | — |
| 2026-09-23 | Slice 6A | Opt-in monetary integration, 2025-03 | Passed | Record counts unchanged by the lock-state counters; every `deleted = 0` record locked, every `deleted = 1` record unlocked | — |
| 2026-09-23 | Slice 6P | `npm run typecheck` | Passed | No TypeScript errors | — |
| 2026-09-23 | Slice 6P | `npm test` | Passed | 221 unit tests, 0 failures (29 new pilot tests incl. 8 mutation guards) | — |
| 2026-09-23 | Slice 6P review | `npm test` | Passed | 221 unit tests after re-classifying connection-acquisition timeouts, removing driver diagnostics from pilot logs, and strengthening the flag-off gate check | — |
| 2026-09-23 | Slice 6P final correction | `npm test` | Passed | 223 unit tests after replacing the empty-month `"0.00"` with `NO_DATA_FOR_PERIOD`, preserving stored zero totals, and mapping null/malformed driver rows to `INCOMPLETE_RESULT` | — |
| 2026-09-23 | Slice 6P | `npm run test:integration` | Environment-blocked | 7 live tests failed identically with `ER_GET_CONNECTION_TIMEOUT`/`ER_CONNECTION_TIMEOUT` (replica unreachable, TCP connect also fails); 4 opt-in tests skipped | — |
| 2026-09-23 | Slice 6P | Opt-in live pilot, 2025-03 | Not run | Replica and staging API unreachable from the workstation; 504 `QUERY_TIMEOUT` from `ER_GET_CONNECTION_TIMEOUT` | — |
| 2026-09-23 | Slice 6P live | Opt-in live pilot, 2025-03, first attempt after connectivity returned | Failed in the test | Request succeeded (200); the test then failed serializing EXPLAIN `BigInt` columns, hidden by a generic catch. Fixed in the test only | — |
| 2026-09-23 | Slice 6P live | Opt-in live pilot, 2025-03 | Passed | 200; 2,242 ms; 20,795 tasks, 20,795 locked; complete; auth, flag-off and unsupported-request checks passed; EXPLAIN recorded; no amount printed | — |
| 2026-09-23 | Slice 6P live | Opt-in live pilot, 2025-07 | Passed | 200; 2,561 ms; 23,669 tasks, 23,669 locked; complete; same checks passed; identical EXPLAIN; no amount printed | — |
| 2026-09-23 | Baseline audit | `npm run test:integration` | Not run as a suite | `tests/integration/fixed-cost-diagnostics.test.ts` ran and skipped: opt-in `FIXED_COST_DIAGNOSTIC_TASK_IDS` absent. The remaining live tests were not run because they print ERP business rows. | — |
| 2026-09-23 | Baseline audit | `git diff --check` | Passed | Checked for `docs/fixed-costs-status-2026-09-23.md` | — |

## 13. Merge-request completion checklist

- [ ] Every completed item links to evidence or a commit.
- [ ] The dated audit remains unchanged as a historical snapshot.
- [ ] This plan reflects the final branch state.
- [ ] `docs/costs-endpoint.md` no longer contradicts the audit or this plan.
- [ ] All unrelated modified and untracked files remain outside the feature diff.
- [ ] All public capability flags match verified implementation status.
- [ ] The final branch diff contains no credentials, raw ERP samples or sensitive exports.
- [ ] Typecheck, unit tests and integration tests are recorded.
- [ ] Reconciliation and query-plan evidence are recorded.
- [ ] Release and rollback steps are documented.
- [ ] One merge request covers the completed fixed-cost feature branch.