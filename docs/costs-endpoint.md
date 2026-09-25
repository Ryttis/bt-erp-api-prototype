# MP-8 Fixed-Cost Analytics Endpoint — Implementation Tracker

**Project:** BT Finance Analyst
**Repository:** `bt-erp-api-prototype`
**Target path:** `docs/costs-endpoint.md`
**Status:** Slices 1, 2 and 3A implemented — production monetary semantics remain unverified; coding gate closed
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
- [x] Slice 3A: classify task/current/locked truck values by sign, the raw `deleted` flag, current/locked date states and relationships, and bounded detail-date equality against both summary dates. Categories only; see section 14.

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
| 2026-09-23 | Record ERP developer business confirmations FCB-01 to FCB-12 as a distinct dated evidence class, separate from schema facts and replica measurements. | ERP developer statements, section 15. | ERP developer | Confirmed |
| 2026-09-23 | Reconcile only months starting at least six months before the current month. | Doubles the FCB-10 three-month recalculation window as a conservative margin. | Engineering safety decision; Finance bound not approved | Active |
| 2026-09-23 | Classify decimal differences with a 0.01 EUR tolerance. | Stored `decimal(13,2)` scale; applied as exact SQL decimal arithmetic. | Implementation safety value; pending Finance approval under FC-14 | Active |
| 2026-09-23 | Do not infer which component subset composes the stored truck total. | Section 15 shows the full 15-component sum fails for ~45-48% of probed tasks; selecting a matching subset would manufacture a business rule. | Engineering safety decision | Active |
| 2026-09-23 | Classify absolute differences into six magnitude buckets in SQL decimal arithmetic, reporting comparable, all-sampled and relative-to-exact denominators. | Section 16; bucket ladder generated from one shared constant. | Engineering decision; bucket names carry no Finance judgement | Active |
| 2026-09-23 | Exclude the truncation sentinel from every counter while preserving the `LIMIT 5001` hard bound. | `ROW_NUMBER()` gate; metadata separates `taskLimit`, `sampledTaskCount` and `fetchedTaskCount`. | Engineering correction | Active |
| 2026-09-23 | Aggregate quarters and years by summing counts before deriving percentages; never average monthly percentages. | Pure tested aggregation function. | Engineering decision | Active |
| 2026-09-23 | Treat `kastai_fiksuoti_ataskaita` as the authoritative task-level total and both detail tables as explanatory breakdowns only; never recompute the total from components. | Section 17; enforced by static SQL and mutation tests. | Engineering implementation decision; not an ERP-report reconciliation | Active |
| 2026-09-23 | Carry every monetary value as canonical decimal text, with all arithmetic in SQL `DECIMAL`. | `CAST(... AS CHAR)` plus canonical-decimal validation; no JavaScript number conversion. | Engineering decision | Active |
| 2026-09-23 | Always group monetary results by declared `deleted` state, and refuse aggregation until an internal approved policy is supplied. | Unapproved default fails closed before replica access (FC-03). | Engineering safety decision | Active |
| 2026-09-23 | Raise rather than return a partial monetary result when a period exceeds the record bound. | `FixedCostMonetaryTruncated`; the statement reads `limit + 1`. | Engineering safety decision | Active |
| 2026-09-23 | Report null, never `0.00`, for every comparison field of a group with no comparable record, and mark it `structurally_non_comparable`. | `SUM(CASE WHEN comparable = 1 ... ELSE NULL END)`; projection fails closed in both directions. | Engineering safety correction | Active |
| 2026-09-23 | Always `LEFT JOIN uzdaviniai`, keep orphan summary rows in the authoritative population and count them with `missingTaskCount`. | A truck allowlist still excludes orphans deterministically, because an orphan cannot be mapped to a requested truck. | Engineering safety correction | Active |
| 2026-09-23 | State the reporting-period basis as `dateBasis: "kastai_data"` for both representations. | `locked_kastaiVilkiko_data` stays lock-event metadata and is never a period filter. | Engineering decision, per FCB-06 | Active |

## 8. Open questions

| ID | Question | Owner | Blocking production totals? | Status |
|---|---|---|---|---|
| FC-01 | Is `kastai_fiksuoti_ataskaita` authoritative, or is `uzdaviniai` the authoritative repeated representation? | ERP/BA | Yes | Confirmed 2026-09-23 (FCB-01, FCB-02): `kastai_fiksuoti_ataskaita` holds the calculated task-level results; `kastaivilkikai` is configuration input. |
| FC-02 | When must current versus locked values be used? | ERP/Finance | Yes | Partly: FCB-05 defines lock state and FCB-09 confirms ERP displays both separately. The API selection/exposure rule is still an open contract decision. |
| FC-03 | Does `deleted = 0` define reportable summary rows? | ERP/Finance | Yes | Open. Section 17 observes that every `deleted = 1` record in three complete months had zero detail rows, so none was comparable. That is structural, not a business rule; monetary results stay separated by declared state and aggregation fails closed without an approved policy. |
| FC-04 | Which date controls reporting? | Finance | Yes | Confirmed 2026-09-23 (FCB-06): `kastai_data` is the cost month. |
| FC-05 | Are all fixed costs implicitly in EUR or already converted? | Finance/ERP | Yes | Confirmed 2026-09-23 (FCB-07): EUR. |
| FC-06 | Do task summary totals reconcile to the sum of detail components? | ERP/Finance | Yes | Open, narrowed: section 16 measures every comparable task within 1.00 EUR across 24 months, with 56.68% within 0.01 EUR. Additivity holds at euro scale; the sub-euro residual rule is unapproved. |
| FC-07 | Which component columns are independently additive? | ERP/Finance | Yes | Open: the full 15-component sum reproduces the stored total within 1.00 EUR for every comparable task. No subset was tried and none is proposed. |
| FC-08 | Should truck reporting use `uzdavinio_masina` or `uzd_vilk_vaziavo`? | ERP/BA | Yes for truck grouping | Confirmed 2026-09-23 (FCB-08): `uzdavinio_masina`. |
| FC-09 | Should trailer reporting use `uzdavinio_priekaba` or `uzd_pr_vaziavo`? | ERP/BA | Yes for trailer grouping | Open |
| FC-10 | How are tasks attributed when historical department intervals overlap or are missing? | ERP/BA | Yes for department grouping | Open |
| FC-11 | Which ERP report and closed period will be used for reconciliation? | Finance | Yes | Open |
| FC-12 | What do `uzdaviniai.kastaiVilkiko`, `kastai_fiksuoti_ataskaita.kastaiVilkiko` and `locked_kastaiVilkiko` each represent? | ERP/BA | Yes | Confirmed 2026-09-23 (FCB-03, FCB-04, FCB-05): component split, locked representation, and `0000-00-00` as not locked. |
| FC-13 | Are zero and negative truck fixed-cost amounts valid? | Finance/ERP | Yes | Open |
| FC-14 | What reconciliation tolerance, if any, is acceptable? | Finance | Yes | Open and now concrete: the 0.01 EUR implementation value is too tight to describe the data; a threshold at or above 1.00 EUR per task would classify every comparable row in the 2024-2025 sweep as reconciled. |
| FC-15 | Does one task belong to exactly one truck fixed-cost calculation? | ERP/BA | Yes | Open |
| FC-16 | Which task date field, if any, participates in fixed-cost reporting? | Finance/BA | Yes | Confirmed 2026-09-23 (FCB-06): the cost month is `kastai_data`. |

## 9. Reconciliation log

| Date | Scope | Period | ERP reference | API/diagnostic result | Difference | Outcome |
|---|---|---|---|---|---|---|
| 2026-09-23 | truck | 2025-03 (engineering probe) | None available | Bounded counters only; see section 15 | 2,185 of 4,894 tasks outside 0.01 | Not reconciled — additivity fails, no ERP reference |
| 2026-09-23 | truck | 2025-07 (engineering probe) | None available | Bounded counters only; see section 15 | 2,343 of 4,921 tasks outside 0.01 | Not reconciled — additivity fails, no ERP reference |
| 2026-09-23 | truck | 2024-01 to 2025-12, all 24 months (bounded prefix diagnostic) | None available | Bounded counters and magnitude buckets only; see section 16 | 0 of 116,678 comparable current rows above 1.00 EUR; 55,136 above 0.01 EUR | Not reconciled — no ERP reference; tolerance unapproved |

## 10. Query-plan evidence

| Date | Operation | Tables | Bounds | Index/plan result | Acceptable? |
|---|---|---|---|---|---|
| 2026-09-22 | Slice 2 task/summary/master categories | `uzdaviniai`, `kastai_fiksuoti_ataskaita`, `masinos` | One parameter per statement; at most 20 inputs | PRIMARY / const / one estimated row per base table; full evidence in section 13 | Yes, internal diagnostic only |
| 2026-09-22 | Slice 2 detail cardinality | `kastai_fiksuoti_vilkikai_det` | Task prefix; LIMIT 101 | PRIMARY / ref / Using index; derived scan bounded to 101 entries | Yes, internal diagnostic only |
| 2026-09-22 | Slice 3A extended task/summary/master categories | `uzdaviniai`, `kastai_fiksuoti_ataskaita`, `masinos` | One parameter; at most 20 inputs | Unchanged: PRIMARY / const / one estimated row per base table; details in section 14 | Yes, internal diagnostic only |
| 2026-09-22 | Slice 3A extended detail categories | `kastai_fiksuoti_vilkikai_det`, `kastai_fiksuoti_ataskaita` | Task prefix LIMIT 101 plus one summary PK row; two bound parameters | Detail PRIMARY / ref / Using index; summary PRIMARY / const; derived scan bounded to 101 entries | Yes, internal diagnostic only |
| 2026-09-23 | Slice 4 month reconciliation | `kastai_fiksuoti_ataskaita`, `uzdaviniai`, `masinos`, `kastai_fiksuoti_vilkikai_det`, `kastai_fiksuoti_vilkikai_det_locked` | Two month bounds; `LIMIT 5001`; analytics gate and query timeout | Task/truck/detail all PRIMARY `eq_ref`/`ref` at one estimated row; derived summary set capped at 5,001 | Yes for an internal bounded diagnostic |
| 2026-09-23 | Slice 4 month filter on the summary table | `kastai_fiksuoti_ataskaita` | `kastai_data` range | `type: index`, full PK walk of ~1,556,311 rows with `Using where`; no index exists on `kastai_data` | No for a public monetary endpoint |

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
| 2026-09-22 | `07067a9` (committed Slice 2) | Targeted diagnostic integration, private 20-task sample | Passed | Corrected unqualified SQL ran against the configured replica; `DATABASE()` matched `ERP_REPLICA_DATABASE`. Category counts identical to the earlier Slice 2 evidence. |
| 2026-09-22 | Uncommitted Slice 3A over `07067a9` | `npm run typecheck` | Passed | |
| 2026-09-22 | Uncommitted Slice 3A | `npm test` | Passed | 71 unit tests; the diagnostic file's nine tests cover the extended SQL allowlist, two-parameter detail binding, the new category allowlists, malformed/raw driver values failing closed, dropped extra fields and sanitized errors. Mutations removing the detail `LIMIT` or qualifying the new summary join were each caught. |
| 2026-09-22 | Uncommitted Slice 3A | Targeted diagnostic integration, private 20-task sample | Passed | Aggregate category and pattern counts only, recorded in section 14. |
| 2026-09-22 | Uncommitted Slice 3A | `npm run test:integration` | Passed | Seven live tests passed; diagnostic test skipped because its opt-in variable was absent. Only pass/fail lines were displayed. |
| 2026-09-23 | Uncommitted Slice 4 over `8fba9ea` | `npm run typecheck` | Passed | No TypeScript errors. |
| 2026-09-23 | Uncommitted Slice 4 | `npm test` | Passed | 84 unit tests, 0 failures; 13 are the new reconciliation file covering month validation, settlement bounds, static/unqualified SQL, current/locked separation, the 15-component sums, tolerance boundaries and ordering, every category value, the task bound, fail-closed aggregates, counter-only output, sanitized driver errors, analytics-gate concurrency and saturation, and unchanged public gating. |
| 2026-09-23 | Uncommitted Slice 4 | Targeted reconciliation integration, 2025-03 and 2025-07 | Passed | Engineering probe months. EXPLAIN plus aggregate counters only; recorded in section 15. Both hit the 5,000-task bound. |
| 2026-09-23 | Uncommitted Slice 4 | `npm run test:integration` | Passed | 7 live tests passed, 2 opt-in fixed-cost tests skipped because their variables were absent. Existing-suite business-data logs were suppressed from displayed output. |
| 2026-09-23 | Uncommitted Slice 4 continued | `npm run typecheck` | Passed | No TypeScript errors. |
| 2026-09-23 | Uncommitted Slice 4 continued | `npm test` | Passed | 98 unit tests, 0 failures; 27 in the reconciliation file, including boundary cases at 0.00/0.01/0.02/1.00/1.01/10.00/10.01/100.00/100.01, ABS on negative differences, zero-denominator nulls, sentinel exclusion, count-based aggregation and four mutation guards. |
| 2026-09-23 | Uncommitted Slice 4 continued | Opt-in reconciliation, 24 months of 2024-2025 | Passed | Sequential; 288-387 ms per month; counters, buckets and aggregates only. Recorded in section 16. |
| 2026-09-23 | Uncommitted Slice 4 continued | `npm run test:integration` | Passed with a known flake | Fixed-cost tests skipped by default as designed. The pre-existing `live invoices` test failed on 2 of 4 runs and passed on the others, reproducing the live row-count drift already recorded for Slice 1. It imports nothing from `src/fixed-costs/`. |
| 2026-09-23 | Uncommitted Slice 4 continued | `git diff --check` | Passed | Scoped to the Slice 4 files. |
| 2026-09-23 | Uncommitted Slice 5 over `e295c82` | `npm run typecheck` | Passed | No TypeScript errors. |
| 2026-09-23 | Uncommitted Slice 5 | `npm test` | Passed | 119 unit tests, 0 failures; 21 in the new monetary file, including strict query validation, current/locked separation, authoritative-total provenance, decimal-string retention, net versus gross, Slice 4 bucket reuse, non-comparable handling, the fail-closed deleted policy, bounds, gate and timeout behavior, sanitized errors and five mutation guards. |
| 2026-09-23 | Uncommitted Slice 5 | Opt-in monetary integration, 2024-01, 2025-03, 2025-12 | Passed | Complete months within the 50,000-record bound; counts only, roughly 2 s each. Recorded in section 17. |
| 2026-09-23 | Uncommitted Slice 5 | `npm run test:integration` | Passed with the known flake | Fixed-cost tests skip by default. The pre-existing `live invoices` test failed on 1 of 2 runs and passed on the other, reproducing the recorded live row-count drift. It imports nothing from `src/fixed-costs/`. |
| 2026-09-23 | Slice 5 pre-commit corrections | `npm test` | Passed | 128 unit tests, 0 failures; 30 in the monetary file, including null comparison fields, fail-closed mismatches in both directions, orphan preservation, `missingTaskCount` validation, truck-filter placeholder binding and the shared cost-month basis, plus three added mutation guards. |
| 2026-09-23 | Slice 5 pre-commit corrections | Opt-in monetary integration, 2025-03 | Passed | Record counts identical to the pre-correction run; `missingTaskCount` 342, all in the `deleted = 1` group; null comparison fields confirmed live. |
| 2026-09-23 | Uncommitted Slice 5 | `git diff --check` | Passed | Scoped to the Slice 5 files. |
| 2026-09-23 | Uncommitted Slice 4 | `git diff --check` | Passed | Scoped to the Slice 4 files. |

## 12. Change log

| Date | Change |
|---|---|
| 2026-09-22 | Created implementation tracker from replica schema findings. Added public-contract, diagnostic, reconciliation, query-plan and release phases. |
| 2026-09-22 | Implemented Slice 1 fixed-cost route shell: strict shared request validation, disabled scope registry, deterministic `SEMANTICS_UNVERIFIED` gate and future response metadata contracts. No monetary repository or replica query was added. |
| 2026-09-22 | Implemented Slice 2 internal truck diagnostic contract/repository, unit tests and opt-in integration test. Verified schema and indexed plans; recorded categorical bounded-sample evidence. Public endpoints and all disabled semantic capabilities unchanged. |
| 2026-09-22 | Slice 2 review corrections: removed hardcoded `infot_2.` qualifiers from diagnostic SQL, added a regression test, reduced the documented `masinos` schema to the relevant subset, and clarified that Slice 1 was committed as `2b252b8` before Slice 2. |
| 2026-09-22 | Slice 3A bounded live semantic investigation: reran corrected Slice 2 SQL live; added ten categorical diagnostics (sign classes, raw deleted flag, date states and relationships); recorded EXPLAIN, aggregate evidence and the approval-question list in section 14. Coding gate remains closed. |
| 2026-09-23 | Slice 4: recorded ERP developer confirmations FCB-01 to FCB-12; captured the locked truck detail schema; added a bounded internal month-reconciliation capability with static SQL, a settlement bound, a documented 0.01 EUR tolerance and counter-only output; recorded EXPLAIN and two engineering-probe months. Measurement contradicts the expected component additivity, so the coding gate stays closed. |
| 2026-09-23 | Slice 4 continued: added SQL magnitude buckets for absolute component differences with three documented denominators, corrected the truncation sentinel so counters never exceed the declared bound, added count-based quarterly/yearly aggregation, and swept all 24 months of 2024-2025. The magnitude evidence supersedes the earlier "additivity fails" reading: no comparable task differs by more than 1.00 EUR. Gate remains closed. |
| 2026-09-23 | Slice 5: added the internal truck monetary contract and repository with decimal-string safety, explicit current/locked separation, authoritative totals read never recomputed, net and gross difference reporting, reuse of the Slice 4 buckets, structural non-comparable counters and a fail-closed unapproved deleted-row policy. Verified three complete months within the record bound. No public surface added; gate remains closed. |

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

## 14. Slice 3A — bounded live semantic investigation

### Purpose and boundaries

Slice 3A characterizes the Slice 2 truck mismatches with additional categorical evidence and lists the decisions still needed from ERP/BA/Finance. It extends the existing internal repository and opt-in integration test only. It adds no HTTP route, CLI, generic query tool, capability, monetary aggregation, numeric difference, ratio, subtotal, component sum or raw value/date output. All three public endpoints still return `SEMANTICS_UNVERIFIED`; every `fixedCostSemanticCapabilities` entry remains `enabled: false`.

### Diagnostic categories added

| Category | Values | SQL basis | Why needed |
|---|---|---|---|
| `taskLockedTotals` | `both_missing`, `left_missing`, `right_missing`, `equal`, `different` | exact equality of `uzdaviniai.kastaiVilkiko` (left) and summary `locked_kastaiVilkiko` (right) | Tests whether the task/summary difference co-occurs with the locked representation. |
| `taskTruckValue`, `summaryCurrentValue`, `summaryLockedValue` | `missing`, `negative`, `zero`, `positive` | sign of `uzdaviniai.kastaiVilkiko`, summary `kastaiVilkiko`, summary `locked_kastaiVilkiko` | Distinguishes zero/non-zero and sign without magnitudes or tolerances. |
| `summaryDeletedFlag` | `missing`, `zero`, `one`, `other` | raw `deleted` value | Records flag state without naming it deleted/reportable. |
| `summaryCurrentDate`, `summaryLockedDate` | `missing`, `zero_date`, `valid_date`, `other` | `kastai_data`, `locked_kastaiVilkiko_data`; strict calendar-date text check | Distinguishes populated dates from zero dates without exposing dates. |
| `currentLockedDate` | `both_missing`, `left_missing`, `right_missing`, `equal`, `current_before_locked`, `current_after_locked`, `unclassified` | order of the two summary dates; `unclassified` unless both are valid dates | Relationship only; neither date is treated as the reporting date. |
| `detailCurrentDate`, `detailLockedDate` | `no_details`, `unclassified`, `summary_date_unusable`, `detail_date_unusable`, `all_equal`, `none_equal`, `mixed` | bounded detail `kastai_data` entries compared with each summary date; `unclassified` when detail entries exceed 100 | Relates the detail date to both summary dates without choosing one. |

No task-date relationship was added. `uzdaviniai` has several date/datetime candidates (for example `pasikrovimo_data`, `pristatymo_data`, their `_temp`/`_temp2` variants, `premijavimo_data`, `kada_sukurta`, `last_update`); choosing one would be an unapproved semantic decision (FC-16). Assigned/actual truck comparison remains omitted (no verified text-to-master mapping). Detail components are not read.

### Query and sample bounds

- Input: unchanged, 1–20 distinct positive safe integer task IDs, validated before any pool call.
- Still two fixed statement shapes per task, executed sequentially: at most 40 statements per run.
- Summary shape: one bound parameter; three PK lookups (`uzdaviniai`, `kastai_fiksuoti_ataskaita`, `masinos`).
- Detail shape: now two bound parameters, both the same task ID: one for the task-prefix lookup of at most 101 `(uzdavinys, kastai_data)` index entries, one for the single summary PK row whose dates are compared. This supersedes the section 13 statement that each task ID is bound once per statement.
- All table names are static and unqualified; `ERP_REPLICA_DATABASE` selects the schema. Classification happens in SQL; the driver's representation of decimals and dates never reaches the repository, which accepts only allowlisted category strings.
- The pool is created with `config.safety.queryTimeoutMs`. Errors are sanitized through `FixedCostDiagnosticError`.

### Confirmed structural facts

Re-verified through the authenticated schema API on 2026-09-22 (all completeness flags true):

- `kastai_fiksuoti_ataskaita`: `PRIMARY(uzdavinys)`; `kastaiVilkiko`, `locked_kastaiVilkiko` `decimal(13,2)` NOT NULL default 0; `kastai_data`, `locked_kastaiVilkiko_data` `date` NOT NULL (default redacted); `deleted` `tinyint(1)` NOT NULL default 0.
- `kastai_fiksuoti_vilkikai_det`: `PRIMARY(uzdavinys, kastai_data)`; `kastai_data` `date` NOT NULL.
- `uzdaviniai`: `PRIMARY(id)`; `kastaiVilkiko` `decimal(13,2)` NOT NULL default 0; multiple date/datetime task-date candidates as listed above, with indexes on `pasikrovimo_data` and `pristatymo_data`.
- The unqualified diagnostic SQL resolves against the configured database: `DATABASE()` matched `ERP_REPLICA_DATABASE`.
- Because the amount and date columns are NOT NULL, `missing` values arise only from absent joined rows.

### EXPLAIN evidence (Slice 3A shapes)

Measured with one internally selected task; no identifiers, parameters, dates or values recorded.

| Shape | Table / alias | Access type | Selected key | Estimated rows | Extra |
|---|---|---|---|---:|---|
| Summary | `<derived2>` (one parameter row) | system | — | 1 | empty |
| Summary | `uzdaviniai` (`t`) | const | PRIMARY | 1 | empty |
| Summary | `kastai_fiksuoti_ataskaita` (`s`) | const | PRIMARY | 1 | empty |
| Summary | `masinos` (`m`) | const | PRIMARY | 1 | Using index |
| Summary | — (parameter SELECT) | — | — | — | No tables used |
| Detail | `<derived2>` (bounded detail entries) | ALL | — | 2 | empty |
| Detail | `kastai_fiksuoti_ataskaita` (`s`) | const | PRIMARY | 1 | empty |
| Detail | `kastai_fiksuoti_vilkikai_det` (derived) | ref | PRIMARY | 1 | Using index |

The only `ALL` access is over the derived result capped at 101 entries, not a base table. The detail lookup remains covering (`Using index`); adding `kastai_data` to the derived projection reads only primary-key columns.

### Bounded observations

Sample: 20 task IDs selected internally as the newest summary rows (`ORDER BY uzdavinys DESC LIMIT 20` on the summary PK), passed only through the environment, never printed or persisted. This sample is not representative of history or of any closed period.

All 20 tasks produced one identical category pattern:

| Check | Count |
|---|---|
| task present / summary present / summary cardinality one | 20 / 20 / 20 |
| assigned truck populated with master | 20 |
| details present, detail cardinality one | 20 |
| `truckTotals` (task vs summary current) different | 20 |
| `currentLocked` (summary current vs locked) different | 20 |
| `taskLockedTotals` (task vs summary locked) equal | 20 |
| `taskTruckValue` zero | 20 |
| `summaryCurrentValue` positive | 20 |
| `summaryLockedValue` zero | 20 |
| `summaryDeletedFlag` zero | 20 |
| `summaryCurrentDate` valid_date | 20 |
| `summaryLockedDate` zero_date | 20 |
| `currentLockedDate` unclassified (locked date not a valid date) | 20 |
| `detailCurrentDate` all_equal | 20 |
| `detailLockedDate` summary_date_unusable | 20 |

All other category counts were zero; sample size 20; complete true.

Within this sample, the task/summary difference co-occurred with: task value zero versus positive summary current value; task value equal to the (zero) locked value; a zero locked date; `deleted = 0`; one detail row whose date equals the summary `kastai_data`. No negative values, missing rows, non-zero deleted flags or detail overflow were observed. Because every row shares one pattern, the sample shows co-occurrence only, not which factor explains the difference.

### Hypotheses not proved

- The task-level `kastaiVilkiko` and the locked summary fields may be populated only at a later stage (for example, when a calculation is locked). The sample is consistent with this but does not prove it; the newest tasks may simply not have reached that stage.
- Summary `kastai_data` and detail `kastai_data` may denote the same calculation date for single-detail tasks. Only equality in this sample is shown.
- `deleted = 0` may mark rows as included. Only the raw flag value is shown.
- A closed-period or older sample may show different patterns; none was drawn.

### Unverified business meaning

No source, amount, date, lock, deletion, currency or sign rule is approved. Equality and sign classes are exact database comparisons, not reconciliation. Neither `uzdaviniai` nor the summary table is treated as authoritative, and current and locked values are never selected or combined.

### Approval questions for ERP/BA/Finance

1. Which table and field are authoritative for reportable truck fixed cost?
2. What does `uzdaviniai.kastaiVilkiko` represent?
3. What does `kastai_fiksuoti_ataskaita.kastaiVilkiko` represent?
4. What does `locked_kastaiVilkiko` represent?
5. Under what condition must the current or the locked value be selected?
6. Which date controls financial reporting: a task date, `kastai_data`, the locked calculation date, or another period field?
7. What does `deleted` mean, and must rows with a non-zero value be excluded?
8. Is currency implicit, converted or stored elsewhere?
9. Are zero and negative amounts valid?
10. Are the detail component fields additive, overlapping or alternative representations?
11. Which ERP report and closed period must be used for reconciliation?
12. What tolerance, if any, is acceptable for reconciliation?
13. Does one task belong to exactly one truck fixed-cost calculation?
14. Is historical department ownership required, and which interval-boundary rules apply?

None of these has a recorded named approval in this repository. They map to FC-01 to FC-16 in section 8.

### Coding gate status

The section 6 coding gate remains closed. No authoritative source, currency, reporting-date, deletion/lock, overlap or dimension rule is approved; no closed-period ERP reference or reconciliation exists; response metadata and classification version are unapproved. Production monetary aggregation remains disabled.

## 15. Slice 4 — ERP-confirmed semantics and bounded closed-period reconciliation

### ERP developer-confirmed business semantics (2026-09-23)

These are business statements from the ERP developer, recorded as confirmed on 2026-09-23. They are a different evidence class from the schema facts in sections 3 and 13 and from the replica measurements below. Confirming meaning does not by itself reconcile any period or open the section 6 coding gate.

| ID | Confirmed statement | Resolves |
|---|---|---|
| FCB-01 | `kastaivilkikai` is configuration/classifier input. | FC-01 scope; confirms the section 7 structural decision |
| FCB-02 | `kastai_fiksuoti_ataskaita` contains the calculated task-level fixed-cost results. | FC-01 |
| FCB-03 | `kastai_fiksuoti_vilkikai_det` contains the same truck result split into components. | FC-12 (component role) |
| FCB-04 | The `_locked` tables contain the locked representation. | FC-12 (locked role) |
| FCB-05 | `locked_kastaiVilkiko_data = '0000-00-00'` means the truck result is not locked. | FC-02, FC-12 (lock state) |
| FCB-06 | `kastai_data` identifies the cost month. | FC-04, FC-16 |
| FCB-07 | Currency is EUR. | FC-05 |
| FCB-08 | The truck used for the logistics chain is `uzdaviniai.uzdavinio_masina`. | FC-08 |
| FCB-09 | ERP displays current and locked values separately. | FC-02 (display behavior only) |
| FCB-10 | Recent values can continue recalculating for approximately three months. | Period-settlement input |
| FCB-11 | The detail components are **expected** to produce the task-level truck total, but this must still be verified against replica data. | FC-06, FC-07 — expectation only, not an approval |
| FCB-12 | A settled 2025 month must be used for reconciliation. The exact month and the official ERP reference result are **not** supplied. | FC-11 partially; the selection remains open |

FCB-09 confirms how ERP displays the two representations. It does not decide how the API must expose or select them; that remains a product/contract decision.

FCB-11 is explicitly an expectation to be tested. The measurements below test it and it does not currently hold.

### Confirmed schema facts for the locked truck detail (authenticated metadata, 2026-09-23)

| Table | Approximate rows | Primary / unique keys | Other indexes |
|---|---:|---|---|
| `kastai_fiksuoti_vilkikai_det_locked` | 1,270,694 | `PRIMARY(uzdavinys, kastai_data)`; no other unique key | None |
| `kastai_fiksuoti_vilkikai_det` (refreshed) | 1,480,410 | `PRIMARY(uzdavinys, kastai_data)`; no other unique key | None |
| `kastai_fiksuoti_ataskaita` (refreshed estimate) | ~1,556,311 optimizer rows | `PRIMARY(uzdavinys)` | None |

`kastai_fiksuoti_vilkikai_det_locked` returned `columns_complete`, `indexes_complete` and `foreign_keys_complete` as true, with no declared foreign keys. It carries the identical 17-column layout to the current truck detail: `uzdavinys int(11)`, `kastai_data date`, and the same 15 `decimal(13,2)` NOT NULL component columns:

`amortizacija`, `remontas`, `padangos`, `draudimai`, `lizingas`, `vairuotojuDU`, `administracijaDU`, `kitiMokesciai`, `vairuotojoTelefonas`, `CMRdraudimas`, `papildomosIslaidos`, `vairuotojuDUPL`, `ruosimasGrazinimui`, `draudiminiuRemontuDedamoji`, `general_administrative_expenses`.

Neither detail table has a date-leading index, and the summary table has no secondary index at all. Any month-scoped access therefore cannot be served by an index on the month column.

### Implemented reconciliation capability

`src/fixed-costs/reconciliation-repository.ts` adds one internal, bounded, read-only capability. It has no HTTP or CLI surface and accepts no caller-selected SQL.

- Input is one month in strict `YYYY-MM-01` form. Anything else is rejected before a pool is touched.
- A month is accepted only when it starts at least six months before the current month. This doubles the FCB-10 recalculation window as a conservative safety margin; it is an implementation bound, not an ERP close-of-period rule.
- Exactly two bound parameters are used: the month start and the exclusive next-month start. Table names, columns, the row bound and the tolerance are module constants, so the statement text is static once the module loads.
- Tables are unqualified; the configured `ERP_REPLICA_DATABASE` selects the schema.
- The task prefix is bounded by `LIMIT 5001` — a 5,000-task bound plus one truncation sentinel — ordered by `uzdavinys`.
- Execution runs through the shared `AnalyticsGate` and the configured replica query timeout.
- Output is aggregate counters per allowlisted category, plus the requested month and the documented safety constants. No task ID, truck identifier, date or monetary amount is projected, returned or logged.

Decimal differences are classified in SQL as `exact`, `within_tolerance`, `outside_tolerance` or `no_details`. The tolerance is **0.01 EUR**, recorded as an implementation safety value pending Finance approval under FC-14/FC-P04. Exact equality is tested before the tolerance, so `exact` never absorbs a difference. Current is compared only with current components and locked only with locked components; the two representations are never added or crossed.

### EXPLAIN evidence (2026-09-23, production-shaped statement)

| id | select_type | table | type | key | rows | Extra |
|---:|---|---|---|---|---:|---|
| 1 | PRIMARY | `<derived8>` | ALL | — | 5,001 | |
| 1 | PRIMARY | `t` (`uzdaviniai`) | eq_ref | PRIMARY | 1 | |
| 1 | PRIMARY | `m` (`masinos`) | eq_ref | PRIMARY | 1 | Using where; Using index |
| 8 | DERIVED | `kastai_fiksuoti_ataskaita` | index | PRIMARY | 1,556,311 | Using where |
| 7 | DEPENDENT SUBQUERY | `l` (locked detail) | ref | PRIMARY | 1 | |
| 6 | DEPENDENT SUBQUERY | `l` (locked detail) | ref | PRIMARY | 1 | Using index |
| 5 | DEPENDENT SUBQUERY | `d` (current detail) | ref | PRIMARY | 1 | |
| 4 | DEPENDENT SUBQUERY | `d` (current detail) | ref | PRIMARY | 1 | Using index |

Every task, truck and detail access is a primary-key `eq_ref` or `ref` lookup of one estimated row, and the derived task set is capped at 5,001 rows.

The one unacceptable access is the derived summary scan: `type: index` over the whole `kastai_fiksuoti_ataskaita` primary key with `Using where`, because no index exists on `kastai_data`. `LIMIT` bounds the rows delivered but not the rows examined, so the month filter is evaluated while walking the PK in `uzdavinys` order. This plan is acceptable for an internal bounded diagnostic and is **not** acceptable for a public monetary endpoint. Section 6's "safe indexed query plan demonstrated" gate is therefore not satisfied for a month-filtered production shape.

### Bounded measurements (2026-09-23)

Two settled months were probed with the capability above. Both were selected by engineering as technical probes to exercise the tooling. **Neither is the Finance-approved reconciliation period**, and no official ERP reference result was available for comparison.

Both runs hit the 5,000-task bound and returned `complete: false`, so each describes the first 5,001 summary rows of the month ordered by `uzdavinys`. That prefix is not a random sample and is not representative of the month.

| Category | 2025-03 | 2025-07 |
|---|---:|---:|
| Tasks examined | 5,001 | 5,001 |
| Summary rows whose `uzdaviniai` task is missing | 105 | 78 |
| Assigned truck populated and resolved to a master row | 4,894 | 4,921 |
| Assigned truck populated without a master row | 0 | 0 |
| Assigned truck zero | 2 | 2 |
| `deleted = 1` | 107 | 80 |
| Lock date `0000-00-00` (unlocked per FCB-05) | 107 | 79 |
| Lock date a valid calendar date | 4,894 | 4,922 |
| Current detail rows per task: exactly one | 4,894 | 4,921 |
| Current detail rows per task: more than one | 0 | 0 |
| Locked detail rows per task: more than one | 0 | 0 |
| Current total vs current component sum: exact | 2,599 | 2,482 |
| Current total vs current component sum: within 0.01 | 110 | 96 |
| Current total vs current component sum: outside 0.01 | 2,185 | 2,343 |
| Locked total vs locked component sum: exact | 2,599 | 2,482 |
| Locked total vs locked component sum: within 0.01 | 110 | 97 |
| Locked total vs locked component sum: outside 0.01 | 2,185 | 2,343 |

Observations, stated as measurements rather than conclusions:

1. With exactly one detail row per task and all fifteen components summed, the component sum differs from the stored task-level total by more than 0.01 EUR for roughly 45 percent of tasks in 2025-03 and 48 percent in 2025-07. **The magnitude of those differences was not measured at this point, and the 0.01 EUR tolerance alone cannot distinguish a sub-euro rounding residual from a structural mismatch. The difference-bucket evidence below resolves that question and supersedes any conclusion drawn from this counter alone.**
2. Duplicate grain was not observed. No task in either probe had more than one current or locked detail row, which is consistent with the `(uzdavinys, kastai_data)` primary key and one cost month per task.
3. The truck mapping is structurally sound. Every populated `uzdavinio_masina` resolved to a `masinos` row in both months; no populated-without-master case occurred.
4. Lock state and the `deleted` flag co-occur closely but not identically (2025-07: 80 deleted versus 79 unlocked). They are not the same condition.
5. Current and locked comparisons are computed from separate tables and produced nearly, but not exactly, identical distributions (2025-07 differs by one task). The locked representation is therefore genuinely independent, not a copy of the current comparison.
6. A minority of summary rows reference a task ID absent from `uzdaviniai` (105 and 78). No inclusion rule is assumed for them.

Because the component set that composes the stored total is unknown, no subset was tried and none is proposed here. Selecting components until the totals matched would manufacture a business rule from data, which sections 2 and 6 prohibit.

### Coding gate status after Slice 4

The section 6 coding gate remains **closed**.

Confirmed by FCB-01 to FCB-10: source roles, currency, cost-month meaning, lock-state meaning and the truck field. Still blocking:

- summary/detail additivity holds only to within 1.00 EUR per task, and the rule that explains the sub-euro residual is unapproved (FC-06, FC-07);
- no closed period has been reconciled against an official ERP reference, and neither the month nor the reference value is available (FC-11);
- the reconciliation tolerance is an implementation value, not a Finance decision (FC-14);
- the `deleted` inclusion rule is unapproved (FC-03);
- zero/negative handling is unapproved (FC-13);
- the month-filtered production plan requires a full primary-key walk of the summary table and is not an acceptable public query plan;
- the API-level rule for selecting or exposing current versus locked is a contract decision that FCB-09 does not make.

Production monetary aggregation stays disabled and all five allocation scopes remain behind `SEMANTICS_UNVERIFIED`.

## 16. Slice 4 continued — difference distribution buckets

### Bucket definition

The reconciliation capability now classifies `ABS(stored_total - component_sum)` into six magnitude buckets, entirely in SQL `DECIMAL` arithmetic. No monetary value is converted to a JavaScript number at any stage; only the resulting integer counts leave the database.

| Bucket | Boundary (EUR) |
|---|---|
| `exact` | `= 0.00` |
| `rounding` | `> 0.00` and `<= 0.01` |
| `small` | `> 0.01` and `<= 1.00` |
| `moderate` | `> 1.00` and `<= 10.00` |
| `material` | `> 10.00` and `<= 100.00` |
| `large` | `> 100.00` |

The ladder is generated from one shared constant consumed by both the SQL builder and an integer-cent verification classifier, so a boundary cannot change in one place only. Bucket names describe magnitude only and carry no Finance judgement about acceptability.

Structurally non-comparable rows are separated **before** any monetary bucket is reachable and are counted on their own, so they cannot dilute a distribution: `no_details` (no detail row), `multiple_details` (more than one detail row, so no single usable grain), `missing_total` (null stored total) and `other`. Current is compared only with current detail and locked only with locked detail.

Each bucket reports three denominators:

- `percentageOfComparable` — of rows with exactly one usable detail row;
- `percentageOfAllSampled` — of the bounded sample after the truncation sentinel is removed;
- `relativeToExactPercentage` — of the exact-match count, where `exact` is by definition 100.

A zero denominator returns `null`, never zero, `Infinity` or `NaN`. Percentages are derived from integer counts, half-up to two decimals.

### Sentinel correction

The statement still fetches `LIMIT 5001` — the hard query bound is unchanged — but the 5,001st row now serves only to prove truncation. A `ROW_NUMBER()` window gates every counter on `rowNumber <= 5000`, so no counter or percentage ever describes more than the declared bound. Metadata separates the three quantities explicitly: `taskLimit` (5,000), `sampledTaskCount` (rows actually counted), `fetchedTaskCount` (rows returned, including the sentinel) and `truncated`. A driver result whose sampled count disagrees with `MIN(fetched, limit)` fails closed.

### Aggregation

Monthly counts combine into quarter, year and combined totals by summing counts first and deriving every percentage afterwards from the combined totals. Monthly percentages are never averaged, so a small month cannot outweigh a large one. Aggregation is associative: combining months directly equals combining their quarters.

### Bounded 2024-2025 diagnostic sweep (2026-09-23)

All 24 months of 2024 and 2025 were run sequentially through the shared analytics gate.

**These are bounded lowest-task-ID prefix diagnostics, not a complete financial reconciliation and not official ERP totals.** Every one of the 24 months holds more than 5,000 summary rows, so all 24 returned `truncated: true` and each figure describes only the first 5,000 tasks of that month ordered by `uzdavinys`. That prefix is not a random sample. Per-month query duration ranged from 288 ms to 387 ms.

Combined current distribution, 24 months, 120,000 sampled tasks:

| Bucket | Count | % of comparable | % of all sampled | Relative to exact |
|---|---:|---:|---:|---:|
| `exact` | 61,542 | 52.75 | 51.29 | 100 |
| `rounding` | 4,583 | 3.93 | 3.82 | 7.45 |
| `small` | 50,553 | 43.33 | 42.13 | 82.14 |
| `moderate` | 0 | 0 | 0 | 0 |
| `material` | 0 | 0 | 0 | 0 |
| `large` | 0 | 0 | 0 | 0 |

Non-comparable current rows: `no_details` 3,320; `multiple_details` 2; `missing_total` 0; `other` 0. Comparable rows: 116,678.

Combined locked distribution is almost identical: `exact` 61,539 (52.74 percent of 116,693 comparable), `rounding` 4,605 (3.95), `small` 50,549 (43.32), and zero in every bucket above 1.00 EUR. Non-comparable locked rows: `no_details` 3,307; `multiple_details` 0.

Yearly current distributions:

| Year | Sampled | Comparable | `exact` | `rounding` | `small` | `moderate` | `material` | `large` | `exact` % of comparable |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2024 | 60,000 | 58,006 | 31,150 | 2,385 | 24,471 | 0 | 0 | 0 | 53.70 |
| 2025 | 60,000 | 58,672 | 30,392 | 2,198 | 26,082 | 0 | 0 | 0 | 51.80 |

Quarterly current distributions:

| Quarter | Comparable | `exact` | `rounding` | `small` | `exact` % of comparable | `small` % of comparable |
|---|---:|---:|---:|---:|---:|---:|
| 2024-Q1 | 14,610 | 8,331 | 742 | 5,537 | 57.02 | 37.90 |
| 2024-Q2 | 14,193 | 7,604 | 475 | 6,114 | 53.58 | 43.08 |
| 2024-Q3 | 14,605 | 7,576 | 642 | 6,387 | 51.87 | 43.73 |
| 2024-Q4 | 14,598 | 7,639 | 526 | 6,433 | 52.33 | 44.07 |
| 2025-Q1 | 14,655 | 7,885 | 370 | 6,400 | 53.80 | 43.67 |
| 2025-Q2 | 14,656 | 7,415 | 402 | 6,839 | 50.59 | 46.66 |
| 2025-Q3 | 14,696 | 7,531 | 435 | 6,730 | 51.25 | 45.79 |
| 2025-Q4 | 14,665 | 7,561 | 991 | 6,113 | 51.56 | 41.68 |

`moderate`, `material` and `large` are zero in every quarter of both years.

### What the distribution changes

The magnitude evidence materially revises the Slice 4 reading recorded in section 15:

1. **No comparable task in 24 months differs by more than 1.00 EUR.** Across 116,678 comparable current rows and 116,693 locked rows, the `moderate`, `material` and `large` buckets are empty. The earlier "roughly 45-48 percent outside tolerance" counter was accurate but described only whether a difference exceeded 0.01 EUR, not how large it was.
2. Component additivity therefore holds at euro scale and fails only at sub-euro scale. 56.68 percent of comparable current rows agree within 0.01 EUR and 100 percent agree within 1.00 EUR.
3. The residual is consistent with per-component rounding in the ERP calculation, since the stored total and the fifteen components are each `decimal(13,2)`. **This is a hypothesis, not a confirmed rule.** No rounding rule, direction or order of operations has been approved, and no component subset was tried.
4. The pattern is stable across all 24 months, both years and both representations; it is not an artefact of one period.
5. `multiple_details` is effectively absent: 2 current rows and 0 locked rows across 120,000 sampled tasks.

This does not open the coding gate. It converts FC-06/FC-07 from "additivity may be structurally broken" into a narrower and more answerable question: which rounding rule reconciles the sub-euro residual, and what tolerance Finance will accept. Both remain unapproved, and the 0.01 EUR implementation tolerance is now known to be too tight to describe the data.

### Coding gate status after the distribution sweep

Unchanged: **closed**. Production monetary aggregation stays disabled and all five allocation scopes remain behind `SEMANTICS_UNVERIFIED`. The blockers listed in section 15 stand, with FC-06/FC-07 restated as above and FC-14 now carrying a concrete question: a tolerance at or above 1.00 EUR per task would classify every comparable row in this sweep as reconciled, and that threshold is Finance's to set, not engineering's.

## 17. Slice 5 — internal truck monetary repository and runtime contract

### Implementation decision (2026-09-23)

Recorded as an **engineering implementation decision**, not as a completed reconciliation against an official ERP report:

- `kastai_fiksuoti_ataskaita` is the authoritative task-level fixed-cost total.
- `kastai_fiksuoti_vilkikai_det` is the explanatory current component breakdown.
- `kastai_fiksuoti_vilkikai_det_locked` is the explanatory locked component breakdown.

The authoritative total is always read from the summary column and is **never** recalculated by summing components. Current and locked are never mixed. Component differences stay explicit and are never folded into an invented category. Public fixed-cost endpoints remain disabled and continue returning `SEMANTICS_UNVERIFIED`.

### Runtime contract

`src/fixed-costs/monetary-contract.ts` defines a strict internal query with exactly five fields: `allocationScope` (only `truck`), an explicit `representation` of `current` or `locked`, a canonical settled `periodMonth` validated by the Slice 4 month contract, an optional bounded allowlist of up to 50 numeric `truckIds`, and a `limit` bounded by a hard maximum of 50,000 records. There is no field, filter, grouping, sorting, measure, table, column or expression input, so neither a caller nor a model can influence the SQL beyond bound values. Trailer, department, support and expedition monetary repositories were not implemented.

Every monetary value is a `DecimalString`: subtraction, absolute value and summation happen in SQL `DECIMAL`, each aggregate is `CAST(... AS CHAR)` before it crosses the driver boundary, and the text is validated against a canonical decimal pattern. No monetary value is ever parsed into a JavaScript `number`. Counts remain integers and percentages are derived only from counts.

Per declared row state the result carries `authoritativeTotal`, `comparableAuthoritativeTotal`, `componentTotal`, `netDifference`, `grossAbsoluteDifference`, `authoritativeRecords`, `comparableRecords`, `affectedRecords`, the six Slice 4 bucket counters, `noDetailRecords`, `multipleDetailRecords` and `missingTotalRecords`. Metadata carries `currency: "EUR"`, `representation`, authoritative and breakdown sources, the fifteen verified ERP component field identifiers, `classificationApplied: false`, `classificationVersion: null`, `semanticsVersion: null`, `recordLimit`, `recordsRead`, `truncated`, `complete`, the deleted-row policy, `reconciliationStatus: "unreconciled"`, the pending approvals and the limitations list.

`authoritativeTotal` spans every in-scope record of a state, including structurally non-comparable ones, so nothing is silently dropped from the authoritative population. `componentTotal` spans comparable records only. `comparableAuthoritativeTotal` exists precisely so the two are never compared across different populations. `netDifference` is the signed sum and `grossAbsoluteDifference` sums per-record absolute values, so positive and negative row differences cannot cancel.

#### Null comparison fields for an empty comparable population

A group with no comparable record reports `null` for `comparableAuthoritativeTotal`, `componentTotal`, `netDifference` and `grossAbsoluteDifference`, and carries a group-level `reconciliationStatus` of `structurally_non_comparable`. It never reports `0.00`, because a fabricated zero reads as "the components reconcile exactly", which is the opposite of "there is nothing to compare". The SQL uses `SUM(CASE WHEN r.comparable = 1 THEN <value> ELSE NULL END)`, so an empty comparable population produces SQL NULL rather than an additive-identity zero.

`authoritativeTotal` is unaffected: it remains the real total for the full row-state population, and is `null` only in the degenerate case where no record of that state carries a stored total at all. Projection fails closed in both directions — a comparison field that is non-null without comparable records, or null with them, raises `InvalidFixedCostMonetaryResult` rather than being reported.

#### Reporting-period basis

Both representations filter the reporting period on `a.kastai_data`, the confirmed cost month (FCB-06), and the runtime metadata states this explicitly as `dateBasis: "kastai_data"`. `locked_kastaiVilkiko_data` is lock-event metadata and is never used as a reporting-period filter or bound as a period parameter; the locked representation is the locked amount *for a cost month*, not a period defined by when the lock occurred.

#### Orphan summary rows

`kastai_fiksuoti_ataskaita` is the base authoritative population and the join to `uzdaviniai` is always a `LEFT JOIN`, so a summary row whose task is absent stays in the population, keeps its declared row state, contributes to `authoritativeTotal`, and is counted by `missingTaskCount` on the group and in metadata. Such a row is never assigned truck `0`, `unknown` or any invented identifier, and if it has no usable detail match it remains structurally non-comparable.

Deterministic limitation: when an explicit truck allowlist is supplied, an orphan has `t.uzdavinio_masina` NULL, `NULL IN (...)` is not TRUE, and the row is excluded — an orphan cannot be mapped to a requested truck. `truckFilterApplied` records whether that exclusion was in force. `LIMIT` is applied after the period predicate and the optional truck predicate inside the same SELECT, so the bound always applies to the filtered population.

Bucket boundaries are imported from the committed Slice 4 ladder. No second ladder is defined.

### Unresolved deleted-row policy

`deleted` semantics remain unapproved (FC-03), so two independent safeguards are active:

1. Results are **always** grouped by declared `deleted` state (`zero`, `one`, `other`). No policy choice can merge states into a single authoritative figure, and a duplicate state group fails closed.
2. Aggregation refuses to execute until an internal caller supplies an approved policy. The module default `unapprovedFixedCostDeletedRowPolicy` has `approved: false`, so the default path raises `FixedCostDeletedPolicyUnapproved` **before any replica access**.

The policy is an internal injected registration. It is absent from every public contract, cannot be supplied through a request, and cannot be selected by a model. An approval also requires a non-empty `approvedBy` and an allowlisted treatment.

### Structurally non-comparable records

A record is comparable only when it has a non-null authoritative total and exactly one matching detail row. Records failing that stay in `authoritativeRecords` and in the authoritative total, are counted as `noDetailRecords`, `multipleDetailRecords` or `missingTotalRecords`, never enter a reconciliation bucket, and are never given a fabricated zero component total.

### Classification

No business labels or cost-group mappings were invented. The breakdown exposes the fifteen verified ERP source column identifiers only, `classificationApplied` is `false` and `classificationVersion` is `null`.

### Query safety and plan status

Static per-representation statements with unqualified tables; the configured `ERP_REPLICA_DATABASE` selects the schema. All caller input is bound, including the truck IN list, which is rendered as `?` markers only. Ordering is deterministic on `a.uzdavinys` and `r.deletedState`. The statement reads `LIMIT limit + 1`, and a period exceeding the bound raises `FixedCostMonetaryTruncated` rather than returning a partial sum. Execution runs through the shared `AnalyticsGate` and the configured query timeout, driver errors are sanitized through `FixedCostMonetaryError`, and no monetary value, truck identifier or row is logged.

**The missing `kastai_data` index remains a blocker (FC-P17).** A full month currently executes in roughly 2 seconds, but that speed does not make the query production-ready: the summary month filter still requires a full primary-key walk, and the cost grows with table size rather than with the result.

### Bounded live verification (2026-09-23)

Three complete months were executed through the opt-in integration test. Only counts are recorded; no monetary total, difference or identifier was printed or stored.

Unlike the Slice 4 diagnostic, whose 5,000-record bound truncated every month, the 50,000-record bound holds a whole month: all three returned `complete: true` at roughly 21,000-22,000 records and about 2 seconds each. **These are therefore complete-month structural figures, not lowest-task-ID prefixes** — but they remain internal diagnostics, not an official ERP reconciliation.

| Month | Records | `deleted=0` comparable | exact | rounding | small | moderate | material | large | `deleted=1` records | `deleted=1` comparable |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2024-01 | 21,619 | 20,404 | 11,360 | 1,164 | 7,880 | 0 | 0 | 0 | 627 | 0 |
| 2025-03 | 21,158 | 20,468 | 10,891 | 673 | 8,904 | 0 | 0 | 0 | 363 | 0 |
| 2025-12 | 21,862 | 20,803 | 11,166 | 949 | 8,688 | 0 | 0 | 0 | 497 | 0 |

Observations, stated as measurements:

1. At full-month scale the Slice 4 finding holds: `moderate`, `material` and `large` are empty in every month and both representations. No comparable record differs from its component sum by more than 1.00 EUR.
2. Every `deleted = 1` record in all three months had **zero** detail rows, so none was comparable. Under the corrected contract that group reports `structurally_non_comparable` with null comparison fields while keeping its real authoritative total. This is a structural observation about where breakdowns exist; it does not establish what `deleted` means and does not resolve FC-03.
5. In 2025-03, `missingTaskCount` was 342 of 21,158 records, and **all 342 fell in the `deleted = 1` group** (363 records); the `deleted = 0` group had none. Record counts were identical before and after the join was made an unconditional `LEFT JOIN`, confirming no authoritative row was previously lost and none was added. The co-occurrence of deletion and a missing task is a measurement, not an approved rule.
3. `multipleDetailRecords` is effectively absent: 0, 0 and 1 across the three months.
4. Locked figures track current closely but are computed independently (2025-03: 9,577 affected current versus 9,579 locked).

### Slice 5 task status

Complete: the internal monetary contract and repository, current/locked separation, decimal-string safety, null comparison fields for an empty comparable population, the explicit `kastai_data` date basis, orphan-preserving `LEFT JOIN` with `missingTaskCount`, the reconciliation metadata block, the fail-closed deleted-row policy, structural non-comparable handling, query bounds and ordering, analytics-gate and timeout integration, sanitized errors, unit and mutation tests, and the opt-in bounded integration test.

Blocked: enabling any public monetary capability (FC-11 official reference, FC-14 tolerance), the `deleted` inclusion rule (FC-03), the sub-euro residual rule (FC-06, FC-07), and a production-acceptable month-filtered query plan (FC-P17).

Intentionally deferred: trailer, department, support and expedition monetary repositories; cost-group classification; any HTTP or CLI surface; telemetry emission for a path that cannot yet run in production.

### Coding gate status after Slice 5

Unchanged: **closed**. Production monetary aggregation stays disabled and all five allocation scopes remain behind `SEMANTICS_UNVERIFIED`.

## 18. Slice 6A — truck summary contract and disabled orchestration

Slice 6 was too large to be a single step: its checklist mixed a contract that can be written today with an activation that depends on unresolved Finance/ERP approvals. It is therefore split, and this section records **Slice 6A only**. Nothing here activates a capability.

### Implemented code

| Artifact | Purpose |
|---|---|
| `src/fixed-costs/summary-contract.ts` | Public truck-summary request parsing, the future response shape, stable limitation ordering, and the period-plan seam. |
| `src/fixed-costs/summary-service.ts` | Internal orchestration that assembles a summary from two independent monetary reads behind an injected executor. |
| `src/fixed-costs/monetary-repository.ts` | Extended with declared lock-state counters and a `SERVICE_BUSY` passthrough. |
| `src/fixed-costs/monetary-contract.ts` | `lockedRecords`, `unlockedRecords` and `unknownLockRecords` added to the group type. |
| `tests/unit/fixed-cost-summary.test.ts` | 20 tests covering the contract, orchestration, gates and route boundary. |

#### Request contract

Allowed public input is exactly `allocationScope=truck` plus a paired `dateFrom` and `dateTo`. `parseTruckFixedCostSummaryRequest` reuses the shared parser, so unknown parameters, repeated query parameters (Fastify yields an array, which is not a string), non-canonical dates, reversed ranges and the existing 366-day maximum are all still enforced; summary additionally requires the scope to be `truck` and both dates to be present. No `representation`, deleted-row policy, tolerance, table, field, grouping, sorting, pagination, SQL fragment or internal limit is accepted.

#### Response contract

The future successful response keeps the two representations apart throughout: `currentAmount` and `lockedAmount` are separate decimal strings or `null`, and per-representation reconciliation carries `comparableAuthoritativeTotal`, `componentTotal`, `netDifference`, `grossAbsoluteDifference`, the Slice 4 buckets and the structural counters. Counts are `totalTaskCount`, `lockedTaskCount`, `unlockedTaskCount` and `unknownLockStateTaskCount`. Metadata carries `sourceFamily`, `authoritativeSource`, `breakdownSources`, `amountSemantics`, `dateBasis`, `semanticsVersion` (null), `classificationApplied`/`classificationVersion` (false/null), `reconciliationStatus`, the representation block, `periodMonths`, `complete`, `missingTaskCount`, the deleted-row policy, pending approvals and `limitations`. Every collection is deterministically ordered; `orderFixedCostLimitations` sorts and de-duplicates, so ordering never depends on insertion.

A standing limitation states that current amounts are live calculations ERP may recalculate for roughly three months (FCB-10) and are **not** final results.

#### Orchestration

`summarizeTruckFixedCosts` calls an injected executor twice, once per representation, and never reuses one result for the other. It fails closed when the repository answers with a mismatched representation, period, scope, currency, date basis or breakdown source. Authoritative totals are copied from the stored total and never from a component sum. Net and gross differences are both preserved, so a netted-to-zero month still shows its gross exposure. Structurally non-comparable populations keep their real authoritative total with null comparison fields. An incomplete or truncated repository result never becomes a summary. Nothing is logged.

#### Lock-state counters (new, from a confirmed fact)

`lockedTaskCount` and `unlockedTaskCount` could not be derived from the Slice 5 repository, so it now counts declared lock state directly from the ERP-confirmed sentinel (FCB-05): `locked_kastaiVilkiko_data = '0000-00-00'` is `unlocked`, a strict calendar date is `locked`, and anything else is `unknown` rather than guessed. The three always cover the population, enforced in SQL projection and again in the service. This uses only confirmed semantics and invents no rule.

The lock **date** is read for both representations because lock state is a task-level property, not a property of an amount. The locked **amount** column is still never read by a current query, and the locked detail table is still never joined by a current query — the unit guards now assert that precisely with `locked_kastaiVilkiko(?!_data)` rather than a prefix match.

### Engineering decisions

- Injected cost months are validated against the request by `assertSummaryPeriodMonths`: each must be canonical `YYYY-MM-01` and must share at least one day with the requested range. Both are necessary conditions under any eventual mapping rule, so neither decides `dateTo` inclusivity, partial-month treatment, nor which of several overlapping months belong in a result. Without this a response could echo one date range while reporting another period's money; a pre-commit review reproduced exactly that, and the check closed it.
- The day-range to cost-month mapping is **not** implemented. `planTruckFixedCostSummaryPeriod` always reports `month_mapping_unapproved` against blocker FC-P19. The public contract accepts calendar days while the repository is scoped to a whole cost month, and no rule defines whether `dateTo` is inclusive, whether a partial month is included, excluded or pro-rated, or whether a range may span months. Inventing any of those would fabricate a financial rule, so the orchestrator takes its months from an internal caller instead.
- Multi-month aggregation is refused: adding month totals would require decimal arithmetic in JavaScript, which this layer will not do.
- A `separate_by_state` policy cannot collapse to one amount and fails closed; `include_all` fails closed as soon as more than one state is populated, for the same decimal-safety reason. Only `exclude_deleted` yields a single amount, by selecting the `deleted = 0` group with no arithmetic at all.
- Analytics-gate saturation is now re-thrown unchanged instead of being wrapped, so `SERVICE_BUSY`/503 survives and is no longer flattened into `REPLICA_UNAVAILABLE`. Timeouts remain `QUERY_TIMEOUT`/504.

### Bounded live verification (2026-09-23)

The extended repository was re-run against 2025-03 through the opt-in integration test. Record counts are **identical** to the pre-change run (21,158 total; 20,795 in `deleted = 0`; 363 in `deleted = 1`), confirming the lock-state addition altered no population.

| Declared state | Records | Locked | Unlocked | Unknown lock |
|---|---:|---:|---:|---:|
| `zero` | 20,795 | 20,795 | 0 | 0 |
| `one` | 363 | 0 | 363 | 0 |

The distribution is identical for both representations, as expected for a task-level property. In this month deletion and lock state were perfectly complementary: every non-deleted record was locked and every deleted record was unlocked, with no unreadable lock date. **That is a measurement of one month, not an approved rule**, and it does not resolve FC-02 or FC-03.

### Route behaviour, unchanged

All five capability registry entries remain disabled. A syntactically valid truck summary request — the exact shape the new contract accepts — still returns HTTP 422 `SEMANTICS_UNVERIFIED` with zero replica access, as do breakdown, dimensions and every other scope. No summary, monetary, reconciliation or diagnostic HTTP or CLI path exists, and the registered fixed-cost route set is unchanged at exactly summary, breakdown and dimensions.

### Slice 6A status

Implemented: request contract, response contract, orchestration, lock-state counters, stable ordering, policy and period gates, period/request consistency validation, route-boundary proof, and 23 unit tests including mutation-style guards.

Not implemented and not claimed: the day-to-month mapping (FC-P19), multi-month aggregation, capability activation, an accepted ERP-reference reconciliation (FC-11), an approved tolerance (FC-14), an approved deleted-row inclusion rule (FC-03), an approved public current-versus-locked exposure policy (FC-02), and a production-suitable query plan (FC-P17).

### Coding gate status after Slice 6A

Unchanged: **closed**. Production monetary aggregation stays disabled.

## 19. Slice 7A — gated breakdown contract and orchestration

Slice 7, like Slice 6, mixed work that can be built today with work that depends on unresolved approvals. It is split, and this section records **Slice 7A only**. Nothing here activates a capability, and no production SQL was added.

### Implemented code

| Artifact | Purpose |
|---|---|
| `src/fixed-costs/breakdown-contract.ts` | Strict request parsing, grouping-availability registry, sort/pagination bounds, response types and the static component inventory. |
| `src/fixed-costs/breakdown-service.ts` | Gated orchestration: capability and policy gates, two independent reads, invariant checks, deterministic ordering and pagination. |
| `tests/unit/fixed-cost-breakdown.test.ts` | 20 tests covering the contract, gates, bounds, ordering, orphans, errors and the route boundary. |

### Request contract

Accepted parameters are exactly `allocationScope`, `dateFrom`, `dateTo`, `groupBy`, `page`, `perPage`, `sortBy`, `sortDirection` and `truckIds`. Everything else — unknown or repeated parameters, arbitrary fields, measures, filter expressions, table or column names, SQL-shaped text, `representation`, deleted-row policy, tolerance and internal query limits — is rejected before anything else happens.

Parameter names use the fixed-cost domain's own camelCase surface rather than the snake_case of the older `/vehicles` and `/invoices` domains. Both conventions already coexist in this repository; a breakdown request shares one query string with `allocationScope`, so matching the fixed-cost surface keeps a single request internally consistent. This is an engineering decision, recorded here because it is a visible deviation from the older endpoints.

### Grouping availability

Recognising a grouping is not the same as supporting it, and a blocked grouping is never silently treated as supported.

| Grouping | Status | Basis or reason | Blockers |
|---|---|---|---|
| `truck` | Structurally supported, **not activated** | `uzdaviniai.uzdavinio_masina`, confirmed as the truck field (FCB-08 / FC-08) | FC-11, FC-14, FC-03, FC-02, FC-P17 |
| `month` | **Blocked** | The date-range to cost-month mapping is unapproved, so month buckets cannot be defined | FC-P19 |
| `costComponent` | **Blocked** | Independent additivity of the component fields is unapproved, so component groups cannot carry monetary measures | FC-06, FC-07 |

The parser accepts all three as recognised values; the registry refuses the blocked two and the orchestration fails closed with the recorded blocker before any executor call.

### Bounds, ordering and pagination

Maximum page size 200 (default 50), maximum group count 1,000, and the existing 366-day maximum date range. Ordering is allowlisted to `truckId`, an immutable integer, with `truckId` ascending as the tie-breaker, so the order is total and pages tile the set exactly once with no overlap or gap.

Monetary sort fields are deliberately **unavailable**: ordering by an amount would mean comparing decimal strings in JavaScript, so an amount sort requires SQL-side ordering and belongs to Slice 7B. A request for one is refused with `sort_field_unavailable`.

A page beyond the last fails closed rather than returning an empty page, and a group count above the maximum fails closed rather than truncating.

### Pre-commit review corrections

A review of this slice found and closed two real defects, both reproduced before fixing:

1. **Reconciliation money was not validated as decimal text.** Only `authoritativeTotal` was checked, so a JavaScript number supplied as `componentTotal`, `netDifference` or `grossAbsoluteDifference` passed straight into the response — breaking the decimal-string guarantee the whole slice rests on. All three are now validated, and a numeric, comma-formatted, exponent or boolean value fails closed.
2. **A resolved truck group could silently drop its missing-task population.** `missingTaskCount` is surfaced only by the unresolved bucket, so a non-zero count on a resolved group vanished from the response entirely. Because truck resolution comes from `uzdaviniai.uzdavinio_masina`, a resolved truck implies its task row exists, so that combination is now refused rather than quietly discarded.

A third, documentation-only fix: the `groupCount` field comment claimed it could exceed the returned rows, which is the opposite of what the code enforces.

### Completeness

The executor must prove it enumerated every group before pagination: a result that is `truncated`, not `complete`, or whose `groupCount` disagrees with its rows is refused with `incomplete_grouping`. A partial aggregation is never presented as complete. Duplicate groups, invalid identifiers, lock-state counts that do not cover the group, representation or period mismatches, and current/locked reads describing different group sets or populations are all rejected.

### Authoritative totals and the component boundary

Group amounts are the stored authoritative totals, copied as decimal text. The orchestration performs no monetary arithmetic and joins no detail table, so a one-to-many detail relationship cannot multiply a task total. A component total never stands in for an authoritative total, and the two remain separately visible in every response.

`fixedCostComponentInventory` is a static technical inventory of the fifteen verified schema column names, sorted deterministically. It is explicitly marked `explanatory_semantics_unverified`, with `independentlyAdditive: false` and `syntheticResidualBucket: false`. No business category is mapped and there is deliberately no synthetic `other` bucket to force a reconciliation to balance.

### Unresolved trucks

Records whose truck cannot be resolved are reported in a separate `unresolved` bucket carrying `taskCount`, `missingTaskCount`, `zeroTruckCount` and its own amounts. It has no identifier field at all — never `0`, `-1`, `null` or `"unknown"` — and is never folded into a real truck's group. An executor row with an invalid identifier fails closed instead of being coerced.

### No production SQL

None was added. A truck grouping would still need the month-filtered summary access that FC-P17 leaves unresolved, so no bounded query can yet be proved safe for activation, and no `EXPLAIN` is claimed. The executor is an injection point, which keeps the orchestration fully unit-testable without giving the public route any path to the replica.

### Route behaviour, unchanged

All five capability registry entries remain disabled. A breakdown request shaped like the new contract still returns HTTP 422 `SEMANTICS_UNVERIFIED` with zero replica access; summary and dimensions are unchanged; every non-truck scope stays blocked. Breakdown-specific parameters are not part of the public parser, so they are refused with 400 `INVALID_QUERY` before the semantic gate. The registered fixed-cost route set is unchanged at exactly summary, breakdown and dimensions, and no diagnostic, reconciliation, monetary or grouping path exists.

### Slice 7A status

Implemented: request contract, grouping-availability registry, pagination and group bounds, deterministic ordering with an immutable tie-breaker, response contract, component inventory, gated orchestration, unresolved-truck handling, completeness safeguards, error propagation, and 22 unit tests including mutation guards and two review regressions.

Not implemented and not claimed: any grouped production SQL or query plan, month and costComponent groupings, monetary ordering, reconciliation against an official ERP reference, and capability activation.

### Coding gate status after Slice 7A

Unchanged: **closed**. Production monetary aggregation stays disabled.

## 20. Slice 8A — gated dimension contract, availability registry and orchestration

Slice 8, like Slices 6 and 7, mixed buildable work with work blocked on approvals. It is split, and this section records **Slice 8A only**.

**Every fixed-cost dimension is publicly unavailable, because no fixed-cost filter or grouping capability has been activated.** A dimension exists to list the values a caller may legitimately use in an *enabled* filter or grouping; none is enabled, so no live value is returned through HTTP and no dimension query runs.

### Implemented code

| Artifact | Purpose |
|---|---|
| `src/fixed-costs/dimension-contract.ts` | Strict request parsing, the static availability registry, exposure classification and future response types. |
| `src/fixed-costs/dimension-service.ts` | Gated orchestration: capability and availability gates, field/sort allowlists, completeness and uniqueness checks, ordering and pagination. |
| `tests/unit/fixed-cost-dimensions.test.ts` | 16 tests covering the registry, boundaries, gates, bounds and the route boundary. |

### Request contract

Exactly six parameters: `allocationScope`, `dimension`, `page`, `perPage`, `sortBy`, `sortDirection`. Everything else is refused — unknown and repeated parameters, arbitrary table, column or schema names, search expressions, SQL fragments, field or measure selection, grouping expressions, deleted-row policy, tolerance, representation, internal limits and sensitive-field selection.

Generic schema-discovery parameters (`table`, `column`, `schema`, `q`, `search`, `pattern`, `include`, `expand`) are deliberately **not** offered here. Schema discovery already exists as its own bounded, separately-authenticated surface; a fixed-cost dimension is a business-value list, not a second way to enumerate the database.

Parameter names continue the fixed-cost surface's camelCase convention rather than the snake_case of `/vehicles` and `/invoices`. Both already coexist, and a dimensions request shares one query string with `allocationScope`.

### Availability registry

One static, deeply frozen registry — code, never request-controlled. Each entry records its key, structural source, public availability, blockers, allowed response fields, allowed filters, allowed sorting, maximum page size and an exposure classification.

| Dimension | Public availability | Structural source | Blockers |
|---|---|---|---|
| `truck` | **false** | `uzdaviniai.uzdavinio_masina` joined to `masinos.id` (FCB-08 / FC-08) | FC-11, FC-14, FC-03, FC-02, FC-P17 |
| `costComponent` | **false** | The fifteen verified decimal columns of the truck detail tables | FC-06, FC-07 |
| `month` | **false** | `kastai_fiksuoti_ataskaita.kastai_data` (FCB-06) | FC-P19, FC-P17 |

Structural verification is not business approval: `truck` has a verified numeric mapping and is still unavailable, because no filter or grouping consumes it yet. A test asserts every entry is `false`, that the registry and its nested arrays are frozen, and that attempting to flip a value or push a field throws and leaves the registry unchanged.

### Truck field boundary

`allowedFields`, `allowedFilters` and `allowedSorting` are each exactly `['truckId']`. The exposure classification is `internal_identifier`, restricted to the numeric identifier alone.

Nothing descriptive is exposed and nothing is inherited from the `/vehicles` field set: no `masinos_nr`, registration string, VIN, make, model, status, lifecycle date, department, lease or rental field, odometer, driver or employee data, comment, or any other `masinos` column. No display name is invented, and no "unknown truck" value exists — records whose truck cannot be resolved are reported as structural counters by the breakdown layer, never as a dimension value. The service enforces this at runtime too: a value carrying any field outside the allowlist, or a non-positive-integer identifier, fails closed.

The truck dimension also does not enumerate `masinos`. A future implementation must be scoped to trucks that actually appear in fixed-cost analytics data, which is Slice 8B work.

### Cost-component boundary

The fifteen verified technical column names remain an internal explanatory inventory, sorted deterministically, with `independentlyAdditive: false`, `syntheticResidualBucket: false` and `status: explanatory_semantics_unverified`. No user-supplied column name is accepted, no business label is invented, there is no synthetic `other` component, and the names are never read dynamically from `INFORMATION_SCHEMA`. Public availability stays false, and `allowedFilters` is empty, so an unapproved dimension offers no filter.

### Month decision — no live query

**No month-availability SQL was added.** `kastai_data` is unindexed, so enumerating available months would scan the full summary table; and the date-range to cost-month mapping is itself unapproved. The dimension is recorded as blocked by FC-P19 and FC-P17, and a test proves a month request performs zero executor calls.

### Pagination, ordering and completeness

Maximum page size 200 (default 50), maximum 5,000 values. Ordering is allowlisted per dimension on its single key, total in both directions, so pages tile the set exactly once; an out-of-range page fails closed. A result that is truncated, incomplete, whose `valueCount` disagrees with its values, that carries duplicates, or that answers a different dimension is refused.

### Unavailable is not an empty success

The result is a discriminated union. An unavailable dimension returns `availability: 'unavailable'` with its blockers and **no `values` array at all**, `complete: false`, and null pagination and sorting. Returning `values: []` would be indistinguishable from "available, but no values exist" — a test asserts both shapes and that they differ.

### Route behaviour, unchanged

All five capabilities remain disabled. A dimensions request still returns HTTP 422 `SEMANTICS_UNVERIFIED` with zero replica access; summary and breakdown are unchanged; every non-truck scope stays blocked. Dimension-specific and schema-discovery parameters are refused with 400 `INVALID_QUERY` before the semantic gate. The route set is unchanged at exactly summary, breakdown and dimensions, with no dimensions sub-route and no schema-discovery, diagnostic, reconciliation or monetary path.

### Pre-commit review corrections

A review of this slice found and closed two low-severity defects, both reproduced first:

1. **An unknown registry entry produced a raw `TypeError`.** A registry lacking the requested dimension dereferenced `undefined` instead of failing closed. The lookup is now guarded and raises a typed `registry_entry_missing`, which also catches an entry whose `key` disagrees with its slot.
2. **A missing executor was reported as `dimension_unavailable`.** When the registry marks a dimension available and the caller supplies no executor, the old reason misstated system state — the dimension was available; the caller was incomplete. That path now reports `executor_unavailable`.

The review also confirmed the injection seam is not a production bypass: `registry` and `capabilities` are explicit function parameters that no request, route or model input can reach, and **nothing in `src/` imports the dimensions service at all**, so it currently has no production caller. The shipped registry remains the default on every path.

### Slice 8A status

Implemented: request contract, availability registry with exposure classification, truck and component boundaries, month blocking with zero database access, gated orchestration, pagination and ordering bounds, completeness and uniqueness checks, the unavailable/empty distinction, and 19 unit tests including mutation guards and three review regressions.

Not implemented and not claimed: any dimension SQL or query plan, live dimension values, an approved public truck display field, and capability activation.

### Coding gate status after Slice 8A

Unchanged: **closed**. Production monetary aggregation stays disabled.

## 21. Slice 6P — provisional locked truck summary pilot

Slice 6P is a **deliberately narrow, temporary internal pilot** for BT Finance Analyst. It is tracked separately from Slice 6B and does not complete it: none of the Slice 6B approvals (FC-02, FC-03, FC-11, FC-14, FC-P17, FC-P19) is resolved here. The pilot is **not** production activation and **not** an officially reconciled Finance report.

### Temporary MP-8 pilot policy

Recorded as an MP-8 engineering pilot decision, **not** as permanent Finance approval:

| Rule | Pilot value |
|---|---|
| Endpoint | `GET /expense-analytics/fixed-costs/summary` only |
| Allocation scope | `truck` only |
| Period | Exactly one complete calendar month: `dateFrom` is the first day, `dateTo` the actual last day of the same month |
| Settlement | The month starts at least six months before the current month (the Slice 4 rule, reused) |
| Source | `kastai_fiksuoti_ataskaita` |
| Reportable amount | `locked_kastaiVilkiko` (stored task-level total, never recomputed from components) |
| Period basis | `kastai_data` (FCB-06) |
| Currency | EUR (FCB-07) |
| Deleted rows | Only `deleted = 0` is included; `deleted = 1` is excluded; any other `deleted` value refuses the month |
| Lock state | Every included task must be locked (FCB-05 sentinel); `lockedTaskCount` must equal `totalTaskCount`, and unlocked and unknown lock-state counts must be zero, otherwise the request is refused |
| Current value | Never read and never reported |
| Caching | None; responses carry `Cache-Control: no-store` |

Because the request must already be one exact calendar month, the pilot needs no answer to FC-P19: it accepts no partial month, no inclusivity rule and no multi-month span. The deleted-row policy is a frozen module constant (`truckFixedCostPilotDeletedRowPolicy`, `approvedBy: "MP-8 Slice 6P temporary pilot policy (not Finance approval)"`), never request input.

### Feature flag

`ERP_FIXED_COST_TRUCK_SUMMARY_PILOT_ENABLED`, default `false`, parsed strictly: only the exact strings `true` and `false` are accepted, and any other value (including `TRUE`, `1`, `yes` or an empty string) fails configuration at startup. It is documented in `.env.example`; `compose.yaml` was intentionally not edited.

- `false`: the summary behaves exactly as before — a valid request returns 422 `SEMANTICS_UNVERIFIED` with zero replica and zero analytics-gate access. Pilot period rules are not evaluated.
- `true`: only `summary` + `truck` resolves as enabled. Breakdown, dimensions and the trailer, department, support and expedition scopes stay 422 `SEMANTICS_UNVERIFIED`.

Capability resolution is the pure function `resolveFixedCostCapability(endpoint, scope, config.fixedCosts)`. The static `fixedCostSemanticCapabilities` registry is now deeply frozen and still all-disabled; nothing mutates it. `buildApp` passes only `config.fixedCosts` to `registerFixedCostRoutes`, and a missing or non-boolean option resolves to disabled. No query parameter, body or model input reaches the resolver.

### Supported request

```text
GET /expense-analytics/fixed-costs/summary?allocationScope=truck&dateFrom=2025-03-01&dateTo=2025-03-31
Authorization: Bearer <service token>
```

Optional single truck (2026-09-25): `truckId=<positive integer>` restricts the same locked read to one canonical ERP truck ID, the verified task-truck field `uzdaviniai.uzdavinio_masina` (FC-08 / FCB-08, joined to `masinos.id`). It reuses the repository's bound allowlist (`AND t.uzdavinio_masina IN (?)`) with every period, deleted-row, lock and completeness rule unchanged. Without `truckId` the fleet request, SQL and response are identical to before. With it, `data.truckId` is echoed after `allocationScope`. The FC-P18 limitation is replaced: summary rows whose task is absent from `uzdaviniai` cannot be attributed to a truck and fall outside a single-truck population. A truck with no included records in the month is 422 `NO_DATA_FOR_PERIOD`, never `0.00`. `truckId` must be canonical digits (`[1-9][0-9]*`, safe integer); plate numbers, lists and repetition are rejected. It is accepted on `summary` only; elsewhere it stays an unknown parameter (400). Telemetry records no truck identifier.

```text
GET /expense-analytics/fixed-costs/summary?allocationScope=truck&truckId=12345&dateFrom=2025-03-01&dateTo=2025-03-31
```

Rejected before any replica access:

| Request class | Result |
|---|---|
| Missing or wrong token | 401 `UNAUTHORIZED` |
| Unknown, repeated or SQL-shaped parameters; `representation`, deleted policy, tolerance, fields, measures, `groupBy`, sorting, pagination, table/column/schema names, internal limits | 400 `INVALID_QUERY` |
| Missing date pair, malformed, impossible or reversed dates | 400 `INVALID_QUERY` |
| Partial month or multi-month range | 422 `PERIOD_NOT_COMPLETE_MONTH` |
| Month starting less than six months before the current month | 422 `PERIOD_NOT_SETTLED` |
| Non-truck scope, breakdown, dimensions, or the flag off | 422 `SEMANTICS_UNVERIFIED` |

### Response contract

```json
{
  "data": {
    "allocationScope": "truck",
    "periodMonth": "2025-03-01",
    "amount": "<decimal string, redacted>",
    "currency": "EUR",
    "representation": "locked",
    "totalTaskCount": 0,
    "lockedTaskCount": 0
  },
  "meta": {
    "sourceFamily": "truck_fixed_costs",
    "amountSemantics": "authoritative_locked_task_total_excluding_deleted",
    "dateBasis": "kastai_data",
    "semanticsVersion": "truck-fixed-cost-summary-pilot-v1",
    "reconciliationStatus": "provisional_unreconciled_erp_reference",
    "complete": true,
    "pilot": true,
    "limitations": ["<sorted, see below>"]
  }
}
```

`amount` is the SQL `DECIMAL` sum cast to text and validated as canonical decimal text; it is never parsed into a JavaScript number.

**Absence of ERP rows is never interpreted as zero.** A month with no summary rows, or with rows only in the excluded `deleted = 1` population, returns 422 `NO_DATA_FOR_PERIOD` with no amount, counts or metadata. `"0.00"` is returned only when at least one included `deleted = 0` record exists, the population is complete and fully locked, and its stored locked total is exactly `0.00`. A missing group, a null or malformed driver row, an incomplete or truncated read, or a missing stored total never becomes zero.

`limitations` is a constant, sorted, de-duplicated list stating that the result is a provisional internal pilot; that `deleted = 1` rows are excluded under a temporary MP-8 pilot policy (FC-03); that it is not reconciled against an accepted official ERP report (FC-11); that only one settled complete calendar month is supported; that the amount is the stored locked total and no current value is reported; that orphan summary rows remain included (FC-P18); that zero/negative amounts pass through unchanged (FC-13); and that `kastai_data` month filtering is unindexed, low-volume pilot behaviour and not production-ready (FC-P17).

### Errors

| Code | HTTP | When |
|---|---:|---|
| `SEMANTICS_UNVERIFIED` | 422 | Flag off, non-truck scope, breakdown or dimensions |
| `PERIOD_NOT_COMPLETE_MONTH` | 422 | Not exactly one complete calendar month |
| `PERIOD_NOT_SETTLED` | 422 | Month too recent |
| `PERIOD_NOT_FULLY_LOCKED` | 422 | Any included task unlocked or of unknown lock state |
| `INCOMPLETE_RESULT` | 422 | Truncated read, undeclared `deleted` state, missing stored total, a null, missing or malformed driver result, or an inconsistent repository result |
| `NO_DATA_FOR_PERIOD` | 422 | No summary rows for the month, or rows only in `deleted = 1`; absence of records is not reported as a zero amount |
| `SERVICE_BUSY` | 503 | Analytics gate saturated |
| `QUERY_TIMEOUT` | 504 | The statement ran and hit the statement or driver query timeout |
| `REPLICA_UNAVAILABLE` | 503 | Any other replica failure, including a connection that could not be obtained (`ER_GET_CONNECTION_TIMEOUT`, `ER_CONNECTION_TIMEOUT`) |

Messages are fixed strings. No SQL, driver message, amount or identifier is returned, and no driver diagnostics are logged: pilot telemetry records only a `failure` classification (`statement_timeout`, `connection` or `replica`).

The shared `isQueryTimeout` classifier treats any code containing `TIMEOUT` as a query timeout, which includes connection-acquisition timeouts. The pilot route re-classifies those two connector codes as `REPLICA_UNAVAILABLE`, because no statement executed. The shared classifier, and therefore every other endpoint, is unchanged. `ER_GET_CONNECTION_TIMEOUT` cannot distinguish an unreachable replica from a pool exhausted by other traffic; both are reported as unavailable.

`PILOT_DISABLED` was requested as an error, but the same request also required a disabled flag to return 422 `SEMANTICS_UNVERIFIED`. The latter was kept, so a disabled pilot is indistinguishable from the pre-pilot behaviour; no `PILOT_DISABLED` code is emitted.

### Repository execution

`runTruckFixedCostPilotSummary` resolves the period first, then performs **one** locked read through the existing `queryFixedCostMonetaryTotals`: static unqualified SQL, bound month values only, `AnalyticsGate`, the pool's configured query timeout, the 50,000-record hard bound with its truncation sentinel, and sanitized `FixedCostMonetaryError`s. The current representation is not read: lock state is a task-level property counted from `locked_kastaiVilkiko_data` in the same row, so the Slice 6A current/locked population cross-check has nothing to compare. The repository still separates groups by declared `deleted` state; the pilot selects the `deleted = 0` group with no arithmetic.

Telemetry is one event per request with `operation: fixed_cost.truck_summary_pilot`, `duration_ms`, `outcome` (`success`, `refused`, `error`, `timeout`, `busy`), and the refusal code, failure classification or `total_task_count`. Successes are logged at `info` below `ERP_SLOW_QUERY_MS` and at `warn` otherwise; refusals and failures are logged at `warn`. It carries no amount, task ID, truck ID, date, row, SQL or driver diagnostic.

### Query-plan limitation

The pilot reuses the Slice 5 locked statement unchanged. `EXPLAIN` of that exact statement, with the bound month values, was recorded on 2026-09-23 by the opt-in live test and was identical for 2025-03 and 2025-07:

| id | select_type | table | type | possible_keys | key | key_len | rows (estimate) | Extra |
|---:|---|---|---|---|---|---:|---:|---|
| 1 | PRIMARY | `<derived6>` | ALL | — | — | — | 50,001 | Using temporary; Using filesort |
| 6 | DERIVED | `a` (`kastai_fiksuoti_ataskaita`) | index | — | PRIMARY | 4 | 1,556,311 | Using where |
| 6 | DERIVED | `t` (`uzdaviniai`) | eq_ref | PRIMARY | PRIMARY | 4 | 1 | Using index |
| 5 | DEPENDENT SUBQUERY | `d` (`kastai_fiksuoti_vilkikai_det_locked`, component sum) | ref | PRIMARY | PRIMARY | 4 | 1 | — |
| 4 | DEPENDENT SUBQUERY | `d` (`kastai_fiksuoti_vilkikai_det_locked`, row count) | ref | PRIMARY | PRIMARY | 4 | 1 | Using index |

The month predicate on `kastai_data` has no usable index (`possible_keys` is null), so `kastai_fiksuoti_ataskaita` is read as a full primary-key index walk of ~1.56 million estimated rows with `Using where`. Every other access is a single-row primary-key lookup: `uzdaviniai` by `eq_ref`, and both correlated locked-detail subqueries by `ref` on the leading `uzdavinys` key column. The outer grouping reads the bounded derived table (limit plus one sentinel row, 50,001 estimated) with a temporary table and filesort, which is bounded by the record limit. The full month-filter scan is the expected and only unbounded access, and it confirms FC-P17.

This is acceptable only as **internal, low-volume pilot behaviour** for one settled month per request. It is **unsuitable for general production traffic**; FC-P17 stays open, and no cache hides the cost.

Measured end-to-end request durations were 2,242 ms (2025-03) and 2,561 ms (2025-07) for one request at a time. This plan is **acceptable only for the internal, low-volume pilot** and **not for general production traffic**: every request scans the summary table regardless of the month, so cost does not shrink with the period and concurrent requests multiply it. FC-P17 stays open.

### Test evidence

- `tests/unit/fixed-cost-pilot.test.ts`: 31 tests covering the flag, resolver, success, authentication, decimal preservation, `NO_DATA_FOR_PERIOD` for absent data, legitimate stored zero totals, malformed driver results, metadata, period rules, rejected parameters, deleted exclusion, lock refusal, completeness, timeout/busy/unavailable, telemetry, unchanged routes, and 8 mutation guards (flag bypass, executing before gates, current instead of locked, including `deleted = 1`, accepting unlocked, removing completeness, component sum replacing the total, dropping limitations).
- `tests/unit/config.test.ts`: default and strict parsing of the flag.
- `tests/integration/fixed-cost-pilot.test.ts`: opt-in via `FIXED_COST_PILOT_TEST_MONTH=YYYY-MM-01`; prints status, counters, duration and `EXPLAIN` access metadata only.
- **Live pilot validation (2026-09-23)**, with the flag forced on for the test process only, against the configured replica. Safe counters only; no amount was printed or recorded.

  | Month | HTTP | Duration | `totalTaskCount` | `lockedTaskCount` | `complete` | Record limit |
  |---|---:|---:|---:|---:|---|---:|
  | 2025-03 | 200 | 2,242 ms | 20,795 | 20,795 | true | 50,000 |
  | 2025-07 | 200 | 2,561 ms | 23,669 | 23,669 | true | 50,000 |

  Both runs also verified: the unauthenticated request is 401; with the flag off the same request is 422 `SEMANTICS_UNVERIFIED`; breakdown, dimensions and the trailer scope are 422 `SEMANTICS_UNVERIFIED`; a `representation` parameter is 400; the amount is canonical two-scale decimal text; `semanticsVersion`, `pilot`, `complete` and `reconciliationStatus` match the contract. The 2025-03 count matches the `deleted = 0` population measured in Slice 6A (20,795, all locked).
- The first live attempt reached the successful request and then failed with only the generic message "Fixed-cost pilot integration failed". The hidden cause was in the test, not the endpoint: the driver returns EXPLAIN's `id` and `rows` columns as `BigInt`, and `JSON.stringify` on the plan threw `TypeError: Do not know how to serialize a BigInt`. The test now converts plan numbers explicitly and reports the failing stage with a safe cause (assertion message, sanitized driver diagnostics, or a non-driver error name and message) instead of hiding it.
- No accepted ERP reconciliation exists; the live result is a provisional pilot figure.

### Rollback

Set `ERP_FIXED_COST_TRUCK_SUMMARY_PILOT_ENABLED=false` (or remove it) and restart the service. The summary immediately returns 422 `SEMANTICS_UNVERIFIED` with zero replica access. No data, schema or cache state needs reverting.

### Permanent-production blockers (unchanged)

FC-02 current/locked public exposure policy; FC-03 approved deleted-row rule; FC-11/FC-P01/FC-P02 accepted ERP reference month and result; FC-13 zero/negative treatment; FC-14 tolerance; FC-P17 indexed access path for `kastai_data`; FC-P18 orphan-row inclusion rule; FC-P19 general day-range to month mapping; Slice 9 caching; the Section 9 production activation gate.

### Coding gate status after Slice 6P

Unchanged: **closed** for production. Only the flag-gated internal pilot can return an amount.
