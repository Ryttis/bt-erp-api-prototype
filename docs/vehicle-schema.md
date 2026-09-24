# Verified vehicle mappings

Read-only discovery on 2026-09-09 used `SHOW FULL COLUMNS`, `SHOW INDEX`, bounded
SELECT examples, cardinality counts, and lookup-integrity counts. No database
changes were made. All tables below are in `infot_2`.

| Canonical field | Confirmed source / join |
|---|---|
| manufactured_at | `masinos.pag_metai`, `pag_menuo`, `pag_diena`; validated year/month/day construction |
| registration_date | `masinos.register_date` (DATE) |
| mileage | `masinos_latest_status.last_odometer`, joined on `masinos_id = masinos.id AND ar_priekaba = 0` |
| department | `masinos.priskirto_skyriaus_id → skyriai.id`, name `skyriai.skyrius` |
| group | `masinos.priskirto_poskyris_id → poskyriai.id`, name `poskyriai.poskyris` |
| market | `masinos.priskirto_rinka_id → rinkos.id`, name `rinkos.rinka` |
| consumer_name | Latest user relation `naudotojas → klientai.id`, name `firmos_pavadinimas` |
| lessor_name | Latest lease relation `lizinguotojas → klientai.id`, name `firmos_pavadinimas` |
| bank_name | Latest lease relation `bankas → klientai.id`, name `firmos_pavadinimas` |
| inactive_since | `masinos.nebedirba_nuo` (DATE); zero dates are null |
| owner_id / owner_name | Latest ownership relation `masinu_priekabu_savininkas.savininkas → klientai.id`, name `firmos_pavadinimas` |
| ownership_status | Latest ownership relation `statusas → tipai_sarasai_visi.id`, name `pavadinimas` |
| technical_inspection_valid_until | `MAX(masinu_galiojimai.galioja_iki)` where `ispejimo_id = 3` and `neaktualus = 0` |
| civil_insurance_valid_until | `MAX(masinu_galiojimai.galioja_iki)` where `ispejimo_id = 8` and `neaktualus = 0` |

The status table also stores trailers. Its column comment explicitly identifies
`ar_priekaba = 1` as trailer IDs. The unique index `(masinos_id, ar_priekaba)`
ensures at most one vehicle-status row when `ar_priekaba = 0`: observed 3,401
vehicle rows / 3,401 distinct vehicle IDs, with zero duplicate groups.
Lookup IDs are primary keys. All nonzero department/group/market assignments
matched their respective lookups across 4,205 vehicles. Market uses the vehicle's
explicit assignment, not `skyriai.rinka_id`; LGK058 has vehicle market 1 while
its department market is 0. No fallback or inherited market is inferred.

Both finance relations retain latest-known ordering `data_nuo DESC, id DESC`.
Zero foreign keys are null before lookup joins. Zero/partial/impossible dates
are null; manufacture components are never silently filled in. SQL validation
was tested with leap-day, non-leap-day, zero components, and April 31 examples.

## Small discovery snapshot

Odometers are operational readings, not permanent fixture constants. Integration
tests compare against fresh bounded source reads. Names and dates below were
observed before being used as fixture evidence.

| Plate | Manufactured | Registered | Mileage |
|---|---|---|---:|
| HOO756 | 2015-04-01 | null | 858219 |
| LGK058 | 2019-11-01 | null | 499249 |
| MUJ352 | 2023-08-01 | 2023-12-28 | 300523 |
| NHJ910 | 2025-01-13 | 2025-01-30 | null |
| NIR935 | 2025-02-01 | 2025-04-08 | 159717 |
| NJI449 | 2025-02-01 | 2025-04-29 | 148909 |

HOO756: department `Sandėlis LT`, group `Sandėlis1`, market null; consumer
`Baltic transline transport, UAB`, lessor `Baltic transline rental, UAB`, bank
`SEB bankas AB`. LGK058 market: `Europos rinka`. NHJ910 group: null.

## Representative query plan

Fleet mileage/rent filtering with consumer-name sorting and a three-field
projection took about 116 ms including endpoint overhead in the validation run.
EXPLAIN used `masinos_nr` for the vehicle scan, `eq_ref` on the status composite
unique key and lookup primary keys, and `masinos_id_data_nuo_idx` for latest
rental lookup. Temporary/filesort appeared for name sorting. No index change is
recommended from this measurement. Integration timings vary with network and
concurrent replica work.

## Legacy trucks parity mappings (2026-09-24)

Approved bounded read-only discovery. Lookup evidence: `galiojimu_tipai` id 3 is
`Tech. apžiūra` and id 8 is `Civilinis draudimas` (both `kam = 'masinoms'`).
Ownership statuses 1040 `Nuomota`, 1041 `Lizingas`, 1042 `Nuosava`, and 1528
`Veiklos nuoma` belong to list `priekabu_statusai`. Vehicle ownership rows also use
1102 `Panauda`, 1103 `Nuoma`, 1104 `Lizingas`, and 5454 `Nuosava` from list
`priekabu_statusai_administracija`; the status join is by primary key and so
covers both lists.

The mappings were reconciled per vehicle ID against the dev ERP
`/plain/mcp/trucks` output (3,590 rows, 3,445 with the same plate in both sources,
which puts dev/replica drift at about 4% of plates). On plate-matching rows:
`inactive_since` 95% equal, ownership status 92%, owner ID 89%,
civil insurance 86%, and technical inspection 77%. Mismatches were
almost all "legacy value older/absent", which is consistent with the dev snapshot being older.
Alternatives were measured worse: "currently valid" relations matched about 43%
and validity picks without the `neaktualus` filter about 40%. No vehicle has more than
one active technical-inspection record. 56 vehicles have several active civil-insurance
records, and the latest expiry is returned for them.

Index use: `masinu_galiojimai` has single-column indexes on `masinos_id` and
`ispejimo_id`, and `masinu_priekabu_savininkas` has `(masinos_id, data_nuo)`.
Live full-fleet requests with all migrated fields, filters, and sorts completed in under 100 ms.
