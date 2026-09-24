# Consolidating `/plain/mcp/trucks` into `/vehicles`

Audit date: 2026-09-24. `/vehicles` is the canonical vehicle endpoint of this
service. `GET /plain/mcp/trucks` is **not** implemented in this repository: it is a
Laravel REST endpoint of the ERP itself (`ERP_API_BASE_URL`, e.g.
`https://api-dev.baltictransline.lt`). BT Finance Analyst calls it directly
(`TrucksApiClient`). This repository cannot delete or change it; "keeping it
operational" needs no action here.

Legacy behavior below was verified empirically against the dev endpoint (structure,
filter probes, per-vehicle reconciliation), because its source code is not available.

## Capability matrix

| Capability | `/plain/mcp/trucks` (Laravel, dev) | `/vehicles` | Same semantics? | Action |
|---|---|---|---|---|
| Source | ERP application DB (dev snapshot), Laravel resources | Read-only MariaDB replica `infot_2`, fixed SQL | Same underlying tables; dev DB has drifted (~4% plates differ) | Documented |
| Row universe | 3,590 vehicles; excludes some `masinos` rows (unconfirmed scope, see open questions) | All 4,221 `masinos` rows | **No** | Not migrated; needs business rule |
| Response | `{data, links, meta{current_page,last_page,per_page,total,from,to,path,links}}`, nested objects | `{data, meta{page,per_page,total,last_page,sort}}`, flat fields | Different shape | Keep `/vehicles` shape |
| Row fields: id, plate, make, model, vin, registration_date, department/group/market, mileage-related | Yes (lookups as `{id,label}`) | Yes (lookup names as strings) | Same sources | None |
| Manufacture date | `manufacture_year/month/day` components | `manufactured_at` validated date | Same source, different form | None |
| Consumer / lessor / bank relation | Nested objects `{id,label}` + contract details | `*_id`, `*_name`, dates, rent, last payment | Same "latest by `data_nuo`, `id`" (89–94% match, rest drift) | None |
| Owner relation | `owner{owner{id,label}, status, dates, value…}` | — | — | **Added** `owner_id`, `owner_name` (opt-in) |
| Ownership status | `owner.status{id,label}` | — | — | **Added** `ownership_status` (opt-in) |
| `is_inactive` / `inactive_since` | Yes | `active` / — | `active` = `!is_inactive` | **Added** `inactive_since` (opt-in) |
| Technical inspection / civil insurance expiry | Yes | — | — | **Added** (opt-in) |
| Other row fields (euro_type, cost_type, working_since, takeover_date, subcontractor, asset_owner_department, registration_country, contract numbers/values, notes, …) | Yes | — | — | Not migrated (no consumer use found; see below) |
| `plate_number` filter | Case-insensitive substring | Same | Yes | None |
| `plate_numbers` | — | Exact list ≤100 | — | Existing |
| `make` | Case-insensitive **substring** | Case-insensitive **exact** | **No** (`make=Volvo` behaves the same; `make=olv` does not) | Keep exact; documented |
| `model` | Case-insensitive substring | Same | Yes | None |
| `department`, `group`, `market` | Case-insensitive **substring** | Case-insensitive **exact** | **No** for fragments | Keep exact; documented |
| `active` | `1`/`0` only (`true` → 422) | `true`/`false`/`1`/`0` | Superset | None |
| `status` | Substring of the **owner** relation's status label | `ownership_status`: case-insensitive **exact** status name; `status` alias | Same field; exact vs substring | **Added** |
| `owner` | Substring of owner name (IDs not accepted) | `owner_name` substring, `owner` alias; plus `owner_id` | Yes | **Added** |
| `consumer`, `lessor`, `bank` | Substring of the counterparty name | `consumer_name`, `lessor_name`, `bank_name` (+ aliases) | Yes | **Aliases added** |
| `inactive_since_from/_to` | Inclusive date range | Same names | Yes | **Added** |
| `technical_inspection_valid_until_from/_to` | Inclusive date range | Same names | Yes | **Added** |
| `civil_insurance_valid_until_from/_to` | Inclusive date range | Same names | Yes | **Added** |
| `lease_start_from/_to`, `lease_end_from/_to` | Filters lessor `contract_date_from/_to` | Latest lease `data_nuo`/`data_iki` | Yes as far as measured (86% equal, rest drift) | None |
| `mileage_from/_to` | Integer | Nonnegative decimal | Yes (superset) | None |
| Manufactured, registration, rent-price, last-payment, consumer-date ranges; `*_id` filters | — | Yes | — | Existing |
| Pagination | `page`, `per_page` default 50; oversized values → 422 (500 rejected; finance client caps at 200) | `page`, `per_page` default 50, max 200 | Compatible | None |
| Sorting | None (client-side ranking scans ≤10,000 rows) | `sort_by`/`sort_direction`, null-last, `id` tie-break | `/vehicles` only | **New sort fields** for migrated dates/names/status |
| Counts / analytics | `meta.total` only | `total`; `summary`, `distinct`, `grouped` views | `/vehicles` only | `ownership_status`, `owner_id` added as categories |
| Unknown parameters | Silently ignored (unfiltered result!) | 400 `INVALID_QUERY` | **No** | Keep strict |
| Invalid values | 422 Laravel validation (`errors` object; dev may include traces) | 400 `INVALID_QUERY` | Different codes | Keep `/vehicles` |
| Reversed range | 200 with empty result | 400 | **No** | Keep strict |
| No data / page past end | 200, empty `data` | 200, empty `data`, total retained, `last_page` 0 when empty | Equivalent | None |
| Null handling | JSON null for missing relations/dates | Null; zero FKs/dates become null; money zero stays 0 | Equivalent | None |
| Deleted / inactive vehicles | Inactive included unless `active` filter | Same | Yes | None |
| Auth | None | Bearer service token | Stricter | None |
| Timeout / busy | Not specified | 30 s statement timeout → 504; analytics gate → 503 `SERVICE_BUSY` | `/vehicles` only | Unchanged |

## Migration guide for BT Finance Analyst

The legacy query names below can be sent to `/vehicles` unchanged: `plate_number, model, active (1/0),
inactive_since_*, technical_inspection_valid_until_*, civil_insurance_valid_until_*,
lease_start_*, lease_end_*, mileage_*, page, per_page` plus the aliases `status,
owner, consumer, lessor, bank`. Also:

- Add `fields=` naming the opt-in fields when they are needed: `inactive_since,
  owner_id, owner_name, ownership_status, technical_inspection_valid_until,
  civil_insurance_valid_until`.
- Send full names for `make`, `department`, `group`, `market`, and `status`
  (exact, case-insensitive). Discover values with `view=distinct&field=…`.
- Use server sorting (`sort_by=technical_inspection_valid_until` etc.) instead of
  client-side scan ranking.
- Adapt to the flat response and `meta.page` (not `current_page`), and send the Bearer token.

## Intentionally not migrated

- **Legacy row-universe scope.** The replica rows missing from the legacy output are
  concentrated in vehicles with an administrative purpose (`admin_auto_paskirtis`
  non-empty: 215 of 369 older excluded rows versus 1 of 3,590 included). This is
  only a hypothesis, and 154 excluded rows remain unexplained. Adding it would change
  existing `/vehicles` totals.
- **Substring matching for `make`/`department`/`group`/`market`/`status`.**
  Changing it would alter existing `/vehicles` behavior, and enum-like values are safer
  exact. For example, legacy `status=nuoma` also matches `Veiklos nuoma`.
- **Remaining legacy row fields** (euro type, cost type, working since, takeover
  date, subcontractor, asset-owner department, registration country, contract
  numbers/values/notes, owner/consumer relation dates and values). No BT Finance
  Analyst code reads them. They reach the model only as raw arrays, so their business
  relevance needs confirmation before they are mapped.
- **Silent acceptance of unknown parameters and reversed ranges.** This is unsafe; `/vehicles` rejects them.
