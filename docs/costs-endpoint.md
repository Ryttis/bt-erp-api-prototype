# MP-8 Fixed-Cost Analytics Endpoint — Implementation Tracker

**Project:** BT Finance Analyst
**Repository:** `bt-erp-api-prototype`
**Target path:** `docs/costs-endpoint.md`
**Status:** Slices 1–2 implemented — production monetary semantics remain unverified
**Last updated:** 2026-09-22
**Owner:** CDT / MP-8

## 1. Objective

Implement deterministic, read-only fixed-cost analytics through the ERP Analytics API without inventing financial semantics or counting the same calculated allocation more than once.

Target public endpoints:

```text
GET /expense-analytics/fixed-costs/summary
GET /expense-analytics/fixed-costs/breakdown
GET /expense-analytics/fixed-costs/dimensions
```

The first release enables monetary results for only one reconciled allocation scope. Other scopes must return a deterministic `SEMANTICS_UNVERIFIED` error until their source, amount, date, currency, status and overlap rules are approved.

## 2. Tracking rules

Status markers:

- `[ ]` — not started;
- `[~]` — in progress;
- `[x]` — completed and verified;
- `[!]` — blocked by a documented decision or missing evidence.

Codex must update this file in the same change whenever it:

- completes or starts a tracked item;
- discovers a new source, join, overlap or performance risk;
- changes an endpoint contract;
- adds or removes a blocker;
- records test, `EXPLAIN` or reconciliation evidence.

An item may be marked `[x]` only when its evidence is recorded in this document or linked to a repository file, test or approved external reference.

## 3. Confirmed structural model

These are schema facts, not yet approved financial semantics.

| Role | Table | Structural grain/key | Current interpretation |
|---|---|---|---|
| Task-level fixed-cost summary candidate | `kastai_fiksuoti_ataskaita` | PK `uzdavinys`; one row per task structurally | Contains current and locked truck, trailer and department totals, cost/lock dates, `deleted` and `last_update`. Leading first-source candidate after reconciliation. |
| Repeated task representation | `uzdaviniai` | PK `id` | Contains task/vehicle identifiers and repeats `kastaiVilkiko`, `kastaiPriekabos`, `kastaiSkyriaus`. Must not be added to the report table. |
| Truck component detail | `kastai_fiksuoti_vilkikai_det` | PK (`uzdavinys`, `kastai_data`) | Current task-date truck-related cost components. |
| Locked truck component detail | `kastai_fiksuoti_vilkikai_det_locked` | PK (`uzdavinys`, `kastai_data`) | Locked counterpart; never add to current detail. |
| Trailer component detail | `kastai_fiksuoti_priekabos_det` | PK (`uzdavinys`, `kastai_data`) | Current task-date trailer-related cost components. |
| Locked trailer component detail | `kastai_fiksuoti_priekabos_det_locked` | PK (`uzdavinys`, `kastai_data`) | Locked counterpart; never add to current detail. |
| Department component detail | `kastai_fiksuoti_skyriaus_det` | PK (`uzdavinys`, `kastai_data`) | Current task-date department-related components. |
| Locked department component detail | `kastai_fiksuoti_skyriaus_det_locked` | PK (`uzdavinys`, `kastai_data`) | Locked counterpart; never add to current detail. |
| Calculation/audit detail | `kastai_fiksuoti_detalizacija` | No PK; indexes on `uzdavinys`, `tipas` | Contains float-based daily cost and day-count calculations. Not selected as a first public monetary source. |
| Truck cost configuration | `kastaivilkikai` | PK `id`; validity period + `kastu_tipas` | Configuration/rate candidate, not an allocated truck-total source. |
| Trailer cost configuration | `kastaipriekabos` | PK `id`; validity period + `kastu_tipas` | Configuration/rate candidate, not an allocated trailer-total source. |
| Department cost configuration | `kastaiskyriai` | PK `id`; validity period + `skyrius` | Configuration/rate candidate, not an allocated department-total source. |
| Truck master | `masinos` | PK `id` | Registration number `masinos_nr`; cost type `tipas_kastu`; current department fields. |
| Trailer master | `priekabos` | PK `id` | Registration number `masinos_nr`; cost type `tipas_kastu`; current department fields. |
| Department master | `skyriai` | PK `id` | Department names, activity and department-type fields. |
| Historical truck department | `masinos_valdymas` | PK `id`; indexed vehicle and validity fields | Temporal truck-to-department candidate using `data_nuo` and `data_iki`. |
| Support allocation | `support_costs` | PK `task_id` | Current/component/locked-looking amounts with deletion and update fields; high overlap risk. |
| Expedition allocation | `expedition_costs` | PK `task_id` | Percentage and locked-cost-looking fields; semantics unresolved. |

No declared foreign keys or explicit currency columns were found in the inspected fixed-cost tables.

## 4. Candidate join model

All joins below are structurally inferred and must be validated with bounded data and ERP behavior.

| Business relation | Candidate join | Status |
|---|---|---|
| Fixed-cost summary → task | `kastai_fiksuoti_ataskaita.uzdavinys = uzdaviniai.id` | Bounded Slice 2 sample matched; business relationship and general coverage remain unapproved |
| Truck detail → task | `kastai_fiksuoti_vilkikai_det.uzdavinys = uzdaviniai.id` | Bounded Slice 2 sample matched; business relationship remains unapproved |
| Trailer detail → task | `kastai_fiksuoti_priekabos_det.uzdavinys = uzdaviniai.id` | `[ ]` Validate |
| Department detail → task | `kastai_fiksuoti_skyriaus_det.uzdavinys = uzdaviniai.id` | `[ ]` Validate |
| Assigned truck → master | `uzdaviniai.uzdavinio_masina = masinos.id` | Bounded Slice 2 numeric join coverage measured; actual-truck mapping remains unverified |
| Actual truck → master | Mapping not verified: `uzd_vilk_vaziavo` is `varchar(55)` whereas master `id` is `int(11)` | `[!]` Do not equate these fields or infer a registration-number mapping |
| Assigned trailer → master | `uzdaviniai.uzdavinio_priekaba = priekabos.id` | `[ ]` Compare with actual-trailer field |
| Actual trailer → master | Text-to-master mapping not verified | `[!]` Do not equate the textual actual-trailer field with an integer master ID |
| Truck → historical department | vehicle ID + cost date within `masinos_valdymas.data_nuo/data_iki` | `[ ]` Prove exactly one applicable row |
| Truck → cost configuration | `masinos.tipas_kastu = kastaivilkikai.kastu_tipas` plus validity date | `[ ]` Validate selection and overlaps |
| Trailer → cost configuration | `priekabos.tipas_kastu = kastaipriekabos.kastu_tipas` plus validity date | `[ ]` Validate selection and overlaps |
| Department → cost configuration | department ID = `kastaiskyriai.skyrius` plus validity date | `[ ]` Validate selection and overlaps |

## 5. Implementation phases

### Phase A — Module and public contract

- [x] Create `src/fixed-costs/` module. Evidence: `src/fixed-costs/` contains the fixed-cost request contract, semantic registry and routes.
- [ ] Add route, contract/validation, repository-boundary and telemetry files following existing project conventions. Repository and telemetry work is intentionally deferred: this slice executes no monetary operation.
- [x] Register the module in `src/app.ts`. Evidence: `registerFixedCostRoutes` is registered with the existing application hooks.
- [x] Add `GET /expense-analytics/fixed-costs/summary`. Evidence: route-level contract tests in `tests/unit/fixed-costs.test.ts`.
- [x] Add `GET /expense-analytics/fixed-costs/breakdown`. Evidence: route-level contract tests in `tests/unit/fixed-costs.test.ts`.
- [x] Add `GET /expense-analytics/fixed-costs/dimensions`. Evidence: route-level contract tests in `tests/unit/fixed-costs.test.ts`.
- [x] Preserve existing authentication, URL-length, analytics-gate and safe-error behavior. Evidence: routes are registered under existing application hooks; authentication and no-gate/no-SQL behavior are covered by `tests/unit/fixed-costs.test.ts`.
- [x] Confirm existing `/vehicles`, `/invoices` and schema routes remain unchanged. Evidence: `npm test` passed all 11 unit-test files, including their existing vehicle, invoice and schema suites.

### Phase B — Request validation and limits

- [x] Require allowlisted `allocationScope`. Evidence: `parseFixedCostRequest` and fixed-cost unit tests.
- [x] Initially recognize `truck`, `trailer`, `department`, `support`, `expedition` as syntactic scope values only. Evidence: `fixedCostAllocationScopes`; each reaches the semantic gate in fixed-cost unit tests.
- [x] Reject unknown parameters. Evidence: all three routes share the `parseFixedCostRequest` allowlist and fixed-cost unit tests.
- [x] Reject repeated scalar parameters. Evidence: non-string repeated Fastify query values are rejected and tested.
- [x] Validate ISO date syntax. Evidence: strict calendar-date validation in `parseFixedCostRequest` and tests.
- [x] Require compatible date bounds and reject `dateFrom > dateTo`. Evidence: fixed-cost unit tests.
- [x] Define and test maximum date-range length. Evidence: maximum 366-day range in `fixedCostMaximumDateRangeDays` and fixed-cost unit tests.
- [ ] Bound `page`, `per_page` and grouping result count.
- [ ] Allow only deterministic sorting with a stable tie-breaker.
- [x] Reject unsupported filters, dimensions and measures deterministically. Evidence: the shared parser allowlist and fixed-cost unit tests.
- [x] Ensure caller input cannot supply table names, column names, expressions or SQL fragments. Evidence: no such parameters are allowlisted; SQL-shaped input tests fail before replica access.

### Phase C — Semantic capability registry

- [ ] Implement a backend registry of enabled scopes, measures, dimensions and semantic versions. Slice 1 implements only the required disabled scope registry; no measure, dimension or semantic version can be registered before approval.
- [x] Default every monetary scope to disabled. Evidence: all registry entries are `enabled: false`, asserted in fixed-cost unit tests.
- [x] Return `SEMANTICS_UNVERIFIED` for valid but unapproved monetary requests. Evidence: stable 422 response asserted for every endpoint and scope.
- [x] Ensure blocked requests execute no monetary replica query. Evidence: zero-call replica fixture and analytics-gate state assertions in fixed-cost unit tests.
- [x] Include the unresolved semantic requirements in the error response without exposing schema internals unnecessarily. Evidence: stable public error identifies source, amount, currency, date, lock/status and reconciliation validation only.

### Phase D — Response contract

- [x] Define metadata fields for `allocationScope` and `sourceFamily`. Evidence: `FixedCostResponseMetadata` in `src/fixed-costs/contracts.ts`.
- [x] Define `amountSemantics`, `dateBasis` and `currencyScope`. Evidence: `FixedCostResponseMetadata` and `FixedCostCurrencyScope` contracts.
- [x] Define current/locked selection metadata. Evidence: `valueSelection` contract field; no value is emitted before approval.
- [x] Define `classificationVersion` and `semanticsVersion`. Evidence: `FixedCostResponseMetadata` contract.
- [x] Define `reconciliationStatus`, `complete` and `limitations`. Evidence: `FixedCostResponseMetadata` contract.
- [ ] Reuse shared MP-59 pagination and grouping conventions where they already exist. The existing shared `ApiError` envelope is used, but no approved fixed-cost pagination or grouping convention exists yet.
- [x] Do not create a generic dynamic query-builder abstraction. Evidence: one shared public parser; Slice 2 adds only two fixed internal diagnostic SQL shapes.

### Phase E — Bounded diagnostic capability

The diagnostic capability is an internal repository exercised by an opt-in integration test. It has no HTTP or CLI surface and accepts no arbitrary SQL. See section 13 for exact scope, schema and evidence.

- [x] Add a hardcoded diagnostic repository. Evidence: `src/fixed-costs/diagnostic-repository.ts`.
- [x] Require 1–20 distinct positive safe integer task IDs. Evidence: separate `diagnostic-contract.ts`; complete validation before pool access.
- [x] Compare truck `uzdaviniai.kastaiVilkiko` with `kastai_fiksuoti_ataskaita.kastaiVilkiko` using exact SQL equality, as a structural hypothesis only.
- [!] Compare summary with component sums: omitted; component set and additivity are unapproved.
- [x] Compare current and locked truck fields categorically without adding or selecting either as authoritative.
- [!] Compare assigned and actual truck identifiers: omitted; textual actual-truck mapping is unverified.
- [!] Compare assigned and actual trailer identifiers: outside truck scope and mapping unverified.
- [x] Check numeric assigned-truck-to-master coverage; no identifiers returned.
- [!] Check history matching: omitted; applicable date, interval boundaries and sentinel-date behavior are unverified.
- [x] Report missing rows, unequal representations and master gaps with categories.
- [x] Bound detail lookup to 100 entries plus one overflow sentinel; output only categories, input positions, sample size and completeness.

### Phase F — Source and semantic decisions

- [ ] Decide whether `kastai_fiksuoti_ataskaita` or the repeated fields in `uzdaviniai` are authoritative.
- [ ] Decide when current values or locked values are reportable.
- [ ] Confirm whether `deleted = 0` is the correct inclusion rule.
- [ ] Confirm the reporting date: `kastai_data`, lock date or another approved date.
- [ ] Confirm whether fixed-cost currency is implicit, converted or resolved through another source.
- [ ] Confirm whether summary totals equal detail sums and document exceptions.
- [ ] Confirm which component fields are additive.
- [ ] Confirm assigned-versus-actual vehicle rules.
- [ ] Confirm historical department attribution rules.
- [ ] Record every approved rule in the decision log below.

### Phase G — Query safety and performance

- [ ] Write only static, parameterized, read-only SQL.
- [ ] Route analytical work through the existing concurrency gate.
- [ ] Run `EXPLAIN` for every intended production query.
- [ ] Record examined indexes and estimated/scanned rows.
- [ ] Avoid date-only scans of task-leading detail-table primary keys.
- [ ] Prefer task-level summary data when reconciliation proves it authoritative.
- [ ] Define timeout, date-range and result-size limits.
- [ ] Add telemetry for duration, outcome, timeout, busy state and bounded result counts.

### Phase H — Reconciliation

- [ ] Select an approved closed ERP reporting period.
- [ ] Identify the corresponding ERP reference report/form and responsible finance owner.
- [ ] Reconcile task counts and monetary totals.
- [ ] Document accepted rounding/tolerance rules.
- [ ] Investigate every material difference.
- [ ] Obtain approval for one source/scope combination.
- [ ] Record evidence in the reconciliation log below.

### Phase I — First production scope

- [ ] Select the first scope only after Phases F–H pass.
- [ ] Current leading candidate: truck fixed costs from `kastai_fiksuoti_ataskaita`.
- [ ] Enable only approved measures and dimensions for that scope.
- [ ] Keep unapproved scopes behind `SEMANTICS_UNVERIFIED`.
- [ ] Enable summary first.
- [ ] Enable breakdown only for reconciled dimensions.
- [ ] Enable dimensions only from verified mappings.
- [ ] Add source, semantics, completeness and limitation metadata to every response.

### Phase J — Tests and release

- [x] Test missing and invalid `allocationScope`. Evidence: `tests/unit/fixed-costs.test.ts`.
- [x] Test unknown and repeated parameters. Evidence: `tests/unit/fixed-costs.test.ts`.
- [x] Test invalid, reversed and excessive date ranges. Evidence: `tests/unit/fixed-costs.test.ts`.
- [ ] Test pagination, grouping and deterministic ordering bounds.
- [x] Test unsupported filters, dimensions and measures. Evidence: `tests/unit/fixed-costs.test.ts`.
- [x] Test `SEMANTICS_UNVERIFIED` stability. Evidence: every recognized scope and route asserts the same 422 body.
- [x] Prove blocked requests execute no replica aggregation query. Evidence: zero-call replica fixture in `tests/unit/fixed-costs.test.ts`.
- [ ] Test that joins do not multiply task-level amounts.
- [ ] Test that current and locked representations cannot be added together.
- [ ] Test that summary and component representations cannot be double-counted.
- [ ] Test deletion/status rules after approval.
- [ ] Test null, zero and negative-value rules after approval.
- [ ] Add reconciliation fixtures for the approved period.
- [x] Run `npm run typecheck`.
- [x] Run `npm test`.
- [x] Run `npm run test:integration` when the replica-test environment is available. Slice 2: seven live tests passed; diagnostic skipped without its opt-in variable, and passed separately with a bounded sample.
- [x] Record Slice 2 test results below. Production reconciliation fixtures remain pending.

## 6. Coding gate

Technical scaffolding and diagnostic queries may be implemented now.

Production monetary aggregation for a scope may be enabled only when all boxes below are complete:

- [ ] exact source and row grain approved;
- [ ] authoritative amount representation approved;
- [ ] current/locked and deleted/status rules approved;
- [ ] currency semantics approved;
- [ ] reporting date approved;
- [ ] vehicle/department joins and cardinalities approved;
- [ ] summary/detail overlap resolved;
- [ ] safe indexed query plan demonstrated;
- [ ] one closed period reconciled against an ERP reference;
- [ ] supported filters, dimensions and measures allowlisted;
- [ ] response metadata states source, semantics and limitations.

## 7. Decision log

| Date | Decision | Evidence | Approved by | Status |
|---|---|---|---|---|
| 2026-09-22 | Treat `kastaivilkikai`, `kastaipriekabos` and `kastaiskyriai` as configuration/rate candidates rather than allocated-output totals. | Schema grain, validity periods, cost-type/department selectors and absence of task/vehicle allocation IDs. | Pending BA/ERP confirmation | Structurally indicated |
| 2026-09-22 | Do not sum current and `_locked` detail tables. | Parallel schemas and differing row counts show alternative representations. | Pending ERP confirmation | Safety rule active |
| 2026-09-22 | Use `kastai_fiksuoti_ataskaita` as the leading source candidate for diagnostic reconciliation. | One-row-per-task structure with current and locked scope totals. | Pending reconciliation | Candidate |
| 2026-09-22 | Slice 1 recognizes only `allocationScope` and optional paired, bounded ISO dates. It rejects grouping, dimensions, pagination, sorting, filters, measures and field selection until MP-40/41 mappings are approved. | `src/fixed-costs/contracts.ts`; route-level validation tests. | Engineering safety decision; BA approval pending | Active |

## 8. Open questions

| ID | Question | Owner | Blocking production totals? | Status |
|---|---|---|---|---|
| FC-01 | Is `kastai_fiksuoti_ataskaita` authoritative, or is `uzdaviniai` the authoritative repeated representation? | ERP/BA | Yes | Open |
| FC-02 | When must current versus locked values be used? | ERP/Finance | Yes | Open |
| FC-03 | Does `deleted = 0` define reportable summary rows? | ERP/Finance | Yes | Open |
| FC-04 | Which date controls reporting? | Finance | Yes | Open |
| FC-05 | Are all fixed costs implicitly in EUR or already converted? | Finance/ERP | Yes | Open |
| FC-06 | Do task summary totals reconcile to the sum of detail components? | ERP/Finance | Yes | Open |
| FC-07 | Which component columns are independently additive? | ERP/Finance | Yes | Open |
| FC-08 | Should truck reporting use `uzdavinio_masina` or `uzd_vilk_vaziavo`? | ERP/BA | Yes for truck grouping | Open |
| FC-09 | Should trailer reporting use `uzdavinio_priekaba` or `uzd_pr_vaziavo`? | ERP/BA | Yes for trailer grouping | Open |
| FC-10 | How are tasks attributed when historical department intervals overlap or are missing? | ERP/BA | Yes for department grouping | Open |
| FC-11 | Which ERP report and closed period will be used for reconciliation? | Finance | Yes | Open |

## 9. Reconciliation log

| Date | Scope | Period | ERP reference | API/diagnostic result | Difference | Outcome |
|---|---|---|---|---|---|---|
| — | — | — | — | — | — | Not started |

## 10. Query-plan evidence

| Date | Operation | Tables | Bounds | Index/plan result | Acceptable? |
|---|---|---|---|---|---|
| 2026-09-22 | Slice 2 task/summary/master categories | `uzdaviniai`, `kastai_fiksuoti_ataskaita`, `masinos` | One parameter per statement; at most 20 inputs | PRIMARY / const / one estimated row per base table; full evidence in section 13 | Yes, internal diagnostic only |
| 2026-09-22 | Slice 2 detail cardinality | `kastai_fiksuoti_vilkikai_det` | Task prefix; LIMIT 101 | PRIMARY / ref / Using index; derived scan bounded to 101 entries | Yes, internal diagnostic only |

## 11. Test record

| Date | Commit/worktree | Command | Result | Notes |
|---|---|---|---|---|
| 2026-09-22 | Slice 1 before commit (later committed as `2b252b8`) | `npm run typecheck` | Passed | TypeScript compilation completed with no errors. |
| 2026-09-22 | Slice 1 before commit (later committed as `2b252b8`) | `npm test` | Passed | All 11 unit-test files passed, including `tests/unit/fixed-costs.test.ts`. |
| 2026-09-22 | Slice 1 before commit (later committed as `2b252b8`) | `npm run test:integration` | Failed (6/7 passed) | Replica infrastructure was available. The pre-existing live invoice reconciliation test observed a one-row count change between separate live samples; no fixed-cost endpoint or query was involved. |
| 2026-09-22 | Uncommitted Slice 2 over `2b252b8` | `npm run typecheck` | Passed | Source TypeScript compilation; Slice 1 implementation unchanged. |
| 2026-09-22 | Uncommitted Slice 2 | `npm test` | Passed | All 12 unit-test files passed. The new file also passed directly: eight tests covering validation before pool calls, strict environment input, exact SQL allowlist, binding, sequential execution, output projection, overflow, sanitized failures/timeouts and unchanged public gates/routes. |
| 2026-09-22 | Uncommitted Slice 2 | Targeted diagnostic integration, variable absent | Skipped cleanly | Confirmed directly as one skipped test, zero failures. |
| 2026-09-22 | Uncommitted Slice 2 | Targeted diagnostic integration, variable supplied privately | Passed | 20 internally selected summary task IDs; category counts only, recorded in section 13. Pool created with configured query timeout and closed. |
| 2026-09-22 | Uncommitted Slice 2 | `npm run test:integration` with replica network access | Passed | Seven live tests passed, one diagnostic test skipped because variable absent. Previous invoice row-count drift did not reproduce. Existing suite business-data logs were suppressed from displayed output. Initial sandbox-only attempt failed; authorized network retry succeeded. |
| 2026-09-22 | Uncommitted Slice 2 | `git diff --check` | Passed | Required scoped diff reviewed; new files checked separately without staging. |
| 2026-09-22 | Uncommitted Slice 2 review correction | `npm run typecheck` | Passed | Diagnostic SQL now uses static unqualified table names; the configured `ERP_REPLICA_DATABASE` selects the schema. |
| 2026-09-22 | Uncommitted Slice 2 review correction | `npm test` | Passed | 71 unit tests passed; the diagnostic file now has nine tests, including a regression test rejecting any `infot_2.` or other schema qualifier in executed diagnostic SQL. A temporary reintroduced qualifier made that test fail before being reverted. |
| 2026-09-22 | Uncommitted Slice 2 review correction | Targeted diagnostic integration, variable absent | Skipped | `FIXED_COST_DIAGNOSTIC_TASK_IDS` was not available; no live result is claimed for the corrected SQL. |

## 12. Change log

| Date | Change |
|---|---|
| 2026-09-22 | Created implementation tracker from replica schema findings. Added public-contract, diagnostic, reconciliation, query-plan and release phases. |
| 2026-09-22 | Implemented Slice 1 fixed-cost route shell: strict shared request validation, disabled scope registry, deterministic `SEMANTICS_UNVERIFIED` gate and future response metadata contracts. No monetary repository or replica query was added. |
| 2026-09-22 | Implemented Slice 2 internal truck diagnostic contract/repository, unit tests and opt-in integration test. Verified schema and indexed plans; recorded categorical bounded-sample evidence. Public endpoints and all disabled semantic capabilities unchanged. |
| 2026-09-22 | Slice 2 review corrections: removed hardcoded `infot_2.` qualifiers from diagnostic SQL, added a regression test, reduced the documented `masinos` schema to the relevant subset, and clarified that Slice 1 was committed as `2b252b8` before Slice 2. |

## 13. Slice 2 — bounded truck relationship investigation

### Delivery and safeguards

All slices remain on `feature/mp-8-fixed-costs`, following Slice 1 checkpoint `2b252b8`, for one merge request. The independent Claude audit informed the repository-plus-test architecture only; authenticated schema metadata and bounded replica queries supplied the structural evidence.

`diagnoseFixedCosts(pool, { taskIds })` accepts exactly one own data property, `taskIds`, with 1–20 distinct positive safe integers. Validation copies the complete list before any pool call. The public `FixedCostRequest` parser is not reused or extended. `InvalidFixedCostDiagnosticInput` is an internal error, with no new public error code.

The opt-in test reads only `FIXED_COST_DIAGNOSTIC_TASK_IDS`, as canonical comma-separated decimal integers with no whitespace, leading zeros, signs, exponents or SQL fragments. It passes through the same contract, loads normal configuration, creates the pool with `config.safety.queryTimeoutMs`, and closes it in `finally`. An absent variable skips; a present malformed value fails before creating a pool. Run with `node --import tsx --test tests/integration/fixed-cost-diagnostics.test.ts` in an environment where the variable is supplied privately. Never place real IDs in source, documentation or command arguments.

Repository plus opt-in test is sufficient for engineering investigation. No HTTP diagnostic route, CLI, public response, generic table query, concurrency gate or production monetary aggregation is added. A future HTTP executor would require the existing application analytics gate; this slice has at most 40 sequential statements and the configured per-query timeout.

SQL returns only categories. The repository reconstructs allowlisted fields and rejects unknown category values, dropping any extra driver fields. Outputs contain zero-based `inputPosition`, eight categorical checks, `sampleSize` and `complete`. IDs, registration numbers, raw rows and amounts are never returned or logged. Errors use existing timeout detection and `ReplicaDiagnosticError` sanitization, without raw errors, SQL, parameters or causes. The integration test prints aggregate category counts only and replaces failures with static labels.

`complete` means all supplied inputs were checked without detail overflow. It does not mean global coverage, approved financial semantics, or a consistent snapshot across sequential queries. Missing rows remain legitimate categories. An `over_limit` detail result makes the sample incomplete; no partial exact count is represented as complete.

### Confirmed schema facts (authenticated metadata, 2026-09-22)

Searches for `kastai_fiksuoti` and `vilkikai` each returned `meta.complete: true`. Every existing required table returned `columns_complete`, `indexes_complete` and `foreign_keys_complete` as true. All four existing required tables have no declared foreign keys. No date-leading fixed-cost index was present. Approximate row counts are optimizer statistics, not exact counts.

Defaults below are reported exactly to the extent exposed by the schema API: **R** means `default_redacted: true`, so the value is unknown (not an inferred empty string or zero date); **none** means metadata default `null` without redaction; **NULL** is the explicitly exposed nullable default. No redacted default is needed by an implemented check.

| Table | Approximate rows | Primary / unique keys | Other indexes (name: ordered columns) |
|---|---:|---|---|
| `kastai_fiksuoti_ataskaita` | 1,532,657 | `PRIMARY(uzdavinys)`; no other unique key | None |
| `kastai_fiksuoti_vilkikai` | Unknown | Unknown | Exact endpoint returned 404; absent from both complete relevant searches. No substitute table inferred. |
| `kastai_fiksuoti_vilkikai_det` | 1,594,454 | `PRIMARY(uzdavinys, kastai_data)`; no other unique key | None |
| `masinos` | 3,985 | `PRIMARY(id)`; no other unique key | Relevant subset only: `masinos_nr(masinos_nr)`; `paskutinis_uzdavinio_id(paskutinis_uzdavinio_id)`; `masinos_nebedirba_IDX(nebedirba)`; all non-unique. Other indexes on unrelated columns omitted. |
| `masinos_valdymas` | 474,595 | `PRIMARY(id)`; no other unique key | `data_iki(data_iki)`; `data_nuo(data_nuo)`; `masinos_id(masinos_id)`; `masinos_id_data_nuo_data_iki_idx(masinos_id, data_nuo, data_iki)`; all non-unique |

All columns of `kastai_fiksuoti_ataskaita` (14, all NOT NULL):

| Columns | SQL type | Default |
|---|---|---|
| `uzdavinys` | `int(11)` | 0; PK, not auto-increment |
| `kastai_data`, `locked_kastaiVilkiko_data`, `locked_kastaiPriekabos_data`, `locked_kastaiSkyriaus_data` | `date` | R |
| `kastaiVilkiko`, `kastaiPriekabos`, `kastaiSkyriaus`, `locked_kastaiVilkiko`, `locked_kastaiPriekabos`, `locked_kastaiSkyriaus` | `decimal(13,2)` | 0 |
| `du_vairuotojai_dienu` | `decimal(4,2)` | 0 |
| `deleted` | `tinyint(1)` | 0 |
| `last_update` | `datetime` | R |

Task candidate: `uzdavinys`; no truck ID. Current/locked truck amount candidates: `kastaiVilkiko` / `locked_kastaiVilkiko`; candidate calculation/lock dates listed above. `deleted` and lock-looking columns do not establish a reportability rule. Numeric join candidate is `uzdavinys = uzdaviniai.id`; currency, period and source authority are unapproved.

All columns of `kastai_fiksuoti_vilkikai_det` (17, all NOT NULL):

| Columns | SQL type | Default |
|---|---|---|
| `uzdavinys` | `int(11)` | 0 |
| `kastai_data` | `date` | R |
| `amortizacija`, `remontas`, `padangos`, `draudimai`, `lizingas`, `vairuotojuDU`, `administracijaDU`, `kitiMokesciai`, `vairuotojoTelefonas`, `CMRdraudimas`, `papildomosIslaidos`, `vairuotojuDUPL`, `ruosimasGrazinimui`, `draudiminiuRemontuDedamoji` | `decimal(13,2)` | 0 |
| `general_administrative_expenses` | `decimal(13,2)` | none |

Task candidate: `uzdavinys`; date candidate: `kastai_data`. No direct truck ID, stored total, locked amount, deletion/status field or currency column. Structural join candidate: `uzdavinys = uzdaviniai.id`. Only cardinality is implemented; components are not summed or compared with summary amounts.

All columns of `masinos_valdymas` (8, all NOT NULL):

| Columns | SQL type | Default |
|---|---|---|
| `id` | `int(11)` | none; PK, auto-increment |
| `masinos_id`, `skyrius_id`, `user_id`, `uzdavinio_id` | `int(11)` | 0 |
| `data_nuo`, `data_iki` | `date` | R |
| `prastovos_tipas` | `int(11)` | 1074 |

Truck candidate: `masinos_id = masinos.id`; task candidate: `uzdavinio_id = uzdaviniai.id` (no task-leading index). Interval candidates: `data_nuo`, `data_iki`. No monetary or locked amount, deletion field or explicit lock flag. `prastovos_tipas` meaning is unverified. Neither task linkage nor applicable interval rules are established by these names.

The complete `masinos` schema (138 columns) was inspected through the schema API. This document intentionally records only the fields relevant to fixed-cost relationship diagnostics; unrelated and potentially sensitive fields are omitted. Field names prove structure only and do not establish business meaning.

| Columns | SQL type | Nullable | Default |
|---|---|---|---|
| `id` | `int(11)` | NN | none; PK, auto-increment |
| `masinos_nr` | `varchar(50)` | NN | R |
| `tipas_kastu`, `paskutinis_uzdavinio_id` | `int(11)` | NN | 0 |
| `nebedirba` | `tinyint(4)` | NN | 0 |
| `nebedirba_nuo`, `dirba_nuo` | `date` | NN | R |

NN = NOT NULL. `nebedirba`, `nebedirba_nuo` and `dirba_nuo` are recorded only as observed status/lifecycle-looking candidates; their meaning is unverified.

Truck identifier candidate: `id`. Task-looking master field: `paskutinis_uzdavinio_id`, unused. No verified task fixed-cost current/locked pair, calculation date/period or lock flag exists here. `nebedirba` / `nebedirba_nuo` and other flags have no approved diagnostic inclusion semantics; none is filtered. Master dates and monetary-looking fields are not used. `masinos_nr` is textual and non-unique; its mapping to `uzd_vilk_vaziavo` is unverified. `priekabos` was not needed or inspected in this slice.

The previously captured `uzdaviniai` evidence was reused; the diagnostic column subset was reverified through the schema API: `id int(11)` NN auto-increment PK, default none; `uzdavinio_masina int(11)` NN default 0, separate non-unique index; `uzd_vilk_vaziavo varchar(55)` NN default R, separate non-unique index; `kastaiVilkiko decimal(13,2)` NN default 0; `last_update datetime` NN default R. No declared FKs. Refreshed approximate rows: 4,095,413 versus earlier 4,095,293. No task-table scan or non-zero-cost search was performed. Real zero dates from prior bounded evidence remain a reason not to use `last_update` as a reporting date.

### Implemented query purposes and structural hypotheses

1. For each input, one constant parameter row left-joins `uzdaviniai.id`, summary `uzdavinys`, then `masinos.id = NULLIF(uzdavinio_masina, 0)`. It returns task and summary presence, summary zero/one cardinality, exact task-versus-summary truck equality, exact summary current-versus-locked truck equality, and assigned-truck coverage. All joins target unique primary keys, so there is no fan-out or need for a summary sentinel. Multiple summaries are structurally impossible under the verified PK; the contract therefore exposes only zero/one.
2. For the same input, a covering task-prefix lookup in `kastai_fiksuoti_vilkikai_det` reads at most 101 constant entries, then counts them to classify details as zero/one/multiple/over_limit (safe bound 100). The sentinel is applied to the inner fan-out query, not mechanically to a grouped result. No date or component is returned.

Every task ID appears only as a bound parameter, once per statement. Each query shape is fixed and has no caller-controlled names, fields, expressions or ordering. The task-to-summary, detail-to-task and assigned-master relationships remain structural hypotheses supported by the sample, not approved business mappings. No deletion, status or lock-based inclusion filter is applied. Missing means SQL NULL (including absent joined rows); zero is never converted to missing for monetary comparisons. `truckTotals` uses task as left and summary as right; `currentLocked` uses current as left and locked as right. The non-null source amount definitions make single-side missing current/locked values unreachable in the present schema, but the comparison vocabulary remains explicit.

### EXPLAIN evidence

Read-only bounded plans were measured before implementation using a task selected internally from the summary PK. No identifiers, parameters, monetary values or business rows are recorded here. The only scan of a base index is the explicitly bounded 20-row summary sample selector (`ORDER BY uzdavinys DESC LIMIT 20`). Diagnostic statements do not select their own inputs.

| Table / alias | Access type | Selected key | Estimated rows | Extra |
|---|---|---|---:|---|
| `kastai_fiksuoti_ataskaita` (sample selection) | index | PRIMARY | 20 | Using index |
| `<derived2>` (one parameter row) | system | — | 1 | empty |
| `uzdaviniai` (`t`) | const | PRIMARY | 1 | empty |
| `kastai_fiksuoti_ataskaita` (`s`) | const | PRIMARY | 1 | empty |
| `masinos` (`m`) | const | PRIMARY | 1 | Using index |
| — (parameter SELECT) | — | — | 0 | No tables used |
| `<derived2>` (bounded detail entries) | ALL | — | 2 | empty |
| `kastai_fiksuoti_vilkikai_det` | ref | PRIMARY | 1 | Using index |

The `ALL` access is over the derived result capped at 101 entries, not an uncontrolled base-table scan. No new index is needed for these two diagnostic shapes. Date-only scans remain unsupported. Plans are sample evidence and should be rechecked after schema/index changes.

### Bounded integration evidence and remaining approval questions

The opt-in test was run with 20 IDs selected internally from the smaller summary table by its PK, passed through the environment only and never persisted or printed. Aggregate categories: tasks present 20; summaries present 20; summary cardinality one 20; task/summary truck totals different 20; current/locked different 20; assigned truck populated with master 20; details present 20; detail cardinality one 20. All other category counts were zero; sample size 20; complete true. This newest-summary sample is neither representative of all history nor a closed-period financial reconciliation. It supplies bounded diagnostic support for the join hypotheses only.

Omitted checks and blockers:

- `kastai_fiksuoti_vilkikai`: missing exact table; no assumed replacement.
- Summary/detail monetary reconciliation: no proven component set or additivity; locked detail sources not needed.
- History cardinality: numeric truck/date fields and an index exist, but selecting the applicable summary versus lock versus detail date, inclusive/exclusive boundaries, zero/open dates and `uzdavinio_id` behavior requires ERP/BA evidence. No interval predicate was invented.
- Assigned/actual equality: integer IDs and textual actual values differ in representation; no proven mapping, and master registration is non-unique.
- Trailer, department, support and expedition monetary diagnostics: outside this truck slice.

BA/ERP/Finance still must approve source precedence, amount meaning, component overlap, current/locked selection, currency, reporting period/date, deletion/status rules, zero/negative treatment, historical mapping, and a closed-period ERP reference. Equality here is exact database equality only; business tolerance remains unresolved. No amounts are added, no tolerance is introduced, and neither representation is made authoritative. MP-37/40/41/42 mappings are not inferred.

Production monetary aggregation remains disabled. Every `fixedCostSemanticCapabilities` entry remains `enabled: false`. All three public endpoints still return `SEMANTICS_UNVERIFIED` for valid requests. Slice 1 contracts, capabilities, routes and `src/app.ts` are unchanged.
