# MP-8 Fixed-Cost Analytics Endpoint — Implementation Tracker

**Project:** BT Finance Analyst
**Repository:** `bt-erp-api-prototype`
**Target path:** `docs/costs-endpoint.md`
**Status:** Slice 1 implemented — awaiting diagnostic slice
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
| Fixed-cost summary → task | `kastai_fiksuoti_ataskaita.uzdavinys = uzdaviniai.id` | `[ ]` Validate cardinality and coverage |
| Truck detail → task | `kastai_fiksuoti_vilkikai_det.uzdavinys = uzdaviniai.id` | `[ ]` Validate |
| Trailer detail → task | `kastai_fiksuoti_priekabos_det.uzdavinys = uzdaviniai.id` | `[ ]` Validate |
| Department detail → task | `kastai_fiksuoti_skyriaus_det.uzdavinys = uzdaviniai.id` | `[ ]` Validate |
| Assigned truck → master | `uzdaviniai.uzdavinio_masina = masinos.id` | `[ ]` Compare with actual-truck field |
| Actual truck → master | `uzdaviniai.uzd_vilk_vaziavo = masinos.id` | `[ ]` Confirm business meaning |
| Assigned trailer → master | `uzdaviniai.uzdavinio_priekaba = priekabos.id` | `[ ]` Compare with actual-trailer field |
| Actual trailer → master | `uzdaviniai.uzd_pr_vaziavo = priekabos.id` | `[ ]` Confirm business meaning |
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
- [x] Reject unknown parameters. Evidence: endpoint-specific allowlists and fixed-cost unit tests.
- [x] Reject repeated scalar parameters. Evidence: non-string repeated Fastify query values are rejected and tested.
- [x] Validate ISO date syntax. Evidence: strict calendar-date validation in `parseFixedCostRequest` and tests.
- [x] Require compatible date bounds and reject `dateFrom > dateTo`. Evidence: fixed-cost unit tests.
- [x] Define and test maximum date-range length. Evidence: maximum 366-day range in `fixedCostMaximumDateRangeDays` and fixed-cost unit tests.
- [ ] Bound `page`, `per_page` and grouping result count.
- [ ] Allow only deterministic sorting with a stable tie-breaker.
- [x] Reject unsupported filters, dimensions and measures deterministically. Evidence: endpoint-specific allowlists and fixed-cost unit tests.
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
- [x] Do not create a generic dynamic query-builder abstraction. Evidence: three route-specific endpoint allowlists and no repository/query builder in this slice.

### Phase E — Bounded diagnostic capability

The diagnostic capability is internal/administrative and must not accept arbitrary SQL.

- [ ] Add a hardcoded diagnostic repository.
- [ ] Require a small bounded task sample or a tightly bounded date/sample selector.
- [ ] Compare `uzdaviniai` totals with `kastai_fiksuoti_ataskaita` totals.
- [ ] Compare task-level summary totals with corresponding component-detail sums.
- [ ] Compare current totals with locked totals without adding them together.
- [ ] Compare assigned and actual truck identifiers.
- [ ] Compare assigned and actual trailer identifiers.
- [ ] Check task-to-master join coverage.
- [ ] Check historical department mapping cardinality.
- [ ] Report mismatches and missing mappings explicitly.
- [ ] Keep diagnostic output bounded and exclude unrelated or sensitive fields.

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
- [ ] Run `npm run test:integration` when the replica-test environment is available.
- [ ] Record final test results below.

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
| — | — | — | — | — | Not measured |

## 11. Test record

| Date | Commit/worktree | Command | Result | Notes |
|---|---|---|---|---|
| 2026-09-22 | Uncommitted Slice 1 | `npm run typecheck` | Passed | TypeScript compilation completed with no errors. |
| 2026-09-22 | Uncommitted Slice 1 | `npm test` | Passed | All 11 unit-test files passed, including `tests/unit/fixed-costs.test.ts`. |
| 2026-09-22 | Uncommitted Slice 1 | `npm run test:integration` | Failed (6/7 passed) | Replica infrastructure was available. The pre-existing live invoice reconciliation test observed a one-row count change between separate live samples; no fixed-cost endpoint or query was involved. |

## 12. Change log

| Date | Change |
|---|---|
| 2026-09-22 | Created implementation tracker from replica schema findings. Added public-contract, diagnostic, reconciliation, query-plan and release phases. |
| 2026-09-22 | Implemented Slice 1 fixed-cost route shell: strict endpoint-specific request validation, disabled scope registry, deterministic `SEMANTICS_UNVERIFIED` gate and future response metadata contracts. No monetary repository or replica query was added. |
