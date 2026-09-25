# bt-erp-api-prototype

Read-only ERP analytical API in development. Existing trips, orders, customers,
invoices, and documents endpoints still serve mock data. `GET /vehicles` reads the ERP replica.

## Configuration and startup

Install dependencies with `npm ci`. Supply the variables listed in `.env.example`
through a repository-local `.env`, the process environment, or a deployment secret manager. The application
requires replica host, database, user, and password; it validates configuration
before starting. Optional defaults are shown in `.env.example`; connection limit
must be between 1 and 100. Never commit deployment credentials.

Every endpoint except `GET /health` requires service-to-service authentication:

```bash
curl -H "Authorization: Bearer $ERP_ANALYTICS_API_TOKEN" http://127.0.0.1:3000/vehicles
```

`ERP_ANALYTICS_API_TOKEN` is required, must be at least 32 characters, and must
be injected by the deployment secret manager (not Compose, source, image layers,
or command lines). Generate a high-entropy value, for example with `openssl rand
-base64 48`, and share it only with the BT Finance Analyst's deployment secret.
The API uses an exact Bearer token comparison and never logs the header.

`src/config.ts` automatically loads `.env` from the working directory. Existing
process environment variables take precedence. The `.env` file is ignored by Git.
Run commands from the repository root:

```bash
npm run dev
# Or:
npm start
```

Startup performs a read-only connectivity query before listening. `/health` is
the deliberately minimal unauthenticated liveness probe (`{"status":"ok"}`), not
a continuous replica readiness check; it discloses no database or configuration
state. All responses are marked `Cache-Control: no-store` and receive baseline
browser-hardening headers. SIGINT/SIGTERM close Fastify and its replica pool.

`ERP_REPLICA_SSL=false` explicitly supports the current replica without TLS.
Use `true` for a TLS-enabled replica; certificate verification is not disabled.
Use an account restricted to SELECT on `infot_2`; the connection pool itself does
not enforce database privileges.

## Tests

```bash
npm run typecheck
npm test
```

Normal tests use injected fake pools and require no replica credentials. Explicit
live verification uses the environment described above:

```bash
npm run test:integration
```

Integration verification executes only `SELECT VERSION(), CURRENT_USER(), DATABASE()`
and `SHOW GRANTS FOR CURRENT_USER()`. It requires direct SELECT-only database grants
on `infot_2` (plus optional global USAGE). Roles, broader grants, and unrecognized
grant formats fail verification and require private review. Grants are never
logged or served through an endpoint. Missing configuration fails this explicit test.

Mock endpoint smoke examples:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/api/trips/313
curl http://localhost:3000/api/orders/A4029709
curl http://localhost:3000/api/customers/customer-1
curl "http://localhost:3000/api/invoices?tripId=313"
curl "http://localhost:3000/api/documents?tripId=313"
```

## Schema discovery

The authenticated `/schema/*` API is an investigation aid for ERP developers.
It exposes only `INFORMATION_SCHEMA` metadata from the configured replica: it
never accepts SQL, reads business-table rows, or returns credentials, grants, or
connection configuration. It shares the replica statement timeout and bounded
analytics concurrency gate used by other analytical reads.

`GET /schema/tables` lists tables and views as `{ data, meta }`. `page` defaults
to 1 and `per_page` defaults to 50 (maximum 100); each item has `name`, `type`,
and `approximate_row_count` (MariaDB's `TABLE_ROWS` estimate). `meta.complete`
is false when subsequent pages remain.

```bash
curl -H "Authorization: Bearer $ERP_ANALYTICS_API_TOKEN" \
  'http://127.0.0.1:3000/schema/tables?per_page=50'
```

`GET /schema/search?q=invoice` requires exactly one non-empty query string of at
most 100 characters. It searches only table and column names and returns matching
tables with `matching_columns`; results are capped at 100 tables. `meta` includes
`result_count` and `complete`, which is false whenever the search cap truncates
the response.

```bash
curl -H "Authorization: Bearer $ERP_ANALYTICS_API_TOKEN" \
  'http://127.0.0.1:3000/schema/search?q=invoice'
```

`GET /schema/tables/:table` first confirms the exact table name in
`INFORMATION_SCHEMA.TABLES`, then returns its type, approximate row count,
columns (including type/null/default/PK/auto-increment metadata), indexes, and
available foreign keys. Unknown names return 404. Detail collections are each
bounded to 500 metadata rows; `meta.columns_complete`, `meta.indexes_complete`,
and `meta.foreign_keys_complete` report each collection's completeness.
Arbitrary string column defaults are redacted (`default: null`,
`default_redacted: true`) so a schema default cannot disclose a secret.

```bash
curl -H "Authorization: Bearer $ERP_ANALYTICS_API_TOKEN" \
  'http://127.0.0.1:3000/schema/tables/invoices'
```

MariaDB 10.3's `TABLE_ROWS` is an engine-maintained estimate, especially for
InnoDB; it is not a transactionally exact count. Foreign-key metadata is present
only for declared constraints (implicit application-level relationships cannot be
discovered), and index prefix/expression details are not included in this MVP.

## Vehicles

`GET /vehicles` returns `{ data, meta }`. Supported filters are `plate_number`
(case-insensitive literal substring), `plate_numbers` (comma-separated exact list,
maximum 100 entries), `make` (case-insensitive exact match), `model`
(case-insensitive literal substring), and `active` (`true`, `false`, `1`, or `0`).
Filters combine with AND. Unknown, repeated, or invalid parameters return 400;
replica failures return a generic 503 without database details.

Pagination uses `page` (default 1) and `per_page` (default 50, maximum 200).
`meta` contains `page`, `per_page`, `total`, `last_page`, and `sort: { field, direction }`.
Totals cover all filtered vehicles; an empty dataset has `last_page: 0`.
Out-of-range pages return an empty array with the filtered total retained.

`sort_by` allows `plate_number`, `make`, `model`, `rent_price`,
`last_payment_amount`, `lease_start`, and `lease_end`. `sort_direction` accepts
`asc` or `desc`. Default order is plate number ascending; every order adds ID
ascending as a deterministic tie-breaker. Nulls sort last in both directions.

Vehicle fields: `id`, `plate_number`, `make`, `model`, `vin`, `active`,
`consumer_id`, `consumer_from`, `consumer_to`, `rent_price`, `lessor_id`,
`bank_id`, `lease_start`, `lease_end`, and `last_payment_amount`.
Dates are `YYYY-MM-DD` or null. Missing relations, zero foreign keys, and zero
dates become null; monetary zero remains zero. Each relation is the latest known
by start date and ID, including future-dated relations. Count and page queries
are separate reads and may reflect intervening replica changes.

```bash
curl 'http://localhost:3000/vehicles?plate_numbers=NIR935,NJI449'
```

## Vehicle numeric summaries

Use `GET /vehicles?view=summary&metric=count`. Require at least one `metric`;
repeat the parameter for multiple metrics (maximum 10 occurrences). Duplicates
are deduplicated; comma-separated metrics are rejected. Supported metrics are
`count` and `sum:<field>`, `avg:<field>`, `min:<field>`, `max:<field>`, where field
is `rent_price` or `last_payment_amount`. Mileage additionally supports
`avg:mileage`, `min:mileage`, and `max:mileage`; `sum:mileage` is unsupported.

```text
GET /vehicles?view=summary&plate_numbers=HOO756,LGK058&metric=count&metric=sum:rent_price
```

```json
{
  "data": { "count": 2, "sum_rent_price": 3050 },
  "meta": { "view": "summary", "complete": true }
}
```

Only requested metrics appear. Summary uses the same `plate_number`,
`plate_numbers`, `make`, `model`, and `active` filters as rows, over every match.
`page`, `per_page`, `sort_by`, and `sort_direction` are rejected with 400 in summary
view, so pagination cannot truncate analytics. Omitting `view` (or using
`view=rows`) retains row behavior; metrics are invalid in rows view.

MariaDB calculates all aggregates in one query using the same latest-known
relations (`data_nuo DESC, id DESC`). Count includes every matching vehicle;
other aggregates exclude nulls and include zero. Empty datasets return count 0
and null for sum/average/minimum/maximum. All-null fields likewise return null.
Final monetary aggregates are rounded in SQL to two decimal places, after
aggregation rather than per row, and returned as JSON numbers. JSON does not
preserve trailing decimal zeros. No raw dataset is fetched for analytics.
Failed or incomplete queries return a generic 503 without `complete: true`.

## Vehicle categorical analytics

```text
GET /vehicles?view=distinct&field=make
GET /vehicles?view=grouped&group_by=make&metric=count&metric=sum:rent_price
```

Both views allow exactly one category field: `make`, `model`, `department`,
`group`, `market`, `active`, `consumer_id`, `lessor_id`, `bank_id`, `owner_id`,
or `ownership_status`. Distinct requires `field` and returns
`data: [{ value, count }]`, with `meta: { view: "distinct", field, complete: true }`.
Grouped requires `group_by` and one or more repeated `metric` parameters, using
the summary metric allowlist and maximum 10 occurrences. It returns
`data: [{ group, ...requestedMetrics }]`, with
`meta: { view: "grouped", group_by, complete: true }`.
Only requested metrics appear; count is not added implicitly to grouped output.

The views share all existing vehicle filters and latest-known relation joins.
Filtering and aggregation happen in MariaDB before the category limit is applied.
Ordering is vehicle count descending, then category ascending, with null last
among equal counts. Grouped uses this ordering even when count is not requested.
Text categories preserve exact spelling, case, and trailing spaces and use binary
UTF-8 ordering; this does not change case-insensitive filter behavior. Active
categories are JSON booleans, relation IDs are numbers, and missing/zero relation
IDs form a single null category. Empty strings remain distinct from null.

Grouped monetary metrics have the same rounding, zero and null semantics as
summary. No matching vehicles returns an empty array with `complete: true`.
Each successful response contains at most 100 categories. SQL fetches at most
101 aggregated categories to detect overflow; overflow returns HTTP 422:

```json
{
  "error": {
    "code": "CATEGORY_LIMIT_EXCEEDED",
    "message": "Category limit exceeded; narrow the filters",
    "limit": 100
  }
}
```

Overflow never returns partial data or `complete: true`. Pagination and row
sorting parameters are rejected with 400 in both views. Distinct rejects metrics
and `group_by`; grouped rejects `field`. Unknown fields, multiple category fields,
and unsupported metrics are rejected with 400.

## Extended vehicle queries

The default row representation also includes `manufactured_at`,
`registration_date`, `mileage`, `department`, `group`, `market`, `consumer_name`,
`lessor_name`, and `bank_name`. Dates are valid `YYYY-MM-DD` or null; incomplete
manufacture components and invalid/zero ERP dates become null. Mileage zero
remains zero. Lookup names and absent mileage are nullable.

Projection is rows-only:

```text
GET /vehicles?fields=plate_number,make,model,mileage,rent_price
```

`fields` accepts all 30 canonical response fields listed in the Vehicles sections
(the 24 default fields plus the six opt-in fields below), with at most 30
comma-separated entries. Whitespace is trimmed and duplicates
are deduplicated. Unknown/empty fields or repeated `fields` parameters return
400. Only requested properties are returned; ID is not implicitly added. Omit
`fields` to return the full default representation. Analytical views reject it.
SQL selects only requested columns and joins required by selection/filter/sort.

Additional filters, shared identically across all four views:

| Parameters | Meaning |
|---|---|
| `mileage_from`, `mileage_to` | Inclusive recorded odometer bounds; nonnegative numbers |
| `rent_price_from`, `rent_price_to` | Inclusive rental price bounds |
| `last_payment_from`, `last_payment_to` | Inclusive last-payment amount bounds |
| `manufactured_from`, `manufactured_to` | Inclusive manufactured-date bounds |
| `registration_from`, `registration_to` | Inclusive registration-date bounds |
| `consumer_from`, `consumer_to` | Inclusive bounds on the latest consumer relation's **start date** |
| `lease_start_from`, `lease_start_to` | Inclusive lease-start bounds |
| `lease_end_from`, `lease_end_to` | Inclusive lease-end bounds |
| `consumer_id`, `lessor_id`, `bank_id` | Exact positive integer IDs |
| `consumer_name`, `lessor_name`, `bank_name` | Case-insensitive literal substring |
| `department`, `group`, `market` | Case-insensitive exact lookup name |
| `inactive_since_from`, `inactive_since_to` | Inclusive bounds on the date the vehicle stopped working |
| `technical_inspection_valid_until_from`, `technical_inspection_valid_until_to` | Inclusive technical-inspection expiry bounds |
| `civil_insurance_valid_until_from`, `civil_insurance_valid_until_to` | Inclusive civil-insurance expiry bounds |
| `owner_id` | Exact positive integer ID |
| `owner_name` | Case-insensitive literal substring |
| `ownership_status` | Case-insensitive exact status name (e.g. `Nuosava`, `Lizingas`) |

`consumer_to` as a query bound does not change the row field `consumer_to`, which
is the relation's end date. These filters never reinterpret latest as active today.
Numbers must be finite decimal notation (no exponent syntax); numeric zero is
valid, and null values do not match ranges. Monetary bounds may be negative.
Dates must be real calendar dates in `YYYY-MM-DD` (years 1000–9999). Invalid
values, reversed ranges, unknown or repeated filter parameters return 400.
All supplied filters combine with AND.

Rows can sort by `plate_number`, `make`, `model`, `manufactured_at`,
`registration_date`, `mileage`, `rent_price`, `last_payment_amount`,
`consumer_name`, `lessor_name`, `bank_name`, `department`, `group`, `market`,
`lease_start`, `lease_end`, `inactive_since`, `owner_name`, `ownership_status`,
`technical_inspection_valid_until`, or `civil_insurance_valid_until`. Direction is `asc` or `desc`; nulls are always
last and ID ascending breaks ties. Analytical views retain their own ordering
and reject row sorting/pagination. Page, plate-list, category, and metric limits
remain 200, 100, 100, and 10 respectively.

### Fields and filters migrated from `/plain/mcp/trucks`

These opt-in row fields are returned only when named in `fields`, so the default
representation is unchanged:

| Field | Source |
|---|---|
| `inactive_since` | `masinos.nebedirba_nuo`; zero/invalid dates are null |
| `owner_id`, `owner_name` | Latest ownership relation (`masinu_priekabu_savininkas`, `data_nuo DESC, id DESC`) → `klientai` |
| `ownership_status` | That relation's `statusas` → `tipai_sarasai_visi.pavadinimas` |
| `technical_inspection_valid_until` | Latest `masinu_galiojimai.galioja_iki` of type 3 (`Tech. apžiūra`), excluding obsolete (`neaktualus`) records |
| `civil_insurance_valid_until` | Same, type 8 (`Civilinis draudimas`) |

`ownership_status` and `owner_id` are also categorical fields for the `distinct`
and `grouped` views; use `view=distinct&field=ownership_status` to list valid
statuses. Ownership follows the same latest-known rule as consumer and lease
relations and is never reinterpreted as "valid today".

For compatibility, these legacy parameter names are accepted as exact synonyms:
`status` → `ownership_status`, `owner` → `owner_name`, `consumer` →
`consumer_name`, `lessor` → `lessor_name`, and `bank` → `bank_name`. Sending both
spellings of one filter returns 400. Legacy date/range filters use the same names
as their `/vehicles` counterparts. Known semantic differences from the legacy
endpoint (row universe, `status`/`make`/lookup exact matching, strict validation)
are listed in [vehicles-trucks-consolidation.md](docs/vehicles-trucks-consolidation.md).

Mileage avg/min/max exclude nulls and include zero, without monetary rounding.
Their sums are intentionally unsupported. Verified source mappings and bounded
replica examples are recorded in [vehicle-schema.md](docs/vehicle-schema.md).

## Replica safety and telemetry

The pool uses a conservative default of four connections, a five-second connect
timeout, ten-second acquisition timeout, 60-second idle release, and a 30-second
MariaDB server-side statement timeout. `ERP_REPLICA_QUERY_TIMEOUT_MS` configures
the statement timeout; it is not a client-side race against an unresolved query.
MariaDB interrupts timed-out statements and the connector removes or resets the
affected connection according to its normal pool lifecycle.

`summary`, `distinct`, and `grouped` share a per-app analytical gate. Defaults
allow three active operations, six queued operations, and a one-second bounded
wait. Overflow or wait expiry returns 503 `SERVICE_BUSY`; a statement timeout
returns 504 `QUERY_TIMEOUT`. Slots are released on all outcomes. Rows are already
bounded by page limits and do not use this gate.

All vehicle errors use this stable shape:

```json
{ "error": { "code": "INVALID_QUERY", "message": "Invalid vehicle query" } }
```

Codes are `INVALID_QUERY`, `CATEGORY_LIMIT_EXCEEDED`, `REPLICA_UNAVAILABLE`,
`QUERY_TIMEOUT`, and `SERVICE_BUSY`. Category-limit errors remain 422; ordinary
replica failures are 503. Errors never expose SQL, tables, driver messages,
credentials, host details, connection URIs, result data, or stacks.

Database-backed vehicle requests emit structured logs with request ID, endpoint,
view, operation (`vehicle.rows`, `vehicle.summary`, `vehicle.distinct`, or
`vehicle.grouped`), duration, outcome, timeout/busy flags, page size, metric
count, and result/category counts. Failure logs include only sanitized driver
codes/metadata. They never include SQL, filter values, plate lists, names,
records, credentials, host details, or raw driver messages. `ERP_SLOW_QUERY_MS`
defaults to 1000; crossing it upgrades the structured event to a warning without
cancelling a request. Fastify's standard request URL is also redacted so it
cannot reintroduce filter values through access logs.

The server rejects URLs over `MAX_REQUEST_URL_LENGTH` (default 4096), and its
router rejects overlong route parameter segments. Existing row, plate-list,
field, metric, and category bounds remain enforced. Repository queries pass a
read-only application boundary permitting only `SELECT`, `SHOW`, and `EXPLAIN`,
in addition to the replica account's verified SELECT-only grants.

No cache is installed. Live queries remain in the low-hundreds of milliseconds
or below, so a cache would add invalidation and stampede complexity without a
measured need. The integration suite reports representative timings and EXPLAIN
summaries but has no fragile timing assertions.

## Docker

The Docker image is multi-stage, runs as the unprivileged `node` user, and contains
only production dependencies plus compiled application files. Supply required
replica variables and `ERP_ANALYTICS_API_TOKEN` through deployment secrets; the
current Compose file binds the API to loopback only and supplies only PORT, so it
needs a local environment override before the API can start. Keep its host port
closed to public networks; expose it to the BT Finance Analyst through a local
authenticated reverse proxy or a private firewall rule only.

## Stage deployment (GitLab CI)

Pipeline jobs: `test` and `typecheck` run on every branch and merge request;
`deploy_stage` then `smoke_stage` run only on `master`. There is no production job.

`deploy_stage` streams `scripts/deploy-stage.sh` over SSH to the stage host. It runs
the manual procedure unchanged: in `/var/www/html/bt-erp-replica-api` it runs
`git fetch`, `git switch master`, `git pull --ff-only`, then `docker compose` with
`compose.yaml`, `~/.config/bt-erp-replica-api/compose.staging.yaml` and
`--env-file ~/.config/bt-erp-replica-api/staging.env` (`up -d --build`, then `ps`).
It fails if SSH, git, the build or startup fails, or if `bt-erp-replica-api-api-1`
does not answer `/health` inside the container within 60 seconds.
`smoke_stage` runs `scripts/smoke-stage.sh` on the stage host against the published
API. It requires `GET /health` to return `{"status":"ok"}` and an unauthenticated
`GET /vehicles` to return 401. It uses no token and never touches the replica.
The manual commands above still work exactly as before.

GitLab CI/CD variables (the same names bt-finance-analyst uses for this host):

| Variable | Purpose |
|---|---|
| `STAGING_HOST` | Stage server address for SSH |
| `STAGING_USER` | SSH user that owns the checkout and `~/.config/bt-erp-replica-api/` |
| `STAGING_SSH_PRIVATE_KEY` | Masked; dedicated CI deploy private key, single-line base64 |
| `STAGING_KNOWN_HOSTS` | Pinned SSH host-key line for the stage server (strict checking stays on) |
| `STAGING_API_URL` | Optional; published API base URL for the smoke test (defaults to the stage address in `.gitlab-ci.yml`) |

Scope the private key to protected branches/environments where possible. Never
commit key material or put application secrets in CI variables; the application
secrets stay in the stage host's `staging.env`.
