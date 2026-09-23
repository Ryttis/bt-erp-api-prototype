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
- [x] All monetary allocation scopes are disabled in the capability registry.
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

### 4.2 Unresolved semantics blocking monetary implementation

No item below may be presented as fact in code, response metadata or documentation until it is approved and recorded in Section 12. Each maps to the canonical open-question register in `docs/costs-endpoint.md` section 8.

- [!] Whether `kastai_fiksuoti_ataskaita` or `uzdaviniai` is authoritative for reportable truck fixed cost (FC-01).
- [!] What `uzdaviniai.kastaiVilkiko`, `kastai_fiksuoti_ataskaita.kastaiVilkiko` and `locked_kastaiVilkiko` each represent (FC-12).
- [!] Under what condition the current or the locked value must be selected (FC-02).
- [!] Whether detail components are additive to the corresponding truck total, and which components are independently additive (FC-06, FC-07).
- [!] Which date controls financial reporting, including whether `kastai_data` denotes an accounting month (FC-04, FC-16).
- [!] What `locked_kastaiVilkiko_data` represents and whether `0000-00-00` denotes an unlocked calculation (FC-02, FC-12).
- [!] Whether fixed-cost amounts are implicitly EUR, already converted, or carry currency through a verified join (FC-05).
- [!] Whether truck reporting uses `uzdaviniai.uzdavinio_masina` or `uzd_vilk_vaziavo` (FC-08).
- [!] Whether `deleted = 0` defines reportable summary rows (FC-03).
- [!] Whether zero and negative truck fixed-cost amounts are valid (FC-13).
- [!] Whether one task belongs to exactly one truck fixed-cost calculation (FC-15).
- [!] Which ERP report and closed period are used for reconciliation, and at what tolerance (FC-11, FC-14).
- [!] How long recent values continue to change before a period may be treated as settled. No ERP statement of a stabilisation window is recorded in this repository, so no such window may be assumed when selecting the reconciliation period.

The Slice 2/3A diagnostics join `uzdaviniai.uzdavinio_masina` to `masinos.id` to characterise coverage only. That is a diagnostic mapping, not an approved reporting mapping. `uzd_vilk_vaziavo` (`varchar(55)`) must not be equated with master `id` (`int(11)`).

The bounded Slice 3A sample of 20 recent tasks produced a single co-occurrence pattern (zero task value, positive summary current value, zero locked value, zero locked date, `deleted = 0`, one detail row). It is not representative of any closed period and proves no rule.

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

- [ ] Select one settled 2025 calendar month with locked truck-cost data.
- [ ] Record the selected month without recording sensitive task identifiers.
- [ ] Add a bounded closed-period reconciliation repository operation.
- [ ] Compare current task-level totals with locked task-level totals.
- [ ] Compare current detail-component sums with current task-level totals.
- [ ] Compare locked detail-component sums with locked task-level totals.
- [ ] Count missing summary rows, missing detail rows and missing truck mappings.
- [ ] Count unlocked rows and zero lock dates in the selected period.
- [ ] Measure the `deleted` flag distribution without assuming its meaning.
- [ ] Detect join multiplication before aggregation.
- [ ] Return only aggregate counts, categorical outcomes and differences; do not expose raw rows or task IDs.
- [ ] Run `EXPLAIN` for each intended production query shape.
- [ ] Record indexes, access type, estimated rows and temporary/filesort use.
- [ ] Reject any production query shape that requires an unbounded scan.
- [ ] Compare the result with the corresponding official ERP report or ERP UI output.
- [ ] Record Finance/ERP acceptance of the selected period and tolerance.

Acceptance criteria:

- [ ] Summary/detail relationships reconcile within the approved tolerance.
- [ ] Current/locked differences are zero or explicitly explained for the settled period.
- [ ] Truck joins do not multiply monetary values.
- [ ] Every intended production query has an acceptable bounded plan.
- [ ] The reconciliation result and approver are recorded in Section 12.

Suggested commit:

```text
Reconcile closed-period truck fixed costs
```

### Slice 5 — Monetary repository and runtime contract

Goal: introduce the production repository boundary and explicit current/locked response semantics while keeping the public capability disabled.

- [ ] Add a fixed-cost monetary repository interface.
- [ ] Add a truck implementation using only static, parameterized, read-only SQL.
- [ ] Use `kastai_fiksuoti_ataskaita` as the task-level summary source only after Slice 4 reconciliation passes.
- [ ] Use current and locked truck detail tables only for their corresponding component representations.
- [ ] Join tasks through `uzdaviniai.id`, and trucks through the truck field approved under FC-08.
- [ ] Apply the approved `deleted` rule.
- [ ] Use the approved accounting-month/date filter without substituting lock date for accounting period.
- [ ] Preserve decimal values without JavaScript floating-point aggregation.
- [ ] Add explicit approved currency metadata; do not emit a currency that is not approved under FC-05.
- [ ] Return current and locked measures separately.
- [ ] Return lock state and lock-date semantics explicitly.
- [ ] Represent unlocked completeness explicitly.
- [ ] Route production queries through the existing analytics concurrency gate.
- [ ] Add sanitized repository error handling.
- [ ] Add fixed-cost telemetry for duration, outcome, timeout, busy state and bounded result counts.
- [ ] Keep the truck public capability disabled throughout this slice.

Acceptance criteria:

- [ ] Repository unit tests cover parameters, SQL allowlists and decimal handling.
- [ ] Tests prove current and locked values are never added together.
- [ ] Tests prove summary totals are not repeated by detail joins.
- [ ] Tests prove blocked public requests still execute no monetary query.
- [ ] Typecheck, unit tests and integration tests pass or an environment-only skip is recorded.

Suggested commit:

```text
Add truck fixed-cost monetary repository
```

### Slice 6 — Truck summary endpoint

Goal: enable the first reconciled public monetary result.

- [ ] Finalize the summary request contract.
- [ ] Support `allocationScope=truck` with paired `dateFrom` and `dateTo`.
- [ ] Add only reconciled summary filters.
- [ ] Return current amount, locked amount and the approved currency separately.
- [ ] Return total, locked and unlocked task counts.
- [ ] Return `sourceFamily`, `amountSemantics`, `dateBasis`, `semanticsVersion`, `reconciliationStatus`, `complete` and `limitations` metadata.
- [ ] Add deterministic stable output ordering where collections occur.
- [ ] Add success, empty-result, timeout and busy-response tests.
- [ ] Add integration reconciliation coverage for the selected 2025 month.
- [ ] Enable only the truck summary capability after all acceptance tests pass.
- [ ] Keep truck breakdown, truck dimensions and all other scopes disabled.

Acceptance criteria:

- [ ] The selected closed-period API result matches the accepted ERP reference.
- [ ] Recent/unlocked ranges cannot be mistaken for final locked results.
- [ ] No unsupported filter or measure reaches the repository.
- [ ] Existing `/vehicles`, invoice and schema endpoints remain unchanged.

Suggested commit:

```text
Enable truck fixed-cost summary analytics
```

### Slice 7 — Truck breakdown endpoint

Goal: expose bounded reconciled groupings without duplicating the task-level total.

- [ ] Finalize the breakdown request contract.
- [ ] Add an allowlisted `groupBy` contract.
- [ ] Implement `month` grouping after date semantics are verified.
- [ ] Implement `truck` grouping through the truck field approved under FC-08.
- [ ] Implement `costComponent` grouping through a static component mapping.
- [ ] Confirm every exposed component is independently additive.
- [ ] Keep current and locked component measures separate.
- [ ] Add bounded pagination for grouped results.
- [ ] Add a maximum group count.
- [ ] Add allowlisted sorting with a stable tie-breaker.
- [ ] Add deterministic filtering by verified truck identifier only.
- [ ] Reject unsupported groupings, sorting, filters and measures.
- [ ] Run and record `EXPLAIN` for every grouping query shape.
- [ ] Add total-versus-breakdown reconciliation tests.
- [ ] Enable the truck breakdown capability only after reconciliation passes.

Acceptance criteria:

- [ ] Every breakdown reconciles to its corresponding summary representation.
- [ ] Pagination and sorting are deterministic.
- [ ] No task-level amount is multiplied by a one-to-many detail join.
- [ ] Group-count, date-range, timeout and concurrency limits are enforced.

Suggested commit:

```text
Add truck fixed-cost breakdown analytics
```

### Slice 8 — Truck dimensions endpoint

Goal: expose only dimension values that are valid for the enabled truck analytics filters and groupings.

- [ ] Finalize the dimensions request contract.
- [ ] Expose the verified truck dimension with minimal required fields.
- [ ] Expose the static approved cost-component dimension.
- [ ] Expose month/period availability only when it can be queried with a bounded plan.
- [ ] Add bounded pagination and deterministic sorting.
- [ ] Exclude sensitive and unrelated vehicle fields.
- [ ] Reject arbitrary column, table and schema discovery requests.
- [ ] Add query-plan and integration tests.
- [ ] Enable the truck dimensions capability only after all tests pass.

Acceptance criteria:

- [ ] Every returned dimension value can be used by an enabled filter or grouping.
- [ ] Dimension queries are bounded, indexed and deterministic.
- [ ] No sensitive ERP fields are returned.

Suggested commit:

```text
Add truck fixed-cost dimensions
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
| FC-P01 | Exact settled 2025 reconciliation month (FC-11) | ERP / Finance | Monetary activation | Open |
| FC-P02 | Official ERP report/UI result for the selected month (FC-11) | ERP / Finance | Monetary activation | Open |
| FC-P03 | `deleted` inclusion rule (FC-03) | ERP / Finance | Production queries | Open |
| FC-P04 | Decimal reconciliation tolerance (FC-14) | Finance | Monetary activation | Open |
| FC-P05 | Zero and negative-value treatment (FC-13) | Finance | Monetary activation | Open |
| FC-P06 | Unlocked-task aggregate representation and completeness rule | Finance / API owner | Public contract | Open |
| FC-P07 | Initial breakdown groupings and filters | BA / Finance | Breakdown activation | Open |
| FC-P08 | Truck dimension projection and identifier exposure | BA / Security | Dimensions activation | Open |
| FC-P09 | Cache backend and settled/recent TTLs | API owner / Operations | Cached release | Open |
| FC-P10 | Cost classification availability/version behavior | Finance / BT Finance Analyst | Classified breakdown only | Deferred |
| FC-P11 | Authoritative truck fixed-cost source and the meaning of each `kastaiVilkiko` field (FC-01, FC-12) | ERP / BA | Slice 4 and all monetary work | Open |
| FC-P12 | Rule selecting the current or the locked representation (FC-02) | ERP / Finance | Public contract | Open |
| FC-P13 | Reporting date basis, including whether `kastai_data` is the accounting month (FC-04, FC-16) | Finance / BA | Production queries | Open |
| FC-P14 | Currency semantics: implicit EUR, converted, or joined (FC-05) | Finance / ERP | Response contract | Open |
| FC-P15 | Truck field for reporting: `uzdavinio_masina` or `uzd_vilk_vaziavo` (FC-08) | ERP / BA | Truck grouping and filtering | Open |
| FC-P16 | Summary/detail additivity and independently additive components (FC-06, FC-07) | ERP / Finance | Breakdown activation | Open |

## 12. Evidence and completion log

### Decisions

| Date | ID | Decision | Evidence/approver | Commit/MR |
|---|---|---|---|---|
| 2026-09-23 | BASELINE | Dated implementation audit adopted as the plan baseline. | `docs/fixed-costs-status-2026-09-23.md` | — |
| — | — | — | — | — |

### Reconciliation

| Date | Scope | Period | Reference | Current result | Locked result | Detail result | Outcome | Commit/MR |
|---|---|---|---|---|---|---|---|---|
| — | truck | — | — | — | — | — | Not started | — |

### Query plans

| Date | Operation | Bounds | Index/access result | Estimated/scanned rows | Accepted | Commit/MR |
|---|---|---|---|---|---|---|
| — | — | — | — | — | No | — |

### Validation

| Date | Slice | Command/check | Result | Evidence | Commit/MR |
|---|---|---|---|---|---|
| 2026-09-23 | Baseline audit | `npm run typecheck` | Passed | No TypeScript errors | — |
| 2026-09-23 | Baseline audit | `npm test` | Passed | 71 unit tests, 0 failures | — |
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